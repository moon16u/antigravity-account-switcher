[English](README.md) | 简体中文

# Antigravity Account Switcher（Antigravity 多账号切换插件）

[![CI](https://github.com/moon16u/antigravity-account-switcher/actions/workflows/ci.yml/badge.svg)](https://github.com/moon16u/antigravity-account-switcher/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node.js >= 18](https://img.shields.io/badge/Node.js-%3E%3D%2018-339933)
![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-brightgreen)

适用于 **Google Antigravity 2.0** 的跨平台原生侧栏（`SIDECAR_UI_ENTRYPOINT_AUX_PANE`）多账号管理与切换插件：支持免退出浏览器 OAuth 添加账号、AES-256-GCM 静态加密存储、不切号同步订阅等级与分账号用量查看，以及安全切号重启。基于 **Node.js >= 18** 开发，**零外部 npm 依赖**。

<p align="center">
  <img src="assets/demo.gif" alt="Antigravity Account Switcher 演示动图" width="560" />
</p>

## 支持平台

| 平台 | 运行时标识 | 宿主桌面端与 Language Server | 验证情况 |
| --- | --- | --- | --- |
| **Windows 原生** | `win32` | Windows Electron 桌面端 + `language_server.exe`（PE64 x64 / ARM64） | 已真机实测 + CI 验证（`windows-latest`） |
| **WSL2 + Windows 宿主** | `wsl` | WSL2 Linux `language_server`（ELF64 x64 / ARM64）+ 通过 `/mnt/c/Windows/System32` 协同的 Windows Electron 宿主 | 已 WSL2 + Windows 宿主双端实测 |
| **Linux 桌面** | `linux` | 原生 Linux Antigravity 桌面端 + `language_server`（ELF64 x64 / ARM64） | 已通过 CI 验证（`ubuntu-latest`） |
| **macOS** | `darwin` | `Antigravity.app`（支持 Intel x64、Apple Silicon ARM64 与 Universal Fat Mach-O） | 已通过 CI 验证（`macos-latest`）；欢迎真机反馈 |

## 功能特性

- **当前账号状态识别与脱敏展示**：在 **macOS**（Keychain `gemini`/`antigravity`）与 **桌面 Linux**（存在 `DBUS_SESSION_BUS_ADDRESS` 时通过 `secret-tool`）自动读取系统凭据库，在 **WSL2** 与无桌面凭据库环境读取 `~/.gemini/jetski-standalone-oauth-token`；在 **Windows 原生**下零 PowerShell 子进程（避免触发安全软件拦截），结合 `LanguageServerService/GetUserStatus` RPC 与加密切换库直接展示当前已登录账号状态，并通过「**+ 添加账号**」免退出纳入切换列表。邮箱默认脱敏显示（支持顶部一键切换完整邮箱显示）。
- **免退出浏览器直接添加账号（`+ 添加账号`）**：
  - 运行时从本机 Antigravity `language_server` / `language_server.exe` 二进制文件中动态提取官方 OAuth 客户端配置（支持 **ELF64**、**PE64** 及单架构/通用 **Mach-O 64-bit**，仓库内零硬编码密钥）。
  - 使用 `127.0.0.1:0` 回环监听 + **PKCE S256** + 恒定时间比较（`timingSafeEqual`）的单次 `state` 校验（有效期 5 分钟）。
  - 唤起系统浏览器并展示可复制授权链接，可粘贴至无痕窗口或其他浏览器配置文件中登录新账号，无需退出当前 Antigravity 会话。
  - 在「高级工具」中保留「**原生登录（备用）**」：当浏览器直接授权受阻时，自动备份当前账号并退出桌面应用，以未登录状态重开窗口进行原生登录。
- **不切号同步订阅等级与分账号用量（`查看用量`）**：
  - 支持在浏览器 OAuth 添加、后台补全缺失等级及点击顶部刷新时，通过 `v1internal:loadCodeAssist` 自动同步各账号的订阅等级（如 `Google AI Pro` / `Google AI Ultra` / `Free`），不切换当前登录态也不改动「上次使用」时间。
  - 每个已保存账号卡片底部提供可展开的「**查看用量**（View usage）」面板，渲染与 Antigravity 原生一致的分组配额与环形进度条（当前活跃账号优先直连本地 `language_server` `RetrieveUserQuotaSummary`，非活跃账号通过加密凭据请求 `v1internal:retrieveUserQuotaSummary`，发送 `antigravity/hub/<ver>` User-Agent 保留 Argon/Carbon 等进阶模型分组）。
  - 智能缓存与节流：首次展开或关闭重开侧栏后首次展开优先命中 `30 秒` 后端缓存（超时则拉最新）；同一会话内折叠后再次展开若距上次成功刷新超过 `10 秒` 会自动强制刷新（`10 秒` 内复用已加载结果）；卡片保持展开期间不自动轮询，交由顶部总刷新或卡片内刷新按钮手动刷新。
- **自动 HTTP 代理支持**：
  - 自动读取标准环境变量 `HTTPS_PROXY` / `https_proxy`、`HTTP_PROXY` / `http_proxy` 与 `NO_PROXY` / `no_proxy`。
  - **Node.js >= 24.5 或 >= 22.21**：直接使用 Node 原生 `https.Agent({ proxyEnv })`，无需在 `sidecar.json` 中写死 `--use-env-proxy`，保证 Node 18/20/22/24 启动方式统一。
  - **Node.js 18 / 20 / 早期 22**：自动回退至内置 `ProxyConnectAgent`，通过 `http://` 代理建立 `CONNECT` 隧道（支持代理 URL 中的 Basic `Proxy-Authorization` 凭据及 `NO_PROXY` 域名后缀/通配匹配），并在隧道上升级为开启严格证书校验的 TLS >= 1.2 连接。
- **AES-256-GCM 静态加密凭据库**：
  - 使用随机生成的本机 256 位主密钥（`vault.key`）加密保存账号库（`vault.enc.json`）、切号前自动备份的活跃凭证（`last-token.enc.json`）与单次切号任务（`jobs/job-<uuid>.enc.json`）。
  - 在 Unix 系统（WSL2 / macOS / Linux）下强制以 `0700` 数据目录权限与 `0600` 文件权限原子写入。
- **Keep In Menu Bar 自适应快速重启**：
  - 通过脱离进程树的独立执行器（`switcher-worker.mjs`；原生 Windows 下采用纯 Node.js 双派生 `--detach-worker` 跳板切断父进程链，Linux/WSL2 下优先通过 `systemd-run --user --scope` 托管，全程零隐藏 PowerShell）执行闭环切号。
  - 在 **Windows / WSL2** 下，读取 `app_storage.json` 中的 `runInBackground`（即 *Keep In Menu Bar* 设置）并通过 `tasklist /V /FO CSV` 识别可见主窗口 `Antigravity.exe` PID，先温和关闭可见窗口再清理托盘残留进程（原生 Windows 不传 `/T`），并在 WSL2 中提前向 `language_server` 发送 `SIGTERM` 落盘退出；原生 Windows 下通过系统内置 `cmdkey.exe` 清除旧的 `gemini:antigravity` 凭据后写入 `~/.gemini/jetski-standalone-oauth-token`（供 `language_server.exe` 启动时自动迁回凭据管理器），再优先通过 `%APPDATA%\Antigravity\launch-env-proxy.vbs`（可选代理启动脚本，存在时使用）、`Antigravity.exe` 或 `ANTIGRAVITY_SWITCHER_RELAUNCH_EXE` 重开应用。
  - 在 **macOS** 下，先通过 `/usr/bin/osascript` 请求优雅退出（超时后回退 `SIGTERM`），完成后通过 `/usr/bin/open -a` 重启应用。
  - 在 **Linux** 下，向桌面端与 `language_server` 发送 `SIGTERM` 并重启捕获到的可执行文件。
- **切号前活跃任务护栏与内置双语界面（`中 / EN`）**：
  - 切号前探测 `language_server` RPC（`GetAllCascadeTrajectories`、`ListBackgroundTasks`、`ListTerminals`）并扫描用户子进程（自动排除 Sidecar 与常驻 MCP 服务等基础设施进程）；若检测到活跃任务，默认返回 `HTTP 409` 并提供「重新检查并切换」「取消」及记入审计日志（`FORCE_SWITCH_REQUESTED`）的「仍要强制切换」。
  - 面板右上角支持一键 **`中 / EN`** 实时切换界面语言。
- **Agent MCP 自助切号、低额度实时 Hook 预警与可选自动续跑**：
  - 内置零依赖 stdio MCP 服务（`mcp_config.json` -> `scripts/mcp-server.mjs`），提供 `get_switcher_status`、`list_accounts`、`get_quota` 与 `switch_account` 工具，并附带 `/switch-account` 技能（`skills/switch-account/SKILL.md`）。
  - Sidecar 在后台低频检测当前账号 Gemini **周额度** 与 **5 小时额度**（每 `60 秒`）并落盘脱敏快照（`quota-alert.json`）；极轻 `PreInvocation` Hook（`hooks.json` -> `scripts/quota-hook.mjs`，在 Windows 下若 `PATH` 缺少 `node` 会自动回退到 Antigravity 内置的 `%APPDATA%\Antigravity\bin\agy-node.cmd`）仅毫秒级读取本地快照，正常时零注入、零常驻内存，任一额度跌破阈值（默认 `10%`）时按会话去重实时将预警送入正在执行的 Agent Loop。
  - 在「高级工具 → **Agent 自动切号与低额度提醒**」中可调整阈值（`1%–50%`）、勾选监控周/5h 池，并按需开启「**允许 Agent 低额度自动切号**」（仅在无其他并发会话/任务时生效）与「**切号重启后自动唤醒当前会话续跑**」；切号时会智能等待当前回合正常收尾后再停壳，重拉时同步 `app_storage.json` 跳过重复的 `One last thing` 弹窗，开启自动续跑时会在新 Hub 与 MCP 工具就绪后发送 `agentapi send-message` 唤醒原会话。

## 功能边界与已知限制

1. **仅支持个人消费者账号**：只支持个人版 Google 账号（`auth_method: "consumer"`），企业版 / Google Workspace SSO 凭据会被拒绝。
2. **切换账号需要重启桌面应用**：Antigravity 的登录态常驻于运行中的 `language_server` 进程内，切号必须先退出桌面端、等待 `language_server` 落盘退出后再替换凭据并重新打开窗口。切号前请先结束或确认运行中的对话/终端任务。
3. **跨平台实测范围与 Windows 凭据读取策略**：
   - **Windows 原生**与 **WSL2 + Windows 宿主**已完成真机端到端实测。为避免触发杀毒软件拦截，Windows 原生端刻意不调用 PowerShell 读取凭据管理器，因此若你已在 Windows 桌面登录了现有账号，首次使用请通过右上角「**+ 添加账号**」完成授权入库。
   - **Linux 桌面**与 **macOS** 已在 GitHub Actions CI（`ubuntu-latest`、`macos-latest`）通过全套单元测试与集成测试，其中 **macOS** 真实桌面环境的实际切号重启流程暂未在物理 Mac 上手动验证，欢迎 macOS 用户反馈或提 PR。
4. **依赖本地二进制提取客户端配置**：仓库内不包含任何 OAuth 密钥，运行时动态从本机 `language_server` 读取官方客户端配置。若未来 Antigravity 升级调整了二进制结构或安装路径，可通过环境变量 `ANTIGRAVITY_AGENTAPI_EXE` 指定路径，或使用「**原生登录（备用）**」兜底。
5. **插件/标签页外层标题为静态英文**：Antigravity 宿主目前的 `plugin.json` 与 `sidecar.json` 清单仅支持静态字符串（不支持随系统语言动态切换清单标题），因此插件管理页与右侧标签页统一显示为 **`Account Switcher`**，面板内部文案可自由切换 **`中 / EN`**。
6. **订阅等级与用量查询可用性**：依赖本地 `language_server` 与 Google Cloud Code 接口（`v1internal:loadCodeAssist`、`v1internal:retrieveUserQuotaSummary`，限流 `30 次/分`）。若遇上游接口变更或网络/代理受阻，等级同步和用量展示可能失败，但不会影响本地账号库管理与正常切号。
7. **独立开源插件**：本项目为独立社区插件，与 Google 无隶属关系；所有账号凭据仅以加密形式保存在你本地设备中。

## 运行环境要求

- **Node.js >= 18**（且 `node` 必须位于 Antigravity `language_server` 可见的 `PATH` 中）。
- **零外部依赖**：无需执行 `npm install`。

> **Unix（WSL2 / macOS / Linux）`PATH` 重要提示：**  
> Antigravity 的 `language_server` 通常由桌面端或非交互环境启动，可能不会加载 `~/.bashrc`、`~/.zshrc` 或 `nvm` 初始化脚本。请确保将 `node` 安装或软链到系统标准 `PATH` 目录（例如 Unix 下的 `/usr/local/bin/node`，或 macOS GUI 可继承的 `/opt/homebrew/bin/node`）。在 Windows 下请确保 `node.exe` 已加入用户或系统 `PATH`。

## 安装与启用

### 方式一：直接克隆到全局插件目录（推荐）

- **Unix（WSL2 / macOS / Linux）**：

  ```bash
  git clone https://github.com/moon16u/antigravity-account-switcher.git ~/.gemini/config/plugins/antigravity-account-switcher
  ```

- **Windows（PowerShell）**：

  ```powershell
  git clone https://github.com/moon16u/antigravity-account-switcher.git "$env:USERPROFILE\.gemini\config\plugins\antigravity-account-switcher"
  ```

### 方式二：克隆到自定义目录并通过 `plugins.json` 注册

1. 克隆仓库到本地任意目录（例如 `/path/to/antigravity-plugins/antigravity-account-switcher`）。
2. 在 `plugins.json` 中填入仓库的**上级目录**，并在 `include_only` 中指定 `"antigravity-account-switcher"`（若文件已存在，请合并到现有数组中）：

   - **Unix（WSL2 / macOS / Linux）** — `~/.gemini/config/plugins.json`：

     ```json
     {
       "entries": [
         {
           "path": "/path/to/antigravity-plugins",
           "include_only": [
             "antigravity-account-switcher"
           ]
         }
       ]
     }
     ```

   - **Windows** — `%USERPROFILE%\.gemini\config\plugins.json`：

     ```json
     {
       "entries": [
         {
           "path": "C:\\path\\to\\antigravity-plugins",
           "include_only": [
             "antigravity-account-switcher"
           ]
         }
       ]
     }
     ```

3. **重启 Antigravity**（或重新加载插件），在右侧辅助面板打开「**Account Switcher**」标签页即可使用。

## 可选环境变量

| 环境变量 | 说明 |
| --- | --- |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | 控制 Google OAuth 令牌换取与 Cloud Code 接口请求的 HTTP 代理及绕过规则（同时支持小写变量）。 |
| `ANTIGRAVITY_SWITCHER_RELAUNCH_EXE` | 自定义切号后重启 Antigravity 的可执行文件路径（Windows/WSL2 下亦支持 `.vbs` 启动脚本）。 |
| `ANTIGRAVITY_AGENTAPI_EXE` | 显式指定用于提取 OAuth 客户端配置的 `language_server` 路径（macOS 下亦用于定位 `.app` 目录）。 |
| `ANTIGRAVITY_APP_STORAGE_PATH` | 覆盖 `app_storage.json` 的探测路径（用于读取 `runInBackground`）。 |
| `ANTIGRAVITY_WIN_APPDATA` / `ANTIGRAVITY_WIN_LOCALAPPDATA` | 在非标准 WSL2 环境下覆盖 Windows `%APPDATA%` / `%LOCALAPPDATA%` 路径解析。 |
| `ANTIGRAVITY_GEMINI_DIR` / `ANTIGRAVITY_EXECUTABLE_DATA_DIR` | 覆盖 `~/.gemini` 与 Sidecar 运行时加密数据目录。 |

## 运行时数据目录

运行时数据与插件源码完全隔离。在 Antigravity 2.0 中默认由 `ANTIGRAVITY_EXECUTABLE_DATA_DIR` 指向 `~/.gemini/antigravity/sidecar_data/antigravity-account-switcher/switcher/data/`（Windows 下为 `%USERPROFILE%\.gemini\antigravity\sidecar_data\antigravity-account-switcher\switcher\data\`；独立运行时默认回退至 `~/.gemini/antigravity/plugin_data/antigravity-account-switcher/`）：

- `vault.key` — 随机生成的 256 位 AES 主密钥（Unix 下 `0600`）
- `vault.enc.json` — AES-256-GCM 加密的已保存账号库（Unix 下 `0600`）
- `last-token.enc.json` — 切号前自动备份的活跃凭证密文（Unix 下 `0600`）
- `jobs/job-<uuid>.enc.json` — 单次加密切号任务（由 `switcher-worker.mjs` 读取后立即删除）
- `switch.log` — 脱敏的切号、OAuth 错误码与强制切换审计日志（不含任何明文邮箱或令牌）
- `settings.json` — 低额度守护阈值、自动切号与自动唤醒续跑配置（Unix 下 `0600`）
- `quota-alert.json` — 脱敏的当前账号低额度状态快照与推荐满血备用号
- `hook-alert-state.json` — `PreInvocation` Hook 按会话去重状态记录

## 安全架构

- **令牌门禁与速率限制**：所有 API 均校验宿主注入的 `ANTIGRAVITY_SIDECAR_UI_TOKEN`（缺失时返回 `403`），并启用滑动窗口限流（读接口 `60 次/分`，写接口 `10 次/分`，等级与用量查询接口 `30 次/分`）与 `15 秒` 切号互斥锁。
- **严格响应头与无注入前端**：HTTP 响应附带 `Content-Security-Policy`（`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'`）、`X-Content-Type-Options: nosniff`、`Cache-Control: no-store`、`Referrer-Policy: no-referrer` 与 `Permissions-Policy`。前端全部使用 `textContent` 与标准 DOM API 构建，无 `innerHTML`、`eval` 或内联脚本/样式。
- **加密完整性校验（Fail-Closed）**：每条密文均采用 AES-256-GCM 配合 12 字节随机 IV 与 16 字节认证标签，任何篡改都会直接拒绝解密。
- **文件系统与进程安全**：对敏感文件及目录执行 `lstatSync` 符号链接拦截与 `assertInsideDir` 边界校验，采用临时文件 + `renameSync` 原子落盘，严格校验 UUID 与过滤原型链污染键（`__proto__`、`constructor`、`prototype`）；子进程调用一律使用 `execFileSync` / `spawn` 参数数组（禁用 `shell: true`），子进程检测仅记录可执行文件名与 PID 以避免命令行参数泄露。
- **OAuth 与远端接口安全加固**：凭据从本机签名二进制动态提取、强制 PKCE S256 与 `crypto.timingSafeEqual` 单次 `state` 校验、仅监听 `127.0.0.1:0` 并在回调后立即关闭监听、静态回调页启用 `default-src 'none'` CSP、出站 HTTPS 强制 TLS >= 1.2 与证书校验，出站主机严格白名单限制为 `oauth2.googleapis.com`、`www.googleapis.com`、`daily-cloudcode-pa.googleapis.com` 与 `cloudcode-pa.googleapis.com`。

## 仓库结构

- `plugin.json` — 插件清单（`antigravity-account-switcher`，显示名 `Account Switcher`）
- `mcp_config.json` — 内置 stdio MCP 服务配置（`switcher`）
- `hooks.json` — 内置 `PreInvocation` 低额度预警 Hook 配置（`quota-guard`）
- `scripts/mcp-server.mjs` — 零依赖 MCP 服务，暴露脱敏状态、配额查询与安全切号工具
- `scripts/quota-hook.mjs` — 极轻短命 `PreInvocation` Hook，读取本地快照注入去重低额度提醒
- `skills/switch-account/SKILL.md` — 面向 Agent 的 `/switch-account` 技能指南
- `assets/logo.svg` — 插件图标
- `sidecars/switcher/sidecar.json` — Sidecar 入口定义（`command: "node"`、`args: ["main.mjs"]`、`SIDECAR_UI_ENTRYPOINT_AUX_PANE`）
- `sidecars/switcher/main.mjs` — Sidecar HTTP 服务、API 路由、后台配额轮询、安全门禁与限流
- `sidecars/switcher/quota-guard.mjs` — 配额阈值评估、最优备用号挑选、守护配置与活跃 Hub 自动发现
- `sidecars/switcher/platform.mjs` — 跨平台运行时检测、路径转换、二进制发现、浏览器唤起与桌面端重启
- `sidecars/switcher/binary-oauth.mjs` — ELF64 / PE64 / Mach-O 64-bit（含 Universal Fat）OAuth 客户端提取器
- `sidecars/switcher/oauth.mjs` — PKCE S256 回环 OAuth 管理器与双模式代理 HTTPS 客户端
- `sidecars/switcher/cloudcode.mjs` — 订阅等级同步（`loadCodeAssist`）、用量配额查询（`retrieveUserQuotaSummary` / 本地 LS 快速通道）与 OAuth 令牌刷新封装
- `sidecars/switcher/vault.mjs` — AES-256-GCM 凭据库、原子写入、符号链接/路径边界防护与凭证标准化
- `sidecars/switcher/token-store.mjs` — 跨平台凭据读写层（macOS Keychain / Linux Secret Service、Windows `cmdkey.exe` + 文件交接与 WSL2 文件存储）
- `sidecars/switcher/active-work.mjs` — 切号前 RPC 与用户子进程活跃探测器
- `sidecars/switcher/switcher-worker.mjs` — 脱离进程树的独立切号与重启执行器
- `sidecars/switcher/public/` — 侧栏 Web UI（`index.html`、`app.js`、`styles.css`）
- `sidecars/switcher/test/` — 全隔离单元测试与集成测试套件（`switcher.test.mjs`、`mcp-and-hook.test.mjs`）

## 验证与测试

在 Node.js >= 18 下运行测试套件：

```bash
node --test sidecars/switcher/test/switcher.test.mjs sidecars/switcher/test/mcp-and-hook.test.mjs
```

在 Node.js >= 24.5 下同时验证 `--use-env-proxy` 原生代理模式：

```bash
node --use-env-proxy --test sidecars/switcher/test/switcher.test.mjs sidecars/switcher/test/mcp-and-hook.test.mjs
```

对所有 `.mjs` 模块与前端脚本执行语法检查：

```bash
for f in scripts/*.mjs sidecars/switcher/*.mjs sidecars/switcher/test/*.mjs sidecars/switcher/public/app.js; do node --check "$f"; done
```

## 开源许可

[MIT](LICENSE)
