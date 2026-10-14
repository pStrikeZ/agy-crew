import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { agyCalls, jobIdOf, jobLog, jobResultFile, promptOf, run, sandbox, waitForJob } from './helpers.mjs';
import { FAMILY, accountHomeOf, emailOfToken, envCalls, globalHomeOf, poolFile, readPool, seedPool, tokenFileOf, writePool } from './pool-helpers.mjs';

const envFile = (sb) => path.join(sb.root, 'agy-env.jsonl');
const withEnvFile = (sb, extra = {}) => ({ FAKE_AGY_ENV_FILE: envFile(sb), ...extra });
const status = (sb, id) => JSON.parse(run(sb, ['status', id]).stdout.split('\n}\n')[0] + '\n}');
const twoAccounts = (sb, mutate) => seedPool(sb, [{ name: 'a', email: 'a@x' }, { name: 'b', email: 'b@x' }], mutate);

test('an empty pool keeps every run on the live login, silently', () => {
  const sb = sandbox('pool-empty');
  const r = run(sb, ['ask', '--prompt', 'hi'], withEnvFile(sb));
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /account=/);
  const [call] = envCalls(envFile(sb));
  assert.equal(call.HOME, sb.home);
  assert.equal(call.account_email, null);
  assert.notEqual(call.SSH_TTY, 'agy-crew-account');
  assert.equal(fs.existsSync(poolFile(sb)), false, 'no pool.json is created by plain runs');
  const state = JSON.parse(fs.readFileSync(path.join(sb.repo, '.agy-crew', 'state.json'), 'utf8'));
  assert.equal(state.conversation_configs['conv-1'].account, undefined);
});

test('a pooled run uses the private HOME with file-token markers and reports its account', () => {
  const sb = sandbox('pool-env');
  seedPool(sb, [{ name: 'a', email: 'a@x' }]);
  const r = run(sb, ['ask', '--prompt', 'hi'], withEnvFile(sb));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /model=gemini-3\.8-flash-low account=a /);
  const [call] = envCalls(envFile(sb));
  assert.equal(call.HOME, accountHomeOf(sb, 'a'));
  if (process.platform === 'win32') assert.equal(call.USERPROFILE, accountHomeOf(sb, 'a'));
  assert.equal(call.SSH_CONNECTION, '127.0.0.1 1 127.0.0.1 1');
  assert.equal(call.account_email, 'a@x');

  const pool = readPool(sb);
  assert.deepEqual(pool.leases, [], 'the lease is released after the run');
  assert.ok(pool.accounts[0].last_used_at);
  assert.equal(pool.conversations['conv-1'].account, 'a');
  const state = JSON.parse(fs.readFileSync(path.join(sb.repo, '.agy-crew', 'state.json'), 'utf8'));
  assert.equal(state.conversation_configs['conv-1'].account, 'a');
});

test('--account live bypasses the pool even when accounts exist', () => {
  const sb = sandbox('pool-live');
  seedPool(sb, [{ name: 'a', email: 'a@x' }]);
  const r = run(sb, ['ask', '--account', 'live', '--prompt', 'hi'], withEnvFile(sb));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /account=live/);
  const [call] = envCalls(envFile(sb));
  assert.equal(call.HOME, sb.home);
  assert.equal(call.account_email, null);
  assert.notEqual(call.SSH_TTY, 'agy-crew-account');
  assert.equal(readPool(sb).conversations['conv-1'], undefined, 'live conversations are never bound');
});

test('AGY_CREW_ACCOUNT supplies the default request and bad requests fail early', () => {
  const sb = sandbox('pool-request');
  twoAccounts(sb);
  const viaEnv = run(sb, ['ask', '--prompt', 'hi'], withEnvFile(sb, { AGY_CREW_ACCOUNT: 'b' }));
  assert.equal(viaEnv.code, 0, viaEnv.stderr);
  assert.equal(envCalls(envFile(sb))[0].account_email, 'b@x');
  for (const [flag, pattern] of [['Not Valid', /invalid --account/], ['ghost', /unknown account "ghost"/]]) {
    const r = run(sb, ['research', '--account', flag, '--prompt', 'x']);
    assert.equal(r.code, 1, flag);
    assert.match(r.stderr, pattern);
  }
  const jobsDir = path.join(sb.repo, '.agy-crew', 'jobs');
  assert.equal(fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir).length : 0, 0,
    'no background job is registered for a request that can never work');
});

