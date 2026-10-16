import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { agyCalls, run, sandbox } from './helpers.mjs';
import { FAMILY, accountHomeOf, deadPid, emailOfToken, envCalls, globalHomeOf, poolFile, readPool, runAsync, seedPool, tokenFileOf, tokenJson, writePool } from './pool-helpers.mjs';

const login = (sb, name, email, extra = {}) => run(sb, ['accounts', 'login', name], { FAKE_AGY_LOGIN_EMAIL: email, ...extra });
const list = (sb) => JSON.parse(run(sb, ['accounts', 'list', '--json']).stdout);

test('login enrolls an account, lists it, and the staging area is cleaned up', () => {
  const sb = sandbox('pool-login');
  const r = login(sb, 'work', 'work@example.com');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /exit agy once its prompt appears/);
  assert.match(r.stdout, /Added account work <work@example.com>/);
  assert.equal(emailOfToken(tokenFileOf(sb, 'work')), 'work@example.com');
  const pool = readPool(sb);
  assert.equal(pool.schema, 1);
  assert.deepEqual(pool.accounts.map((a) => [a.name, a.email, a.disabled]), [['work', 'work@example.com', false]]);
  assert.equal(fs.existsSync(path.join(globalHomeOf(sb), 'enroll')) && fs.readdirSync(path.join(globalHomeOf(sb), 'enroll')).length, 0);

  const listed = list(sb);
  assert.equal(listed.accounts[0].state, 'ready');
  assert.match(listed.live.description, /never pooled/);
  const text = run(sb, ['accounts', 'list']);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /work +work@example\.com +ready/);
  assert.match(text.stdout, /live +your own agy login, never pooled/);
  assert.equal(fs.existsSync(path.join(sb.repo, '.agy-crew')), false, 'accounts never touches the repo state dir');
});

test('login refuses duplicate emails, bad names, and a login that wrote no token', () => {
  const sb = sandbox('pool-login-refuse');
  assert.equal(login(sb, 'one', 'same@example.com').code, 0);
  const dup = login(sb, 'two', 'same@example.com');
  assert.equal(dup.code, 1);
  assert.match(dup.stderr, /same@example.com is already enrolled as account "one"/);
  assert.equal(fs.existsSync(path.join(globalHomeOf(sb), 'accounts', 'two')), false);
  assert.equal(fs.readdirSync(path.join(globalHomeOf(sb), 'enroll')).length, 0);

  for (const bad of ['Bad Name', 'live', 'auto', '-x', 'a'.repeat(40)]) {
    const r = login(sb, bad, 'x@example.com');
    assert.equal(r.code, 1, bad);
    assert.match(r.stderr, /invalid account name|reserved account name/);
  }
  const failed = login(sb, 'three', 'three@example.com', { FAKE_AGY_LOGIN_FAIL: '1' });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /file-based token storage/);
  assert.equal(readPool(sb).accounts.length, 1);
});

test('re-login clears the auth error, keeps the email, and restores the token on mismatch', () => {
  const sb = sandbox('pool-relogin');
  seedPool(sb, [{ name: 'a', email: 'a@example.com', auth_error_at: '2026-01-01T00:00:00Z', auth_error: '401' }]);
  assert.match(list(sb).accounts[0].state, /needs login/);

  const wrong = login(sb, 'a', 'other@example.com');
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /re-login produced other@example.com/);
  assert.equal(emailOfToken(tokenFileOf(sb, 'a')), 'a@example.com');
  assert.equal(fs.existsSync(tokenFileOf(sb, 'a') + '.agy-crew.login-backup'), false);
  assert.match(list(sb).accounts[0].state, /needs login/);

  const ok = login(sb, 'a', 'a@example.com');
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(readPool(sb).accounts[0].auth_error_at, null);
  assert.equal(list(sb).accounts[0].state, 'ready');
});

