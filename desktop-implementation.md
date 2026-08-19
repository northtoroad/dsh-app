# DeepSeek Harness 桌面端 —— 当前实现方案落成文档

> 文档性质：将本会话（2026-08-17）中「DeepSeek Harness Mac/Windows 桌面端」从方案到 P1 落地的实现固化为一份完整记录，作为方案对照、后续开发与交接的基准。
> 文档位置：工作区 `/Users/macos/Desktop/DSH-app/docs/desktop-implementation.md`（仓库外，未纳入 deepseek-harness 仓库门禁）。
> 代码状态：`deepseek-harness` 仓库分支 `feature/desktop-client`，工作树干净，两个提交（见 §10）。

---

## 1. 项目背景与目标

DeepSeek Harness（DSH）是 DeepSeek AI 开源的、基于 Cordis 的"一切皆插件"Agent 运行时（npm 包 `@deepseek-ai/dsh`，`dsh web` 默认在 `http://127.0.0.1:3080` 提供 Web UI）。用户目标：为其提供 **macOS 与 Windows 原生桌面客户端**，使终端用户无需安装 Node、无需打开浏览器即可使用 DSH，并具备原生系统能力（托盘、通知、系统文件选择器、钥匙串、自动更新等）。

**成功标准（方案阶段定义）**
1. 双平台签名安装包（macOS DMG 公证 + Windows 签名安装器），开箱即用，自带 Node 运行时。
2. 桌面端渲染现有 Web UI，功能与浏览器版一致；与 CLI/浏览器共享 `~/.dsh` 会话与配置。
3. 具备原生能力：单实例、托盘、系统通知、原生目录选择器、OS 凭据库、深链、自动更新。
4. 安全验收：只绑 `127.0.0.1` 随机端口、信任围栏在 webview 场景有效、外链走系统浏览器、签名公证。
5. 按仓库插件模式落地（`desktop` profile + `dsh-desktop-*` 包），CI 自动出包。

---

## 2. 核心架构决策

**方案：瘦原生外壳（Tauri v2）+ DSH Node 边车 + WebView 直载现有 Web UI**

```
┌────────────────────────── Tauri v2 应用 ──────────────────────────┐
│  WebView（WKWebView / WebView2）                                   │
│    直接加载 http://127.0.0.1:<随机端口>/  ←── 现有 dsh Web UI      │
│  托盘 · 单实例 · 信号处理（SIGTERM/SIGINT → 优雅退出）              │
│  桥接监听（回环 TCP，每启动随机令牌鉴权）                           │
└──────────────────────────┬─────────────────────────────────────────┘
                           │ spawn，env: DSH_DESKTOP_BRIDGE_PORT/TOKEN
                           ▼
        dsh --profile desktop --port <端口>   （边车，只绑 127.0.0.1）
```

**关键决策点**

| 决策 | 内容 | 理由 |
|---|---|---|
| 壳技术 | Tauri v2（Rust + 系统 WebView） | 体积小、无常驻 Chromium；仓库已有 Rust 原生组件（native/landlock-run） |
| UI 呈现 | **直载现有 Web UI**（`http://127.0.0.1:<port>/`），不复制前端产物、不引入自定义协议源 | 前端零改动、功能 1:1；loopback 同源天然通过现有信任围栏 |
| 端口握手 | 外壳 bind `127.0.0.1:0` 取空闲端口 → 释放 → `--port N` 传给边车 → HTTP `GET /` 轮询就绪（裸 TCP，零依赖） | 无需解析边车 stdout；对上游零改动 |
| 桥接传输 | **回环 TCP + 每启动随机令牌**（首帧 hello 鉴权），单向帧 `notify`/`revealPath` | 原计划 stdio 因 Windows 无法注入 CRT fd 而放弃；记录于 Agent Note |
| 无壳降级 | `DSH_DESKTOP_BRIDGE_*` 环境变量缺失时提供方空操作 | 同一 profile 可在纯终端运行 |
| 状态共享 | 边车默认 `~/.dsh`（`$DSH_HOME` 可覆盖），与 CLI/浏览器共享 | 会话、设置、插件互见 |
| profile 形态 | `desktop` profile = base + web-app + desktop 补丁行 | 仓库现有 profile 机制（PROFILE_TEMPLATES） |

