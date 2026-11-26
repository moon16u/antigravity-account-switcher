English | [简体中文](CHANGELOG.zh-CN.md)

# Changelog

All notable changes to **Antigravity Account Switcher** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-11-27

Low-risk, local-first architecture overhaul: eliminates all outbound remote Google API requests, runtime binary OAuth extraction, and idle background polling while tightening Agent permission boundaries and refining the Advanced Settings UI.

### Added

- **Local quota snapshots & reset-time projection** (`sidecars/switcher/quota-snapshots.mjs`, `quota-snapshots.json`): only the active account queries local `language_server` RPC (`RetrieveUserQuotaSummary`), with automatic best-effort final snapshot capture before switching. Inactive accounts render locally with `Est. reset` / `Est. 100%` projection and a >24h staleness hint — zero remote requests.
- **Event-driven quota monitoring**: `PostInvocation` hook (`hooks.json`, `scripts/quota-hook.mjs`) writes a throttled trigger file (`quota-refresh-trigger.json`) watched by the Sidecar via `fs.watch`, removing idle heartbeat polling while keeping hooks non-blocking.
- **Dynamic thresholds & natural relaunch pause**: per-session jittered soft wrap-up and hard floor bounds (`dynamicThresholdEnabled`, default on) plus a random `3–8s` pause before desktop relaunch (`naturalPauseEnabled`, default on).
- **Opt-in onboarding skip toggle**: `skipOnboardingPrompt` (**default OFF**) in **Advanced Settings** lets users explicitly choose whether to update local onboarding state on switch.
- **Dedicated settings rate-limit countdown**: `/api/settings/update` uses a dedicated `25 req/min` limiter returning `Retry-After` and `retryAfterSec`, displayed as a gentle amber cooldown notice in the sidebar.
- **Expanded test suite**: 59 isolated unit and integration tests passing in both standard and `--use-env-proxy` modes across 6-matrix CI.

### Changed

- **Hard MCP permission gate (`Agent Autonomous Switch`, default OFF)**: renamed from `Agent Auto-Switch` and enforced fail-closed at the MCP server layer (`AGENT_SWITCH_DISABLED` when off, keeping the Agent strictly read-only). **Auto-Resume After Switch** is now coupled to this gate and automatically disabled and greyed out whenever autonomous switching is off.
- **Official native sign-in as the sole add-account flow**: `+ Add Account` backs up the active account, restarts Antigravity signed out for official Google sign-in, and saves the new session via `Save Account`.
- **MCP server (`0.4.0`) & level-aware `PreInvocation` hook**: `get_quota` and `switch_account` (`pickBest: true`) now rely on local snapshots and reset projection (with least-recently-used unsnapshotted fallback); `PreInvocation` distinguishes `soft` wrap-up alerts from `hard` switch alerts with per-level conversation deduplication.
- **Redesigned Advanced Settings UI**: concise setting titles, subtle hover-only `ⓘ` tooltips with unified `Low risk:` / `Medium risk:` labels, right-aligned instant `Off / On` segmented controls (optimistic per-row updates with zero panel flicker), and **Alert Threshold** placed at the bottom.

### Fixed

- **Native Windows Save Account & pre-switch backup**: panel loads remain zero-subprocess while showing **Save Account** whenever the local `language_server` reports an unsaved active account. Saving or backing up reads `gemini:antigravity` from Windows Credential Manager on demand via Python `ctypes` (`CredReadW`), falling back to plain `pwsh` / `powershell.exe` without `-WindowStyle Hidden` or `-EncodedCommand`, and aborts safely before restart if reading is blocked.

### Removed

- Removed all direct remote `v1internal:loadCodeAssist` / `v1internal:retrieveUserQuotaSummary` calls and custom `antigravity/hub/<ver>` User-Agent headers (`cloudcode.mjs`).
- Removed runtime binary OAuth client extraction (`binary-oauth.mjs`) and self-hosted browser PKCE OAuth (`oauth.mjs`, `/api/oauth/*`, `/api/accounts/sync-tiers`).
- Removed the 60-second background `setInterval` quota polling loop.

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