test('auto spreads two concurrent background jobs over two accounts', async () => {
  const sb = sandbox('pool-spread');
  twoAccounts(sb);
  const env = withEnvFile(sb, { FAKE_AGY_SLEEP_MS: '2500' });
  const first = jobIdOf(run(sb, ['staffer', '--prompt', 'one'], env).stdout);
  const second = jobIdOf(run(sb, ['staffer', '--prompt', 'two'], env).stdout);
  assert.equal(await waitForJob(sb, first), 'done');
  assert.equal(await waitForJob(sb, second), 'done');
  const emails = envCalls(envFile(sb)).map((c) => c.account_email).sort();
  assert.deepEqual(emails, ['a@x', 'b@x']);
  assert.deepEqual(new Set([status(sb, first).account, status(sb, second).account]), new Set(['a', 'b']));
  assert.match(jobLog(sb, first), /account=[ab] /);
  assert.deepEqual(readPool(sb).leases, []);
});

test('a continuation is pinned to the account that owns the conversation', () => {
  const sb = sandbox('pool-pinned');
  twoAccounts(sb);
  assert.equal(run(sb, ['ask', '--account', 'b', '--prompt', 'start'], withEnvFile(sb)).code, 0);
  const again = run(sb, ['continue', '--conversation', 'conv-1', '--prompt', 'more'], withEnvFile(sb));
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(envCalls(envFile(sb)).map((c) => c.account_email), ['b@x', 'b@x']);

  const conflict = run(sb, ['continue', '--conversation', 'conv-1', '--account', 'a', '--prompt', 'more'], withEnvFile(sb));
  assert.equal(conflict.code, 1);
  assert.match(conflict.stderr, /conversation conv-1 belongs to account b/);
  assert.equal(envCalls(envFile(sb)).length, 2, 'the conflicting request never reached agy');
});

test('a conversation from before the pool existed continues on the live login', () => {
  const sb = sandbox('pool-prepool');
  assert.equal(run(sb, ['ask', '--prompt', 'old'], withEnvFile(sb)).code, 0);
  twoAccounts(sb);
  const r = run(sb, ['continue', '--conversation', 'conv-1', '--prompt', 'later'], withEnvFile(sb));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(envCalls(envFile(sb))[1].account_email, null);
  assert.equal(envCalls(envFile(sb))[1].HOME, sb.home);
  const refused = run(sb, ['continue', '--conversation', 'conv-1', '--account', 'a', '--prompt', 'x']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /belongs to account live/);
});

