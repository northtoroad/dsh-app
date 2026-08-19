import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

import {
  assertNodeArchitecture,
  NODE_RUNTIME_VERSION,
  parseChecksumManifest,
  resolveTarget,
} from "./runtime-target.mjs";

const execFileAsync = promisify(execFile);
const { values } = parseArgs({
  options: { target: { type: "string" } },
  strict: true,
});
const targetName = values.target;
const target = resolveTarget(targetName);

if (process.platform !== "darwin") {
  throw new Error("Desktop runtime staging currently supports macOS only");
}

const dshRootSource = process.env.DSH_DESKTOP_DSH_ROOT;
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = resolve(projectRoot, "../..");
const runtimeRoot = resolve(projectRoot, "src-tauri/resources/runtime");
const nodeRuntimeRoot = resolve(runtimeRoot, "node");
const nodeTarget = resolve(nodeRuntimeRoot, "bin/node");
const dshTarget = resolve(runtimeRoot, "dsh");
const runtimeCacheRoot = resolve(projectRoot, ".runtime-cache");

await ensureHostCanRunTarget(target);
const nodeDistribution = await resolveNodeDistribution(target);

await rm(nodeRuntimeRoot, { recursive: true, force: true });
await mkdir(dirname(nodeTarget), { recursive: true });
await cp(nodeDistribution.nodePath, nodeTarget, { force: true });
await chmod(nodeTarget, 0o755);
await cp(nodeDistribution.licensePath, resolve(nodeRuntimeRoot, "LICENSE"), {
  force: true,
});

await rm(dshTarget, { recursive: true, force: true });

if (dshRootSource) {
  if (target.nodeArch !== process.arch) {
    throw new Error(
      "DSH_DESKTOP_DSH_ROOT cannot be used for a cross-architecture build because its native dependencies cannot be verified. Use DSH_DESKTOP_DSH_PACKAGE instead.",
    );
  }
  const dshRootPath = resolve(dshRootSource);
  const dshInfo = await stat(dshRootPath).catch(() => undefined);
  if (!dshInfo?.isDirectory()) {
    throw new Error(`DSH runtime tree not found: ${dshRootPath}`);
  }
  await cp(dshRootPath, dshTarget, { recursive: true, force: true });
} else {
  const packageJsonPath = resolve(
    projectRoot,
    "node_modules/@deepseek-ai/dsh/package.json",
  );
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const packageSpec =
    process.env.DSH_DESKTOP_DSH_PACKAGE ??
    `@deepseek-ai/dsh@${packageJson.version}`;

  await mkdir(dshTarget, { recursive: true });
  console.log(`Installing ${packageSpec} for darwin-${target.nodeArch}`);
  await execFileAsync(
    nodeDistribution.nodePath,
    [
      nodeDistribution.npmCliPath,
      "install",
      "--prefix",
      dshTarget,
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
      `--cpu=${target.nodeArch}`,
      "--os=darwin",
      packageSpec,
    ],
    {
      cwd: workspaceRoot,
      env: targetEnvironment(nodeDistribution.nodePath, target),
      maxBuffer: 1024 * 1024 * 64,
    },
  );
}

const dshBin = await firstExisting([
  resolve(dshTarget, "apps/cli/lib/bin.js"),
  resolve(dshTarget, "lib/bin.js"),
  resolve(dshTarget, "node_modules/@deepseek-ai/dsh/lib/bin.js"),
  resolve(dshTarget, "bin.js"),
]);
if (!dshBin) {
  throw new Error(`DSH CLI was not found in staged runtime: ${dshTarget}`);
}

const { stdout: stagedNodeArchitecture } = await execFileAsync(nodeTarget, [
  "-p",
  "process.arch",
]);
assertNodeArchitecture(stagedNodeArchitecture, target);
const { stdout: dshVersion } = await execFileAsync(
  nodeTarget,
  [dshBin, "--version"],
  { env: targetEnvironment(nodeTarget, target) },
);

console.log(`Staged target: ${targetName}`);
console.log(`Staged Node:   ${nodeTarget} (${stagedNodeArchitecture.trim()})`);
console.log(`Staged DSH:    ${dshTarget} (${dshVersion.trim()})`);

async function ensureHostCanRunTarget(targetInfo) {
  if (process.arch === "arm64" && targetInfo.nodeArch === "x64") {
    try {
      await execFileAsync("/usr/bin/arch", ["-x86_64", "/usr/bin/true"]);
    } catch {
      throw new Error(
        "Building the Intel runtime on Apple Silicon requires Rosetta 2. Install it with `softwareupdate --install-rosetta --agree-to-license`, then retry.",
      );
    }
  }
  if (process.arch === "x64" && targetInfo.nodeArch === "arm64") {
    throw new Error(
      "An Intel Mac cannot execute the arm64 Node runtime during staging. Build arm64 on an Apple Silicon host or CI runner.",
    );
  }
}

async function resolveNodeDistribution(targetInfo) {
  const override = process.env.DSH_DESKTOP_NODE;
  if (override) {
    const nodePath = await resolveExecutable(override);
    return inspectNodeDistribution(nodePath, targetInfo, {
      npmCliOverride: process.env.DSH_DESKTOP_NPM_CLI,
      licenseOverride: process.env.DSH_DESKTOP_NODE_LICENSE,
    });
  }

  if (
    process.version === `v${NODE_RUNTIME_VERSION}` &&
    process.arch === targetInfo.nodeArch
  ) {
    try {
      return await inspectNodeDistribution(process.execPath, targetInfo);
    } catch {
      // setup-node and most official installations include npm and LICENSE,
      // but fall back to the verified archive if they do not.
    }
  }

  return downloadNodeDistribution(targetInfo);
}

