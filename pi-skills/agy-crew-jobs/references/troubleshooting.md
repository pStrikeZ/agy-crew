<!-- Generated from skills/jobs/references/troubleshooting.md; run npm run generate:pi. Do not edit here. -->

# Troubleshooting agy runs

## The harness command sandbox (`operation not permitted`)

agy cannot run inside a harness command sandbox (e.g. Codex workspace-write): it binds a localhost port for its internal language server and reads its OAuth token file, which sandbox secret-protection hides. No writable_roots/network_access knob fixes the hidden token — the run dies with `operation not permitted` on `~/.gemini/...` or on binding `127.0.0.1`, or with a bogus "authentication failed".

Fix: run the companion command **unsandboxed**. In Codex, request escalated permissions for the command or have the user grant the workspace full access. Do not retry the command as-is; the sandbox will block it the same way every time.

## False crash reports across permission or sandbox contexts

If a background job was started unsandboxed but a management command (`wait`, `status`, `result`) is later run from a sandboxed or different permission context, the collector process may not see the running worker process. Because the liveness check fails and no result file has been written yet, the command reports the job as `crashed` with no stored result.

Fix: run job management commands (`wait`, `status`, `result`, `cancel`) in the same unsandboxed permission context as the job start. Rerunning `wait`/`status`/`result` from the unsandboxed context sees the live worker PID and resumes waiting or reporting normal running status.

## Empty response with status SUCCESS

The fail-closed signature of a restricted run: headless agy auto-denies every unlisted tool call, so agy finishes "successfully" with nothing to say. The companion's error message carries the exact guidance — run `setup` once to install the evidence-gathering allowlist (see `setup.md`), or pass `--unrestricted` explicitly when authorized (continuations inherit the previous profile; new tool-using tasks default to unrestricted). Note that some agy tools ignore allow-rules in headless mode entirely, so even a complete allowlist cannot make them work; those need an unrestricted run. An empty response from an *unrestricted* run is not a permission issue — report it.

## done_with_warnings (error status, response text)

When agy reports an error but response text came back, the companion delivers the response anyway: exit 0, response on stdout, warning on stderr (retained in the job log and included as a bounded tail during background result collection). Assess the response against the task and review the diagnostics before deciding whether more work is needed. An empty response at a deadline with a known conversation instead needs attention (exit 5); other empty responses remain failures.

## Quota exhausted and needs login (account pool)

`reason=quota_exhausted` with a `retry_at` means the account (and any idle account that could lend a credential) hit its quota for that model family. Failover and credential loans have already been tried inside the run, so do not retry in a loop. Offer `continue --job <id>` after `retry_at`, or when `accounts list` shows an idle account; with no conversation, offer a new run with another `--account` or model family. `accounts quota --refresh` shows current numbers when the user wants them.

## upstream_unavailable (503, no capacity)

`reason=upstream_unavailable` means agy got `UNAVAILABLE (code 503): No capacity available for model ...` from the server, after its own internal retries (roughly two minutes each time). The companion has parked that account for the model family for a few minutes and tried other accounts where it could, so another account or a loan is not worth trying by hand; do not retry in a loop.

- **agy had not done anything yet** (clean `git status`, no partial result): rewrite the task and run it again as a new run, with `restart <job id>` or a new dispatch with an updated prompt. **Do not use `continue`.** A continuation is bound to the original account and conversation, which holds nothing useful, and it only repeats the failing request.
- **agy had already changed the workspace**: inspect `git status` and `git diff`, then `continue --job <id>` with a prompt that says what is done and what is left. Ask the user first, as with a timeout.
- The outage may be model-wide. After `retry_at` try once more, or offer another model family; ask before a second retry.

An authentication failure on a pool account marks it `needs login` and is never retried. The user must run `agy-crew accounts login <name>` in their own terminal (browser sign-in); do not run it yourself. Live authentication failures still mean running `agy` interactively once.

## Retry rules

- Do not retry with different flags unless the error message itself names the exact flag.
- For a timeout, inspect the retained result and workspace. Exit 5 means the conversation is resumable: ask the user whether to continue with the suggested timeout or stop, and recover only after explicit confirmation. Background `--timeout` defaults to 60m and accepts at most 120m; increase it only below that ceiling, otherwise narrow the task. A known conversation ID lets `continue` resume with its recorded configuration. A response already received before the hard deadline is delivered with a warning, so do not restart a completed job merely because cleanup timed out.
- Model-id errors fail pre-flight with the valid ids in the message (`agy models` lists them); expired auth means running `agy` interactively once to re-login (for a pool account, `agy-crew accounts login <name>`).
