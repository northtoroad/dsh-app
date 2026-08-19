# DeepSeek Harness Desktop

This directory contains the Tauri v2 shell for macOS 13 or newer. Separate
packages are produced for Apple Silicon (`arm64`) and Intel (`x64`). The shell
starts a local DSH Node sidecar on an ephemeral loopback port, waits for
`GET /` to return `200`, and then points the WebView at the existing DSH Web
UI.

## Development

Install dependencies and run the shell natively on the current Mac:

```sh
pnpm install
pnpm --dir apps/desktop dev
```

The npm DSH runtime ships the `web` profile, which the desktop shell uses by
default. If you are using a DSH source checkout that includes a custom
`desktop` profile, set `DSH_DESKTOP_PROFILE=desktop`.

The shell normally discovers the workspace Node and `@deepseek-ai/dsh`
installations. A source-checkout runtime can be selected explicitly:

```sh
export DSH_DESKTOP_NODE=/absolute/path/to/node
export DSH_DESKTOP_DSH_BIN=/absolute/path/to/deepseek-harness/apps/cli/lib/bin.js
pnpm --dir apps/desktop dev
```

## Architecture-specific packages

From the workspace root, use one of these commands:

```sh
pnpm desktop:build:arm64  # Apple Silicon .app and .dmg
pnpm desktop:build:x64    # Intel .app and .dmg
pnpm desktop:build:all    # both, built sequentially
```

`pnpm desktop:build` remains an alias for the Apple Silicon build. Building
both architectures sequentially is required because they share the staging
directory under `src-tauri/resources/runtime`.

Before rebuilding a DMG, eject any mounted `DeepSeek Harness` disk image. The
build wrapper detects mounted copies and fails early with a clear message so
Finder cannot make Tauri's DMG layout step target an older volume.

The build wrapper downloads and verifies the official Node 22.23.2 archive
for the requested architecture, caches it under `.runtime-cache`, installs
the npm DSH runtime with matching native dependencies, builds with Tauri, and
then verifies the App executable, bundled Node, DSH CLI, and installed native
modules.

An Intel build made on Apple Silicon requires Rosetta 2 so the x64 Node
runtime can install and smoke-test its dependencies. The script checks for
Rosetta and prints the installation command if it is unavailable. An Intel
Mac can build the x64 package natively but cannot run `build:all`, because it
cannot execute the arm64 Node runtime during staging.

Build outputs are written to:

```text
src-tauri/target/aarch64-apple-darwin/release/bundle/{macos,dmg}/
src-tauri/target/x86_64-apple-darwin/release/bundle/{macos,dmg}/
```

## Runtime overrides

Release builds use the exact npm package version installed in this workspace.
The following overrides remain available:

```sh
export DSH_DESKTOP_NODE=/absolute/path/to/target-architecture/node
export DSH_DESKTOP_NPM_CLI=/absolute/path/to/npm-cli.js       # optional
export DSH_DESKTOP_NODE_LICENSE=/absolute/path/to/Node-LICENSE # optional
export DSH_DESKTOP_DSH_PACKAGE=@deepseek-ai/dsh@version
```

An overridden Node executable must report the architecture selected by
`--target`. `DSH_DESKTOP_DSH_ROOT` remains available for native builds, but is
rejected for cross-architecture builds because an existing source tree may
contain native modules for the host architecture.

## Checks and distribution

```sh
pnpm --dir apps/desktop test:runtime
pnpm --dir apps/desktop check:all
```

The GitHub Actions workflow builds on native ARM and Intel macOS runners and
uploads separately named DMG artifacts. Signing and notarization are still
controlled by the invoking environment; development artifacts are not ready
for unrestricted public distribution.
