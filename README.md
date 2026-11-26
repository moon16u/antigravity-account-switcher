English | [简体中文](README.zh-CN.md) | [Changelog](CHANGELOG.md)

# Antigravity Account Switcher

[![CI](https://github.com/moon16u/antigravity-account-switcher/actions/workflows/ci.yml/badge.svg)](https://github.com/moon16u/antigravity-account-switcher/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node.js >= 18](https://img.shields.io/badge/Node.js-%3E%3D%2018-339933)
![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-brightgreen)

A cross-platform auxiliary-pane sidecar plugin (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`) for **Google Antigravity 2.0** that manages multiple local accounts with a low-risk, local-first architecture: official native Google sign-in, AES-256-GCM encrypted credentials at rest, local quota snapshots with reset projection, and clean account switching across desktop and WSL2 environments — built on **Node.js >= 18** with **zero external npm dependencies**, **zero outbound remote API calls**, and **zero idle polling**.

<p align="center">
  <img src="assets/demo.gif" alt="Antigravity Account Switcher Demo" width="560" />
</p>

## Supported Platforms

| Platform | Runtime Mode | Antigravity Host & Language Server | Verification Status |
| --- | --- | --- | --- |
| **Windows (native)** | `win32` | Windows Electron desktop + `language_server.exe` (PE64 x64 / ARM64) | Live desktop verified + CI (`windows-latest`) |
| **WSL2 + Windows host** | `wsl` | WSL2 Linux `language_server` (ELF64 x64 / ARM64) + Windows Electron host via `/mnt/c/Windows/System32` | Live WSL2 + Windows host verified |
| **Linux (desktop)** | `linux` | Native Linux Antigravity desktop + `language_server` (ELF64 x64 / ARM64) | Verified in CI (`ubuntu-latest`) |
| **macOS** | `darwin` | `Antigravity.app` (Intel x64, Apple Silicon ARM64, and Universal Fat Mach-O) | Verified in CI (`macos-latest`); physical desktop testing welcome |

## Features

- **Current Account Inspection & Masked Display**: Reads the active session token from OS Keyring on **macOS** (Keychain `gemini`/`antigravity`) and **Linux desktop** (Secret Service via `secret-tool` when `DBUS_SESSION_BUS_ADDRESS` is set), or from `~/.gemini/jetski-standalone-oauth-token` on **WSL2** and non-keyring environments. On **native Windows**, the panel uses `LanguageServerService/GetUserStatus` and the vault to identify the signed-in account. Click **Save Account** to save it after native sign-in. Emails are masked by default with a one-click header toggle to reveal full addresses.
- **Official Native Sign-In (`+ Add Account`)** — the primary and sole account addition flow:
  - Clicking **`+ Add Account`** backs up the active session into the encrypted vault and `last-token.enc.json`, removes the active token, and restarts Antigravity signed out.
  - Complete the official Google sign-in in the Antigravity window itself; back in the panel, click **`Save Account`** to capture and encrypt the new session into the vault.
  - No browser OAuth or PKCE callback, no local OAuth listener, no runtime binary OAuth client extraction, no client secrets, and no remote token exchange. The plugin never asks for passwords, OAuth codes, or token files.
- **Local-First Quota Snapshots & Per-Account `View usage`**:
  - **Only the active account** queries the local `language_server` RPC (`RetrieveUserQuotaSummary`) through a loopback-only connection. Normalized summaries are cached in `quota-snapshots.json` per account UUID; before a switch, the outgoing account's final snapshot is force-captured on a best-effort basis before its token is replaced.
  - **Inactive accounts** render their last local snapshot. When a bucket's `resetTime` has already passed, it is projected to 100% and labeled **`Estimated reset`** / **`Est. 100%`**; snapshots older than **24 hours** show **`Snapshot >24h old · syncs on switch`**, and accounts without a snapshot show a local-capture hint. No remote requests are made for any of this.
  - Each saved account card includes a collapsible **`View usage`** panel rendering Antigravity-style quota groups and circular rings. Subscription tier labels are kept from the local `language_server` status and snapshots when available.
  - Smart caching & refresh: initial expansion after opening/reopening the sidebar honors the `30s` backend cache; re-expanding within the same session automatically refreshes when more than `10s` have elapsed since the last successful fetch (reusing loaded data within `10s`); staying expanded leaves refreshes to the manual refresh controls, with no automatic polling.
- **Zero Outbound Remote API Calls, Zero Binary Extraction, Zero Idle Polling**:
  - The plugin makes **no direct remote Google API calls**: no remote tier lookups, no remote quota-summary requests, no custom hub-version User-Agent, no Cloud Code host whitelist, and no CONNECT-tunnel proxy transport.
  - There is **no runtime binary OAuth client extraction** and **no self-hosted browser PKCE OAuth flow**; the related extractor, OAuth manager, remote-call modules, API routes, and tier-sync endpoint were removed in 0.4.0.
  - There is **no `setInterval` background quota poll**. Quota refresh is driven by conversation lifecycle events, account capture, manual usage refresh, and pre-switch capture. The only HTTP client path is the local `language_server` RPC, restricted to loopback hosts (`localhost`, `127.0.0.1`, `::1`) and authenticated with the host-provided CSRF token.
- **AES-256-GCM Encrypted Vault**:
  - Encrypts saved accounts (`vault.enc.json`), automatic pre-switch active-token backups (`last-token.enc.json`), and single-use switch jobs (`jobs/job-<uuid>.enc.json`) with a local 256-bit random master key (`vault.key`).
  - Enforces `0700` directory permissions and `0600` file permissions on Unix (WSL2, macOS, and Linux).
- **Keep In Menu Bar Adaptive Fast Shutdown & Relaunch**:
  - Executes switches in a detached worker (`switcher-worker.mjs`: pure Node.js double-fork `--detach-worker` on native Windows outside the `Antigravity.exe` tree, or `systemd-run --user --scope` on Linux/WSL2 when available — zero hidden `powershell.exe` calls).
  - On **Windows / WSL2**, reads `app_storage.json` (`runInBackground` — Antigravity's *Keep In Menu Bar* setting) and inspects `tasklist /V /FO CSV` to identify visible main `Antigravity.exe` windows, closes them first before cleaning up tray processes (native Windows omits `/T`), and signals WSL2 `language_server` (`SIGTERM`) to flush cleanly. On native Windows, clears the active `gemini:antigravity` Credential Manager entry via `cmdkey.exe` and writes `~/.gemini/jetski-standalone-oauth-token` (which `language_server.exe` imports on startup), then relaunches via `%APPDATA%\Antigravity\launch-env-proxy.vbs` (optional proxy wrapper if present), `Antigravity.exe`, or `ANTIGRAVITY_SWITCHER_RELAUNCH_EXE`.
  - On **macOS**, quits cleanly via `/usr/bin/osascript` (`SIGTERM` fallback) and relaunches via `/usr/bin/open -a`. On **Linux**, terminates desktop and `language_server` processes via `SIGTERM` and relaunches the captured desktop binary.
  - Adds a **natural relaunch pause** (random `3–8s` before relaunch, `naturalPauseEnabled`, default on) so the restart does not look mechanically instant.
- **Pre-Switch Active-Work Guard & Bilingual UI (`中 / EN`)**:
  - Checks `GetAllCascadeTrajectories`, `ListBackgroundTasks`, and `ListTerminals` via `language_server` RPC plus active user child processes before switching; pauses with **Recheck & Switch**, **Cancel**, or audited **Force Switch** (`FORCE_SWITCH_REQUESTED` in `switch.log`) when work is running.
  - Built-in instant **`中 / EN`** toggle switches all in-panel UI copy immediately.
- **Agent MCP Tools & Event-Driven Quota Guard**:
  - Bundles a zero-dependency stdio MCP server (`mcp_config.json` → `scripts/mcp-server.mjs`, server version `0.4.0`) exposing `get_switcher_status`, `list_accounts`, `get_quota`, and `switch_account`, with a matching `/switch-account` skill in `skills/switch-account/SKILL.md`. `get_quota` reads live local `language_server` quota for the active account and local snapshots plus reset projection for inactive accounts; `switch_account` (`pickBest: true`) selects from local snapshots with a least-recently-used unsnapshotted fallback and captures a pre-switch snapshot.
  - The conversation lifecycle drives quota checks: the **`PostInvocation`** hook (`hooks.json` → `scripts/quota-hook.mjs`) writes a throttled local trigger file (`quota-refresh-trigger.json`), which the Sidecar watches with `fs.watch` and coalesces. The Sidecar then queries only the active account's local `language_server` RPC and writes a sanitized `quota-alert.json`. There is no idle heartbeat polling, and the hook returns immediately without network or RPC calls (Windows automatically falls back to Antigravity's bundled `%APPDATA%\Antigravity\bin\agy-node.cmd` if `node` is missing from `PATH`).
  - The **`PreInvocation`** hook reads the local snapshot in milliseconds with zero resident RAM and injects a level-aware, deduplicated `systemMessage`: **`soft`** = wrap-up reminder as quota enters the soft threshold, **`hard`** = switch prompt at the hard floor. Deduplication is per conversation and per level, so a `soft` alert can later escalate to `hard` while duplicate same-level alerts stay quiet.
  - In Tools → **Advanced Settings**, you can configure the base threshold (panel dropdown `10%–50%`), toggle Weekly / 5h monitoring, enable the **dynamic threshold range** (`dynamicThresholdEnabled`, default on: a per-session jittered soft wrap-up threshold plus a jittered hard floor), enable the **natural relaunch pause** (`naturalPauseEnabled`, default on), opt in to **Allow Agent auto-switch on low quota** (safely blocked if any other conversation/task/terminal is active), and opt in to **Auto-resume current conversation after restart**.
  - The **Advanced Settings** panel uses concise setting titles, with info and risk explanations shown only on hover through `ⓘ` tooltips, and right-aligned instant **On / Off** toggle buttons consistent with the Saved Accounts action controls.
  - The **Advanced Settings** panel also exposes the opt-in **`skipOnboardingPrompt`** toggle (**default OFF**). When enabled, `switcher-worker` may update `app_storage.json` (`agy.onboarding.lastLoginUsername`) only when a prior acceptance marker exists, to skip repeated onboarding modals on later switches.
  - Agent-initiated switches that carry a `conversationId` wait for the current turn to wrap up cleanly (bounded) before quitting; auto-resume can send `agentapi send-message` once the new hub and MCP tools are ready.

## Scope, Boundaries & Known Limitations

1. **Consumer Accounts Only**: Only personal Google accounts (`auth_method: "consumer"`) are supported; enterprise / Google Workspace SSO tokens are rejected.
2. **Restart Required on Switch**: Antigravity holds the active OAuth session in its running `language_server` process, so switching accounts requires quitting Antigravity, waiting for `language_server` to flush and exit, swapping credentials, and relaunching the app. Always finish or acknowledge running tasks before switching.
3. **Platform Verification & Windows Credential Reading**:
   - **Windows (native)** & **WSL2 + Windows host** have been verified end-to-end on real desktops. On native Windows, loading or refreshing the panel starts zero child processes. **Save Account** and the backup before switching or **+ Add Account** read `gemini:antigravity` from Windows Credential Manager when the token file is absent. If all readers fail, the action stops before restart.
   - **Linux (desktop)** & **macOS** pass full unit/integration CI suites (`ubuntu-latest`, `macos-latest`), while physical macOS desktop GUI switching has not yet been manually tested on real Apple hardware — issue reports and PRs from macOS users are very welcome.
4. **Native Sign-In Only, No Browser OAuth Fallback**: Account addition depends on the official Antigravity / Google sign-in flow. There is no browser OAuth fallback, no PKCE loopback listener, and no runtime binary extraction in 0.4.0; if Google sign-in is blocked in your environment, the plugin cannot add that account. `ANTIGRAVITY_AGENTAPI_EXE` only overrides executable discovery for local RPC / relaunch and is not used for OAuth client extraction.
5. **Static Manifest Display Name**: Antigravity's `plugin.json` and `sidecar.json` currently accept static strings only (no OS-locale manifest switching), so the Plugins manager entry and side-pane tab always display **`Account Switcher`**, while all content inside the panel supports **`中 / EN`** switching.
6. **Inactive Quota Values Are Local Estimates**: Inactive accounts show the last local snapshot with reset-time projection, not live usage. A bucket past its `resetTime` is optimistically projected to 100%, and snapshots older than 24 hours are marked stale. Actual calibration happens only after switching to that account and querying the active local `language_server`; there is intentionally no remote quota endpoint or background sync.
7. **Independent Community Project**: This is an independent open-source plugin and is not affiliated with or endorsed by Google. All credentials remain encrypted locally on your machine.

## Requirements

- **Node.js >= 18** (`node` binary must be on the `PATH` visible to Antigravity's `language_server`).
- **Zero npm packages**: No `npm install` step is required.

> **Important `PATH` note for Unix (WSL2 / macOS / Linux):**  
> Antigravity's `language_server` may run outside your interactive shell environment and might not load `~/.bashrc`, `~/.zshrc`, or `nvm` initialization scripts. Ensure `node` is available on a standard system `PATH` directory (such as `/usr/local/bin/node`, or `/opt/homebrew/bin/node` on macOS if inherited by GUI apps). On Windows, ensure `node.exe` is on your User or System `PATH`.

## Installation

### Option A: Clone Directly into the Global Plugins Folder (Recommended)

- **Unix (WSL2 / macOS / Linux)**:

  ```bash
  git clone https://github.com/moon16u/antigravity-account-switcher.git ~/.gemini/config/plugins/antigravity-account-switcher
  ```

- **Windows (PowerShell or CMD)**:

  ```powershell
  git clone https://github.com/moon16u/antigravity-account-switcher.git "$env:USERPROFILE\.gemini\config\plugins\antigravity-account-switcher"
  ```

### Option B: Clone Elsewhere & Register via `plugins.json`

1. Clone this repository into any directory (for example `/path/to/antigravity-plugins/antigravity-account-switcher`).
2. Add the parent directory and `"include_only": ["antigravity-account-switcher"]` to `plugins.json` (merge into existing arrays if present):

   - **Unix (WSL2 / macOS / Linux)** — `~/.gemini/config/plugins.json`:

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

   - **Windows** — `%USERPROFILE%\.gemini\config\plugins.json`:

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

3. **Restart Antigravity** and open the **`Account Switcher`** tab in the right auxiliary pane (also reachable via the **Plugins** page).

## Optional Environment Variables

| Variable | Purpose |
| --- | --- |
| `ANTIGRAVITY_SWITCHER_RELAUNCH_EXE` | Custom executable path (or `.vbs` launcher on Windows/WSL2) used to relaunch Antigravity after switching. |
| `ANTIGRAVITY_AGENTAPI_EXE` | Overrides the `language_server` / `agentapi` executable path used for local RPC, auto-resume, and macOS `.app` relaunch discovery. Not used for OAuth client extraction in 0.4.0. |
| `ANTIGRAVITY_APP_STORAGE_PATH` | Overrides the path to `app_storage.json` (`runInBackground` detection and opt-in onboarding sync). |
| `ANTIGRAVITY_WIN_APPDATA` / `ANTIGRAVITY_WIN_LOCALAPPDATA` | Overrides Windows `%APPDATA%` / `%LOCALAPPDATA%` discovery under WSL2 when Windows interop or `PATH` inference is unavailable. |
| `ANTIGRAVITY_GEMINI_DIR` / `ANTIGRAVITY_EXECUTABLE_DATA_DIR` | Overrides `~/.gemini` and the encrypted sidecar data directory. |

## Runtime Data Directory

Runtime data is completely separated from plugin source files. Under Antigravity 2.0 (`ANTIGRAVITY_EXECUTABLE_DATA_DIR`), data lives at `~/.gemini/antigravity/sidecar_data/antigravity-account-switcher/switcher/data/` (or `%USERPROFILE%\.gemini\antigravity\sidecar_data\antigravity-account-switcher\switcher\data\` on Windows; standalone fallback is `~/.gemini/antigravity/plugin_data/antigravity-account-switcher/`):

- `vault.key` — Randomly generated 256-bit AES master key (`0600` on Unix)
- `vault.enc.json` — AES-256-GCM encrypted account vault (`0600` on Unix)
- `last-token.enc.json` — AES-256-GCM encrypted backup of the active token captured before switching or native re-login (`0600` on Unix)
- `jobs/job-<uuid>.enc.json` — Single-use encrypted switch job deleted immediately upon worker pickup
- `switch.log` — Sanitized audit and diagnostic log (masked emails and error codes only; never logs tokens or secrets)
- `settings.json` — Quota guard, dynamic threshold, natural pause, onboarding sync, and Agent auto-switch / auto-resume preferences (`0600` on Unix)
- `quota-snapshots.json` — Local per-account quota summary cache used for reset projection and inactive-account rendering (`0600` on Unix)
- `quota-alert.json` — Sanitized active-account quota alert snapshot and best healthy backup candidate
- `quota-refresh-trigger.json` — Throttled `PostInvocation` trigger watched by the Sidecar via `fs.watch`
- `hook-alert-state.json` — Per-conversation, per-level `PreInvocation` hook deduplication state

## Security Architecture

- **Token Gate & Rate Limiting**: All API endpoints require the host-injected `ANTIGRAVITY_SIDECAR_UI_TOKEN` (`403` when absent) and enforce sliding-window rate limits (`60 req/min` reads, `10 req/min` writes, `30 req/min` usage queries) plus a `15s` switch lock.
- **Strict CSP & DOM-Safe Frontend**: Responses include `Content-Security-Policy` (`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'`), `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and `Permissions-Policy`. The web UI uses `textContent` and DOM builders exclusively (no `innerHTML`, `eval`, or inline scripts/styles).
- **Cryptographic Integrity (Fail-Closed)**: Every encrypted envelope uses AES-256-GCM with a unique 12-byte IV and 16-byte authentication tag; any tampering rejects decryption.
- **Filesystem & Process Hardening**: Rejects symlinks (`lstatSync`) on sensitive files and directories, enforces path-boundary containment (`assertInsideDir`), writes atomically via temp file + `renameSync`, validates UUIDs, strips prototype-pollution keys (`__proto__`, `constructor`, `prototype`), and invokes child processes strictly with argument arrays (`execFileSync` / `spawn`, never `shell: true`). Active-process inspection logs only executable basename + PID to avoid exposing command-line arguments.
- **Native Windows credential reads** use Python `ctypes` to call `CredReadW`. If Python cannot complete the read, the switcher tries `pwsh`, then `powershell.exe`, with plain `-Command` and neither `-WindowStyle Hidden` nor `-EncodedCommand`. A confirmed missing entry ends the lookup immediately.
- **Local-Only Network & OAuth Surface**: The plugin opens no outbound HTTPS connections to Google APIs, runs no OAuth token exchange, and hosts no OAuth callback listener. The only HTTP client path is the local `language_server` RPC, restricted to loopback hosts with the host-provided CSRF token. Hooks perform no network or RPC calls: `PostInvocation` only writes a throttled trigger file, and `PreInvocation` only reads local snapshots/settings and updates local deduplication state. Binary OAuth client extraction, browser PKCE, remote tier sync, and remote quota calls are absent by design.

## Repository Structure

- `plugin.json` — Plugin manifest (`antigravity-account-switcher`, display name `Account Switcher`)
- `mcp_config.json` — Bundled stdio MCP server declaration (`switcher`)
- `hooks.json` — Bundled `PreInvocation` and `PostInvocation` quota-guard hook declarations (`quota-guard`)
- `scripts/mcp-server.mjs` — Zero-dependency MCP server (`0.4.0`) exposing account status, local-snapshot quota, and safe switch tools
- `scripts/quota-hook.mjs` — Short-lived event-driven hook: level-aware `PreInvocation` alert and throttled `PostInvocation` trigger
- `skills/switch-account/SKILL.md` — `/switch-account` skill workflow for Antigravity Agents
- `assets/logo.svg` — Plugin icon
- `sidecars/switcher/sidecar.json` — Sidecar entrypoint (`command: "node"`, `args: ["main.mjs"]`, `SIDECAR_UI_ENTRYPOINT_AUX_PANE`)
- `sidecars/switcher/main.mjs` — Sidecar HTTP server, API routes, local quota refresh via `fs.watch`, security gates, and rate limiting
- `sidecars/switcher/quota-guard.mjs` — Quota threshold evaluation (soft/hard), best-backup selection, guard settings, dynamic thresholds, natural pause, and live hub discovery
- `sidecars/switcher/quota-snapshots.mjs` — Local quota snapshot cache, active-account `language_server` query, reset-time projection, and >24h staleness detection
- `sidecars/switcher/platform.mjs` — Cross-platform runtime detection, path translation, `language_server` / `agentapi` discovery, onboarding sync, and Antigravity relaunch
- `sidecars/switcher/vault.mjs` — AES-256-GCM vault, atomic file writes, symlink/boundary guards, and token normalization
- `sidecars/switcher/token-store.mjs` — Cross-platform token store (macOS Keychain & Linux Secret Service keyring, on-demand Windows Credential Manager reads and `cmdkey.exe`/file handoff, and WSL2 file store)
- `sidecars/switcher/active-work.mjs` — Pre-switch RPC (loopback-only) and user child-process detector
- `sidecars/switcher/switcher-worker.mjs` — Detached switch, native re-login, and desktop restart worker
- `sidecars/switcher/public/` — Auxiliary-pane web UI (`index.html`, `app.js`, `styles.css`)
- `sidecars/switcher/test/` — Isolated unit and integration test suites (`switcher.test.mjs`, `mcp-and-hook.test.mjs`)
- `CHANGELOG.md` / `CHANGELOG.zh-CN.md` — Bilingual release changelog (English / Simplified Chinese)

## Running Tests

Run the test suite on Node.js >= 18:

```bash
node --test sidecars/switcher/test/switcher.test.mjs sidecars/switcher/test/mcp-and-hook.test.mjs
```

Run syntax checks across all `.mjs` modules and frontend script:

```bash
for f in scripts/*.mjs sidecars/switcher/*.mjs sidecars/switcher/test/*.mjs sidecars/switcher/public/app.js; do node --check "$f"; done
```

## License

[MIT](LICENSE)
