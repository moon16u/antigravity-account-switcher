English | [简体中文](README.zh-CN.md)

# Antigravity Account Switcher

[![CI](https://github.com/moon16u/antigravity-account-switcher/actions/workflows/ci.yml/badge.svg)](https://github.com/moon16u/antigravity-account-switcher/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node.js >= 18](https://img.shields.io/badge/Node.js-%3E%3D%2018-339933)
![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-brightgreen)

A cross-platform auxiliary-pane sidecar plugin (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`) for **Google Antigravity 2.0** that manages multiple local OAuth accounts, encrypts credentials at rest, displays per-account quota usage, and switches accounts cleanly across desktop and WSL2 environments — built on **Node.js >= 18** with **zero external npm dependencies**.

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

- **Current Account Inspection & Masked Display**: Reads the active session token from OS Keyring on **macOS** (Keychain `gemini`/`antigravity`) and **Linux desktop** (Secret Service via `secret-tool` when `DBUS_SESSION_BUS_ADDRESS` is set), or from `~/.gemini/jetski-standalone-oauth-token` on **WSL2** and non-keyring environments. On **native Windows** (zero background PowerShell subprocesses), combines `LanguageServerService/GetUserStatus` with the encrypted vault to show active sign-in status cleanly and relies on **`+ Add Account`** to enroll accounts. Emails are masked by default with a one-click header toggle to reveal full addresses.
- **No-Logout Browser OAuth Addition (`+ Add Account`)**:
  - Dynamically extracts the official OAuth client configuration at runtime from your local Antigravity `language_server` / `language_server.exe` binary (**ELF64**, **PE64**, and single/Universal Fat **Mach-O 64-bit** — zero client secrets stored in this repository).
  - Runs a Google OAuth 2.0 **PKCE S256** flow with a `127.0.0.1:0` loopback callback, single-use constant-time (`timingSafeEqual`) `state` verification, and a 5-minute TTL.
  - Displays a copyable authorization URL so you can sign in inside an incognito window or another browser profile without signing out of your active Antigravity session.
  - Includes **Native Sign-in (Fallback)** in Tools for environments where browser OAuth is blocked (backs up the active account, quits the desktop app, and relaunches signed out).
- **Non-Active Tier Sync & Per-Account `View usage` Panel**:
  - Automatically resolves subscription tiers (`Google AI Pro`, `Google AI Ultra`, `Free`, etc.) via `v1internal:loadCodeAssist` upon browser OAuth addition, background fill for uncached accounts, and header Refresh — without switching accounts or altering last-used timestamps.
  - Each saved account card includes a collapsible **`View usage`** panel rendering Antigravity-style quota groups and circular rings (querying local `language_server` `RetrieveUserQuotaSummary` directly for the active account with remote `v1internal:retrieveUserQuotaSummary` fallback for non-active accounts, using `antigravity/hub/<ver>` headers so advanced model groups such as Argon/Carbon stay intact).
  - Smart caching & refresh: initial expansion after opening/reopening the sidebar honors the `30s` backend cache; re-expanding within the same session automatically refreshes when more than `10s` have elapsed since the last successful fetch (reusing loaded data within `10s`); staying expanded leaves refreshes to the manual refresh controls.
- **Automatic HTTP Proxy Support**:
  - Honors `HTTPS_PROXY` / `https_proxy`, `HTTP_PROXY` / `http_proxy`, and `NO_PROXY` / `no_proxy`.
  - **Node.js >= 24.5 or >= 22.21**: Uses Node's native `https.Agent({ proxyEnv })` directly without needing `--use-env-proxy` in `sidecar.json`, keeping Node 18/20/22/24 startup uniform.
  - **Node.js 18 / 20 / earlier 22**: Automatically falls back to the built-in `ProxyConnectAgent`, establishing an HTTP `CONNECT` tunnel (including Basic `Proxy-Authorization` credentials and `NO_PROXY` bypass matching) and upgrading to TLS >= 1.2 with strict certificate verification.
- **AES-256-GCM Encrypted Vault**:
  - Encrypts saved accounts (`vault.enc.json`), automatic pre-switch active-token backups (`last-token.enc.json`), and single-use switch jobs (`jobs/job-<uuid>.enc.json`) with a local 256-bit random master key (`vault.key`).
  - Enforces `0700` directory permissions and `0600` file permissions on Unix (WSL2, macOS, and Linux).
- **Keep In Menu Bar Adaptive Fast Shutdown & Relaunch**:
  - Executes switches in a detached worker (`switcher-worker.mjs`: pure Node.js double-fork `--detach-worker` on native Windows outside the `Antigravity.exe` tree, or `systemd-run --user --scope` on Linux/WSL2 when available — zero hidden `powershell.exe` calls).
  - On **Windows / WSL2**, reads `app_storage.json` (`runInBackground` — Antigravity's *Keep In Menu Bar* setting) and inspects `tasklist /V /FO CSV` to identify visible main `Antigravity.exe` windows, closes them first before cleaning up tray processes (native Windows omits `/T`), and signals WSL2 `language_server` (`SIGTERM`) to flush cleanly. On native Windows, clears the active `gemini:antigravity` Credential Manager entry via `cmdkey.exe` and writes `~/.gemini/jetski-standalone-oauth-token` (which `language_server.exe` imports on startup), then relaunches via `%APPDATA%\Antigravity\launch-env-proxy.vbs` (optional proxy wrapper if present), `Antigravity.exe`, or `ANTIGRAVITY_SWITCHER_RELAUNCH_EXE`.
  - On **macOS**, quits cleanly via `/usr/bin/osascript` (`SIGTERM` fallback) and relaunches via `/usr/bin/open -a`.
  - On **Linux**, terminates desktop and `language_server` processes via `SIGTERM` and relaunches the captured desktop binary.
- **Pre-Switch Active-Work Guard & Bilingual UI (`中 / EN`)**:
  - Checks `GetAllCascadeTrajectories`, `ListBackgroundTasks`, and `ListTerminals` via `language_server` RPC plus active user child processes before switching; pauses with **Recheck & Switch**, **Cancel**, or audited **Force Switch** (`FORCE_SWITCH_REQUESTED` in `switch.log`) when work is running.
  - Built-in instant **`中 / EN`** toggle switches all in-panel UI copy immediately.

## Scope, Boundaries & Known Limitations

1. **Consumer Accounts Only**: Only personal Google accounts (`auth_method: "consumer"`) are supported; enterprise / Google Workspace SSO tokens are rejected.
2. **Restart Required on Switch**: Antigravity holds the active OAuth session in its running `language_server` process, so switching accounts requires quitting Antigravity, waiting for `language_server` to flush and exit, swapping credentials, and relaunching the app. Always finish or acknowledge running tasks before switching.
3. **Platform Verification & Windows Credential Reading**:
   - **Windows (native)** & **WSL2 + Windows host** have been verified end-to-end on real desktops. On native Windows, this plugin deliberately avoids launching hidden PowerShell/WMI commands to read Credential Manager (preventing security-suite false positives); enroll accounts already signed in on Windows once via **`+ Add Account`**.
   - **Linux (desktop)** & **macOS** pass full unit/integration CI suites (`ubuntu-latest`, `macos-latest`), while physical macOS desktop GUI switching has not yet been manually tested on real Apple hardware — issue reports and PRs from macOS users are very welcome.
4. **Local Binary Extraction Dependency**: Zero OAuth client secrets are bundled; the plugin extracts client credentials at runtime from your local `language_server` binary. If a future Antigravity update moves the binary or changes its compiled layout, set `ANTIGRAVITY_AGENTAPI_EXE` or use **`Native Sign-in (Fallback)`**.
5. **Static Manifest Display Name**: Antigravity's `plugin.json` and `sidecar.json` currently accept static strings only (no OS-locale manifest switching), so the Plugins manager entry and side-pane tab always display **`Account Switcher`**, while all content inside the panel supports **`中 / EN`** switching.
6. **Quota & Tier Endpoints**: Tier sync and non-active quota views depend on Google Cloud Code endpoints (`v1internal:loadCodeAssist`, `v1internal:retrieveUserQuotaSummary`, `30 req/min` rate limit). Upstream API changes or proxy network errors may prevent tier/quota updates while leaving local account switching unaffected.
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
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | HTTP proxy and bypass rules for Google OAuth token exchange and Cloud Code requests (lowercase variants also supported). |
| `ANTIGRAVITY_SWITCHER_RELAUNCH_EXE` | Custom executable path (or `.vbs` launcher on Windows/WSL2) used to relaunch Antigravity after switching. |
| `ANTIGRAVITY_AGENTAPI_EXE` | Overrides the `language_server` binary path used for OAuth client extraction (also used on macOS to locate the `.app` bundle). |
| `ANTIGRAVITY_APP_STORAGE_PATH` | Overrides the path to `app_storage.json` (`runInBackground` detection). |
| `ANTIGRAVITY_WIN_APPDATA` / `ANTIGRAVITY_WIN_LOCALAPPDATA` | Overrides Windows `%APPDATA%` / `%LOCALAPPDATA%` discovery under WSL2 when Windows interop or `PATH` inference is unavailable. |
| `ANTIGRAVITY_GEMINI_DIR` / `ANTIGRAVITY_EXECUTABLE_DATA_DIR` | Overrides `~/.gemini` and the encrypted sidecar data directory. |

## Runtime Data Directory

Runtime data is completely separated from plugin source files. Under Antigravity 2.0 (`ANTIGRAVITY_EXECUTABLE_DATA_DIR`), data lives at `~/.gemini/antigravity/sidecar_data/antigravity-account-switcher/switcher/data/` (or `%USERPROFILE%\.gemini\antigravity\sidecar_data\antigravity-account-switcher\switcher\data\` on Windows; standalone fallback is `~/.gemini/antigravity/plugin_data/antigravity-account-switcher/`):

- `vault.key` — Randomly generated 256-bit AES master key (`0600` on Unix)
- `vault.enc.json` — AES-256-GCM encrypted account vault (`0600` on Unix)
- `last-token.enc.json` — AES-256-GCM encrypted backup of the active token captured before switching (`0600` on Unix)
- `jobs/job-<uuid>.enc.json` — Single-use encrypted switch job deleted immediately upon worker pickup
- `switch.log` — Sanitized audit and diagnostic log (masked emails and error codes only; never logs tokens or secrets)

## Security Architecture

- **Token Gate & Rate Limiting**: All API endpoints require the host-injected `ANTIGRAVITY_SIDECAR_UI_TOKEN` (`403` when absent) and enforce sliding-window rate limits (`60 req/min` reads, `10 req/min` writes, `30 req/min` tier/usage queries) plus a `15s` switch lock.
- **Strict CSP & DOM-Safe Frontend**: Responses include `Content-Security-Policy` (`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'`), `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and `Permissions-Policy`. The web UI uses `textContent` and DOM builders exclusively (no `innerHTML`, `eval`, or inline scripts/styles).
- **Cryptographic Integrity (Fail-Closed)**: Every encrypted envelope uses AES-256-GCM with a unique 12-byte IV and 16-byte authentication tag; any tampering rejects decryption.
- **Filesystem & Process Hardening**: Rejects symlinks (`lstatSync`) on sensitive files and directories, enforces path-boundary containment (`assertInsideDir`), writes atomically via temp file + `renameSync`, validates UUIDs, strips prototype-pollution keys (`__proto__`, `constructor`, `prototype`), and invokes child processes strictly with argument arrays (`execFileSync` / `spawn`, never `shell: true`). Active-process inspection logs only executable basename + PID to avoid exposing command-line arguments.
- **OAuth & Cloud Code Hardening**: Extracts client credentials dynamically from the local signed binary, enforces PKCE S256 + `crypto.timingSafeEqual` single-use `state`, binds callback only on `127.0.0.1:0` with immediate listener teardown, serves static `default-src 'none'` callback pages, enforces TLS >= 1.2 (`rejectUnauthorized: true`), and restricts outbound HTTPS requests strictly to `oauth2.googleapis.com`, `www.googleapis.com`, `daily-cloudcode-pa.googleapis.com`, and `cloudcode-pa.googleapis.com`.

## Repository Structure

- `plugin.json` — Plugin manifest (`antigravity-account-switcher`, display name `Account Switcher`)
- `assets/logo.svg` — Plugin icon
- `sidecars/switcher/sidecar.json` — Sidecar entrypoint (`command: "node"`, `args: ["main.mjs"]`, `SIDECAR_UI_ENTRYPOINT_AUX_PANE`)
- `sidecars/switcher/main.mjs` — Sidecar HTTP server, API routes, security gates, and rate limiting
- `sidecars/switcher/platform.mjs` — Cross-platform runtime detection, path translation, binary discovery, browser launch, and Antigravity relaunch
- `sidecars/switcher/binary-oauth.mjs` — ELF64, PE64, and Mach-O 64-bit / Universal Fat binary OAuth client extractor
- `sidecars/switcher/oauth.mjs` — PKCE S256 loopback OAuth manager & dual-mode proxy HTTPS client
- `sidecars/switcher/cloudcode.mjs` — Subscription tier sync (`loadCodeAssist`), quota summary retrieval (`retrieveUserQuotaSummary` / local LS), and OAuth token refresh helper
- `sidecars/switcher/vault.mjs` — AES-256-GCM vault, atomic file writes, symlink/boundary guards, and token normalization
- `sidecars/switcher/token-store.mjs` — Cross-platform token store (macOS Keychain & Linux Secret Service keyring, Windows `cmdkey.exe` + file handoff, and WSL2 file store)
- `sidecars/switcher/active-work.mjs` — Pre-switch RPC and user child-process detector
- `sidecars/switcher/switcher-worker.mjs` — Detached switch and desktop restart worker
- `sidecars/switcher/public/` — Auxiliary-pane web UI (`index.html`, `app.js`, `styles.css`)
- `sidecars/switcher/test/switcher.test.mjs` — Isolated unit and integration test suite

## Running Tests

Run the test suite on Node.js >= 18:

```bash
node --test sidecars/switcher/test/switcher.test.mjs
```

On Node.js >= 24.5, also verify native proxy mode with `--use-env-proxy`:

```bash
node --use-env-proxy --test sidecars/switcher/test/switcher.test.mjs
```

Run syntax checks across all `.mjs` modules and frontend script:

```bash
for f in sidecars/switcher/*.mjs sidecars/switcher/test/*.mjs sidecars/switcher/public/app.js; do node --check "$f"; done
```

## License

[MIT](LICENSE)