**已否决的替代**

- **Electron**：一条语言栈但体积 ~200MB+、常驻 Chromium，与仓库 Rust 原生组件路线不符。
- **原生重写 UI（SwiftUI + WinUI）**：等于重写整个前端，违背 DSH 客户端-服务端分离设计。
- **PWA 壳**：无托盘/真通知/更新器，体验不达标。
- **stdio/fd 桥**：Windows `std::process::Command` 只接线三个标准句柄，无法为子进程指定额外 CRT fd。

**平台基线**：macOS 13+（arm64/x64）、Windows 10/11 x64（WebView2 Evergreen）。

---

## 3. 仓库落地结构（monorepo 内）

```
apps/desktop/                          # Tauri v2 外壳（Rust + 最小前端）
  package.json                         # @deepseek-ai/dsh-desktop-app（private，devDep: @tauri-apps/cli）
  dist/index.html                      # 占位页（"正在启动…"）
  app-icon.svg                         # 图标源（取自 apps/web/public/favicon.svg）
  src-tauri/
    Cargo.toml                         # tauri 2（tray-icon/image-png）、opener、single-instance、notification、uuid、ctrlc(termination)
    tauri.conf.json                    # 窗口 1280x820，visible:false 启动隐藏；CSP null；bundle targets all
    capabilities/default.json          # core:default、opener:default、notification:default
    src/lib.rs                         # 应用装配：setup、托盘、单实例回调、RunEvent::Exit 杀边车
    src/sidecar.rs                     # 端口挑选、spawn（管道 stdout/stderr → sidecar.log）、就绪探测
    src/bridge.rs                      # 回环桥监听：hello 鉴权 + notify/revealPath 分发
packages/desktop/                      # 新包组（宿主侧）
  desktop-shell/                       # @deepseek-ai/dsh-desktop-shell：ctx.desktopShell 服务定义
    src/index.ts                       # DesktopShell 抽象服务（notify/revealPath）
    src/invariant.ts                   # 包不变式同伴
    tests/service.spec.ts              # 注册/离去与请求转发
  desktop-shell-tcp/                   # @deepseek-ai/dsh-desktop-shell-tcp：TCP 提供方
    src/index.ts                       # JSON 行帧、hello 鉴权、惰性连接、空操作模式
    tests/provider.spec.ts             # 真实回环 socket 端到端（6 项）
packages/bundle/desktop/               # @deepseek-ai/dsh-desktop：desktop profile 补丁层
  cordis.patch.yml                     # 插入 desktop-shell-tcp 行
packages/boot/app-boot/src/profile.ts  # PROFILE_TEMPLATES += desktop（base+web-app+desktop）
apps/cli/src/args.ts                   # 新增 `dsh desktop` 别名（对齐 `dsh web`）
apps/cli/package.json                  # deps += dsh-desktop / dsh-desktop-shell / dsh-desktop-shell-tcp
tsconfig.base.json / tsconfig.host.json# paths 与 host 聚合注册
packages/README(.zh).md                # 新增 desktop/ 组行
scripts/verify-package-readme-model-experience.ts  # 3 个包 allowlist 审计
.github/workflows/desktop.yml          # 出包矩阵 CI
.agents/notes/implemented/feature/2026-08-17-desktop-shell-tauri-loopback-bridge.{md,zh,md.i18n.yaml}
                                      # Agent Note：TCP 桥决策记录
```

---

## 4. 子系统设计

### 4.1 边车生命周期（外壳侧，Rust）

- **启动**：setup 中先生成 `uuid v4` 令牌并绑定桥接监听（`127.0.0.1:0`），再以 `node <dsh-bin> --profile desktop --port <N>` 拉起边车；`DSH_DESKTOP_BRIDGE_PORT/TOKEN` 注入子进程环境。
- **日志**：子进程 stdout/stderr 以管道捕获，逐行追加至 `~/Library/Logs/ai.deepseek.dsh.desktop/sidecar.log`（管道必被排空，防止子进程写满缓冲阻塞）。
- **就绪**：裸 TCP `GET /` 轮询（250ms 间隔，90s 超时），200 后 `navigate` 到 `http://127.0.0.1:<port>/` 并显示窗口。
- **退出**：`RunEvent::Exit` 中 `kill` 边车并 `wait`；`ctrlc`（**需显式启用 `termination` feature**，否则只拦 SIGINT）处理 SIGTERM/SIGINT → `app.exit(0)` → 走同一清理路径（实测：SIGTERM 后边车进程随之消失）。
- **单实例**：`tauri-plugin-single-instance`，二次启动聚焦既有窗口。
- **托盘**：tray-icon，菜单 Show/Quit，左键单击显示窗口。

