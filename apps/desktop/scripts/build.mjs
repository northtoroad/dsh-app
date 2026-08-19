import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

import { resolveTarget } from "./runtime-target.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const execFileAsync = promisify(execFile);
const stageRuntimeScript = fileURLToPath(
  new URL("./stage-runtime.mjs", import.meta.url),
);
const verifyBundleScript = fileURLToPath(
  new URL("./verify-bundle.mjs", import.meta.url),
);
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const tauriConfig = JSON.parse(
  await readFile(
    fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url)),
    "utf8",
  ),
);

const { values } = parseArgs({
  options: {
    target: { type: "string", multiple: true },
    bundles: { type: "string", default: "app,dmg" },
  },
  strict: true,
});

const targets = values.target ?? [];
if (targets.length === 0) {
  throw new Error("At least one --target is required");
}
for (const target of targets) resolveTarget(target);

await run(pnpm, ["run", "icons"]);

for (const target of targets) {
  console.log(`\nBuilding DeepSeek Harness for ${target}`);
  if (values.bundles.split(",").includes("dmg")) {
    await assertBundleVolumeIsNotMounted(tauriConfig.productName);
  }
  await run(process.execPath, [stageRuntimeScript, "--target", target]);
  await run(pnpm, [
    "exec",
    "tauri",
    "build",
    "--target",
    target,
    "--bundles",
    values.bundles,
  ]);
  await run(process.execPath, [verifyBundleScript, "--target", target]);
}

async function assertBundleVolumeIsNotMounted(productName) {
  const { stdout } = await execFileAsync("/usr/bin/hdiutil", ["info"]);
  if (stdout.includes(`/Volumes/${productName}`)) {
    throw new Error(
      `${productName} is currently mounted. Eject every mounted ${productName} disk image in Finder before building a new DMG.`,
    );
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`,
          ),
        );
      }
    });
  });
}
