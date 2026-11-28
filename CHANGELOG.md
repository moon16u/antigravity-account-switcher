English | [简体中文](CHANGELOG.zh-CN.md)

# Changelog

All notable changes to **Antigravity Account Switcher** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] - 2026-11-28

Upgrades local vault encryption to **OS Keyring envelope encryption** (`sidecars/switcher/key-store.mjs`): stores the 256-bit AES-GCM master key in your operating system's native secret store with verified automatic migration and safe file fallback.

### Added

- **OS Keyring master key storage** (`sidecars/switcher/key-store.mjs`): stores the 256-bit vault key in **Windows Credential Manager** (`CredWriteW` / `CredReadW` via Python `ctypes` primary with plain non-hidden `pwsh` / `powershell.exe` fallback), **macOS Keychain** (`/usr/bin/security`), or **Linux / WSL2 Secret Service** (`secret-tool` when `DBUS_SESSION_BUS_ADDRESS` is set). All secrets pass strictly over `stdin` (never in CLI arguments), and each process caches the key in memory after a single read.
- **Verified automatic migration & safe fallback**: existing `vault.key` files migrate automatically on first read — the switcher writes to the OS Keyring, reads back to verify byte-for-byte equality, and only then wipes and removes the legacy plaintext file (logging `VAULT_KEY_MIGRATED`). If the keyring is unavailable, blocked, or disagrees with an existing encrypted vault, it preserves `vault.key` intact and falls back safely to `0600` file storage (with `SWITCHER_KEY_STORE=file` available as an explicit override).
- **Footer storage indicator & expanded tests**: `/api/state` exposes only a sanitized `vaultKeySource` (`'keyring'` or `'file'`) reflected in the sidebar footer, detached workers inherit the storage mode cleanly, and isolated tests grow to **89 passing tests**.

### Changed

- **CI maintenance**: upgraded GitHub Actions workflow steps to `actions/checkout@v5` and `actions/setup-node@v5`.

## [0.6.1] - 2026-11-28

### Changed

- **Aligned unsaved-account banner & text inputs with active-card styling**: updated `.unsaved-banner` from the legacy dashed amber box to the same solid blue highlight style used for the active account card (`10px` radius, soft primary tint and border), and refined text inputs with clean card-surface backgrounds, `8px` corners, and soft focus rings.

## [0.6.0] - 2026-11-28

Adds Antigravity-style floating **View Usage** popovers and one-click **Smart Switch** powered purely by local quota snapshots.

### Added

- **One-click `Smart Switch`** (`POST /api/accounts/best`): added a **`Smart Switch`** button next to `+ Add Account` that ranks backup accounts locally from saved quota snapshots and reset-time projection (falling back to the least-recently-used unsnapshotted account, zero remote requests / zero LS RPCs) and previews the recommendation in the native `<dialog>` confirmation modal (`63` passing tests).

### Changed

- **Antigravity-style floating `View Usage` popover**: replaced the inline expanding usage drawer with a compact full-width `View Usage` trigger bar (using the official Material Symbols `speed` gauge icon) and a native Top-Layer anchored popover (`popover="hint"` + `interestfor` + CSS Anchor Positioning) with borderless metric rows, circular quota rings, zero layout shift, and in-place refresh without dismissing the open card.
- **Cleaner flat card surfaces**: removed the nested fill tint on inactive account cards (`background: transparent`) so regular cards sit cleanly on the enclosing card surface like Antigravity's native Settings cards while keeping the active account highlight.

## [0.5.0] - 2026-11-28

UI/UX visual polish aligned with Antigravity Desktop's native design language, paired with modern web platform upgrades following `googlechrome/modern-web-guidance`.

### UI & UX

- **Aligned with Antigravity Desktop design language**: replaced segmented controls with native-style sliding toggle switches, adopted outlined pill buttons for `+ Add Account` and `Switch`, matched the host's active-card tint and `#2f75c3` primary accent, removed heavy bold weights across the panel, and bundled the official offline **Google Sans** Latin subset (`OFL-1.1`, 36 KB) at a `14px` base size.
- **Compact usage tiles & zero-shift overlays**: redesigned the `View usage` drawer into responsive 2-column metric tiles on wider panes, upgraded switch/remove/add-account/active-work confirmations to a lightweight native `<dialog>` modal (`0px` layout shift), and narrowed top status pills to appear only for rate-limit cooldowns, switch/restart transitions, and errors.

### Modern Web Platform (`modern-web-guidance`)

- Replaced manual `ⓘ` tooltip positioning hacks with native Popover API (`popover="hint"`), `interestfor`, and CSS Anchor Positioning (`position-area` / `position-try-fallbacks`) for hoverable, `Esc`-dismissible, overflow-safe hints.
- Adopted CSS Container Queries (`container-type: inline-size`), `<meta name="color-scheme" content="light dark">` + `light-dark()` tokens, zero-JS native transitions (`interpolate-size: allow-keywords`, `::details-content`, `@starting-style`), branded `appearance: base-select` threshold picker with custom thin chevron and checkmark, `prefers-contrast: more` scrollbar cleanup, and semantic `<main>` / `<ul>` / `role="alert"` / `event.source` hardening (`60` passing tests).

## [0.4.1] - 2026-11-27

### Security

- Removed the agent-supplied `resumeMessage` parameter from MCP `switch_account` and locked post-restart auto-resume to a fixed benign wakeup message, closing the indirect prompt-injection persistence vector across account switches.
- Documented the local single-user `vault.key` threat-model boundary explicitly in **Security Architecture**.

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

[0.7.0]: https://github.com/moon16u/antigravity-account-switcher/releases/tag/v0.7.0
[0.6.1]: https://github.com/moon16u/antigravity-account-switcher/releases/tag/v0.6.1
[0.6.0]: https://github.com/moon16u/antigravity-account-switcher/releases/tag/v0.6.0
[0.5.0]: https://github.com/moon16u/antigravity-account-switcher/releases/tag/v0.5.0
[0.4.1]: https://github.com/moon16u/antigravity-account-switcher/releases/tag/v0.4.1
[0.4.0]: https://github.com/moon16u/antigravity-account-switcher/releases/tag/v0.4.0
[0.3.0]: https://github.com/moon16u/antigravity-account-switcher/releases/tag/v0.3.0
