# DeepSeek Harness Desktop

这是 DeepSeek Harness 的 macOS 桌面端外壳，基于 Tauri v2 构建，支持 Apple Silicon 和 Intel 两种独立安装包。

## 系统要求

- macOS 13.0 或更高版本。
- Apple Silicon Mac 请选择 `arm64` 安装包。
- Intel Mac 请选择 `x64` 安装包。

## 下载与安装

安装包发布在 [GitHub Releases](https://github.com/sscm/DSH-APP/releases)。下载与电脑架构对应的 DMG：

| 电脑 | 安装包 |
| --- | --- |
| Apple Silicon（M1/M2/M3/M4） | `DeepSeek Harness_0.1.0_aarch64.dmg` |
| Intel | `DeepSeek Harness_0.1.0_x64.dmg` |

打开 DMG，将 `DeepSeek Harness.app` 拖到 `Applications`，推出 DMG 后，从“应用程序”目录启动 App。建议先根据 Release 中的 `SHA256SUMS.txt` 校验下载文件。

当前 Release 是未签名、未公证的开发阶段安装包。若 Apple Silicon 上提示 App“已损坏”，确认校验值一致并将 App 复制到 `/Applications` 后，仅对来源可信的包执行：

```sh
/usr/bin/codesign --force --deep --sign - "/Applications/DeepSeek Harness.app"
/usr/bin/codesign --verify --deep --strict --verbose=2 "/Applications/DeepSeek Harness.app"
/usr/bin/xattr -dr com.apple.quarantine "/Applications/DeepSeek Harness.app"
open "/Applications/DeepSeek Harness.app"
```

不要对挂载中的只读 DMG 内 App 执行签名，也不要全局关闭 Gatekeeper。正式公开分发前应接入 Developer ID 签名和 Apple 公证。

## 本地开发与构建

```sh
pnpm install
pnpm desktop:dev
pnpm desktop:build:arm64
pnpm desktop:build:x64
pnpm desktop:build:all
```

`pnpm desktop:build` 仍是 arm64 构建别名。构建产物位于：

```text
apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/
apps/desktop/src-tauri/target/x86_64-apple-darwin/release/bundle/
```

Apple Silicon 本机构建 Intel 包需要安装 Rosetta 2。双架构构建、运行时准备、安装说明和分发注意事项详见 [`apps/desktop/README.md`](apps/desktop/README.md) 与 [`SESSION_SUMMARY.md`](SESSION_SUMMARY.md)。
