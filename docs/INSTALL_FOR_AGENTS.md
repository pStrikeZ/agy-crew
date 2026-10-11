# Installing agy-crew — a guide for coding agents

You are a coding agent that has been asked to install and verify the **agy-crew** plugin. Follow this file top to bottom. When you finish (or get blocked), report the outcome to the user **in the user's own language** — the language they have been using with you, not necessarily English.

> [!IMPORTANT]
> If you reached this file through a URL, read its **raw** text — `curl -fsSL https://raw.githubusercontent.com/pStrikeZ/agy-crew/master/docs/INSTALL_FOR_AGENTS.md` — or clone the repo. Fetching the rendered page through a web tool that summarises before handing you the content can return a paraphrase, and a paraphrased install command is a broken install command. If all you have is a summary, stop and fetch the raw file.

## 0. Prerequisites

1. **`agy` binary** — run `agy --version`. Use a version supporting `stream-json` (lifecycle smoke tests use v1.1.27). If it is missing, do **not** install it yourself: give the user the official install page <https://antigravity.google/docs/cli/install> (macOS/Linux: `curl -fsSL https://antigravity.google/cli/install.sh | bash`) and wait for them to install and authenticate (`agy` run interactively once handles login).
2. **Node.js** — run `node --version` (20 or newer). The companion script uses only the Node standard library.
3. **No agy-staff on this machine.** agy-crew is a fork of the upstream agy-staff, and the two must not be installed together: the skills would appear twice and both companions would write the same per-repository state. `agy-crew install` refuses to run when it finds agy-staff. If you find agy-staff (the `agy@agy-staff` Claude Code plugin, an agy-staff plugin in Codex, an `agy-staff@…` entry in `opencode.json`, an agy-staff Pi package, or upstream flat skills such as `agy-ask` and `agy-jobs` in a harness skills directory), **stop and ask the user before removing anything**. Never remove it silently. With the user's agreement, the removal is: Claude Code `claude plugin uninstall agy@agy-staff`; Codex remove the agy-staff plugin and restart; OpenCode remove the `agy-staff@…` entry from `opencode.json`; Pi uninstall the agy-staff package; and delete any upstream flat skills.

## 1. Detect which harness you are running in

You normally know which product you are. If unsure, check:

- **Claude Code** — you have `/plugin` slash commands, project instructions arrive via `CLAUDE.md`, and your Bash tool typically has `CLAUDECODE=1` in the environment. → Follow section 2a.
- **Codex** — you invoke skills with `$name` syntax, follow `AGENTS.md`, and plugins are managed through the `codex` CLI. → Follow section 2b.
- **Pi** — you invoke skills with `/skill:name` and manage packages with `pi install`. → Follow section 2c.
- **OpenCode V1** — you use `opencode`, its `plugin` config or `opencode plugin` installer, and native `/agy-crew-*` commands. Verified with OpenCode 1.18.34; V2 is not covered. → Follow section 2d.
- **Oh My Pi / DeepSeek Harness** — supported through route A only (`--hosts omp`, `--hosts dsh`).
- **Anything else** — this package documents Claude Code, Codex, Pi, OpenCode V1, Oh My Pi and DeepSeek Harness. Report the unsupported harness and stop.

### Route A (preferred): the `agy-crew` terminal command

If `node` and `npm` are available, install the command and let it put the skills into the harness you are running in. It supports Claude Code (`claude`), Codex (`codex`), Oh My Pi (`omp`), OpenCode (`opencode`) and DeepSeek Harness (`dsh`); it does not cover Pi, which uses section 2c.

```bash
npm install -g github:pStrikeZ/agy-crew
agy-crew install --dry-run --hosts <this harness>   # optional: print the plan, write nothing
agy-crew install --hosts <this harness>             # e.g. --hosts claude
agy-crew install --status --json                    # verify per-host link state and bundle
```

For a local checkout the user gave you, run `npm link` inside it instead of `npm install -g`; the skills then run from the checkout, and `agy-crew install` must be re-run after a `git pull`. The installer renders the skills once into `~/.agy-crew/bundles/<version>-<digest>/` and links `agy-crew-<persona>` directories into the harness skills directory. It never overwrites anything it did not create; on any conflict it aborts before writing and prints the paths and a remedy, which you should relay verbatim and not work around. If route A succeeds, skip to section 3.

### Route B: the harness plugin manager

Use this when route A is not possible (no npm, Pi, or the user prefers the plugin manager). Follow exactly one of the four sections below.

