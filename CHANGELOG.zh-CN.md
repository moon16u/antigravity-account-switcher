[English](CHANGELOG.md) | 简体中文

# 更新日志

本文档记录 **Antigravity Account Switcher** 的主要版本变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本（Semantic Versioning）](https://semver.org/lang/zh-CN/)。

## [0.3.0] - 2026-11-25

### 新增

- 内置零依赖 stdio MCP 服务（`mcp_config.json`、`scripts/mcp-server.mjs`），提供 `get_switcher_status`、`list_accounts`、`get_quota` 与 `switch_account` 工具，并附带 `/switch-account` 技能（`skills/switch-account/SKILL.md`）。
- 新增后台 Gemini **周额度** 与 **5 小时额度** 监测（`sidecars/switcher/quota-guard.mjs`，Sidecar 每 `60s` 轮询）及短命 `PreInvocation` Hook（`hooks.json`、`scripts/quota-hook.mjs`）：任一额度池触及阈值（默认 `10%`）即向当前运行的 Agent Loop 注入提醒；支持按会话去重、零常驻内存，且在 Windows 下 `PATH` 缺少 `node` 时自动回退至 `%APPDATA%\Antigravity\bin\agy-node.cmd`。
- 侧栏新增可折叠的 **Agent 自动切号与低额度提醒（Agent Auto-Switch & Quota Alert）** 面板：支持 `10%–50%` 下拉阈值、周/5h 池独立开关、无其他并发任务时的可选自动切号，以及重启后可选自动唤醒续跑。
- 新增停壳前优雅等待回合收尾机制（`waitForConversationIdleBeforeStop`），以及自动续跑发现新 Hub 后等待 MCP 就绪的 `3s` 缓冲（`AUTO_RESUME_WAIT_MCP`），再发送 `agentapi send-message`。
- 停壳后自动同步 `app_storage.json` 的引导状态（`agy.onboarding.lastLoginUsername` / `agy.onboarding.lastLoginIsGcpTos`），切号后跳过重复弹出的 `One last thing before getting started...` 条款弹窗（仅在设备此前已存在确认记录时生效）。
- 统一 Sidecar、MCP 服务与 Hook 的数据目录探测顺序（优先复用已存在的 `sidecar_data/.../switcher/data`，再回退至 `PLUGIN_DATA` / `plugin_data`）。
- 在中英文 README 中补充演示动图（`assets/demo.gif`），并新增 11 项全隔离 MCP/Hook/守护/引导同步测试（`sidecars/switcher/test/mcp-and-hook.test.mjs`，6 矩阵 CI 共计 42 项测试）。

### 变更与修复

- 切号前活跃任务护栏（`active-work.mjs`）支持排除调用方自身的 `conversationId`，并忽略 `scripts/mcp-server.mjs` 与 `scripts/quota-hook.mjs` 等基础设施进程。
- 侧栏设置保存提示支持 `2.5s` 自动消失与中英双语文案，并精简了设置项标签文案。
- `scripts/quota-hook.mjs` 改用异步 `stdin` 流式读取，提升 Windows 管道输入稳定性。

## [0.2.0] - 2026-11-20

首个开源发布版本。

### 新增

- 面向 Google Antigravity 2.0 的跨平台原生右侧辅助栏 Sidecar 插件（`SIDECAR_UI_ENTRYPOINT_AUX_PANE`），支持 Windows 原生（`win32`）、WSL2 + Windows 宿主（`wsl`）、Linux 桌面（`linux`）与 macOS（`darwin`），零外部 npm 依赖（要求 `Node.js >= 18`）。
- 免退出浏览器 OAuth 添加账号（`+ 添加账号`）：运行时动态从本机二进制提取 OAuth 客户端配置（支持 ELF64、PE64 及单架构/通用 Fat Mach-O 64-bit），配合 PKCE S256 与回环回调完成授权。
- 不切号同步订阅等级（`v1internal:loadCodeAssist`）及每张账号卡可折叠的「查看用量（View usage）」环形配额面板（活跃账号走本地 LS 快速通道 `RetrieveUserQuotaSummary`，非活跃账号回退至远端 Cloud Code 接口）。
- 双模 HTTP 代理支持：Node >= 24.5 / >= 22.21 使用原生 `https.Agent({ proxyEnv })`，Node 18/20/早期 22 自动回退至内置 `ProxyConnectAgent`。
- AES-256-GCM 本地加密凭据库、切号前活跃凭证自动备份、脱离进程树的独立切号执行器（原生 Windows `--detach-worker` / Linux 与 WSL2 `systemd-run --user --scope`）、`Keep In Menu Bar` 自适应停壳与重拉、OS Keyring / `cmdkey.exe` 凭据交接以及切号前活跃任务护栏。
- 自适应宿主明暗主题的 `中 / EN` 双语界面（严格 CSP、零 `innerHTML` 与内联脚本），附带 31 项全隔离单测/集成测试与 6 矩阵 GitHub Actions CI。

### 修复

- 修复 macOS 下 `runInBackground` 默认值测试断言，并修正 CI 中 DER 证书序列号的正数规范编码（`a9e3bd3`）。

[0.3.0]: https://github.com/moon16u/antigravity-account-switcher/releases/tag/v0.3.0
