import { chmod, cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const execFileAsync = promisify(execFile);
const nodeSource = process.env.DSH_DESKTOP_NODE ?? process.execPath;
const dshRootSource = process.env.DSH_DESKTOP_DSH_ROOT;
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = resolve(projectRoot, "../..");
const runtimeRoot = resolve(projectRoot, "src-tauri/resources/runtime");
const nodeTarget = resolve(runtimeRoot, "node/bin/node");
const dshTarget = resolve(runtimeRoot, "dsh");

const nodeSourcePath = resolve(nodeSource);
const nodeInfo = await stat(nodeSourcePath).catch(() => undefined);

if (!nodeInfo?.isFile()) {
  throw new Error(`Node runtime not found: ${nodeSourcePath}`);
}

await mkdir(dirname(nodeTarget), { recursive: true });
await cp(nodeSourcePath, nodeTarget, { force: true });
await chmod(nodeTarget, 0o755);

await rm(dshTarget, { recursive: true, force: true });

if (dshRootSource) {
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
  await execFileAsync(
    "npm",
    [
      "install",
      "--prefix",
      dshTarget,
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      packageSpec,
    ],
    { cwd: workspaceRoot, maxBuffer: 1024 * 1024 * 16 },
  );
}

console.log(`Staged Node: ${nodeTarget}`);
console.log(`Staged DSH:  ${dshTarget}`);
