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

## 安装未签名的开发包

Apple Silicon 使用 `_aarch64.dmg`，Intel 使用 `_x64.dmg`。安装前应将下载
文件的 SHA-256 与该次构建发布的校验值进行比较。确认一致后打开 DMG，将
`DeepSeek Harness.app` 拖入 `Applications`，推出 DMG，再启动已经复制到
“应用程序”目录的 App。

当前开发包尚未使用 Developer ID 签名，也没有经过 Apple 公证。在 Apple
Silicon 上，即使 DMG 校验值正确，Gatekeeper 仍可能提示 App“已损坏”。仅对
来源可信的内部测试包，可为已经复制的 App 添加本地 ad-hoc 签名，验证签名，
移除隔离属性，然后启动：

```sh
/usr/bin/codesign --force --deep --sign - "/Applications/DeepSeek Harness.app"
/usr/bin/codesign --verify --deep --strict --verbose=2 "/Applications/DeepSeek Harness.app"
/usr/bin/xattr -dr com.apple.quarantine "/Applications/DeepSeek Harness.app"
open "/Applications/DeepSeek Harness.app"
```

签名校验命令应显示 `valid on disk` 和 `satisfies its Designated Requirement`。
如果没有 `/Applications` 的写入权限，可在 `codesign` 和 `xattr` 命令前添加
`sudo`。不要对已挂载 DMG 内的只读 App 执行签名，也不要全局关闭 Gatekeeper。

该 ad-hoc 签名只会修改本地安装的测试副本，不能替代 Developer ID 签名和
Apple 公证。

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
