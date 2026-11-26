[English](CHANGELOG.md) | 简体中文

# 更新日志

本文档记录 **Antigravity Account Switcher** 的主要版本变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本（Semantic Versioning）](https://semver.org/lang/zh-CN/)。

## [0.4.0] - 2026-11-26

低风险架构加固：插件全面转向本地优先，不再直接发起任何 Google 远端 API 调用，不在运行时提取二进制 OAuth 客户端，也不进行空闲后台轮询。

### 新增

- 新增本地优先的配额快照缓存与重置倒计时投影（`sidecars/switcher/quota-snapshots.mjs`、`quota-snapshots.json`）：仅当前活跃账号通过本地 `language_server` RPC（`RetrieveUserQuotaSummary`）查询配额，切号前自动采集最终快照（尽最大努力）；非活跃账号直接渲染本地快照，并给出「预计已重置 / 预计 100%」投影与超过 24 小时的陈旧提示，全程零远端请求。
- 新增对话生命周期事件驱动的配额检查：`PostInvocation` Hook（`hooks.json`、`scripts/quota-hook.mjs`）写入节流的本地触发文件（`quota-refresh-trigger.json`），由 Sidecar 通过 `fs.watch` 监听，消除空闲心跳轮询，同时保持 Hook 非阻塞。
- 新增非机械式动态阈值区间（按会话随机抖动的软收尾阈值 + 硬下限，`dynamicThresholdEnabled` 默认开启）与自然重启停顿（重启前随机 3–8 秒延迟，`naturalPauseEnabled` 默认开启）。
- **高级设置**面板新增可选开关 `skipOnboardingPrompt`（**默认关闭**），用于控制 `switcher-worker` 是否更新 `app_storage.json`（`agy.onboarding.lastLoginUsername`）以跳过重复的引导弹窗。

### 变更

- 将原生登录提升为唯一且主要的添加账号流程（`+ 添加账号` → 备份当前账号、重启进入官方 Google 登录，登录后点击「保存当前账号」）。
- MCP 服务（`0.4.0`）的 `get_quota` 与 `switch_account`（`pickBest: true`）改为使用本地快照 + 重置时间投影（并附「最近最少使用且无快照」的备用号回退），同时在切号前采集当前账号快照。
- `PreInvocation` Hook 改为分级提醒（`soft` 收尾提醒 / `hard` 切号提示），并按会话与级别去重。
- 侧栏设置项更名为 **高级设置**，并采用精简的设置标题、仅在悬停时显示的 `ⓘ` 信息/风险提示，以及右对齐的即时「开启 / 关闭」切换按钮，与「已保存账号」卡片的操作控件保持一致。

### 修复

- Windows 原生端通过语言服务器识别出尚未保存的账号后，即可点击「**保存当前账号**」。面板加载时不启动任何子进程。保存账号、切号或「**+ 添加账号**」前备份时，若令牌文件不存在，插件会从凭据管理器按需读取 `gemini:antigravity`。优先使用 Python `ctypes`（`CredReadW`），失败后依次尝试 `pwsh` 和 `powershell.exe`，不使用 `-WindowStyle Hidden` 或 `-EncodedCommand`。

### 移除

- 移除所有直接请求远端 `v1internal:loadCodeAssist` / `v1internal:retrieveUserQuotaSummary` 的 HTTP 调用及自定义 `antigravity/hub/<ver>` User-Agent 构造（删除 `cloudcode.mjs`）。
- 移除运行时二进制 OAuth 客户端提取（`binary-oauth.mjs`）与自托管浏览器 PKCE OAuth 流程（`oauth.mjs`、`/api/oauth/*`、`/api/accounts/sync-tiers`）。
- 移除每 60 秒后台 `setInterval` 配额轮询循环（空闲时零后台 RPC / 网络请求）。

## [0.3.0] - 2026-11-25

### 新增

- 内置零依赖 stdio MCP 服务（`mcp_config.json`、`scripts/mcp-server.mjs`），提供 `get_switcher_status`、`list_accounts`、`get_quota` 与 `switch_account` 工具，并附带 `/switch-account` 技能（`skills/switch-account/SKILL.md`）。
- 新增后台 Gemini **周额度** 与 **5 小时额度** 监测（`sidecars/switcher/quota-guard.mjs`，Sidecar 每 `60s` 轮询）及短命 `PreInvocation` Hook（`hooks.json`、`scripts/quota-hook.mjs`）：任一额度池触及阈值（默认 `10%`）即向当前运行的 Agent Loop 注入提醒；支持按会话去重、零常驻内存，且在 Windows 下 `PATH` 缺少 `node` 时自动回退至 `%APPDATA%\Antigravity\bin\agy-node.cmd`。
- 侧栏新增可折叠的 **Agent 自动切号与低额度提醒（Agent Auto-Switch & Quota Alert）** 面板：支持 `10%–50%` 下拉阈值、周/5h 池独立开关、无其他并发任务时的可选自动切号，以及重启后可选自动唤醒续跑。
- 新增关闭桌面端应用前优雅等待回合收尾机制（`waitForConversationIdleBeforeStop`），以及自动续跑发现新 Hub 后等待 MCP 就绪的 `3s` 缓冲（`AUTO_RESUME_WAIT_MCP`），再发送 `agentapi send-message`。
- 关闭桌面端应用后自动同步 `app_storage.json` 的引导状态（`agy.onboarding.lastLoginUsername` / `agy.onboarding.lastLoginIsGcpTos`），切号后跳过重复弹出的 `One last thing before getting started...` 条款弹窗（仅在设备此前已存在确认记录时生效）。
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
- AES-256-GCM 本地加密凭据库、切号前活跃凭证自动备份、脱离进程树的独立切号执行器（原生 Windows `--detach-worker` / Linux 与 WSL2 `systemd-run --user --scope`）、`Keep In Menu Bar` 自适应关闭与重启桌面端应用、OS Keyring / `cmdkey.exe` 凭据交接以及切号前活跃任务护栏。
- 自适应宿主明暗主题的 `中 / EN` 双语界面（严格 CSP、零 `innerHTML` 与内联脚本），附带 31 项全隔离单测/集成测试与 6 矩阵 GitHub Actions CI。

### 修复

- 修复 macOS 下 `runInBackground` 默认值测试断言，并修正 CI 中 DER 证书序列号的正数规范编码（`a9e3bd3`）。

[0.4.0]: https://github.com/moon16u/antigravity-account-switcher/releases/tag/v0.4.0
[0.3.0]: https://github.com/moon16u/antigravity-account-switcher/releases/tag/v0.3.0
