[English](README.md) | 简体中文 | [更新日志](CHANGELOG.zh-CN.md)

# Antigravity Account Switcher（Antigravity 多账号切换插件）

[![CI](https://github.com/moon16u/antigravity-account-switcher/actions/workflows/ci.yml/badge.svg)](https://github.com/moon16u/antigravity-account-switcher/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node.js >= 18](https://img.shields.io/badge/Node.js-%3E%3D%2018-339933)
![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-brightgreen)

适用于 **Google Antigravity 2.0** 的跨平台原生侧栏（`SIDECAR_UI_ENTRYPOINT_AUX_PANE`）多账号管理与切换插件，采用低风险、本地优先架构：官方原生 Google 登录、AES-256-GCM 静态加密存储、本地配额快照与重置时间投影，以及安全切号重启。基于 **Node.js >= 18** 开发，**零外部 npm 依赖**，插件**不发起任何远端 API 请求、不做二进制提取、也不进行空闲轮询**。

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

- **当前账号状态识别与脱敏展示**：在 **macOS**（Keychain `gemini`/`antigravity`）与 **桌面 Linux**（存在 `DBUS_SESSION_BUS_ADDRESS` 时通过 `secret-tool`）自动读取系统凭据库，在 **WSL2** 与无桌面凭据库环境读取 `~/.gemini/jetski-standalone-oauth-token`；在 **Windows 原生**下零 PowerShell 子进程（避免触发安全软件拦截），结合 `LanguageServerService/GetUserStatus` RPC 与加密凭据库直接展示当前已登录账号状态，并通过「**+ 添加账号**」走官方原生 Google 登录纳入切换列表。邮箱默认脱敏显示（支持顶部一键切换完整邮箱显示）。
- **官方原生登录添加账号（`+ 添加账号`）**——唯一且主要的添加账号流程：
  - 点击「**+ 添加账号**」后，插件会将当前活跃凭证备份到加密凭据库与 `last-token.enc.json`，清除当前 token，并以未登录状态重启 Antigravity。
  - 在 Antigravity 官方窗口内完成 Google 登录，回到面板后点击「**保存当前账号**」，即可将新的登录态加密入库。
  - 全程不启动浏览器 OAuth/PKCE 回调、不监听本地 OAuth 端口、不在运行时提取二进制 OAuth 客户端配置、不内置客户端密钥、不进行远端令牌交换；插件不会索取密码、验证码或令牌文件。
- **本地优先配额快照与分账号「查看用量」**：
  - **仅当前活跃账号**通过回环地址调用本地 `language_server` RPC（`RetrieveUserQuotaSummary`）；标准化后的配额快照按账号 UUID 缓存到 `quota-snapshots.json`。每次切号前都会在替换 token 之前尽力强制采集当前账号的最终快照。
  - **非活跃账号**直接渲染本地快照。若某个配额桶的 `resetTime` 已过，则按 100% 投影并标注「**预计已重置** / **预计 100%**」；快照超过 **24 小时**会显示「**快照已超过 24 小时 · 切入后自动校准**」；尚无快照的账号显示本地采集提示。以上过程不发起任何远端请求。
  - 每个已保存账号卡片提供可展开的「**查看用量**（View usage）」面板，渲染与 Antigravity 原生一致的分组配额与环形进度条；订阅等级标签来自本地 `language_server` 状态与已有快照。
  - 智能缓存与节流：首次展开或关闭重开侧栏后首次展开优先命中 `30 秒` 后端缓存；同一会话内折叠后再次展开，若距上次成功刷新超过 `10 秒` 会自动刷新（`10 秒` 内复用已加载结果）；卡片保持展开期间不自动轮询，交由顶部总刷新或卡片内刷新按钮手动刷新。
- **零远端 API 调用、零二进制提取、零空闲轮询**：
  - 插件**不直接调用任何 Google 远端 API**：不进行远端等级查询、不请求远端配额摘要、不构造 hub 版本 User-Agent、不维护 Cloud Code 主机白名单，也不使用 CONNECT 隧道代理传输层。
  - **不在运行时提取二进制 OAuth 客户端**，也**不自托管浏览器 PKCE OAuth 流程**；相关提取器、OAuth 管理器、远端调用模块、API 路由与等级同步端点均已在 0.4.0 移除。
  - **没有 `setInterval` 后台配额轮询**。配额刷新由对话生命周期事件、账号保存、手动刷新用量与切号前采集驱动。唯一的 HTTP 客户端路径是本地 `language_server` RPC，且仅允许回环主机（`localhost`、`127.0.0.1`、`::1`）并携带宿主注入的 CSRF token。
- **AES-256-GCM 静态加密凭据库**：
  - 使用随机生成的本机 256 位主密钥（`vault.key`）加密保存账号库（`vault.enc.json`）、切号/原生重新登录前自动备份的活跃凭证（`last-token.enc.json`）与单次切号任务（`jobs/job-<uuid>.enc.json`）。
  - 在 Unix 系统（WSL2 / macOS / Linux）下强制以 `0700` 数据目录权限与 `0600` 文件权限原子写入。
- **Keep In Menu Bar 自适应快速重启**：
  - 通过脱离进程树的独立执行器（`switcher-worker.mjs`；原生 Windows 下采用纯 Node.js 双派生 `--detach-worker` 跳板切断父进程链，Linux/WSL2 下优先通过 `systemd-run --user --scope` 托管，全程零隐藏 PowerShell）执行闭环切号。
  - 在 **Windows / WSL2** 下，读取 `app_storage.json` 中的 `runInBackground`（即 *Keep In Menu Bar* 设置）并通过 `tasklist /V /FO CSV` 识别可见主窗口 `Antigravity.exe` PID，先温和关闭可见窗口再清理托盘残留进程（原生 Windows 不传 `/T`），并在 WSL2 中提前向 `language_server` 发送 `SIGTERM` 落盘退出；原生 Windows 下通过系统内置 `cmdkey.exe` 清除旧的 `gemini:antigravity` 凭据后写入 `~/.gemini/jetski-standalone-oauth-token`（供 `language_server.exe` 启动时自动迁回凭据管理器），再优先通过 `%APPDATA%\Antigravity\launch-env-proxy.vbs`（可选代理启动脚本，存在时使用）、`Antigravity.exe` 或 `ANTIGRAVITY_SWITCHER_RELAUNCH_EXE` 重开应用。
  - 在 **macOS** 下，先通过 `/usr/bin/osascript` 请求优雅退出（超时后回退 `SIGTERM`），完成后通过 `/usr/bin/open -a` 重启应用。在 **Linux** 下，向桌面端与 `language_server` 发送 `SIGTERM` 并重启捕获到的可执行文件。
  - 重启前加入**自然停顿**（随机 `3–8 秒`，`naturalPauseEnabled` 默认开启），避免机械式的瞬时重启。
- **切号前活跃任务护栏与内置双语界面（`中 / EN`）**：
  - 切号前探测 `language_server` RPC（`GetAllCascadeTrajectories`、`ListBackgroundTasks`、`ListTerminals`）并扫描用户子进程（自动排除 Sidecar 与常驻 MCP 服务等基础设施进程）；若检测到活跃任务，默认返回 `HTTP 409` 并提供「重新检查并切换」「取消」及记入审计日志（`FORCE_SWITCH_REQUESTED`）的「仍要强制切换」。
  - 面板右上角支持一键 **`中 / EN`** 实时切换界面语言。
- **Agent MCP 工具与事件驱动低额度守护**：
  - 内置零依赖 stdio MCP 服务（`mcp_config.json` → `scripts/mcp-server.mjs`，服务版本 `0.4.0`），提供 `get_switcher_status`、`list_accounts`、`get_quota` 与 `switch_account` 工具，并附带 `/switch-account` 技能（`skills/switch-account/SKILL.md`）。`get_quota` 对活跃账号读取本地 `language_server` 实时配额，对非活跃账号读取本地快照并做重置投影；`switch_account`（`pickBest: true`）基于本地快照选择，并附「最近最少使用且无快照」的备用号回退，同时在切号前采集快照。
  - 配额检查由对话生命周期驱动：**`PostInvocation`** Hook（`hooks.json` → `scripts/quota-hook.mjs`）写入节流的本地触发文件（`quota-refresh-trigger.json`），Sidecar 通过 `fs.watch` 监听并合并事件，随后仅查询当前活跃账号的本地 `language_server` RPC，写入脱敏的 `quota-alert.json`。整个过程没有空闲心跳轮询，Hook 会立即返回且不执行网络或 RPC 调用（Windows 下若 `PATH` 缺少 `node`，自动回退到 Antigravity 内置的 `%APPDATA%\Antigravity\bin\agy-node.cmd`）。
  - **`PreInvocation`** Hook 以毫秒级读取本地快照、零常驻内存，并注入按会话去重的分级 `systemMessage`：**`soft`** 表示额度进入软阈值后的收尾提醒，**`hard`** 表示触及硬下限后的切号提示。去重按会话与级别分别记录，因此同一会话可从 `soft` 升级为 `hard` 再提醒一次，而同级重复提醒保持静默。
  - 在「高级工具 → **高级设置**」中可按需切换周/5h 池监控、**动态阈值区间**（`dynamicThresholdEnabled` 默认开启：按会话随机浮动的软收尾与切号阈值）、**切号自然停顿**（`naturalPauseEnabled` 默认开启）、**Agent 自动切号**（仅在无其他并发会话或任务时生效）、**切号后自动续跑**，以及面板底部的**触发阈值**（`10%–50%`）。
  - **高级设置**面板采用精简的设置标题，信息与风险说明仅在悬停 `ⓘ` 图标时展示；布尔选项统一为右对齐的即时「**关闭 / 开启**」左右分段切换控件，与「已保存账号」卡片的操作控件保持一致。
  - **高级设置**面板还提供可选开关 **`skipOnboardingPrompt`**（**默认关闭**）。开启后，`switcher-worker` 仅在设备已有确认记录时更新 `app_storage.json`（`agy.onboarding.lastLoginUsername`），以在后续切号时跳过重复的引导弹窗。
  - 由 Agent 发起且携带 `conversationId` 的切号会（在有限时间内）等待当前回合正常收尾后再关闭桌面端应用；开启自动续跑时会在重启后的新 Hub 与 MCP 工具就绪后发送 `agentapi send-message` 唤醒原会话。

## 功能边界与已知限制

1. **仅支持个人消费者账号**：只支持个人版 Google 账号（`auth_method: "consumer"`），企业版 / Google Workspace SSO 凭据会被拒绝。
2. **切换账号需要重启桌面应用**：Antigravity 的登录态常驻于运行中的 `language_server` 进程内，切号必须先退出桌面端、等待 `language_server` 落盘退出后再替换凭据并重新打开窗口。切号前请先结束或确认运行中的对话/终端任务。
3. **跨平台实测范围与 Windows 凭据读取策略**：
   - **Windows 原生**与 **WSL2 + Windows 宿主**已完成真机端到端实测。为避免触发杀毒软件拦截，Windows 原生端刻意不调用 PowerShell 读取凭据管理器，因此请通过「**+ 添加账号**」走官方原生 Google 登录来纳入或新增账号。
   - **Linux 桌面**与 **macOS** 已在 GitHub Actions CI（`ubuntu-latest`、`macos-latest`）通过全套单元测试与集成测试，其中 **macOS** 真实桌面环境的实际切号重启流程暂未在物理 Mac 上手动验证，欢迎 macOS 用户反馈或提 PR。
4. **仅支持官方原生登录，不提供浏览器 OAuth 兜底**：添加账号依赖 Antigravity / Google 官方登录流程。0.4.0 不提供浏览器 OAuth 兜底、不启动 PKCE 回环监听、也不做运行时二进制提取；若你的环境无法完成 Google 登录，插件无法添加该账号。`ANTIGRAVITY_AGENTAPI_EXE` 仅用于覆盖本地 RPC / 重启相关可执行文件路径，与 OAuth 客户端提取无关。
5. **插件/标签页外层标题为静态英文**：Antigravity 宿主目前的 `plugin.json` 与 `sidecar.json` 清单仅支持静态字符串（不支持随系统语言动态切换清单标题），因此插件管理页与右侧标签页统一显示为 **`Account Switcher`**，面板内部文案可自由切换 **`中 / EN`**。
6. **非活跃账号的用量是本地估算**：非活跃账号展示最后一次本地快照及重置时间投影，并非实时用量。已过 `resetTime` 的配额桶会乐观投影为 100%，超过 24 小时的快照会被标记为陈旧。只有切换到该账号并查询本地 `language_server` 后才会真正校准；插件有意不提供远端配额接口或后台同步。
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
| `ANTIGRAVITY_SWITCHER_RELAUNCH_EXE` | 自定义切号后重启 Antigravity 的可执行文件路径（Windows/WSL2 下亦支持 `.vbs` 启动脚本）。 |
| `ANTIGRAVITY_AGENTAPI_EXE` | 覆盖用于本地 RPC、自动续跑与 macOS `.app` 定位的 `language_server` / `agentapi` 可执行文件路径；0.4.0 中与 OAuth 客户端提取无关。 |
| `ANTIGRAVITY_APP_STORAGE_PATH` | 覆盖 `app_storage.json` 的探测路径（用于读取 `runInBackground` 及可选的引导状态同步）。 |
| `ANTIGRAVITY_WIN_APPDATA` / `ANTIGRAVITY_WIN_LOCALAPPDATA` | 在非标准 WSL2 环境下覆盖 Windows `%APPDATA%` / `%LOCALAPPDATA%` 路径解析。 |
| `ANTIGRAVITY_GEMINI_DIR` / `ANTIGRAVITY_EXECUTABLE_DATA_DIR` | 覆盖 `~/.gemini` 与 Sidecar 运行时加密数据目录。 |

## 运行时数据目录

运行时数据与插件源码完全隔离。在 Antigravity 2.0 中默认由 `ANTIGRAVITY_EXECUTABLE_DATA_DIR` 指向 `~/.gemini/antigravity/sidecar_data/antigravity-account-switcher/switcher/data/`（Windows 下为 `%USERPROFILE%\.gemini\antigravity\sidecar_data\antigravity-account-switcher\switcher\data\`；独立运行时默认回退至 `~/.gemini/antigravity/plugin_data/antigravity-account-switcher/`）：

- `vault.key` — 随机生成的 256 位 AES 主密钥（Unix 下 `0600`）
- `vault.enc.json` — AES-256-GCM 加密的已保存账号库（Unix 下 `0600`）
- `last-token.enc.json` — 切号 / 原生重新登录前自动备份的活跃凭证密文（Unix 下 `0600`）
- `jobs/job-<uuid>.enc.json` — 单次加密切号任务（由 `switcher-worker.mjs` 读取后立即删除）
- `switch.log` — 脱敏的切号、错误码与强制切换审计日志（不含任何明文邮箱或令牌）
- `settings.json` — 低额度守护阈值、动态阈值、自然停顿、引导状态同步、自动切号与自动唤醒续跑配置（Unix 下 `0600`）
- `quota-snapshots.json` — 本地分账号配额快照缓存，用于重置投影与非活跃账号展示（Unix 下 `0600`）
- `quota-alert.json` — 脱敏的当前账号低额度状态快照与推荐满血备用号
- `quota-refresh-trigger.json` — 由 `PostInvocation` 写入、Sidecar 通过 `fs.watch` 监听的节流触发文件
- `hook-alert-state.json` — `PreInvocation` Hook 按会话与级别去重的状态记录

## 安全架构

- **令牌门禁与速率限制**：所有 API 均校验宿主注入的 `ANTIGRAVITY_SIDECAR_UI_TOKEN`（缺失时返回 `403`），并启用滑动窗口限流（读接口 `60 次/分`，写接口 `10 次/分`，用量查询接口 `30 次/分`）与 `15 秒` 切号互斥锁。
- **严格响应头与无注入前端**：HTTP 响应附带 `Content-Security-Policy`（`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'`）、`X-Content-Type-Options: nosniff`、`Cache-Control: no-store`、`Referrer-Policy: no-referrer` 与 `Permissions-Policy`。前端全部使用 `textContent` 与标准 DOM API 构建，无 `innerHTML`、`eval` 或内联脚本/样式。
- **加密完整性校验（Fail-Closed）**：每条密文均采用 AES-256-GCM 配合 12 字节随机 IV 与 16 字节认证标签，任何篡改都会直接拒绝解密。
- **文件系统与进程安全**：对敏感文件及目录执行 `lstatSync` 符号链接拦截与 `assertInsideDir` 边界校验，采用临时文件 + `renameSync` 原子落盘，严格校验 UUID 与过滤原型链污染键（`__proto__`、`constructor`、`prototype`）；子进程调用一律使用 `execFileSync` / `spawn` 参数数组（禁用 `shell: true`），子进程检测仅记录可执行文件名与 PID 以避免命令行参数泄露。
- **仅本地网络与最小 OAuth 面**：插件不向 Google API 发起任何出站 HTTPS 连接，不执行 OAuth 令牌交换，也不托管 OAuth 回调监听。唯一的 HTTP 客户端路径是本地 `language_server` RPC，且仅允许回环主机并携带宿主 CSRF token。Hook 不执行网络或 RPC 调用：`PostInvocation` 仅写入节流触发文件，`PreInvocation` 仅读取脱敏本地快照并更新本地去重状态。凭据提取、浏览器 PKCE、远端等级同步与远端配额调用均已在设计上移除。

## 仓库结构

- `plugin.json` — 插件清单（`antigravity-account-switcher`，显示名 `Account Switcher`）
- `mcp_config.json` — 内置 stdio MCP 服务配置（`switcher`）
- `hooks.json` — 内置 `PreInvocation` 与 `PostInvocation` 低额度守护 Hook 配置（`quota-guard`）
- `scripts/mcp-server.mjs` — 零依赖 MCP 服务（`0.4.0`），暴露脱敏状态、本地快照配额查询与安全切号工具
- `scripts/quota-hook.mjs` — 轻量事件驱动 Hook：分级 `PreInvocation` 提醒与节流 `PostInvocation` 触发
- `skills/switch-account/SKILL.md` — 面向 Agent 的 `/switch-account` 技能指南
- `assets/logo.svg` — 插件图标
- `sidecars/switcher/sidecar.json` — Sidecar 入口定义（`command: "node"`、`args: ["main.mjs"]`、`SIDECAR_UI_ENTRYPOINT_AUX_PANE`）
- `sidecars/switcher/main.mjs` — Sidecar HTTP 服务、API 路由、基于 `fs.watch` 的本地配额刷新、安全门禁与限流
- `sidecars/switcher/quota-guard.mjs` — 配额阈值（软/硬）评估、最优备用号挑选、守护配置、动态阈值、自然停顿与活跃 Hub 自动发现
- `sidecars/switcher/quota-snapshots.mjs` — 本地配额快照缓存、活跃账号 `language_server` 查询、重置时间投影与超过 24 小时的陈旧检测
- `sidecars/switcher/platform.mjs` — 跨平台运行时检测、路径转换、`language_server` / `agentapi` 发现、引导状态同步与桌面端重启
- `sidecars/switcher/vault.mjs` — AES-256-GCM 凭据库、原子写入、符号链接/路径边界防护与凭证标准化
- `sidecars/switcher/token-store.mjs` — 跨平台凭据读写层（macOS Keychain / Linux Secret Service、Windows `cmdkey.exe` + 文件交接与 WSL2 文件存储）
- `sidecars/switcher/active-work.mjs` — 切号前回环 RPC 与用户子进程活跃探测器
- `sidecars/switcher/switcher-worker.mjs` — 脱离进程树的独立切号、原生重新登录与重启执行器
- `sidecars/switcher/public/` — 侧栏 Web UI（`index.html`、`app.js`、`styles.css`）
- `sidecars/switcher/test/` — 全隔离单元测试与集成测试套件（`switcher.test.mjs`、`mcp-and-hook.test.mjs`）
- `CHANGELOG.md` / `CHANGELOG.zh-CN.md` — 中英文双语版本更新日志

## 验证与测试

在 Node.js >= 18 下运行测试套件：

```bash
node --test sidecars/switcher/test/switcher.test.mjs sidecars/switcher/test/mcp-and-hook.test.mjs
```

对所有 `.mjs` 模块与前端脚本执行语法检查：

```bash
for f in scripts/*.mjs sidecars/switcher/*.mjs sidecars/switcher/test/*.mjs sidecars/switcher/public/app.js; do node --check "$f"; done
```

## 开源许可

[MIT](LICENSE)