async function inspectNodeDistribution(nodePath, targetInfo, overrides = {}) {
  const nodeInfo = await stat(nodePath).catch(() => undefined);
  if (!nodeInfo?.isFile()) {
    throw new Error(`Node runtime not found: ${nodePath}`);
  }

  const { stdout: architecture } = await execFileAsync(nodePath, [
    "-p",
    "process.arch",
  ]);
  assertNodeArchitecture(architecture, targetInfo);

  const distributionRoot = resolve(dirname(nodePath), "..");
  const npmCliPath = overrides.npmCliOverride
    ? resolve(overrides.npmCliOverride)
    : resolve(distributionRoot, "lib/node_modules/npm/bin/npm-cli.js");
  const licensePath = overrides.licenseOverride
    ? resolve(overrides.licenseOverride)
    : resolve(distributionRoot, "LICENSE");

  for (const [label, path] of [
    ["npm CLI", npmCliPath],
    ["Node LICENSE", licensePath],
  ]) {
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`${label} not found: ${path}`);
  }

  return { nodePath, npmCliPath, licensePath };
}

async function downloadNodeDistribution(targetInfo) {
  const archiveName = `node-v${NODE_RUNTIME_VERSION}-darwin-${targetInfo.nodeArch}.tar.gz`;
  const releaseBase = `https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}`;
  const downloadRoot = resolve(runtimeCacheRoot, "downloads");
  const archivePath = resolve(downloadRoot, archiveName);
  const checksumsPath = resolve(
    downloadRoot,
    `node-v${NODE_RUNTIME_VERSION}-SHASUMS256.txt`,
  );
  const distributionRoot = resolve(
    runtimeCacheRoot,
    `node-v${NODE_RUNTIME_VERSION}-darwin-${targetInfo.nodeArch}`,
  );

  try {
    return await inspectNodeDistribution(
      resolve(distributionRoot, "bin/node"),
      targetInfo,
    );
  } catch {
    // A missing or incomplete cache is recreated below.
  }

  await mkdir(downloadRoot, { recursive: true });
  if (!(await isFile(checksumsPath))) {
    await downloadFile(`${releaseBase}/SHASUMS256.txt`, checksumsPath);
  }
  const checksumManifest = await readFile(checksumsPath, "utf8");
  const expectedChecksum = parseChecksumManifest(checksumManifest, archiveName);

  if (
    !(await isFile(archivePath)) ||
    (await sha256(archivePath)) !== expectedChecksum
  ) {
    await rm(archivePath, { force: true });
    await downloadFile(`${releaseBase}/${archiveName}`, archivePath);
  }
  const actualChecksum = await sha256(archivePath);
  if (actualChecksum !== expectedChecksum) {
    await rm(archivePath, { force: true });
    throw new Error(
      `Node archive checksum mismatch for ${archiveName}: expected ${expectedChecksum}, received ${actualChecksum}`,
    );
  }

  const temporaryRoot = `${distributionRoot}.partial-${process.pid}`;
  await rm(temporaryRoot, { recursive: true, force: true });
  await mkdir(temporaryRoot, { recursive: true });
  try {
    await execFileAsync("/usr/bin/tar", [
      "-xzf",
      archivePath,
      "--strip-components",
      "1",
      "-C",
      temporaryRoot,
    ]);
    await inspectNodeDistribution(
      resolve(temporaryRoot, "bin/node"),
      targetInfo,
    );
    await rm(distributionRoot, { recursive: true, force: true });
    await rename(temporaryRoot, distributionRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  return inspectNodeDistribution(
    resolve(distributionRoot, "bin/node"),
    targetInfo,
  );
}

async function downloadFile(url, destination) {
  const temporaryPath = `${destination}.partial-${process.pid}`;
  await rm(temporaryPath, { force: true });
  console.log(`Downloading ${url}`);
  const response = await fetch(url, {
    headers: { "user-agent": "dsh-desktop-build/0.1.0" },
    redirect: "follow",
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(temporaryPath, { mode: 0o600 }),
    );
    await rename(temporaryPath, destination);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function resolveExecutable(value) {
  if (isAbsolute(value) || value.includes("/")) return resolve(value);
  const { stdout } = await execFileAsync("/usr/bin/which", [value]);
  const path = stdout.trim();
  if (!path) throw new Error(`Executable not found on PATH: ${value}`);
  return path;
}

function targetEnvironment(nodePath, targetInfo) {
  return {
    ...process.env,
    PATH: `${dirname(nodePath)}:${process.env.PATH ?? ""}`,
    npm_config_arch: targetInfo.nodeArch,
    npm_config_cpu: targetInfo.nodeArch,
    npm_config_os: "darwin",
    npm_config_platform: "darwin",
  };
}

async function firstExisting(paths) {
  for (const path of paths) {
    if (await isFile(path)) return path;
  }
  return undefined;
}

async function isFile(path) {
  return (await stat(path).catch(() => undefined))?.isFile() ?? false;
}