## 2a. Claude Code — plugin route (B) install / upgrade

Use the `claude` CLI. The `/plugin …` forms you may have seen are TUI slash commands typed by a human — you cannot execute them from your Bash tool, and there is no shell equivalent of "typing a slash command".

Install (use the local checkout path instead of the slug if the user gave you one):

```bash
claude plugin marketplace add pStrikeZ/agy-crew   # human types: /plugin marketplace add pStrikeZ/agy-crew
claude plugin install agy-crew@agy-crew                # human types: /plugin install agy-crew@agy-crew
```

Upgrade an existing install — note this is `update`, not `install`:

```bash
claude plugin marketplace update agy-crew
claude plugin update agy-crew@agy-crew
```

> [!IMPORTANT]
> `install` never upgrades: on an already-installed plugin it answers "already installed" and does nothing, whatever the version. And `update` is keyed on the **version string**, not the commit — if the published version is unchanged it answers "already at the latest version", so the user keeps running the old commit while the marketplace clone has moved on. Check by comparing `gitCommitSha` in `~/.claude/plugins/installed_plugins.json` against `git -C ~/.claude/plugins/marketplaces/agy-crew log -1`. When they differ but the version does not, force the current commit in: `claude plugin uninstall agy-crew@agy-crew && claude plugin install agy-crew@agy-crew`.

Then verify what actually landed: `claude plugin list` should show `agy-crew@agy-crew` enabled, at the version you expected. If the user is a contributor, watch for an install whose marketplace source is a **local directory** rather than the GitHub slug — that install tracks their working tree, not a release, which is fine for development but is not what "install the plugin" usually means. Say so, and offer the clean path: `claude plugin uninstall agy-crew@agy-crew`, `claude plugin marketplace remove agy-crew`, then add the slug again.

**A restart is required before the plugin is usable.** A freshly installed plugin is not in the current session's skill registry, so `/agy-crew:…` either does not resolve or — if an older copy was loaded when the session started — silently resolves to that stale copy. Tell the user to restart Claude Code, or verify without a restart using the shell fallback in section 3.

## 2b. Codex — plugin route (B) install / upgrade

Install (use the local checkout path instead of the URL if the user gave you one):

```bash
codex plugin marketplace add https://github.com/pStrikeZ/agy-crew
codex plugin add agy-crew@agy-crew
```

Then the user must restart the app — Codex caches plugins per version. Upgrades reach the app only after the plugin version is bumped **and** `codex plugin marketplace upgrade` is run, followed by a restart.

> [!IMPORTANT]
> Codex's command sandbox cannot run agy. agy binds a localhost port for its internal language server and reads its OAuth token file; the workspace-write sandbox blocks the bind and hides the token (secret protection — no `writable_roots`/`network_access` config opens it). Every companion command (both job dispatch and management commands such as `wait`, `status`, `result`) must run **unsandboxed**: the workspace needs full access, or each companion command needs escalated approval. The failure signature is `operation not permitted` on `~/.gemini/antigravity-cli/...` followed by empty output or a bogus "authentication failed".

## 2c. Pi — package route (B) install / upgrade / local development

Install (use the local checkout path if provided):

```bash
pi install git:github.com/pStrikeZ/agy-crew
```

For local development checkouts, use `pi install /absolute/path/to/checkout` (or `pi -e /absolute/path/to/checkout` for a temporary session). Run `npm run generate:pi` in the checkout if canonical skills were modified.

To upgrade an existing Git install:

```bash
pi update --extension git:github.com/pStrikeZ/agy-crew
```

Restart Pi or run `/reload` afterwards. Use `pi list` to verify the package is registered, then check Pi's skill picker for `agy-crew-lead`, `agy-crew-ask`, `agy-crewer`, `agy-crew-researcher`, `agy-crew-reviewer`, `agy-crew-implementer`, and `agy-crew-jobs`.

## 2d. OpenCode V1 — plugin route (B) install / upgrade / local development

Use the native plugin installer (verified with OpenCode 1.18.34):

```bash
opencode plugin 'agy-crew@git+https://github.com/pStrikeZ/agy-crew.git' --global
```

This installs the full package and adds it to the `plugin` array in OpenCode's config, preserving other settings. Do not replace the user's config file. The plugin registers its bundled skills automatically; do not manually clone the repository or add `skills.paths` as an installation workaround. For an explicitly provided local checkout, use `opencode plugin /absolute/path/to/checkout --global`. Regenerate modified canonical skills with `npm run generate:skills` in that checkout.