### 4.2 桥接协议（宿主 ↔ 外壳，host → shell 单向）

回环 TCP，JSON 行帧（每帧一行），外壳侧实现于 `bridge.rs`，宿主侧实现于 `dsh-desktop-shell-tcp`：

| 帧 | 字段 | 语义 |
|---|---|---|
| `hello` | `type, token, pid` | 连接建立后首帧，令牌不符即关闭（外壳回 `{"type":"error","message":"unauthorized"}`） |
| `notify` | `type, title, body?` | 系统通知（外壳经 notification 插件展示） |
| `revealPath` | `type, path` | 文件管理器定位（外壳经 opener `reveal_item_in_dir`） |

宿主侧细节：惰性连接（首次请求时 connect）、写前入队、连接失败/超时（2s）以 `BridgeUnreachableError` 拒绝请求；队列上限 64；环境变量缺失时 `notify/revealPath` 直接 resolve（空操作）。

### 4.3 信任围栏（已验证）

`dsh-client-connection` 对 HTTP 与 WS upgrade 统一执行三重校验：Host 回环/白名单 + `sec-fetch-site: cross-site` 拒绝 + Origin 同源比对。实测矩阵（对运行中边车）：

| # | 场景 | 结果 |
|---|---|---|
| A | WS 同源 Origin（webview 场景） | 101 OPEN ✓ |
| B | WS 伪造 Origin（evil.example） | 403 ✓ |
| C | WS `sec-fetch-site: cross-site` | 403 ✓ |
| D | WS 无标记（非浏览器客户端） | 101（设计如此：防 DNS-rebinding，非鉴权层） |
| E | HTTP `/api` 伪造 Origin | 403 ✓ |
| F | HTTP `/api` 无标记 | 426 upgrade required ✓ |
| G | `GET /` 页面 | 200 ✓ |
| H | `GET /api/session.list` 回环 | 404（围栏放行、方法路由 404）✓ |
| I | `GET /` + Host 伪造 | 200（静态页无 API 面）✓ |

结论：方案中规划的"WS Origin/token 加固"上游 master 已实现，桌面 webview 与围栏天然兼容；每启动令牌为桥接专用。

### 4.4 安全模型

- 边车只绑 `127.0.0.1`，端口由外壳挑选（随机）；`--host 0.0.0.0` 上游显式禁止。
- 桥接 socket 仅回环 + 每启动令牌；无令牌的本地进程无法驱动 OS 效果。
- 外链经 opener 走系统浏览器；非回环导航不授予任何能力。
- 生产构建无 devtools；凭据计划入系统钥匙串（P2，未实现）。

---

## 5. 兼容性处理与已知问题

| 问题 | 状态 | 说明 |
|---|---|---|
| macOS 12 WKWebView（Safari 15）缺 `AbortSignal.timeout/any` | **已修复并提交**（`42b377f`） | 客户端 fetch 载体每次请求都调用；`packages/client/web/src/abort-signal-polyfill.ts` 在引导内核最早处做特性检测垫片（原生存在时不覆盖），8 项测试 |
| Safari 15 shiki 高亮崩溃（`invalid group specifier name`） | **已定位，未修复（按用户要求回退）** | `highlight.ts` 自定义 regexConstructor 未传 `target`，`oniguruma-to-es` 默认输出含重复命名捕获组的现代正则，Safari 15 编译失败 → `conversation.chat.node` 槽位崩溃 → 对话结果不渲染；修复方向：`regexConstructor` 传 `target: 'auto'`（引擎自适应 ES2018/ES2025）；另：调试期加装的 webview 控制台转发器（on_page_load 注入）已随回退移除 |
| 边车孤儿进程（早期 P0 发现） | **已修复** | SIGTERM 默认动作直接杀进程导致子进程残留；`ctrlc` 启用 `termination` feature 后走 `RunEvent::Exit` 清理，实测通过 |
| 本会话开发环境（文件沙箱）限制 | 环境产物，非应用缺陷 | 沙箱拦截 `~/Library` WebKit 数据目录、`hdiutil` 建 DMG、`~/.dsh` 写操作；真实用户终端无此问题 |
| 代码高亮门禁抖动 | 与本次改动无关 | `code-block.client.spec.tsx` 整库并行负载下偶发超时，隔离运行 15/15 通过 |