test('re-login is refused while the account is leased', () => {
  const sb = sandbox('pool-relogin-busy');
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }], (p) => p.leases.push({ id: 'l', account: 'a', pid: process.pid, job_id: null, role: 'run', started_at: '' }));
  const r = login(sb, 'a', 'a@example.com');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /in use/);
});

test('import copies token and settings from a HOME-shaped directory', () => {
  const sb = sandbox('pool-import');
  const src = path.join(sb.root, 'manager-account');
  const dir = path.join(src, '.gemini', 'antigravity-cli');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'antigravity-oauth-token'), JSON.stringify(tokenJson('imp@example.com')));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ permissions: { allow: ['command(x)'] } }));

  const r = run(sb, ['accounts', 'import', 'imp', '--home', src]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(emailOfToken(tokenFileOf(sb, 'imp')), 'imp@example.com');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(accountHomeOf(sb, 'imp'), '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')).permissions.allow, ['command(x)']);

  const dup = run(sb, ['accounts', 'import', 'imp2', '--home', src]);
  assert.equal(dup.code, 1);
  assert.match(dup.stderr, /already enrolled as account "imp"/);
  const live = run(sb, ['accounts', 'import', 'self', '--home', sb.home]);
  assert.equal(live.code, 1);
  assert.match(live.stderr, /live home/);
  const missing = run(sb, ['accounts', 'import', 'nope', '--home', path.join(sb.root, 'absent')]);
  assert.equal(missing.code, 1);
  assert.equal(readPool(sb).accounts.length, 1);
});

test('enable and disable toggle selection state', () => {
  const sb = sandbox('pool-toggle');
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }]);
  assert.equal(run(sb, ['accounts', 'disable', 'a']).code, 0);
  assert.equal(list(sb).accounts[0].state, 'disabled');
  assert.equal(run(sb, ['accounts', 'enable', 'a']).code, 0);
  assert.equal(list(sb).accounts[0].state, 'ready');
  const unknown = run(sb, ['accounts', 'enable', 'ghost']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown account "ghost"/);
});

test('remove previews without --yes, then deletes account data and bindings', () => {
  const sb = sandbox('pool-remove');
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }, { name: 'b', email: 'b@example.com' }], (p) => {
    p.cooldowns[`a|${FAMILY}`] = { retry_at: new Date(Date.now() + 3600_000).toISOString() };
    p.quota.a = { refreshed_at: 'x', pools: {} };
    p.conversations.c1 = { account: 'a' };
    p.conversations.c2 = { account: 'a' };
    p.conversations.c3 = { account: 'b' };
  });
  const preview = run(sb, ['accounts', 'remove', 'a']);
  assert.equal(preview.code, 0);
  assert.match(preview.stdout, /Would delete account a/);
  assert.match(preview.stdout, /2 conversation binding/);
  assert.equal(readPool(sb).accounts.length, 2);

  const done = run(sb, ['accounts', 'remove', 'a', '--yes']);
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /2 conversation\(s\) bound to it can no longer be continued/);
  const pool = readPool(sb);
  assert.deepEqual(pool.accounts.map((a) => a.name), ['b']);
  assert.deepEqual(pool.cooldowns, {});
  assert.equal(pool.quota.a, undefined);
  assert.deepEqual(Object.keys(pool.conversations), ['c3']);
  assert.equal(fs.existsSync(path.join(globalHomeOf(sb), 'accounts', 'a')), false);
});

test('remove refuses while the account is leased or lending', () => {
  const sb = sandbox('pool-remove-busy');
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }], (p) => p.leases.push({ id: 'l', account: 'a', pid: process.pid, role: 'run' }));
  const r = run(sb, ['accounts', 'remove', 'a', '--yes']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /in use/);
  assert.equal(readPool(sb).accounts.length, 1);
});

