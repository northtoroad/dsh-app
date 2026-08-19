import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

import {
  assertMachOArchitectures,
  assertNodeArchitecture,
  resolveTarget,
} from "./runtime-target.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({
  options: {
    target: { type: "string" },
    "app-path": { type: "string" },
  },
  strict: true,
});
const targetName = values.target;
const target = resolveTarget(targetName);
const tauriConfig = JSON.parse(
  await readFile(resolve(projectRoot, "src-tauri/tauri.conf.json"), "utf8"),
);
const appPath = values["app-path"]
  ? resolve(values["app-path"])
  : resolve(
      projectRoot,
      "src-tauri/target",
      targetName,
      "release/bundle/macos",
      `${tauriConfig.productName}.app`,
    );

if (!(await isDirectory(appPath))) {
  throw new Error(`Application bundle not found: ${appPath}`);
}

const contentsPath = resolve(appPath, "Contents");
const infoPlist = resolve(contentsPath, "Info.plist");
const { stdout: executableName } = await execFileAsync("/usr/bin/plutil", [
  "-extract",
  "CFBundleExecutable",
  "raw",
  "-o",
  "-",
  infoPlist,
]);
const appExecutable = resolve(
  contentsPath,
  "MacOS",
  executableName.trim(),
);
await verifyMachO(appExecutable, target);

const runtimeRoot = await firstDirectory([
  resolve(contentsPath, "Resources/runtime"),
  resolve(contentsPath, "Resources/resources/runtime"),
]);
if (!runtimeRoot) {
  throw new Error(`Bundled runtime directory not found in ${appPath}`);
}

const nodePath = resolve(runtimeRoot, "node/bin/node");
const nodeLicense = resolve(runtimeRoot, "node/LICENSE");
if (!(await isFile(nodeLicense))) {
  throw new Error(`Bundled Node LICENSE not found: ${nodeLicense}`);
}
await verifyMachO(nodePath, target);

const { stdout: nodeArchitecture } = await execFileAsync(nodePath, [
  "-p",
  "process.arch",
]);
assertNodeArchitecture(nodeArchitecture, target);

const dshBin = await firstFile([
  resolve(runtimeRoot, "dsh/apps/cli/lib/bin.js"),
  resolve(runtimeRoot, "dsh/lib/bin.js"),
  resolve(runtimeRoot, "dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"),
  resolve(runtimeRoot, "dsh/bin.js"),
]);
if (!dshBin) throw new Error(`Bundled DSH CLI not found under ${runtimeRoot}`);

const verificationHome = await mkdtemp(join(tmpdir(), "dsh-bundle-verify-"));
try {
  const verificationEnvironment = {
    ...process.env,
    DSH_HOME: verificationHome,
    PATH: `${resolve(runtimeRoot, "node/bin")}:${process.env.PATH ?? ""}`,
  };
  const { stdout: dshVersion } = await execFileAsync(
    nodePath,
    [dshBin, "--version"],
    { env: verificationEnvironment },
  );
  const { stdout: nativeModules } = await execFileAsync(
    nodePath,
    [
      "-e",
      `const { createRequire } = require("node:module");
const requireFromDsh = createRequire(process.argv[1]);
const loaded = [];
for (const name of ["sharp", "koffi", "node-pty", "node-addon-require-builtin"]) {
  try {
    requireFromDsh.resolve(name);
  } catch (error) {
    if (error?.code === "MODULE_NOT_FOUND") continue;
    throw error;
  }
  requireFromDsh(name);
  loaded.push(name);
}
process.stdout.write(loaded.join(","));`,
      dshBin,
    ],
    { env: verificationEnvironment },
  );

  console.log(`Verified app:    ${appPath}`);
  console.log(`Verified target: ${targetName}`);
  console.log(`Verified Node:   ${nodeArchitecture.trim()}`);
  console.log(`Verified DSH:    ${dshVersion.trim()}`);
  console.log(
    `Native modules:  ${nativeModules.trim() || "none installed by this DSH version"}`,
  );
} finally {
  await rm(verificationHome, { recursive: true, force: true });
}

async function verifyMachO(path, targetInfo) {
  if (!(await isFile(path))) throw new Error(`Mach-O file not found: ${path}`);
  const { stdout } = await execFileAsync("/usr/bin/lipo", ["-archs", path]);
  assertMachOArchitectures(stdout, targetInfo);
}

async function firstFile(paths) {
  for (const path of paths) {
    if (await isFile(path)) return path;
  }
  return undefined;
}

async function firstDirectory(paths) {
  for (const path of paths) {
    if (await isDirectory(path)) return path;
  }
  return undefined;
}

async function isFile(path) {
  return (await stat(path).catch(() => undefined))?.isFile() ?? false;
}

async function isDirectory(path) {
  return (await stat(path).catch(() => undefined))?.isDirectory() ?? false;
}
