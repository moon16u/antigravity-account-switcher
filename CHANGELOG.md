English | [简体中文](CHANGELOG.zh-CN.md)

# Changelog

All notable changes to **Antigravity Account Switcher** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-11-26

Low-Risk Architecture Hardening: the plugin is now fully local-first, makes no direct outbound Google API calls, performs no runtime binary OAuth extraction, and runs no idle background polling.

### Added

- Local-first quota snapshot cache and reset-countdown projection (`sidecars/switcher/quota-snapshots.mjs`, `quota-snapshots.json`): only the active account queries the local `language_server` RPC (`RetrieveUserQuotaSummary`), pre-switch final snapshots are captured automatically (best-effort), and inactive accounts render local snapshots with `Estimated reset` / `Est. 100%` projection plus a >24h staleness indicator, with zero remote requests.
- Conversation-lifecycle event-driven quota checks: the `PostInvocation` hook (`hooks.json`, `scripts/quota-hook.mjs`) writes a throttled local trigger file (`quota-refresh-trigger.json`) watched by the Sidecar through `fs.watch`, eliminating idle heartbeat polling while keeping hooks non-blocking.
- Non-mechanical dynamic threshold range (per-session jittered soft wrap-up threshold + hard floor, `dynamicThresholdEnabled`, default on) and natural relaunch pause (random 3–8s delay before relaunch, `naturalPauseEnabled`, default on).
- Opt-in toggle `skipOnboardingPrompt` (**default OFF**) in the **Advanced Settings** panel to control whether `switcher-worker` updates `app_storage.json` (`agy.onboarding.lastLoginUsername`) to skip repeated onboarding modals.

### Changed

- **Agent Autonomous Switch** (`Agent 自主切号`, default OFF) now acts as a hard, fail-closed MCP permission gate: when OFF, the Agent keeps read-only access (status, quota, alerts) and `switch_account` is rejected at the MCP server layer with `AGENT_SWITCH_DISABLED`. **Auto-Resume After Switch** is coupled to this gate: it is automatically disabled and greyed out in the UI while autonomous switching is off; when ON, the Agent may switch on user request or at the low-quota hard floor (still guarded by active-work detection) and **Auto-Resume After Switch** can be toggled independently.
- Promoted native sign-in (`+ Add Account` → back up the active account, restart into official Google sign-in, then click `Save Account`) as the primary and sole account addition flow.
- Updated the MCP server (`0.4.0`) `get_quota` and `switch_account` (`pickBest: true`) to use local snapshots plus reset projection (with a least-recently-used unsnapshotted fallback) and to capture pre-switch snapshots before switching.
- Updated the `PreInvocation` hook to emit level-aware alerts (`soft` wrap-up reminder vs `hard` switch prompt) with per-level conversation deduplication.
- Renamed the sidebar settings entry to **Advanced Settings** and refreshed it with concise setting titles, hover-only `ⓘ` info/risk tooltips, and right-aligned instant **On / Off** toggle buttons consistent with the Saved Accounts action controls.

### Fixed

- **Save Account** is available on native Windows when the language server identifies an unsaved account. Panel loads start zero child processes. Saving or backing up before a switch or **+ Add Account** reads `gemini:antigravity` from Credential Manager when the token file is missing. The reader prefers Python `ctypes` (`CredReadW`), then tries `pwsh` and `powershell.exe` without `-WindowStyle Hidden` or `-EncodedCommand`.

### Removed

- Removed all direct remote `v1internal:loadCodeAssist` / `v1internal:retrieveUserQuotaSummary` HTTP calls and custom `antigravity/hub/<ver>` User-Agent construction (`cloudcode.mjs` removed).
- Removed runtime binary OAuth client extraction (`binary-oauth.mjs`) and the self-hosted browser PKCE OAuth flow (`oauth.mjs`, `/api/oauth/*`, `/api/accounts/sync-tiers`).
- Removed the 60-second background `setInterval` quota polling loop (zero idle background RPC/network requests).

## [0.3.0] - 2026-11-25

### Added

