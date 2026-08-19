# DSH 桌面端会话总结

更新时间：2026-08-18

## 1. 当前目标与状态

本项目按照 `desktop-implementation.md` 实现了 DeepSeek Harness 的桌面端外壳，支持 **macOS Apple Silicon（arm64）和 Intel（x64）**，最低 macOS 版本为 13.0。

当前状态：

- 本地桌面 App 已可以正常启动并加载 DSH Web UI。
- 可以分别生成 Apple Silicon 与 Intel 的 `.app` 和 `.dmg` 安装包。
- 运行时 Node 与 DSH CLI 可以在构建时自动放入应用资源，因此用户不必单独安装 Node。
- 当前本地安装包仍属于开发阶段产物；正式公开分发还需要 Apple Developer ID 签名和公证。

## 2. 已实现的架构

```text
Tauri v2 外壳
  ├─ 创建隐藏窗口、托盘菜单和单实例行为
  ├─ 启动随机 loopback 端口上的 DSH Node 服务
  ├─ 等待 HTTP 服务就绪后加载现有 DSH Web UI
  └─ 通过带随机令牌的 loopback TCP 桥接调用系统通知和文件定位
```

主要代码位置：

- `apps/desktop/src-tauri/src/lib.rs`：Tauri 应用装配、窗口、托盘、单实例和退出清理。
- `apps/desktop/src-tauri/src/sidecar.rs`：Node/DSH 边车启动、端口选择、就绪检查、日志和进程回收。
- `apps/desktop/src-tauri/src/bridge.rs`：loopback TCP 桥接、令牌认证、通知和文件定位。
- `packages/desktop/desktop-shell`：桌面能力抽象接口。
- `packages/desktop/desktop-shell-tcp`：DSH 侧 TCP 桥接提供方；没有桥接环境变量时自动降级为空操作。
- `apps/desktop/scripts/build.mjs`：按目标架构准备运行时、调用 Tauri 并验证 Bundle。
- `apps/desktop/scripts/stage-runtime.mjs`：下载并校验目标架构 Node，安装生产版 `@deepseek-ai/dsh` 运行时。
- `apps/desktop/src-tauri/tauri.conf.json`：双架构共用的构建资源、Hardened Runtime 和 macOS 最低版本配置。

代码通过编译条件限制非 macOS 或非 arm64/x86_64 构建：

```rust
#[cfg(not(all(
    target_os = "macos",
    any(target_arch = "aarch64", target_arch = "x86_64")
)))]
compile_error!("DeepSeek Harness Desktop supports arm64 and x86_64 macOS only");
```

## 3. 本次排查并解决的问题

### Cargo 不存在

最初运行 Tauri 时出现 `failed to run 'cargo metadata'`，原因是系统中没有可用的 Cargo/Rust 工具链。安装 Rust 后，Cargo metadata 和桌面端编译流程可以继续执行。

### Rust 文档下载过慢

`rust-docs` 下载速度慢属于 Rust 工具链安装阶段的网络问题，不是项目代码错误。工具链安装完成后，项目本身不依赖再次下载文档；后续可复用本地 Rust 缓存，或在网络条件较好的环境安装。

### 找不到 DSH 运行时

应用曾提示：

```text
未找到 DSH 运行时
```

现在构建脚本会自动准备以下资源：

```text
apps/desktop/src-tauri/resources/runtime/
  node/bin/node
  dsh/...
```

开发或 CI 也可以通过以下环境变量覆盖运行时位置：

```sh
export DSH_DESKTOP_NODE=/path/to/node
export DSH_DESKTOP_DSH_BIN=/path/to/dsh/apps/cli/lib/bin.js
```

### DMG 中看到 `Application` 和 `Contents`

`.app` 本质上是一个目录包，看到 `Contents` 是 macOS 应用包的正常内部结构。正确的 DMG 根目录应显示应用图标和 `Applications` 快捷方式，用户应将应用拖入 `Applications` 后再启动。

### 将 DMG 直接压缩为 ZIP 后提示磁盘损坏

此前安装包是开发阶段的 ad-hoc 签名或未完成公证的产物。直接把 DMG 再压缩成 ZIP 也不是正式 macOS 分发流程，可能导致 Gatekeeper 报错。正式发布应使用 Developer ID 签名、Apple 公证，并保留原始 DMG 或从已公证的 App 正确制作 ZIP。

### Apple Silicon 提示 App“已损坏”

