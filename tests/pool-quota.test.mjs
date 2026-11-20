import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FAKE_AGY, run, sandbox } from './helpers.mjs';
import { accountHomeOf, readPool, runAsync, seedPool, tokenFileOf, tokenJson, writePool } from './pool-helpers.mjs';
import { warmUp } from '../companion/pool/quota.mjs';

const bucket = (id, window, remaining_fraction, reset_time) => ({ id, name: id, window, remaining_fraction, reset_time });
/** What `agy -p /usage` prints under command.data.groups. */
const USAGE = [
  { name: 'Gemini Models', buckets: [bucket('gemini-weekly', 'weekly', 0.5, '2031-01-07T00:00:00Z'), bucket('gemini-5h', '5h', 0.25, '2031-01-01T05:00:00Z')] },
  { name: 'Claude and GPT models', buckets: [bucket('3p-5h', '5h', 0.9, '2031-01-01T05:00:00Z')] },
];
const usageEnv = (groups) => ({ FAKE_AGY_USAGE: JSON.stringify(groups) });

test('quota --refresh stores snapshots from agy /usage, clears recovered cooldowns, and never prints tokens', async () => {
  const sb = sandbox('pool-quota');
  seedPool(sb, [{ name: 'a', email: 'a@x' }], (p) => {
    p.cooldowns[`a|gemini`] = { retry_at: new Date(Date.now() + 3600_000).toISOString() };
    p.cooldowns['a|claude-sonnet-4-6'] = { retry_at: new Date(Date.now() + 3600_000).toISOString() };
  });
  const envFile = path.join(sb.root, 'usage-env.jsonl');
  const cwdFile = path.join(sb.root, 'usage-cwd');
  const r = await runAsync(sb, ['accounts', 'quota', '--refresh', '--json'], { ...usageEnv(USAGE), FAKE_AGY_ENV_FILE: envFile, FAKE_AGY_CWD_FILE: cwdFile });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes('fake-access') && !r.stderr.includes('fake-access'));
  const argv = JSON.parse(fs.readFileSync(sb.argvFile, 'utf8').trim().split('\n').at(-1));
  assert.deepEqual(argv.slice(0, 4), ['-p', '/usage', '--output-format', 'json']);
  assert.equal(argv[4], '--log-file');
  const [env] = fs.readFileSync(envFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(env.HOME, accountHomeOf(sb, 'a'), 'agy reads the quota as that account');
  assert.equal(env.SSH_CONNECTION, '127.0.0.1 1 127.0.0.1 1');
  assert.equal(fs.readFileSync(cwdFile, 'utf8'), accountHomeOf(sb, 'a'));

  const snapshot = readPool(sb).quota.a;
  assert.equal(snapshot.error, null);
  assert.deepEqual(snapshot.pools.gemini.short, { remaining: 0.25, reset_at: '2031-01-01T05:00:00.000Z' });
  assert.equal(snapshot.pools.gemini.weekly.remaining, 0.5);
  assert.equal(snapshot.pools.other.short.remaining, 0.9);
  assert.deepEqual(readPool(sb).cooldowns, {}, 'quota left in both pools clears the cooldowns');

  const cached = run(sb, ['accounts', 'quota']);
  assert.equal(cached.code, 0);
  assert.match(cached.stdout, /gemini +25%  resets in .* +50%  resets in /);
  const listed = run(sb, ['accounts', 'list']);
  assert.match(listed.stdout, /other +90%  resets in /);
});

test('quota --refresh leaves a borrower alone while its token is on loan, so it never reports the lender quota', async () => {
  const sb = sandbox('pool-quota-loan');
  const stale = { refreshed_at: '2026-01-01T00:00:00.000Z', error: null,
    pools: { gemini: { short: { remaining: 0, reset_at: '2031-01-01T05:00:00.000Z' } } } };
  seedPool(sb, [{ name: 'a', email: 'a@x' }, { name: 'b', email: 'b@x' }], (p) => { p.quota.a = stale; });
  // Mid-loan state: a (cooling down) runs on b's credential; its own is in the backup.
  const backup = path.join(path.dirname(tokenFileOf(sb, 'a')), '.antigravity-oauth-token.agy-crew.loan-backup');
  fs.renameSync(tokenFileOf(sb, 'a'), backup);
  const lent = tokenJson('b@x'); lent.token.access_token = 'lender-access';
  fs.writeFileSync(tokenFileOf(sb, 'a'), JSON.stringify(lent));
  fs.writeFileSync(tokenFileOf(sb, 'b'), JSON.stringify(lent));
  const pool = readPool(sb);
  pool.loans.push({ id: 'L1', borrower: 'a', lender: 'b', pid: process.pid, job_id: null, host_had_token: true, started_at: new Date().toISOString() });
  pool.leases.push({ id: 'x1', account: 'b', pid: process.pid, role: 'lender', loan_id: 'L1' }, { id: 'x2', account: 'a', pid: process.pid, role: 'run', loan_id: 'L1' });
  writePool(sb, pool);
  const envFile = path.join(sb.root, 'loan-env.jsonl');
  const lenderQuota = [{ name: 'Gemini Models', buckets: [bucket('gemini-5h', '5h', 0.9, '2031-01-01T05:00:00Z')] }];
  const r = await runAsync(sb, ['accounts', 'quota', '--refresh'], { ...usageEnv(lenderQuota), FAKE_AGY_ENV_FILE: envFile });
  assert.equal(r.code, 0, r.stderr);
  const after = readPool(sb);
  assert.deepEqual(after.quota.a, stale, 'the borrower keeps its last real snapshot');
  assert.equal(after.quota.b.pools.gemini.short.remaining, 0.9, 'the lender is still refreshed');
  const asked = fs.readFileSync(envFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l).HOME);
  assert.deepEqual(asked, [accountHomeOf(sb, 'b')], 'agy was not run for the borrower');
  assert.match(r.stderr, /- a: skipped, credential on loan/);
  assert.equal(JSON.parse(fs.readFileSync(tokenFileOf(sb, 'a'), 'utf8')).token.access_token, 'lender-access', 'the loaned token file is untouched');
});

