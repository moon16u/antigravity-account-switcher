[English](CHANGELOG.md) | 简体中文

# 更新日志

本文档记录 **Antigravity Account Switcher** 的主要版本变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本（Semantic Versioning）](https://semver.org/lang/zh-CN/)。

## [0.6.1] - 2026-11-28

### 优化

- **统一「未保存当前账号」提示栏与输入框样式**：将旧版棕色虚线提示框升级为与当前使用账号卡片一致的淡蓝高亮实线卡片（`10px` 圆角、柔和主题蓝底与细边框），同步优化文本输入框为白底 `8px` 圆角与柔和聚焦态，贴合当前登录语境。

## [0.6.0] - 2026-11-28

新增对齐 Antigravity 原生设计的悬浮「**查看用量**」卡片与基于本地快照的一键「**智能切换**」。

### 新增

- **一键「智能切换」**（`POST /api/accounts/best`）：在「`+ 添加账号`」旁新增「**智能切换**」按钮，完全基于本地配额快照与重置倒计时推算挑选最优备用号（无快照时回退至最久未用备用号，零远端请求、零 LS RPC），并在原生 `<dialog>` 确认弹窗中展示推荐账号与预计余量（全隔离测试增至 `63` 项）。

### 优化

- **原生风格悬浮「查看用量」卡片**：将原先撑开列表的内联折叠区升级为 Antigravity 同款紧凑「查看用量」触发栏（采用官方 Material Symbols `speed` 仪表盘指针图标）+ 原生 Top-Layer 锚定悬浮卡（`popover="hint"` + `interestfor` + CSS Anchor Positioning），支持悬停/点击弹出、无框分组配额行与圆环进度、零页面位移，并在刷新数据时原地更新不闪退。
- **统一纯净卡片底色**：移除普通账号卡片的多余嵌套底色（改为 `background: transparent`），与外层「已保存账号」容器同底、只以细线条区分，更贴合 Antigravity 原生设置页观感，同时保留当前使用号的淡蓝高亮状态。

## [0.5.0] - 2026-11-28

围绕 **Antigravity 宿主设计语言对齐** 与 **`googlechrome/modern-web-guidance` 现代 Web 最佳实践** 完成侧栏前端重塑与交互打磨。

### UI / UX 优化

- **全面对齐宿主视觉语言**：高级设置升级为 Antigravity 同款平滑滑动开关（`role="switch"`），「`+ 添加账号`」与「`切换`」统一为白底细边框药丸按钮，当前使用卡片与主题蓝（`#2f75c3`）对齐宿主设置页配色；取消全局粗体字重，统一 `14px` 基准字号，并离线内置官方 **Google Sans** 拉丁子集字体（`OFL-1.1`，36 KB）。
- **紧凑用量布局与零位移交互**：展开「查看用量」在宽栏下自动排为 2 列紧凑指标卡，显著压缩纵向高度；切号、删除、添加账号与活跃任务拦截统一收进原生居中毛玻璃 `<dialog>` 弹窗（0px 页面位移）；顶部悬浮提示收窄居中，且改为仅在高级设置冷却保护、切号重启间隙与报错时显示。

### Modern Web 规范升级（`modern-web-guidance`）

- 将 `ⓘ` 说明气泡重构为原生 Popover API（`popover="hint"`）+ `interestfor` + CSS Anchor Positioning，移除脆弱的像素硬算，支持自动贴边防遮挡、移入阅读与 `Esc` 关闭。
- 落地容器查询（`container-type: inline-size`）、`<meta name="color-scheme" content="light dark">` + `light-dark()` 防暗色闪白、原生零 JS 折叠/淡入动效（`interpolate-size`、`::details-content`、`@starting-style`）、`appearance: base-select` 定制阈值下拉框（细线条下拉箭头与极简选中勾）、清理失效滚动条样式并补 `prefers-contrast: more`，以及 `<main>` / `<ul>` / `role="alert"` / `event.source` 等语义与细节加固（隔离测试增至 `60` 项）。

## [0.4.1] - 2026-11-27

### 安全加固

- 移除 MCP `switch_account` 的自定义 `resumeMessage` 参数，将「切号后自动续跑」锁死为内置固定良性唤醒语，阻断间接 Prompt 注入借切号重启在新账号会话中持久化指令的攻击面。
- 在「安全架构」中补充说明本地单用户 `vault.key` 的威胁模型边界。

## [0.4.0] - 2026-11-27

低风险本地优先架构重构：彻底移除远端 Google API 直连、运行时二进制 OAuth 提取与空闲后台轮询，收紧 Agent 切号权限边界，并重塑「高级设置」交互体验。

### 新增

- **本地配额快照与重置倒计时推算**（`sidecars/switcher/quota-snapshots.mjs`、`quota-snapshots.json`）：仅当前活跃账号调用本地 `language_server` RPC（`RetrieveUserQuotaSummary`），切号前自动采集一次终态快照；非活跃账号完全本地展示，过期的重置窗口标注「预计已重置 / 预计 100%」，超过 24 小时的快照显示温和提示，全程零远端请求。
- **对话周期事件驱动监测**：新增 `PostInvocation` Hook（`hooks.json`、`scripts/quota-hook.mjs`），按节流写入本地触发文件（`quota-refresh-trigger.json`）并由 Sidecar 通过 `fs.watch` 异步监听，消除空闲心跳轮询且不阻塞对话。
- **动态阈值区间与切号自然停顿**：支持会话级随机浮动的软收尾与硬下限阈值（`dynamicThresholdEnabled`，默认开启），以及切号重启前随机 `3–8 秒` 自然停顿（`naturalPauseEnabled`，默认开启）。
- **可选「跳过重复条款弹窗」开关**：在「高级设置」中新增 `skipOnboardingPrompt`（**默认关闭**），由用户自主决定切号时是否同步更新本地引导记录。
- **高级设置独立限流与冷却倒计时**：`/api/settings/update` 使用独立 `25 次/分` 限流并返回 `Retry-After` / `retryAfterSec`，触发保护时以柔和提示显示剩余等待秒数。
- **扩充测试覆盖**：双模式（标准与 `--use-env-proxy`）全隔离测试增至 **59 项**，覆盖 6 矩阵 CI。

### 变更

- **「Agent 自主切号」硬权限门禁（默认关闭）**：由原「Agent 自动切号」更名并升级为 MCP 服务层 fail-closed 硬拦截——关闭时 Agent 仅具只读权限，`switch_account` 直接返回 `AGENT_SWITCH_DISABLED`；**「切号后自动续跑」** 与之强联动，在关闭时自动关闭并置灰禁用，开启后可自由切换。
- **官方原生登录扶正为唯一添加方式**：`+ 添加账号` 自动备份当前账号并重启桌面端应用进入官方 Google 登录，登录后点击「保存当前账号」加密入库。
- **MCP 服务（`0.4.0`）与分级 `PreInvocation` Hook**：`get_quota` 与 `switch_account`（`pickBest: true`）改用本地快照与重置推算（无快照时回退至最久未用备用号）；`PreInvocation` 区分 `soft` 收尾提醒与 `hard` 下限提醒，并按会话与级别去重。
- **重塑「高级设置」界面**：更名为「高级设置」，保留精简纯标题、仅悬停 `ⓘ` 显示的「低风险：/ 中风险：」说明气泡、右对齐即时「关闭 / 开启」左右分段切换控件（局部乐观更新、零界面闪烁），并将「触发阈值」统一置于面板底部。

### 修复

- **Windows 原生保存账号与切号前备份**：打开或刷新面板保持零子进程，只要 `language_server` 识别出未入库的活跃账号即可直接点击「保存当前账号」；保存账号及切号前自动备份按需从 Windows 凭据管理器读取 `gemini:antigravity`（优先 Python `ctypes` `CredReadW`，不可用时回退至不含 `-WindowStyle Hidden` / `-EncodedCommand` 的 `pwsh` / `powershell.exe`），若读取受阻则在重启前安全中止。

### 移除

- 移除所有直接请求远端 `v1internal:loadCodeAssist` / `v1internal:retrieveUserQuotaSummary` 的 HTTP 调用与自定义 `antigravity/hub/<ver>` User-Agent（删除 `cloudcode.mjs`）。
- 移除运行时二进制 OAuth 客户端提取（`binary-oauth.mjs`）与自建浏览器 PKCE OAuth 流程（`oauth.mjs`、`/api/oauth/*`、`/api/accounts/sync-tiers`）。
- 移除 60 秒后台 `setInterval` 定时轮询。

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

[0.6.1]: https://github.com/moon16u/antigravity-account-switcher/releases/tag/v0.6.1
[0.6.0]: https://github.com/moon16u/antigravity-account-switcher/releases/tag/v0.6.0
[0.5.0]: https://github.com/moon16u/antigravity-account-switcher/releases/tag/v0.5.0
[0.4.1]: https://github.com/moon16u/antigravity-account-switcher/releases/tag/v0.4.1
[0.4.0]: https://github.com/moon16u/antigravity-account-switcher/releases/tag/v0.4.0
[0.3.0]: https://github.com/moon16u/antigravity-account-switcher/releases/tag/v0.3.0