Restart OpenCode, then verify with `opencode debug skill`: expect `agy-crew-ask`, `agy-crewer`, `agy-crew-researcher`, `agy-crew-reviewer`, `agy-crew-implementer`, `agy-crew-jobs`, and `agy-crew-lead` alongside any other installed skills. OpenCode exposes these directly as `/agy-crew-*` commands. Existing skill permissions remain in effect. Install the entire package, since its companion, templates and references are relative resources.

OpenCode 1.18.34 caches the full package spec. Restarting or reinstalling the same Git spec does not guarantee an update, even with `--force`. Select a newer tag or commit containing the adapter, replace the placeholder below, then restart:

```bash
opencode plugin 'agy-crew@git+https://github.com/pStrikeZ/agy-crew.git#<tag-or-commit>' --global --force
```

Changing the ref creates a fresh cache key; `--force` replaces the configured plugin entry. Do not clear unrelated caches. This adapter covers V1, not V2.

## 3. Smoke test

Run the zero-setup ask mode — it needs no allowlist and answers in ~3 seconds:

- Installed with route A (any harness): `/agy-crew-ask reply with OK` (Codex shows it as `$agy-crew-ask`) — after the restart
- Claude Code plugin route: `/agy-crew:ask "reply with OK"` — **after the restart**, otherwise you are testing the old copy or nothing at all
- Codex: `$agy-crew:ask reply with OK`
- Pi: `/skill:agy-crew-ask reply with OK` — after restart or `/reload`
- OpenCode: `/agy-crew-ask reply with OK` — after restart

If you cannot restart the session, call the companion of the freshly installed copy directly from the shell. After route A the `agy-crew` command is the companion: `agy-crew ask --prompt "reply with OK"`. It is the same code path the skill takes, so a pass here means the install is sound:

For Claude Code, resolve its installed copy with:

```bash
AGY_ROOT=$(node -p 'require(process.env.HOME+"/.claude/plugins/installed_plugins.json").plugins["agy-crew@agy-crew"][0].installPath')
node "$AGY_ROOT/companion/agy-companion.mjs" ask --prompt "reply with OK"
```