test('an empty gemini window keeps auto selection away from the account until its reset', async () => {
  const sb = sandbox('pool-quota-exhausted');
  seedPool(sb, [{ name: 'a', email: 'a@x' }, { name: 'b', email: 'b@x' }]);
  const empty = [{ name: 'Gemini Models', buckets: [bucket('gemini-5h', '5h', 0, '2031-01-01T05:00:00Z')] }];
  const r = await runAsync(sb, ['accounts', 'quota', 'a', '--refresh'], usageEnv(empty));
  assert.equal(r.code, 0, r.stderr);
  const envFile = path.join(sb.root, 'env.jsonl');
  assert.equal(run(sb, ['ask', '--prompt', 'hi'], { FAKE_AGY_ENV_FILE: envFile }).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(envFile, 'utf8').trim()).account_email, 'b@x');
});

test('a signed-out agy marks the account as needing login', async () => {
  const sb = sandbox('pool-quota-auth');
  seedPool(sb, [{ name: 'a', email: 'a@x' }]);
  const r = await runAsync(sb, ['accounts', 'quota', '--refresh', '--json'], { FAKE_AGY_USAGE_AUTH_FAIL: '1' });
  assert.equal(r.code, 0, r.stderr);
  const pool = readPool(sb);
  assert.match(pool.quota.a.error, /authentication failed/);
  assert.ok(pool.accounts[0].auth_error_at);
  const list = JSON.parse(run(sb, ['accounts', 'list', '--json']).stdout);
  assert.equal(list.accounts[0].state, 'needs login');
});

test('a report that did not come from file-backed token storage is refused, since it could be another account\'s', async () => {
  const sb = sandbox('pool-quota-keyring');
  seedPool(sb, [{ name: 'a', email: 'a@x' }]);
  const r = await runAsync(sb, ['accounts', 'quota', '--refresh', '--json'], { ...usageEnv(USAGE), FAKE_AGY_USAGE_KEYRING: '1' });
  assert.equal(r.code, 0, r.stderr);
  const pool = readPool(sb);
  assert.match(pool.quota.a.error, /file-based token storage/);
  assert.deepEqual(pool.quota.a.pools, {});
  assert.equal(pool.accounts[0].auth_error_at, null, 'not a login problem');
});

test('quota for an unknown account is an error', () => {
  const sb = sandbox('pool-quota-unknown');
  seedPool(sb, [{ name: 'a', email: 'a@x' }]);
  const r = run(sb, ['accounts', 'quota', 'ghost']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown account "ghost"/);
});

test('quota --refresh reports progress per account on stderr, and stays quiet for --json off a terminal', async () => {
  const sb = sandbox('pool-quota-progress');
  seedPool(sb, [{ name: 'a', email: 'a@x' }, { name: 'b', email: 'b@x' }]);
  {
    const text = await runAsync(sb, ['accounts', 'quota', '--refresh']);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stderr, /^Refreshing quota for 2 account\(s\), one at a time\.\.\.\n  ✓ a \(\d+\.\ds\)\n  ✓ b \(\d+\.\ds\)\n$/);
    assert.doesNotMatch(text.stdout, /Refreshing/);
    const json = await runAsync(sb, ['accounts', 'quota', '--refresh', '--json']);
    assert.equal(json.code, 0, json.stderr);
    assert.equal(json.stderr, '');
  }
});

test('warmUp stops agy once the token changes instead of waiting for the print turn', async () => {
  const sb = sandbox('warmup-early');
  seedPool(sb, [{ name: 'a', email: 'a@x' }]);
  const home = accountHomeOf(sb, 'a');
  const previous = process.env.FAKE_AGY_NEW_ACCESS_TOKEN;
  const previousAfter = process.env.FAKE_AGY_AFTER_RESULT_MS;
  process.env.FAKE_AGY_NEW_ACCESS_TOKEN = 'renewed';
  process.env.FAKE_AGY_AFTER_RESULT_MS = '5000';
  try {
    const started = Date.now();
    await warmUp(home, (args) => ({ cmd: process.execPath, args: [FAKE_AGY, ...args] }));
    assert.ok(Date.now() - started < 2000, 'returned after the token file changed, not after agy exited');
    assert.equal(JSON.parse(fs.readFileSync(tokenFileOf(sb, 'a'), 'utf8')).token.access_token, 'renewed');
  } finally {
    if (previous === undefined) delete process.env.FAKE_AGY_NEW_ACCESS_TOKEN;
    else process.env.FAKE_AGY_NEW_ACCESS_TOKEN = previous;
    if (previousAfter === undefined) delete process.env.FAKE_AGY_AFTER_RESULT_MS;
    else process.env.FAKE_AGY_AFTER_RESULT_MS = previousAfter;
  }
});