test('cooldown clear removes one family or all of an account', () => {
  const sb = sandbox('pool-cooldown');
  const later = new Date(Date.now() + 3600_000).toISOString();
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }], (p) => {
    p.cooldowns[`a|${FAMILY}`] = { retry_at: later };
    p.cooldowns['a|claude-sonnet-4-6'] = { retry_at: later };
  });
  assert.match(list(sb).accounts[0].state, new RegExp(`cooling .* until ${later}`));
  assert.equal(run(sb, ['accounts', 'cooldown', 'clear', 'a', '--family', FAMILY]).code, 0);
  assert.deepEqual(Object.keys(readPool(sb).cooldowns), ['a|claude-sonnet-4-6']);
  assert.equal(run(sb, ['accounts', 'cooldown', 'clear', 'a']).code, 0);
  assert.deepEqual(readPool(sb).cooldowns, {});
});

test('hold acquire keeps agy-crew off an account until release', () => {
  const sb = sandbox('pool-hold');
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }]);
  const acquire = (...extra) => run(sb, ['accounts', 'hold', 'acquire', 'a', '--pid', String(process.pid), '--family', FAMILY, '--json', ...extra]);
  const held = acquire();
  assert.equal(held.code, 0, held.stderr);
  const { hold } = JSON.parse(held.stdout);
  assert.deepEqual([hold.account, hold.role, hold.pid], ['a', 'hold', process.pid]);
  assert.equal(JSON.parse(acquire().stdout).hold.id, hold.id, 'the same process gets its hold back');
  assert.equal(list(sb).accounts[0].state, 'held');

  const other = run(sb, ['accounts', 'hold', 'acquire', 'a', '--pid', '2', '--json']);
  assert.equal(other.code, 1);
  assert.equal(JSON.parse(other.stdout).refused.reason, 'busy');
  const removed = run(sb, ['accounts', 'remove', 'a', '--yes']);
  assert.equal(removed.code, 1);
  assert.match(removed.stderr, /in use/);
  const ask = run(sb, ['ask', '--account', 'a', '--prompt', 'hi']);
  assert.equal(ask.code, 1);
  assert.match(ask.stderr, /held by another process/);

  const released = run(sb, ['accounts', 'hold', 'release', hold.id, '--json']);
  assert.deepEqual(JSON.parse(released.stdout), { released: true });
  assert.deepEqual(JSON.parse(run(sb, ['accounts', 'hold', 'release', hold.id, '--json']).stdout), { released: false });
  assert.equal(list(sb).accounts[0].state, 'ready');
});

test('hold acquire refuses unknown, busy and cooling accounts, but not disabled or signed-out ones', () => {
  const sb = sandbox('pool-hold-refused');
  const later = new Date(Date.now() + 3600_000).toISOString();
  seedPool(sb, [
    { name: 'busy', email: 'busy@example.com' },
    { name: 'cool', email: 'cool@example.com' },
    { name: 'off', email: 'off@example.com', disabled: true },
    { name: 'out', email: 'out@example.com', auth_error_at: '2026-01-01T00:00:00Z' },
  ], (p) => {
    p.leases.push({ id: 'l', account: 'busy', pid: process.pid, role: 'run' });
    p.cooldowns[`cool|${FAMILY}`] = { retry_at: later };
  });
  const refused = (name) => {
    const r = run(sb, ['accounts', 'hold', 'acquire', name, '--pid', String(process.pid), '--family', FAMILY, '--json']);
    assert.equal(r.code, 1, name);
    return JSON.parse(r.stdout).refused;
  };
  assert.equal(refused('nobody').reason, 'unknown');
  assert.equal(refused('busy').reason, 'busy');
  assert.deepEqual([refused('cool').reason, refused('cool').retry_at], ['quota_exhausted', later]);
  for (const name of ['off', 'out']) {
    assert.equal(run(sb, ['accounts', 'hold', 'acquire', name, '--pid', String(process.pid)]).code, 0, name);
  }
  const plain = run(sb, ['accounts', 'hold', 'acquire', 'cool', '--pid', String(process.pid)]);
  assert.equal(plain.code, 0, 'without --family a cooldown does not refuse the hold');
  assert.equal(run(sb, ['accounts', 'hold', 'acquire', 'cool']).code, 1, '--pid is required');
});

