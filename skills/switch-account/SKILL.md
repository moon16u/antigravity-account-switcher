---
name: switch-account
description: >-
  Check Antigravity account status, inspect per-account Gemini/3P quota usage,
  and safely switch accounts via the bundled MCP server
  (`antigravity-account-switcher_switcher`). Use when the user asks to check
  saved accounts or quota, switch to another Antigravity account, or when a
  low-quota alert triggers. Do NOT use for non-Antigravity OAuth tokens or when
  adding a brand-new account via browser login (guide the user to "+ Add
  Account" in the Account Switcher sidebar instead).
---

# Antigravity Account Switching Workflow

Use the bundled MCP server tools (`antigravity-account-switcher_switcher`):

1. **Inspect status & saved accounts**:
   - Call `get_switcher_status` or `list_accounts` to view masked accounts, current active account, and guard settings.
   - Never look for or print raw OAuth token files directly.

2. **Check quota across accounts**:
   - Call `get_quota` (`includeAll: true`) to see Gemini Weekly & 5h percentages for all saved accounts and identify `bestCandidate`.

3. **Safe switch & restart**:
   - Call `switch_account` with:
     - `accountId` (or `pickBest: true` to pick the healthiest backup account above threshold)
     - `conversationId` (always pass the current conversation ID when available so active-work detection excludes this conversation and optional auto-resume can wake it after restart)
     - `reason` (short summary)
   - **Active-work guardrail**: Never pass `force: true` on your own. If `switch_account` reports `ACTIVE_WORK_RUNNING` (other running chats, background tasks, or terminals), inform the user and wait for explicit confirmation before forcing.
   - Because switching restarts Antigravity after a short delay (default 3 seconds), deliver a concise closing summary immediately after `switch_account` succeeds.
