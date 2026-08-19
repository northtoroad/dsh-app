import assert from "node:assert/strict";
import test from "node:test";

import {
  assertMachOArchitectures,
  assertNodeArchitecture,
  parseChecksumManifest,
  resolveTarget,
  SUPPORTED_TARGETS,
} from "./runtime-target.mjs";

test("maps both supported macOS targets", () => {
  assert.deepEqual(SUPPORTED_TARGETS, [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
  ]);
  assert.equal(resolveTarget("aarch64-apple-darwin").nodeArch, "arm64");
  assert.equal(resolveTarget("x86_64-apple-darwin").nodeArch, "x64");
});

test("rejects missing and unsupported targets", () => {
  assert.throws(() => resolveTarget(), /Missing --target/u);
  assert.throws(
    () => resolveTarget("universal-apple-darwin"),
    /Unsupported desktop target/u,
  );
});

test("extracts the requested checksum", () => {
  const expected = "a".repeat(64);
  const manifest = `${"b".repeat(64)}  other.tar.gz\n${expected}  node.tar.gz\n`;
  assert.equal(parseChecksumManifest(manifest, "node.tar.gz"), expected);
  assert.throws(
    () => parseChecksumManifest(manifest, "missing.tar.gz"),
    /was not found/u,
  );
});

test("validates Node and Mach-O architecture values", () => {
  assert.doesNotThrow(() =>
    assertNodeArchitecture("x64\n", "x86_64-apple-darwin"),
  );
  assert.throws(
    () => assertNodeArchitecture("arm64", "x86_64-apple-darwin"),
    /Node architecture mismatch/u,
  );
  assert.doesNotThrow(() =>
    assertMachOArchitectures("x86_64 arm64", "aarch64-apple-darwin"),
  );
  assert.throws(
    () => assertMachOArchitectures("arm64", "x86_64-apple-darwin"),
    /Mach-O architecture mismatch/u,
  );
});