如果 arm64 DMG 的 SHA-256 与发布值一致，并且 `hdiutil verify` 通过，则文件本身没有损坏。当前开发包的 arm64 主程序带有链接器生成的临时签名，但整个 `.app` 尚未建立完整的资源签名；Gatekeeper 可能因此将签名错误显示为“已损坏”。

仅对来源可信的内部测试包，可先将 App 拖入 `/Applications` 并推出 DMG，再执行：

```sh
/usr/bin/codesign --force --deep --sign - "/Applications/DeepSeek Harness.app"
/usr/bin/codesign --verify --deep --strict --verbose=2 "/Applications/DeepSeek Harness.app"
/usr/bin/xattr -dr com.apple.quarantine "/Applications/DeepSeek Harness.app"
open "/Applications/DeepSeek Harness.app"
```

签名校验应显示 `valid on disk` 和 `satisfies its Designated Requirement`。如果 `/Applications` 权限不足，可在 `codesign` 和 `xattr` 命令前添加 `sudo`。不要直接修改只读 DMG 内的 App，也不要全局关闭 Gatekeeper。这个本地 ad-hoc 签名只是开发包安装的临时措施，不能替代 Developer ID 签名和 Apple 公证。

## 4. 本地运行和构建

在仓库根目录执行：

```sh
pnpm install
pnpm --dir apps/desktop dev
```

如果开发环境无法自动找到 Node 或 DSH CLI，可以显式设置：

```sh
export DSH_DESKTOP_NODE=/path/to/node
export DSH_DESKTOP_DSH_BIN=/path/to/dsh/lib/bin.js
pnpm --dir apps/desktop dev
```

构建架构独立的安装包：

```sh
pnpm desktop:build:arm64
pnpm desktop:build:x64
pnpm desktop:build:all
```

`desktop:build` 仍默认构建 arm64。构建脚本会先生成图标，下载并校验固定版本的目标架构 Node，使用目标 Node 安装原生依赖，然后调用 Tauri 并验证 Bundle。Apple Silicon 本机构建 x64 需要 Rosetta 2。本地构建产物位于：

```text
apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/
apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/
apps/desktop/src-tauri/target/x86_64-apple-darwin/release/bundle/macos/
apps/desktop/src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/
```

常用检查命令：

```sh
pnpm --dir apps/desktop check
pnpm --dir apps/desktop check:all
pnpm --dir apps/desktop test:runtime
pnpm --dir apps/desktop fmt
```

## 5. 正式分发待办

公开提供 DMG 下载时，建议加入 Apple Developer Program，费用通常为 **99 美元/年**，实际金额按地区货币和税费结算。直接官网下载的 macOS App 应使用 `Developer ID Application` 签名，并通过 `notarytool` 公证；`hardenedRuntime` 已在 Tauri 配置中开启。

正式发布流程还需要：

1. 创建 Apple Developer 账号和 Developer ID Application 证书。
2. 在本地或 CI 中配置证书、签名身份和公证凭据；凭据不能提交进 Git。
3. 签名 `.app`/DMG，提交 Apple 公证并 stapling。
4. 分别在 Apple Silicon 和 Intel Mac 上验证安装、首次启动、卸载和升级。
5. 发布原始 DMG，或将已签名且已公证的 `.app` 正确压缩为 ZIP；不要把 DMG 再套一层 ZIP 作为替代方案。

如果改为发布到 Mac App Store，应使用 `Apple Distribution` 证书和 App Store Connect 流程；Enterprise 计划不适合公开下载场景。

## 6. Git 提交范围

本次提交包含桌面端源代码、配置、锁文件、构建脚本、CI 配置和文档。以下本地生成内容不提交：

- `node_modules/`、`.pnpm-store/`
- Rust `target/`
- 自动生成的 Tauri 图标目录
- `.runtime-cache/` 下按架构缓存的 Node 官方发行包
- `apps/desktop/src-tauri/resources/runtime/node/` 下的 Node 二进制
- `apps/desktop/src-tauri/resources/runtime/dsh/` 下的生产运行时
- `dist/`

运行时会在构建时重新生成；本次同时修正了 `.gitignore` 中运行时目录的实际路径，避免把本地二进制误提交。

## 7. 下一步建议

优先完成 macOS Developer ID 签名、公证和 CI Secret 配置，然后在干净的 Apple Silicon 与 Intel Mac 上分别验证正式安装包。完成这一步后，再考虑自动更新、钥匙串凭据存储、原生文件选择器和崩溃反馈等增强能力。
