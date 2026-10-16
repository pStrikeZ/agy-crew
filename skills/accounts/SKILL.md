---
name: accounts
description: Manage the agy account pool - list accounts, read quota and cooldown state, import, enable, disable, remove, and guide interactive sign-in. Use when the user asks "which agy accounts are available", "add an agy account", "agy quota", "why is the agy account cooling down", or "remove/disable an agy account". This is an operations skill for the pool; the persona skills select accounts automatically.
allowed-tools: Bash(node:*), AskUserQuestion
---

# agy accounts

Inspect and manage the pool of agy accounts that background jobs run on. Pool state is global per user (`~/.agy-crew/pool.json`, overridable with `AGY_CREW_HOME`), not per repository.

This file lives at `<plugin-root>/skills/accounts/SKILL.md`:

```bash
node "<skill-dir>/../../companion/agy-companion.mjs" accounts <subcommand> [args]
```

> [!IMPORTANT]
> Run this command **unsandboxed**, like every companion command. Details: `../jobs/references/troubleshooting.md`.

## Live and pool accounts

- **live** is the user's own agy login. It is never part of the pool: `auto` never picks it, it never lends credentials and never borrows. It runs only when explicitly requested (`--account live`) or when the pool has no enabled account, so an empty pool behaves exactly as before.
- **Pool accounts** are named, private agy logins stored under `~/.agy-crew/accounts/<name>/home`. Runs pick one automatically; the user does not need to name it.

## Commands

| Command | Purpose |
| --- | --- |
| `accounts list [--json]` | Aligned tables: each account with email, state and last use (plus a line for live), then a `QUOTA` table (per pool: remaining percent and reset time for the 5h and weekly windows, and how old the snapshot is), then `COOLDOWNS` when any are active. Start here. |
| `accounts quota [<name>...] [--refresh] [--json]` | The same `QUOTA` table and `COOLDOWNS` section, from cached snapshots. `--refresh` queries Google's Cloud Code service and updates the snapshots; it is the only subcommand that uses the network. |
| `accounts import <name> --home <dir>` | Copy the token (and `settings.json`) from an existing HOME-shaped directory, for example an agy-cli-manager account. |
| `accounts enable <name>` / `accounts disable <name>` | Put an account into or out of automatic selection. |
| `accounts cooldown clear <name> [--family <f>]` | Drop a recorded quota cooldown. Use it only when the user says the quota is back. |
| `accounts remove <name> [--yes]` | Delete an account. Without `--yes` it only prints what would be deleted. |
| `accounts login <name>` | Interactive sign-in. **Do not run this yourself**, see below. |
| `start <name> [-- <agy args>...]` | Interactive agy as that account in the current directory, holding it until agy exits. Needs the user's terminal: **do not run this yourself**; tell the user to run `agy-crew start <name>`. |

Add `--json` when you need to parse the output; otherwise read the table.

## Adding an account

`accounts login <name>` opens a browser sign-in and waits for the user to exit agy. It cannot work from a background or sandboxed command. Tell the user to run this in their own terminal:

```bash
agy-crew accounts login <name>
```

If the `agy-crew` command is not on their PATH, give them the full `node "<skill-dir>/../../companion/agy-companion.mjs" accounts login <name>` line instead. Then run `accounts list` to confirm the account shows as ready. Names are lowercase letters, digits, `.`, `_` and `-`; `live` and `auto` are reserved. The same Google account cannot be added twice. To refresh an expired sign-in, the user runs the same login command for the existing name.

If the user already has accounts elsewhere, offer `accounts import` instead of a new sign-in; it copies files and needs no browser.

## Reading the state

| State in `list` | Meaning | Action |
| --- | --- | --- |
| `ready` | Idle and usable | None. |
| `busy n` | `n` runs hold it | Normal. A new `auto` run prefers an idle account. |
| `held` | Another process outside agy-crew is using its credential | Runs skip it; a conversation bound to it borrows another account's credential. Leave it alone; the hold ends when that process releases it or exits. |
| `cooling` | A model family hit its quota; other families still work. The `COOLDOWNS` section lists each family with `until <time> (in <duration>)` | Wait until then, use another model family or account. Do not clear the cooldown on your own. |
| `needs login` | agy rejected the credential | Tell the user to run `agy-crew accounts login <name>`. Never retry. |
| `disabled` | Excluded from selection | `enable` only if the user asks. |

Cooldowns are per account and per model family (for example `gemini-3.8-flash`, whatever the effort suffix). The `QUOTA` table shows the short-window (5H) and weekly remaining percent and reset time per quota pool, with times in local clock (`HH:MM` for today, otherwise `MM-DD HH:MM`) and `AS OF` giving the snapshot age; they are cached, so `quota --refresh` is needed for current numbers. Refresh only when the user asks about current quota or a run failed with a quota error, not for routine checks.

## Choosing an account for a run

Run commands accept `--account auto|live|<name>` (default `auto`, or the `AGY_CREW_ACCOUNT` environment variable):

- `auto` picks an idle ready account, then the one with the most known quota left. With no enabled pool account it uses live.
- `<name>` forces that account; it fails when the account is unknown, disabled, cooling or needs login.
- `live` forces the user's own login.

A conversation stays bound to the account that created it; continuing it with a different explicit `--account` is refused. Quota handling during runs is described in `../jobs/SKILL.md`.

## Rules

- `remove` is destructive: it deletes the account's stored login, its conversations become unusable, and re-adding needs a new sign-in. Run it without `--yes` first, show the user what would be deleted, ask with `AskUserQuestion`, and add `--yes` only after an explicit yes. `remove`, `login` and re-login refuse while the account is in use.
- Never read or print token files under `~/.agy-crew/accounts/`.
- Do not create, import or remove accounts unprompted. Report the pool state and let the user decide.
- Quote companion errors exactly and add a concise diagnosis. Exit 0 is success, 1 is an error.