---

## 6. 本地运行指南

### 方式 A：桌面应用（GUI）

```sh
export DSH_DESKTOP_NODE=/Users/macos/.nvm/versions/node/v22.22.0/bin/node
export DSH_DESKTOP_DSH_BIN=/Users/macos/Desktop/DSH-app/deepseek-harness/apps/cli/lib/bin.js
/Users/macos/Desktop/DSH-app/deepseek-harness/apps/desktop/src-tauri/target/debug/dsh-desktop-app
```

窗口先显示"正在启动…"，边车就绪后自动加载 Web UI；Cmd+Q / SIGTERM 退出时连带清理边车。

### 方式 B：终端运行 desktop profile（无 GUI）

```sh
cd /Users/macos/Desktop/DSH-app/deepseek-harness
export PATH=/Users/macos/Desktop/DSH-app/.npm-global/bin:$PATH
pnpm dsh desktop --port 3000     # 浏览器打开 http://127.0.0.1:3000
```

### 重新构建（代码有改动时）

```sh
export RUSTUP_HOME=/Users/macos/Desktop/DSH-app/.rustup \
       CARGO_HOME=/Users/macos/Desktop/DSH-app/.cargo
export PATH=/Users/macos/Desktop/DSH-app/.cargo/bin:/Users/macos/Desktop/DSH-app/.npm-global/bin:$PATH

cd /Users/macos/Desktop/DSH-app/deepseek-harness
pnpm install --ignore-scripts      # 本机 git 2.24 < 2.26，跳过 lefthook 钩子
pnpm run build                     # host + client 库 + web dist（约 1 分钟）
cd apps/desktop
pnpm exec tauri build --debug --no-bundle   # 编译外壳
```

**本机环境要点**：Rust 装在工作区（`.rustup`/`.cargo`）；pnpm 装在工作区（`.npm-global/bin`）；DMG 打包在本会话沙箱内被 `hdiutil` 权限拦截，普通终端可正常出包。

---

## 7. 测试与门禁（已通过项）

| 项 | 结果 |
|---|---|
| `packages/desktop/*` vitest | 8/8 通过（服务定义 2 + TCP 提供方 6） |
| `apps/cli` + `packages/boot/app-boot` vitest | 137 通过 / 1 跳过（profile.ts、args.ts 改动无回归） |
| `test:gui`（客户端全量） | 3764 通过 / 1 跳过；唯一失败为上述 code-block 高亮负载抖动，隔离通过 |
| oxlint（全仓库） | 0 errors / 0 warnings |
| `verify-package-invariants` | 222 包同伴全部符合（新增 3 包） |
| `verify-cordis-config` | 121 个配置通过（desktop 补丁行） |
| `verify-agent-note-format` | 542 篇符合 |
| `verify-doc-budgets` / 模型体验 / 限制节 / 翻译配对 | 全绿（942 对双语记录一致） |
| 桌面 profile 实机启动 | `dsh desktop --dump-default-config` 组合正确；`--port 0` 带/不带桥环境均启动成功，UI 200 |

---

## 8. 打包与发布现状