- Bundled zero-dependency stdio MCP server (`mcp_config.json`, `scripts/mcp-server.mjs`) exposing `get_switcher_status`, `list_accounts`, `get_quota`, and `switch_account`, plus the `/switch-account` skill (`skills/switch-account/SKILL.md`).
- Background Gemini **Weekly** and **5-Hour** quota monitoring (`sidecars/switcher/quota-guard.mjs`, 60s Sidecar poll) paired with a short-lived `PreInvocation` hook (`hooks.json`, `scripts/quota-hook.mjs`) that alerts the running agent loop when either bucket hits the threshold (default `10%`), with per-conversation deduplication, zero resident RAM, and automatic Windows fallback to `%APPDATA%\Antigravity\bin\agy-node.cmd` when `node` is not on `PATH`.
- Collapsible **Agent Auto-Switch & Quota Alert** panel in the sidebar (`10%–50%` dropdown threshold, Weekly/5h toggles, opt-in auto-switch when no other tasks are busy, and opt-in post-restart auto-resume).
- Graceful turn-idle waiting (`waitForConversationIdleBeforeStop`) before shutdown plus a 3s post-Hub MCP readiness buffer (`AUTO_RESUME_WAIT_MCP`) before sending `agentapi send-message` on auto-resume.
- Automatic `app_storage.json` onboarding sync (`agy.onboarding.lastLoginUsername` / `agy.onboarding.lastLoginIsGcpTos`) after shutdown to skip repeated `One last thing before getting started...` modals when switching accounts (only when prior acceptance already exists).
- Unified data directory discovery across Sidecar, MCP server, and Hook (preferring existing `sidecar_data/.../switcher/data` before falling back to `PLUGIN_DATA` / `plugin_data`).
- Demo GIF (`assets/demo.gif`) in READMEs and 11 isolated MCP/Hook/guard/onboarding tests (`sidecars/switcher/test/mcp-and-hook.test.mjs`, 42 tests total across 6-matrix CI).

### Changed & Fixed

- Pre-switch active-work guard (`active-work.mjs`) supports excluding the caller's `conversationId` and ignores `scripts/mcp-server.mjs` and `scripts/quota-hook.mjs` infrastructure processes.
- Sidebar settings save notices auto-dismiss after `2.5s` with bilingual copy, and settings labels were simplified.
- `scripts/quota-hook.mjs` uses async `stdin` streaming for reliable Windows pipe handling.

## [0.2.0] - 2026-11-20

Initial open-source release.

### Added

- Cross-platform auxiliary-pane Sidecar plugin (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`) for Google Antigravity 2.0 across Windows native (`win32`), WSL2 + Windows host (`wsl`), Linux desktop (`linux`), and macOS (`darwin`) with zero external npm dependencies (`Node.js >= 18`).
- No-logout browser OAuth account addition (`+ Add Account`) with runtime ELF64, PE64, and Mach-O 64-bit / Universal Fat binary OAuth client extraction and PKCE S256 loopback callback.
- Subscription tier sync (`v1internal:loadCodeAssist`) and per-account collapsible `View usage` quota rings (`RetrieveUserQuotaSummary` local LS fast path + remote Cloud Code fallback).
- Dual-mode HTTP proxy support (native `https.Agent({ proxyEnv })` on Node >= 24.5 / >= 22.21 and built-in `ProxyConnectAgent` fallback on Node 18/20/early 22).
- AES-256-GCM encrypted local vault, pre-switch active-token backup, detached switch worker (`--detach-worker` on native Windows / `systemd-run --user --scope` on Linux & WSL2), `Keep In Menu Bar` adaptive shutdown/relaunch, OS Keyring / `cmdkey.exe` handoff, and pre-switch active-work guard.
- Host dark/light adaptive bilingual (`中 / EN`) UI with strict CSP and zero `innerHTML`/inline scripts, plus 31 isolated unit/integration tests and 6-matrix GitHub Actions CI.

### Fixed

- Fixed macOS `runInBackground` default test assertion and canonical positive DER certificate serial generation in CI (`a9e3bd3`).

[0.4.0]: https://github.com/moon16u/antigravity-account-switcher/releases/tag/v0.4.0
[0.3.0]: https://github.com/moon16u/antigravity-account-switcher/releases/tag/v0.3.0