test('a hold whose process died is reaped on the next update', async () => {
  const sb = sandbox('pool-hold-reap');
  const dead = await deadPid();
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }], (p) => p.leases.push({ id: 'h', account: 'a', pid: dead, role: 'hold' }));
  assert.equal(list(sb).accounts[0].state, 'ready');
  assert.deepEqual(readPool(sb).leases, []);
});

test('cooldown record adds a quota cooldown and never shortens one in force', () => {
  const sb = sandbox('pool-cooldown-record');
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }]);
  const record = (at) => run(sb, ['accounts', 'cooldown', 'record', 'a', '--family', FAMILY, '--retry-at', at, '--json']);
  const later = new Date(Date.now() + 2 * 3600_000).toISOString();
  const sooner = new Date(Date.now() + 3600_000).toISOString();
  assert.equal(JSON.parse(record(later).stdout).cooldown.retry_at, later);
  assert.equal(JSON.parse(record(sooner).stdout).cooldown.retry_at, later);
  assert.equal(readPool(sb).cooldowns[`a|${FAMILY}`].reason, 'quota_exhausted');
  assert.equal(JSON.parse(record('2000-01-01T00:00:00Z').stdout).cooldown.retry_at, later);
  assert.equal(run(sb, ['accounts', 'cooldown', 'record', 'a', '--family', FAMILY, '--retry-at', 'soon']).code, 1);
  assert.equal(run(sb, ['accounts', 'cooldown', 'record', 'a', '--retry-at', later]).code, 1);
});

test('a pool.json from a newer version is refused, never reset', () => {
  const sb = sandbox('pool-newer');
  fs.mkdirSync(globalHomeOf(sb), { recursive: true });
  const body = JSON.stringify({ schema: 2, accounts: [], future: true });
  fs.writeFileSync(poolFile(sb), body);
  const r = run(sb, ['accounts', 'list']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /pool\.json was written by a newer agy-crew/);
  const ask = run(sb, ['ask', '--prompt', 'hi']);
  assert.equal(ask.code, 1);
  assert.match(ask.stderr, /newer agy-crew/);
  assert.equal(fs.readFileSync(poolFile(sb), 'utf8'), body);
});

test('a corrupt pool.json is an error and is left alone', () => {
  const sb = sandbox('pool-corrupt');
  fs.mkdirSync(globalHomeOf(sb), { recursive: true });
  fs.writeFileSync(poolFile(sb), '{ not json');
  const r = run(sb, ['accounts', 'list']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /pool\.json is corrupt/);
  assert.equal(fs.readFileSync(poolFile(sb), 'utf8'), '{ not json');
});

test('leases of dead processes are reaped on the next update', async () => {
  const sb = sandbox('pool-reap-lease');
  const dead = await deadPid();
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }], (p) => {
    p.leases.push({ id: 'dead', account: 'a', pid: dead, job_id: null, role: 'run', started_at: '' });
    p.leases.push({ id: 'live', account: 'a', pid: process.pid, job_id: null, role: 'run', started_at: '' });
    p.cooldowns[`a|${FAMILY}`] = { retry_at: '2000-01-01T00:00:00Z' };
  });
  assert.match(list(sb).accounts[0].state, /^busy 1$/);
  const pool = readPool(sb);
  assert.deepEqual(pool.leases.map((l) => l.id), ['live']);
  assert.deepEqual(pool.cooldowns, {}, 'expired cooldowns are dropped');
});

