---
name: switch-account
description: >-
  Check Antigravity account status, inspect Gemini/3P quota, and safely switch
  accounts via the bundled MCP server (`antigravity-account-switcher_switcher`).
  `get_quota` reads live quota from the local `language_server` RPC for the
  active account and uses local quota snapshots plus reset-countdown projection
  for inactive accounts (no remote internal API polling). Use when the user asks
  to check saved accounts or quota, switch to another Antigravity account, or
  when a low-quota alert fires (soft wrap-up or hard floor). Do NOT use for
  non-Antigravity OAuth tokens, and do not collect credentials for a new
  account: guide the user to native sign-in via "+ Add Account" in the Account
  Switcher sidebar instead.
---

# Antigravity Account Switching Workflow

Use the bundled MCP server tools (`antigravity-account-switcher_switcher`):

1. **Inspect status & saved accounts**:
   - Call `get_switcher_status` or `list_accounts` to view masked accounts, the current active account, and guard settings.
   - Never look for, print, or handle raw OAuth token files directly.

2. **Check quota (local-first, v0.4.0)**:
   - Call `get_quota` (`includeAll: true`) for a quota overview.
   - The **active account** is queried through the live local `language_server` RPC.
   - **Inactive accounts** are read from local quota snapshots with reset-time countdown projection — no remote internal API polling and zero remote HTTP calls.
   - Inspect each account's `source` (`live` / `snapshot` / `none`), `capturedAt`, `isStale`, `estimatedAnyReset`, and `hasSnapshot` before trusting a number. Prefer `bestCandidate` for a healthy backup.

3. **React to quota alerts**:
   - **Soft wrap-up alert**: quota is entering the wrap-up zone. Finish the smallest verifiable sub-step, keep the workspace clean, avoid starting large refactors or long tool chains, and prepare to switch at a natural breakpoint. Do not force a switch yet.
   - **Hard floor alert**: finish the current atomic write/step, then switch with `pickBest: true` (when auto-switch is enabled) or ask the user to confirm. Never pass `force: true` without explicit user confirmation.

4. **Safe switch & restart**:
   - Call `switch_account` with:
     - `accountId`, or `pickBest: true` to select the healthiest backup from local snapshots/reset projection (falls back to the least-recently-used unsnapshotted backup on first use).
     - `conversationId` (always pass the current conversation ID when available so active-work detection excludes this conversation and optional auto-resume can wake it after restart).
     - `reason` (short summary).
   - Guard settings are respected automatically, including opt-in onboarding-modal sync and the natural relaunch pause.
   - **Active-work guardrail**: If `switch_account` reports `ACTIVE_WORK_RUNNING` (other running chats, background tasks, or terminals), inform the user and wait for explicit confirmation before forcing.
   - Immediately after `switch_account` succeeds, output a brief closing summary and end the current turn (no further tool calls), allowing `switcher-worker` to detect that this turn finished cleanly and restart Antigravity immediately. After restart, wait until MCP tools are ready before waking a new turn.

5. **Add a new account (native sign-in)**:
   - Tell the user to use **"+ Add Account"** in the Account Switcher sidebar. That backs up the current account and restarts Antigravity into the official Google sign-in flow. Do not ask for passwords, OAuth codes, or token files.
