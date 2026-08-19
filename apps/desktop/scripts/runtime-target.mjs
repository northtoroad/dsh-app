export const NODE_RUNTIME_VERSION = "22.23.2";

const TARGETS = new Map([
  [
    "aarch64-apple-darwin",
    Object.freeze({
      rustTarget: "aarch64-apple-darwin",
      nodeArch: "arm64",
      machoArch: "arm64",
      artifactArch: "arm64",
    }),
  ],
  [
    "x86_64-apple-darwin",
    Object.freeze({
      rustTarget: "x86_64-apple-darwin",
      nodeArch: "x64",
      machoArch: "x86_64",
      artifactArch: "x64",
    }),
  ],
]);

export const SUPPORTED_TARGETS = Object.freeze([...TARGETS.keys()]);

export function resolveTarget(target) {
  if (!target) {
    throw new Error(
      `Missing --target. Expected one of: ${SUPPORTED_TARGETS.join(", ")}`,
    );
  }

  const info = TARGETS.get(target);
  if (!info) {
    throw new Error(
      `Unsupported desktop target ${JSON.stringify(target)}. Expected one of: ${SUPPORTED_TARGETS.join(", ")}`,
    );
  }
  return info;
}

export function parseChecksumManifest(contents, filename) {
  for (const line of contents.split(/\r?\n/u)) {
    const match = /^([a-f\d]{64})\s+\*?(.+)$/iu.exec(line.trim());
    if (match?.[2] === filename) {
      return match[1].toLowerCase();
    }
  }
  throw new Error(`Checksum for ${filename} was not found`);
}

export function assertNodeArchitecture(actualArchitecture, target) {
  const info = typeof target === "string" ? resolveTarget(target) : target;
  const actual = actualArchitecture.trim();
  if (actual !== info.nodeArch) {
    throw new Error(
      `Node architecture mismatch: expected ${info.nodeArch}, received ${actual || "an empty value"}`,
    );
  }
}

export function assertMachOArchitectures(actualArchitectures, target) {
  const info = typeof target === "string" ? resolveTarget(target) : target;
  const architectures = actualArchitectures.trim().split(/\s+/u).filter(Boolean);
  if (!architectures.includes(info.machoArch)) {
    throw new Error(
      `Mach-O architecture mismatch: expected ${info.machoArch}, received ${architectures.join(", ") || "an empty value"}`,
    );
  }
}