test('a loan whose process died is rolled back: tokens restored, refreshed credential returned', async () => {
  const sb = sandbox('pool-reap-loan');
  const dead = await deadPid();
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }, { name: 'b', email: 'b@example.com' }]);
  // State left behind mid-loan: a holds b's (refreshed) credential, its own is in the backup.
  const original = fs.readFileSync(tokenFileOf(sb, 'a'), 'utf8');
  const backup = path.join(path.dirname(tokenFileOf(sb, 'a')), '.antigravity-oauth-token.agy-crew.loan-backup');
  fs.renameSync(tokenFileOf(sb, 'a'), backup);
  fs.writeFileSync(tokenFileOf(sb, 'a'), JSON.stringify({ ...tokenJson('b@example.com'), refreshed_by_run: true }));
  const pool = JSON.parse(fs.readFileSync(poolFile(sb), 'utf8'));
  pool.loans.push({ id: 'L1', borrower: 'a', lender: 'b', pid: dead, job_id: null, host_had_token: true, started_at: '' });
  pool.leases.push({ id: 'x1', account: 'b', pid: dead, role: 'lender', loan_id: 'L1' }, { id: 'x2', account: 'a', pid: dead, role: 'run', loan_id: 'L1' });
  writePool(sb, pool);

  assert.equal(run(sb, ['accounts', 'list']).code, 0);
  assert.equal(fs.readFileSync(tokenFileOf(sb, 'a'), 'utf8'), original);
  assert.equal(fs.existsSync(backup), false);
  assert.equal(JSON.parse(fs.readFileSync(tokenFileOf(sb, 'b'), 'utf8')).refreshed_by_run, true);
  const after = readPool(sb);
  assert.deepEqual([after.loans, after.leases], [[], []]);
});

test('setup lists pool account settings in the dry run and writes them with --apply', () => {
  const sb = sandbox('pool-setup');
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }]);
  const settings = path.join(accountHomeOf(sb, 'a'), '.gemini', 'antigravity-cli', 'settings.json');

  const dry = run(sb, ['setup']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.ok(dry.stdout.includes(settings), dry.stdout);
  assert.equal(fs.existsSync(settings), false);
  assert.equal(fs.existsSync(path.join(sb.home, '.gemini', 'antigravity-cli', 'settings.json')), false);

  const apply = run(sb, ['setup', '--apply']);
  assert.equal(apply.code, 0, apply.stderr);
  assert.ok(apply.stdout.includes(settings));
  const written = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.ok(written.permissions.allow.includes('command(git)'));
  assert.ok(written.permissions.deny.includes('command(git push)'));
  const live = JSON.parse(fs.readFileSync(path.join(sb.home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'));
  assert.ok(live.permissions.allow.includes('command(git)'));

  const again = run(sb, ['setup', '--apply']);
  assert.match(again.stdout, /already installed/);
});

test('login seeds the new account permissions from the live settings file', () => {
  const sb = sandbox('pool-seed');
  const liveDir = path.join(sb.home, '.gemini', 'antigravity-cli');
  fs.mkdirSync(liveDir, { recursive: true });
  fs.writeFileSync(path.join(liveDir, 'settings.json'), JSON.stringify({ theme: 'x', permissions: { allow: ['command(ls)'] } }));
  assert.equal(login(sb, 'a', 'a@example.com').code, 0);
  const seeded = JSON.parse(fs.readFileSync(path.join(accountHomeOf(sb, 'a'), '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'));
  assert.deepEqual(seeded, { permissions: { allow: ['command(ls)'] } });
});

test('usage text documents accounts and --account', () => {
  const sb = sandbox('pool-usage');
  const r = run(sb, []);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /accounts/);
  assert.match(r.stderr, /--account <auto\|live\|name>/);
});

test('start runs agy in this directory as the account, holding it until agy exits', async () => {
  const sb = sandbox('pool-start');
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }, { name: 'b', email: 'b@example.com' }]);
  const envFile = path.join(sb.root, 'env.jsonl');
  const cwdFile = path.join(sb.root, 'cwd.txt');
  const running = runAsync(sb, ['start', 'b', '--', '--model', 'x', '--json'],
    { FAKE_AGY_ENV_FILE: envFile, FAKE_AGY_CWD_FILE: cwdFile, FAKE_AGY_SLEEP_MS: '1500', FAKE_AGY_EXIT: '3' });
  let leases = [];
  for (let i = 0; i < 100 && !leases.length; i++) {
    await new Promise((r) => setTimeout(r, 20));
    try { leases = readPool(sb).leases; } catch {}
  }
  assert.deepEqual(leases.map((l) => [l.account, l.role]), [['b', 'hold']], 'b is held while agy runs');
  const r = await running;
  assert.equal(r.code, 3, 'agy\'s exit code is passed on');
  assert.deepEqual(agyCalls(sb), [['--model', 'x', '--json']], 'args after -- reach agy untouched');
  assert.deepEqual(envCalls(envFile).map((c) => [c.HOME, c.account_email]), [[accountHomeOf(sb, 'b'), 'b@example.com']]);
  assert.equal(fs.readFileSync(cwdFile, 'utf8'), sb.repo);
  const pool = readPool(sb);
  assert.deepEqual(pool.leases, [], 'the hold ends with agy');
  assert.ok(pool.accounts.find((a) => a.name === 'b').last_used_at);
});