- **CI**：`.github/workflows/desktop.yml` —— 矩阵 macos-14(arm64)/macos-13(x64)/windows-latest(x64)，PR 或 push 触发（路径过滤 apps/desktop、packages/desktop、bundle/desktop、workflow 自身），`pnpm install --frozen-lockfile` + `pnpm run build` + `tauri build`，产物经 upload-artifact 上传。
- **缺口（正式安装包不可用前必须补齐）**
  1. **运行时自包含**：当前外壳用环境变量定位 node/dsh；发布包需把 Node 官方二进制 + `@deepseek-ai/dsh` 包树打进 `resources/`，`sidecar.rs` 改为优先 `app.path().resource_dir()`，`tauri.conf.json` 配 `bundle.resources`。
  2. **签名/公证**：macOS Developer ID + Hardened Runtime + notarization（CI secrets：APPLE_CERTIFICATE 等）；Windows Authenticode（PFX/signtool）+ SmartScreen 信誉；更新器签名密钥（TAURI_SIGNING_PRIVATE_KEY）。
  3. DMG 在本机沙箱内无法本地验证（`hdiutil` 权限），需 CI 或普通终端。
- **本地（非沙箱终端）**：`pnpm --dir apps/desktop exec tauri build --bundles app,dmg`（macOS）；exe 需 Windows 机器或 CI（NSIS）。

---

## 9. 里程碑与后续工作

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 可行性 | 边车握手、围栏矩阵、Tauri 构建、webview 直载验证、P0 报告 | ✅ 完成（报告：`/Users/macos/Desktop/DSH-app/spike/P0-REPORT.md`） |
| P1 MVP | desktop profile、边车生命周期、单实例、托盘、桥接、CI 骨架 | ✅ 完成（本文档） |
| P2 原生集成 | 通知消费者（`agent/turn-stopping` → OS 通知）、原生目录选择器桥、OS 钥匙串（`dsh-credentials-keychain`）、深链、自动更新、设置页 | ⬜ 待做 |
| P3 加固发布 | 运行时自包含、签名/公证/SmartScreen、崩溃与遥测（opt-in）、正式安装包 | ⬜ 待做 |
| P4 后续 | 多 profile/多窗口、全局快捷键、MAS 评估、Linux | ⬜ 待做 |

---

## 10. 关键事实清单（交接用）

- 仓库：`/Users/macos/Desktop/DSH-app/deepseek-harness`，分支 `feature/desktop-client`（基于 master `47f9438`）。
- 提交：
  - `611329d` feat(desktop): Tauri 桌面外壳 + desktop profile + 桥接（apps/desktop、packages/desktop/*、bundle/desktop、profile.ts、args.ts、CI、Agent Note、双语 README）
  - `42b377f` fix(client-web): AbortSignal.timeout/any 垫片（abort-signal-polyfill.ts + boot.tsx + 8 测试）
- 环境：macOS 12.7.6（Monterey）、Node v22.22.0（nvm）、Rust 1.97.1（工作区 `.rustup`/`.cargo`）、pnpm 11.7.0（工作区 `.npm-global`）、Tauri 2.11.x / tauri-cli 2.11.4、@deepseek-ai/dsh 0.1.0-rc.6（npm）与仓库 master 源码并存。
- 模型与会话：方案与实现全程 DeepSeek-V4-Pro Max；多轮（20+ 轮）协作，含方案评审驳回重交、编译/门禁逐轮纠错、两个环境兼容性问题的"复现→埋点→定位"排查。
- 调试残留物（会话产物，非仓库内容）：`/Users/macos/Desktop/DSH-app/spike/`（P0 报告、围栏矩阵、驱动/监听脚本）；已随回退移除：webview 控制台转发器、`tauri.conf.json` 显式窗口化、highlight `target` 修复（如需可恢复）。

---

## 附：实现过程与成本记录（对照用）

- **提示词**：中文、两段式（"先出方案，不要写代码" → 驳回后 "按照计划推进"），阶段式指令驱动。
- **模型**：DeepSeek-V4-Pro Max，全程单一上下文（无子代理/工作流），plan mode 承载方案评审。
- **token 成本（估算，会话内无法精确统计）**：方案调研约 1–3 万；实现（编码+全量构建+门禁迭代）约 15–40 万；兼容性排查约 5–15 万；合计数十万量级。主要消耗：仓库源码阅读、全量构建与门禁（覆盖率/双语/Agent Note/allowlist 合规成本高）。
- **是否需要多轮对话**：是。方案评审、编译/门禁纠错、用户环境兼容性排查均依赖多轮上下文；单轮仅适合一次性成型的小任务。