Resolve the root that way rather than globbing `cache/agy-crew/agy-crew/*/`: superseded version directories are left behind after an upgrade, so the glob expands to several paths and the command fails with `unknown subcommand`. `installPath` is always the copy in use. (Codex's equivalent root is printed by `codex plugin list`.) For OpenCode, `opencode debug skill` reports each skill location; resolve `../../companion/agy-companion.mjs` from the installed `agy-crew-ask` skill directory and invoke it with `node` from the user’s project directory. For Pi, use the registered package root from `pi list`. A fallback pass still leaves the restart outstanding — report it as "installed and verified, restart the current harness to use it".

Expect a short answer on stdout with no telemetry mixed in, plus an `[agy-crew]` telemetry line on stderr (mode, profile, model, duration, tokens, conversation id — for you, not for the user). If it errors, relay the error verbatim; the usual causes are expired agy auth (user runs `agy` interactively once to re-login) or an invalid model id (`agy models` lists valid ids). Do not improvise flags to work around errors.

> [!IMPORTANT]
> A passing `ask` smoke means the install is done. `staffer`, `researcher`, `reviewer` and `implementer` all default to the **unrestricted** profile, so they gather evidence and edit files without any allowlist — nothing else is required to use them. Section 4 (`setup`) is **optional hardening**: it only matters if the user wants to run with `--restricted`, where headless agy fail-closes on every tool call that is not on the allowlist. Do not run setup unprompted; offer it, and apply it only if the user asks for the hardened path.

## 4. Optional hardening — setup, dry run first

Skip this section unless the user wants it. Every tool-using mode already works unrestricted; setup exists so that the opt-in `--restricted` profile is usable, because a restricted run needs an **evidence-gathering command allowlist** in agy's settings or it comes back empty. Mention it to security-sensitive users (shared machines, reviewing untrusted PRs) and let them decide. Setup can also record a per-repo policy (`setup --restrict review,research` makes those modes default to restricted in the current repository; `--restrict none` clears it) — offer that only in the same opt-in conversation.

If they opt in, global install is the normal path. Run the setup **dry run** first — never apply directly:

```bash
agy-crew setup   # dry run; only add --apply after user confirmation (without the command on PATH: node <plugin-root>/companion/agy-companion.mjs setup)
```

The full guided flow lives in the jobs skill (`skills/jobs/references/setup.md`).

Show the user the full dry-run output and state these four things plainly before asking for confirmation:

1. Which command rules would be added, and that they exist so `--restricted` runs can gather evidence unattended.
2. The target file is the **global** `~/.gemini/antigravity-cli/settings.json`, so the rules apply to every `agy` run on this machine — not only to agy-crew jobs.
3. Setup keeps broad git/gh grants and adds five native deny prefixes: `git push`, `git reset --hard`, `git clean`, `gh pr merge`, and `gh release delete`. AGY evaluates deny > ask > allow. Existing rules are preserved, and the dry run shows any additions. This prevents common mistakes, not every irreversible action: alternate command forms, scripts and APIs are not comprehensively covered. Task authorization does not override deny.
4. The existing file is backed up before writing.

Apply only after the user explicitly agrees. If they decline, nothing is lost from the default experience — all four modes keep working; they simply cannot harden a run with `--restricted` until the allowlist exists.

If the user is security-sensitive and the machine-wide scope is unacceptable, tell them agy also supports project-scoped permission rules (highest priority) tied to its `--project` system — but that **the project-settings file path is undocumented and unverified against the current agy release**. Do not guess a path and do not write one; point them at [REFERENCE.md → Advanced: project-scoped permissions](REFERENCE.md#advanced-project-scoped-permissions) and let them verify it interactively with `agy`.

## 5. Optional — the account pool

Skip this section unless the user wants concurrent jobs on several agy accounts. Without it everything runs on the user's own agy login (**live**), exactly as before; live is never part of the pool.

Never run `accounts login` yourself. It opens a browser sign-in and waits for the user to exit agy, so only the user can complete it. Offer it, and if they agree give them the command to run in their own terminal:

```bash
agy-crew accounts login work1     # choose any name: lowercase letters, digits, . _ -
```

Without the command on PATH, use `node <plugin-root>/companion/agy-companion.mjs accounts login work1`. Repeat with another name for each account (each must be a different Google account). If the user already has agy homes from agy-cli-manager, `agy-crew accounts import <name> --home <dir>` copies the token without a browser; ask before importing. Afterwards you can verify without side effects:

```bash
agy-crew accounts list            # each account should show "ready"
```

Runs then choose an account automatically (`--account auto`). New accounts copy their permission settings from the live settings file on login, and a later `setup --apply` updates every pool account. Details: [REFERENCE.md → Accounts](REFERENCE.md#accounts).

## 6. The execution model

`ask` returns its answer synchronously. `staffer`, `research`, `review` and `implement` return a job id, and the job-start output prints the exact collect command (`wait <id> --timeout 10m`). Run that as a background command — one background wait per job — and deliver the result when it exits; exit code 2 means still running, so run the same `wait` again (`cancel <id>` stops the job). Do not leave a started job unreported.

Exit 5 signals a timeout with a resumable conversation. Inspect the retained workspace changes and ask whether to continue with the suggested timeout or stop; recover only after explicit user confirmation. The continuation command preserves the original persona/model/profile. This also applies to synchronous `ask`; no run automatically retries or continues.

Per-repo state lives in `<repo>/.agy-crew/`; the companion git-ignores it automatically on first use (via `.git/info/exclude` — the tracked `.gitignore` is never touched).

## 7. Report back

Tell the user, in **their** language: whether install succeeded (name the version and whether it came from the GitHub slug or a local checkout, and whether you used route A or route B), the smoke-test result, whether a restart is still needed before the skills load, and whether the optional setup rules were applied, declined, or never offered (the default unrestricted profile does not need it), and whether any pool accounts were added (and that the user, not you, ran the login).

Default: prepare the prompt, dispatch, wait for the final result, then validate as needed. On wait exit 2, wait again for the same job without extra progress checks. While running, do not proactively observe, read logs or inspect intermediate artifacts, including for routine updates. Observe only when the user explicitly asks for progress; diagnose after a failure or a result requiring intervention. Host collection of a pending wait command is necessary result collection, not active observation. Prefer background completion delivery or the longest practical blocking wait the host supports; avoid short empty polls and sleep/observe loops. The worker's hard limit and explicit recovery protocol remain separate from wait soft expiry.

`observe <id>` always returns bounded JSON, including after completion. Its exit 0 means the job finished; collect the existing wait session or use `result <id>` to obtain the full report. Observation does not consume the waiting command’s output.