test('start refuses unknown, busy, disabled and signed-out accounts without launching agy', () => {
  const sb = sandbox('pool-start-refused');
  seedPool(sb, [
    { name: 'busy', email: 'busy@example.com' },
    { name: 'off', email: 'off@example.com', disabled: true },
    { name: 'out', email: 'out@example.com', auth_error_at: '2026-01-01T00:00:00Z' },
  ], (p) => p.leases.push({ id: 'l', account: 'busy', pid: process.pid, role: 'run' }));
  for (const [name, why] of [['nobody', /unknown account/], ['busy', /in use/], ['off', /disabled/], ['out', /needs login/]]) {
    const r = run(sb, ['start', name]);
    assert.equal(r.code, 1, name);
    assert.match(r.stderr, why, name);
  }
  const help = run(sb, ['start']);
  assert.equal(help.code, 1);
  assert.match(help.stderr, /usage: agy-crew start <name>/);
  assert.match(help.stderr, /busy +busy@example\.com +busy 1/, 'start without a name lists the accounts');
  assert.match(run(sb, ['start', 'a', 'b']).stderr, /usage: start <name>/);
  assert.deepEqual(agyCalls(sb), []);
  assert.deepEqual(readPool(sb).leases.map((l) => l.id), ['l']);
});

test('start notes a cooldown but still launches', () => {
  const sb = sandbox('pool-start-cooling');
  const later = new Date(Date.now() + 3600_000).toISOString();
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }], (p) => { p.cooldowns[`a|${FAMILY}`] = { retry_at: later }; });
  const r = run(sb, ['start', 'a']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`no ${FAMILY} quota until ${later}`));
  assert.equal(agyCalls(sb).length, 1);
});

test('start without a name on an empty pool says how to add an account', () => {
  const sb = sandbox('pool-start-empty');
  const r = run(sb, ['start']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /No pool accounts yet\. Add one with `agy-crew accounts login <name>`/);
});

test('help and version', () => {
  const sb = sandbox('help-version');
  const bare = run(sb, []);
  assert.equal(bare.code, 1);
  assert.doesNotMatch(bare.stderr, /error/);
  for (const arg of ['help', '--help', '-h']) {
    const r = run(sb, [arg]);
    assert.equal(r.code, 0, arg);
    assert.equal(r.stdout, bare.stderr, arg);
  }
  assert.match(bare.stderr, /start <name> \[-- <agy args>\]/);
  const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const arg of ['version', '--version', '-v']) {
    const r = run(sb, [arg]);
    assert.equal(r.code, 0, arg);
    assert.equal(r.stdout, `agy-crew ${version}\nagy 1.1.13-fake\n`, arg);
  }
});