test('quota with no conversation records a cooldown with the parsed reset and fails over', () => {
  const sb = sandbox('pool-failover');
  twoAccounts(sb);
  const before = Date.now();
  const r = run(sb, ['ask', '--prompt', 'hi'], withEnvFile(sb, { FAKE_AGY_QUOTA_EMAILS: 'a@x', FAKE_AGY_QUOTA_AFTER_CONVERSATION: '0' }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /fake answer/);
  assert.deepEqual(envCalls(envFile(sb)).map((c) => c.account_email), ['a@x', 'b@x']);
  const cooldown = readPool(sb).cooldowns[`a|${FAMILY}`];
  assert.equal(cooldown.reason, 'quota_exhausted');
  const wait = Date.parse(cooldown.retry_at) - Date.parse(cooldown.recorded_at);
  assert.equal(wait, 2 * 3_600_000 + 3 * 60_000);
  assert.ok(Date.parse(cooldown.recorded_at) >= before - 1000);
  assert.match(cooldown.message, /Individual quota reached/);
  assert.equal(readPool(sb).conversations['conv-1'].account, 'b');
  assert.match(r.stderr, /account=b /);
  assert.equal(agyCalls(sb).length, 2);
  assert.equal(promptOf(agyCalls(sb)[0]), promptOf(agyCalls(sb)[1]), 'the same prompt is retried');
});

test('next run skips an account that is cooling for the family', () => {
  const sb = sandbox('pool-skip-cooling');
  twoAccounts(sb, (p) => { p.cooldowns[`a|${FAMILY}`] = { retry_at: new Date(Date.now() + 3600_000).toISOString(), reason: 'quota_exhausted' }; });
  assert.equal(run(sb, ['ask', '--prompt', 'hi'], withEnvFile(sb)).code, 0);
  assert.equal(envCalls(envFile(sb))[0].account_email, 'b@x');
});

test('quota on a bound conversation borrows an idle account credential and restores every token', () => {
  const sb = sandbox('pool-loan');
  twoAccounts(sb);
  const originalA = fs.readFileSync(tokenFileOf(sb, 'a'), 'utf8');
  const r = run(sb, ['ask', '--account', 'a', '--prompt', 'work'], withEnvFile(sb, { FAKE_AGY_QUOTA_EMAILS: 'a@x', FAKE_AGY_REFRESH_TOKEN: '1' }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /fake answer/);
  // second attempt ran in a's home with b's credential
  const calls = envCalls(envFile(sb));
  assert.deepEqual(calls.map((c) => c.account_email), ['a@x', 'b@x']);
  assert.ok(calls.every((c) => c.HOME === accountHomeOf(sb, 'a')));
  const argv = agyCalls(sb);
  assert.equal(argv[1][argv[1].indexOf('--conversation') + 1], 'conv-1');
  assert.match(promptOf(argv[1]), /stopped because the account hit a quota limit.*do not repeat finished steps/);
  assert.match(r.stderr, /account=a credential=b /);

  assert.equal(fs.readFileSync(tokenFileOf(sb, 'a'), 'utf8'), originalA, 'borrower token restored');
  assert.equal(emailOfToken(tokenFileOf(sb, 'b')), 'b@x');
  assert.equal(JSON.parse(fs.readFileSync(tokenFileOf(sb, 'b'), 'utf8')).refreshed_by_run, true, 'lender gets the refreshed credential back');
  assert.equal(fs.existsSync(path.join(path.dirname(tokenFileOf(sb, 'a')), '.antigravity-oauth-token.agy-crew.loan-backup')), false);
  const pool = readPool(sb);
  assert.deepEqual([pool.loans, pool.leases], [[], []]);
  assert.ok(pool.cooldowns[`a|${FAMILY}`], 'the quota cooldown is on the borrower that hit the limit');
  assert.equal(pool.cooldowns[`b|${FAMILY}`], undefined);
});

test('continuing a bound conversation whose account is cooling starts with a loan', () => {
  const sb = sandbox('pool-loan-start');
  twoAccounts(sb, (p) => {
    p.conversations['conv-1'] = { account: 'a', recorded_at: '' };
    p.cooldowns[`a|${FAMILY}`] = { retry_at: new Date(Date.now() + 3600_000).toISOString(), reason: 'quota_exhausted' };
  });
  // a state file that knows the conversation (as a previous run would have left)
  assert.equal(run(sb, ['ask', '--account', 'live', '--prompt', 'seed']).code, 0);
  const state = path.join(sb.repo, '.agy-crew', 'state.json');
  const parsed = JSON.parse(fs.readFileSync(state, 'utf8'));
  parsed.conversation_configs['conv-1'].account = 'a';
  fs.writeFileSync(state, JSON.stringify(parsed));
  const r = run(sb, ['continue', '--conversation', 'conv-1', '--prompt', 'go on'], withEnvFile(sb));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(envCalls(envFile(sb)).map((c) => c.account_email), ['b@x']);
  assert.equal(envCalls(envFile(sb))[0].HOME, accountHomeOf(sb, 'a'));
  assert.equal(emailOfToken(tokenFileOf(sb, 'a')), 'a@x');
});

test('continuing a bound conversation whose account is held runs on a borrowed credential', () => {
  const sb = sandbox('pool-loan-held');
  twoAccounts(sb, (p) => {
    p.conversations['conv-1'] = { account: 'a', recorded_at: '' };
    p.leases.push({ id: 'h', account: 'a', pid: process.pid, role: 'hold' });
  });
  assert.equal(run(sb, ['ask', '--account', 'live', '--prompt', 'seed']).code, 0);
  const state = path.join(sb.repo, '.agy-crew', 'state.json');
  const parsed = JSON.parse(fs.readFileSync(state, 'utf8'));
  parsed.conversation_configs['conv-1'].account = 'a';
  fs.writeFileSync(state, JSON.stringify(parsed));
  const r = run(sb, ['continue', '--conversation', 'conv-1', '--prompt', 'go on'], withEnvFile(sb));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(envCalls(envFile(sb)).map((c) => c.account_email), ['b@x']);
  assert.equal(envCalls(envFile(sb))[0].HOME, accountHomeOf(sb, 'a'));
  assert.equal(emailOfToken(tokenFileOf(sb, 'a')), 'a@x');
  assert.deepEqual(readPool(sb).leases.map((l) => l.role), ['hold'], 'the hold outlives the run');
});

test('every account cooling is a quota_exhausted error naming the earliest retry', () => {
  const sb = sandbox('pool-all-cooling');
  const soon = new Date(Date.now() + 1800_000).toISOString();
  const later = new Date(Date.now() + 7200_000).toISOString();
  twoAccounts(sb, (p) => {
    p.cooldowns[`a|${FAMILY}`] = { retry_at: later, reason: 'quota_exhausted' };
    p.cooldowns[`b|${FAMILY}`] = { retry_at: soon, reason: 'quota_exhausted' };
  });
  const r = run(sb, ['ask', '--prompt', 'hi'], withEnvFile(sb));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /quota_exhausted/);
  assert.ok(r.stderr.includes(soon) && r.stderr.includes(later));
  assert.match(r.stderr, /--account live/);
  assert.equal(envCalls(envFile(sb)).length, 0);

  const explicit = run(sb, ['ask', '--account', 'a', '--prompt', 'hi']);
  assert.equal(explicit.code, 1);
  assert.ok(explicit.stderr.includes(later));
  assert.match(explicit.stderr, /--account auto/);

  const other = run(sb, ['ask', '--model', 'claude-sonnet-4-6', '--prompt', 'hi'], withEnvFile(sb));
  assert.equal(other.code, 0, 'a different family is not cooling');
});

test('a background job that exhausts every account stops in attention with retry guidance', async () => {
  const sb = sandbox('pool-bg-quota');
  seedPool(sb, [{ name: 'a', email: 'a@x' }]);
  const r = run(sb, ['staffer', '--prompt', 'long task'], withEnvFile(sb, { FAKE_AGY_QUOTA_EMAILS: 'a@x' }));
  const id = jobIdOf(r.stdout);
  assert.equal(await waitForJob(sb, id), 'attention');
  const job = status(sb, id);
  assert.equal(job.reason, 'quota_exhausted');
  assert.ok(job.retry_at);
  assert.equal(job.account, 'a');
  assert.ok(job.conversation_id);
  const result = jobResultFile(sb, id);
  assert.match(result, /Job needs attention/);
  assert.match(result, /"retry_at"/);
  assert.match(result, new RegExp(`continue --job ${id} after ${job.retry_at.replace(/[.]/g, '\\.')}`));
  assert.match(result, /credential loan is used automatically/);
  const code = run(sb, ['status', id]).code;
  assert.equal(code, 5);
  assert.deepEqual(readPool(sb).leases, []);
});

test('a foreground run that exhausts its only account exits 5 with the conversation, and 1 without one', () => {
  const sb = sandbox('pool-fg-quota');
  seedPool(sb, [{ name: 'a', email: 'a@x' }]);
  const withConv = run(sb, ['ask', '--prompt', 'hi'], withEnvFile(sb, { FAKE_AGY_QUOTA_EMAILS: 'a@x' }));
  assert.equal(withConv.code, 5);
  assert.match(withConv.stderr, /"reason": "quota_exhausted"/);
  assert.match(withConv.stderr, /"retry_at"/);
  assert.match(withConv.stderr, /credential loan is used automatically/);

  const sb2 = sandbox('pool-fg-quota2');
  seedPool(sb2, [{ name: 'a', email: 'a@x' }]);
  const without = run(sb2, ['ask', '--prompt', 'hi'], withEnvFile(sb2, { FAKE_AGY_QUOTA_EMAILS: 'a@x', FAKE_AGY_QUOTA_AFTER_CONVERSATION: '0' }));
  assert.equal(without.code, 1);
  assert.match(without.stderr, /quota_exhausted/);
});

const UNAVAILABLE = 'FAKE_AGY_UNAVAILABLE_EMAILS';

test('a 503 with no conversation parks the account briefly and fails over with the same prompt', () => {
  const sb = sandbox('pool-503-failover');
  twoAccounts(sb);
  const r = run(sb, ['ask', '--prompt', 'hi'], withEnvFile(sb, { [UNAVAILABLE]: 'a@x', FAKE_AGY_QUOTA_AFTER_CONVERSATION: '0' }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /fake answer/);
  assert.deepEqual(envCalls(envFile(sb)).map((c) => c.account_email), ['a@x', 'b@x']);
  const cooldown = readPool(sb).cooldowns[`a|${FAMILY}`];
  assert.equal(cooldown.reason, 'upstream_unavailable');
  assert.equal(Date.parse(cooldown.retry_at) - Date.parse(cooldown.recorded_at), 3 * 60_000);
  assert.match(cooldown.message, /No capacity available/);
  assert.equal(promptOf(agyCalls(sb)[0]), promptOf(agyCalls(sb)[1]));
});

test('the next separate run does not reuse the account that just returned a 503', () => {
  const sb = sandbox('pool-503-next-run');
  twoAccounts(sb);
  const env = withEnvFile(sb, { [UNAVAILABLE]: 'a@x', FAKE_AGY_QUOTA_AFTER_CONVERSATION: '0' });
  assert.equal(run(sb, ['ask', '--prompt', 'one'], env).code, 0);
  assert.equal(run(sb, ['ask', '--prompt', 'two'], env).code, 0);
  assert.deepEqual(envCalls(envFile(sb)).map((c) => c.account_email), ['a@x', 'b@x', 'b@x'],
    'the second run never touches the cooling account');
});

test('a 503 on a new task that changed nothing reruns the original prompt as a new conversation, not a continuation', () => {
  const sb = sandbox('pool-503-rewrite');
  twoAccounts(sb);
  const r = run(sb, ['ask', '--prompt', 'the real task'], withEnvFile(sb, { [UNAVAILABLE]: 'a@x' }));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(envCalls(envFile(sb)).map((c) => c.account_email), ['a@x', 'b@x']);
  const [first, second] = agyCalls(sb);
  assert.equal(first.includes('--conversation'), false);
  assert.equal(second.includes('--conversation'), false, 'a new conversation, so nothing is continued');
  assert.equal(promptOf(second), promptOf(first));
  assert.doesNotMatch(promptOf(second), /previous turn stopped/);
});

test('a 503 after agy changed the workspace continues the conversation on a borrowed credential', async () => {
  const sb = sandbox('pool-503-continue');
  twoAccounts(sb);
  const r = run(sb, ['staffer', '--prompt', 'edit things'],
    withEnvFile(sb, { [UNAVAILABLE]: 'a@x', FAKE_AGY_UNAVAILABLE_WRITE: 'partial.txt' }));
  const id = jobIdOf(r.stdout);
  assert.equal(await waitForJob(sb, id), 'done');
  assert.deepEqual(envCalls(envFile(sb)).map((c) => c.account_email), ['a@x', 'b@x'], 'b lends its credential to a\'s conversation');
  const [first, second] = agyCalls(sb);
  assert.equal(first.includes('--conversation'), false);
  assert.equal(second[second.indexOf('--conversation') + 1], 'conv-1');
  assert.match(promptOf(second), /previous turn stopped/);
  assert.deepEqual(readPool(sb).leases, []);
  assert.deepEqual(readPool(sb).loans, []);
});

test('a continuation that hits a 503 is never rewritten as a new task', () => {
  const sb = sandbox('pool-503-pinned');
  twoAccounts(sb);
  assert.equal(run(sb, ['ask', '--account', 'a', '--prompt', 'first'], withEnvFile(sb)).code, 0);
  const r = run(sb, ['ask', '--continue', '--prompt', 'next step'], withEnvFile(sb, { [UNAVAILABLE]: 'a@x' }));
  assert.equal(r.code, 0, r.stderr);
  const calls = agyCalls(sb);
  assert.equal(calls.length, 3);
  assert.equal(calls[2][calls[2].indexOf('--conversation') + 1], 'conv-1');
  assert.equal(envCalls(envFile(sb)).at(-1).account_email, 'b@x', 'b only lends its credential to the pinned conversation');
});

test('503 on every account is upstream_unavailable, not a quota error', () => {
  const sb = sandbox('pool-503-all');
  twoAccounts(sb);
  const r = run(sb, ['ask', '--prompt', 'hi'], withEnvFile(sb, { [UNAVAILABLE]: 'a@x,b@x', FAKE_AGY_QUOTA_AFTER_CONVERSATION: '0' }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /upstream_unavailable/);
  assert.doesNotMatch(r.stderr, /out of .* quota/);
  assert.equal(envCalls(envFile(sb)).length, 2, 'each account is tried once');
  const pool = readPool(sb);
  assert.equal(pool.cooldowns[`a|${FAMILY}`].reason, 'upstream_unavailable');
  assert.equal(pool.cooldowns[`b|${FAMILY}`].reason, 'upstream_unavailable');
});

test('a background job that gets a 503 everywhere stops in attention and says to rewrite, not continue', async () => {
  const sb = sandbox('pool-503-bg');
  seedPool(sb, [{ name: 'a', email: 'a@x' }]);
  const r = run(sb, ['staffer', '--prompt', 'long task'], withEnvFile(sb, { [UNAVAILABLE]: 'a@x' }));
  const id = jobIdOf(r.stdout);
  assert.equal(await waitForJob(sb, id), 'attention');
  const job = status(sb, id);
  assert.equal(job.reason, 'upstream_unavailable');
  assert.ok(job.retry_at);
  const result = jobResultFile(sb, id);
  assert.match(result, /Job needs attention/);
  assert.match(result, /had no capacity \(503\)/);
  assert.match(result, new RegExp(`restart ${id}`));
  assert.match(result, /do not use continue/i);
  assert.equal(run(sb, ['status', id]).code, 5);
});

test('a foreground 503 on an explicitly chosen account is reported, not moved to another account', () => {
  const sb = sandbox('pool-503-explicit');
  twoAccounts(sb);
  const r = run(sb, ['ask', '--account', 'a', '--prompt', 'hi'], withEnvFile(sb, { [UNAVAILABLE]: 'a@x', FAKE_AGY_QUOTA_AFTER_CONVERSATION: '0' }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /"reason": "upstream_unavailable"/);
  assert.deepEqual(envCalls(envFile(sb)).map((c) => c.account_email), ['a@x']);
});

test('an authentication failure parks the account and is not retried', () => {
  const sb = sandbox('pool-auth');
  twoAccounts(sb);
  const r = run(sb, ['ask', '--prompt', 'hi'], withEnvFile(sb, { FAKE_AGY_STATUS: 'ERROR', FAKE_AGY_RESPONSE: '', FAKE_AGY_ERROR: '401 Unauthenticated: invalid credential' }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /401 Unauthenticated/);
  assert.equal(envCalls(envFile(sb)).length, 1, 'auth failures are never retried');
  const pool = readPool(sb);
  assert.ok(pool.accounts[0].auth_error_at);
  assert.match(pool.accounts[0].auth_error, /401/);
  assert.equal(pool.accounts[1].auth_error_at, null);
  const list = JSON.parse(run(sb, ['accounts', 'list', '--json']).stdout);
  assert.equal(list.accounts[0].state, 'needs login');
  assert.equal(run(sb, ['ask', '--prompt', 'again'], withEnvFile(sb)).code, 0);
  assert.equal(envCalls(envFile(sb)).at(-1).account_email, 'b@x', 'selection skips the parked account');
});

test('a dead-pid lease does not make auto selection avoid its account', async () => {
  const sb = sandbox('pool-dead-lease-run');
  const child = (await import('node:child_process')).spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  twoAccounts(sb, (p) => p.leases.push({ id: 'ghost', account: 'a', pid: Number(child.stdout), job_id: null, role: 'run', started_at: '' }));
  assert.equal(run(sb, ['ask', '--prompt', 'hi'], withEnvFile(sb)).code, 0);
  assert.equal(envCalls(envFile(sb))[0].account_email, 'a@x');
  assert.deepEqual(readPool(sb).leases, []);
});

test('restart selects an account again and accepts --account', async () => {
  const sb = sandbox('pool-restart');
  twoAccounts(sb);
  const id = jobIdOf(run(sb, ['staffer', '--account', 'a', '--prompt', 'task'], withEnvFile(sb)).stdout);
  assert.equal(await waitForJob(sb, id), 'done');
  const again = run(sb, ['restart', id, '--account', 'b'], withEnvFile(sb));
  assert.equal(again.code, 0, again.stderr);
  const second = jobIdOf(again.stdout);
  assert.equal(await waitForJob(sb, second), 'done');
  assert.deepEqual(envCalls(envFile(sb)).map((c) => c.account_email), ['a@x', 'b@x']);
  assert.equal(status(sb, second).account, 'b');
  assert.ok(fs.existsSync(globalHomeOf(sb)));
});
