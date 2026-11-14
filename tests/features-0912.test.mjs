/**
 * accounts rename / refresh-email, shell completion, and `inspect` across the
 * worktrees of one repository.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { run, sandbox } from './helpers.mjs';
import { accountHomeOf, readPool, seedPool, tokenFileOf, tokenJson, globalHomeOf } from './pool-helpers.mjs';

// ---------------------------------------------------------------------------
// accounts rename
// ---------------------------------------------------------------------------

test('rename moves the directory, cooldowns, quota and conversation bindings', () => {
  const sb = sandbox('rename');
  const later = new Date(Date.now() + 3600_000).toISOString();
  seedPool(sb, [{ name: 'old', email: 'a@example.com' }, { name: 'other', email: 'b@example.com' }], (pool) => {
    pool.cooldowns['old|gemini'] = { retry_at: later, reason: 'quota_exhausted' };
    pool.quota.old = { error: null };
    pool.conversations.c1 = { account: 'old' };
    pool.conversations.c2 = { account: 'other' };
  });
  const r = run(sb, ['accounts', 'rename', 'old', 'new']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Renamed account old to new/);
  assert.ok(fs.existsSync(tokenFileOf(sb, 'new')));
  assert.equal(fs.existsSync(path.join(globalHomeOf(sb), 'accounts', 'old')), false);
  const pool = readPool(sb);
  assert.deepEqual(pool.accounts.map((a) => a.name), ['new', 'other']);
  assert.deepEqual(Object.keys(pool.cooldowns), ['new|gemini']);
  assert.ok(pool.quota.new && !pool.quota.old);
  assert.equal(pool.conversations.c1.account, 'new');
  assert.equal(pool.conversations.c2.account, 'other');
});

test('rename refuses unknown, taken, invalid and busy accounts', () => {
  const sb = sandbox('rename-refuse');
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }, { name: 'b', email: 'b@example.com' }], (pool) => {
    pool.leases.push({ id: 'l1', account: 'b', role: 'hold', pid: process.pid, job_id: null, started_at: new Date().toISOString() });
  });
  assert.match(run(sb, ['accounts', 'rename', 'zzz', 'x']).stderr, /unknown account "zzz"/);
  assert.match(run(sb, ['accounts', 'rename', 'a', 'b']).stderr, /account "b" already exists/);
  assert.match(run(sb, ['accounts', 'rename', 'a', 'Bad Name']).stderr, /invalid account name/);
  assert.match(run(sb, ['accounts', 'rename', 'a', 'live']).stderr, /reserved/);
  assert.match(run(sb, ['accounts', 'rename', 'b', 'c']).stderr, /in use/);
  assert.match(run(sb, ['accounts', 'rename', 'a']).stderr, /usage: accounts rename/);
  assert.deepEqual(readPool(sb).accounts.map((a) => a.name), ['a', 'b']);
});

// ---------------------------------------------------------------------------
// accounts refresh-email
// ---------------------------------------------------------------------------

test('refresh-email re-reads the token, reports changes and never creates duplicates', () => {
  const sb = sandbox('refresh-email');
  seedPool(sb, [{ name: 'a', email: 'old-a@example.com' }, { name: 'b', email: 'b@example.com' }, { name: 'c', email: 'c@example.com' }]);
  fs.writeFileSync(tokenFileOf(sb, 'a'), JSON.stringify(tokenJson('new-a@example.com')));
  fs.writeFileSync(tokenFileOf(sb, 'c'), JSON.stringify(tokenJson('b@example.com')));   // clashes with b
  const r = run(sb, ['accounts', 'refresh-email', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const by = Object.fromEntries(JSON.parse(r.stdout).accounts.map((x) => [x.name, x]));
  assert.equal(by.a.status, 'updated');
  assert.equal(by.a.email, 'new-a@example.com');
  assert.equal(by.b.status, 'unchanged');
  assert.match(by.c.status, /already enrolled as "b"/);
  assert.deepEqual(readPool(sb).accounts.map((a) => a.email), ['new-a@example.com', 'b@example.com', 'c@example.com']);

  const text = run(sb, ['accounts', 'refresh-email', 'a']);
  assert.match(text.stdout, /a +new-a@example\.com +unchanged/);
  assert.match(run(sb, ['accounts', 'refresh-email', 'nope']).stderr, /unknown account "nope"/);
});

test('refresh-email reports a missing token and one without an email', () => {
  const sb = sandbox('refresh-email-missing');
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }, { name: 'b', email: 'b@example.com' }]);
  fs.rmSync(tokenFileOf(sb, 'a'));
  fs.writeFileSync(tokenFileOf(sb, 'b'), JSON.stringify({ token: { access_token: 'x' } }));
  const out = JSON.parse(run(sb, ['accounts', 'refresh-email', '--json']).stdout).accounts;
  assert.match(out[0].status, /no token/);
  assert.match(out[1].status, /no email/);
  assert.deepEqual(readPool(sb).accounts.map((a) => a.email), ['a@example.com', 'b@example.com']);
  assert.ok(fs.existsSync(accountHomeOf(sb, 'b')));
});

// ---------------------------------------------------------------------------
// completion
// ---------------------------------------------------------------------------

const complete = (sb, ...words) => run(sb, ['__complete', ...words]).stdout.split('\n').filter(Boolean);

test('completion: commands, subcommands, flags and flag values', () => {
  const sb = sandbox('complete');
  seedPool(sb, [{ name: 'work', email: 'w@example.com' }, { name: 'spare', email: 's@example.com' }]);
  assert.deepEqual(complete(sb, 'ins'), ['inspect', 'install']);
  assert.ok(complete(sb, '').includes('accounts'));
  assert.ok(complete(sb, 'accounts', 're').includes('rename'));
  assert.ok(complete(sb, 'accounts', 're').includes('refresh-email'));
  assert.deepEqual(complete(sb, 'research', '--mo'), ['--model']);
  assert.deepEqual(complete(sb, 'research', '--model', 'gemini-3.1'), ['gemini-3.1-pro-high', 'gemini-3.1-pro-low']);
  assert.deepEqual(complete(sb, 'ask', '--effort', ''), ['low', 'medium', 'high']);
  assert.deepEqual(complete(sb, 'ask', '--account', 's'), ['spare']);
  assert.deepEqual(complete(sb, 'ask', '--account', ''), ['auto', 'work', 'spare']);
  assert.deepEqual(complete(sb, 'accounts', 'rename', 'w'), ['work']);
  assert.deepEqual(complete(sb, 'accounts', 'rename', 'work', ''), [], 'the new name is free text');
  assert.deepEqual(complete(sb, 'accounts', 'quota', 'work', ''), ['work', 'spare'].filter((n) => n !== 'work'), 'repeatable account list');
  assert.deepEqual(complete(sb, 'accounts', 'cooldown', ''), ['clear', 'record']);
  assert.deepEqual(complete(sb, 'accounts', 'cooldown', 'record', 'work', '--f'), ['--family']);
  assert.deepEqual(complete(sb, 'install', '--hosts', 'claude,s'), ['claude,shared']);
  assert.deepEqual(complete(sb, 'completion', ''), ['bash', 'zsh', 'fish', 'powershell']);
  assert.deepEqual(complete(sb, 'start', 'w'), ['work']);
  assert.deepEqual(complete(sb, 'start', '--'), ['--model', '--help', '--']);
  assert.deepEqual(complete(sb, 'start', 'work', '--', '--m'), [], 'after -- the words are agy\'s');
  assert.deepEqual(complete(sb, 'research', '--model', 'pro', '--m'), [], 'a used flag is not offered again');
});

test('completion: job ids come from this repository, scripts print for every shell', () => {
  const sb = sandbox('complete-jobs');
  fs.mkdirSync(path.join(sb.repo, '.agy-crew'));
  fs.writeFileSync(path.join(sb.repo, '.agy-crew', 'state.json'), JSON.stringify({ conversations: {}, last: null,
    jobs: [{ id: 'research-aaa-1', started_at: '2026-01-01T00:00:00Z' }, { id: 'review-bbb-2', started_at: '2026-01-02T00:00:00Z' }] }));
  assert.deepEqual(complete(sb, 'inspect', ''), ['review-bbb-2', 'research-aaa-1'], 'newest first');
  assert.deepEqual(complete(sb, 'result', 'research'), ['research-aaa-1']);
  assert.deepEqual(complete(sb, 'continue', '--job', 'rev'), ['review-bbb-2']);
  for (const shell of ['bash', 'zsh', 'fish', 'powershell', 'pwsh']) {
    const r = run(sb, ['completion', shell]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /agy-crew __complete/);
  }
  const bad = run(sb, ['completion', 'tcsh']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /usage: agy-crew completion <bash\|zsh\|fish\|powershell>/);

  // PowerShell passes the words as JSON in the environment (an empty last word survives).
  const viaEnv = (words) => run(sb, ['__complete'], { AGY_CREW_COMPLETE_WORDS: JSON.stringify(words) }).stdout.split('\n').filter(Boolean);
  assert.deepEqual(viaEnv(['accounts', 'cooldown', '']), ['clear', 'record']);
  assert.deepEqual(viaEnv(['accounts', 'coo']), ['cooldown']);
});

// ---------------------------------------------------------------------------
// inspect across worktrees
// ---------------------------------------------------------------------------

function worktreeOf(sb, name) {
  const git = (...args) => { const r = spawnSync('git', args, { cwd: sb.repo, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  fs.writeFileSync(path.join(sb.repo, 'f.txt'), 'x');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
  const dir = path.join(sb.root, name);
  git('worktree', 'add', '-q', '-b', name, dir);
  return fs.realpathSync.native(dir);
}

test('inspect finds jobs started in another worktree, from the main checkout and back', async () => {
  const sb = sandbox('inspect-wt');
  const wt = worktreeOf(sb, 'feature-wt');
  const env = { AGY_CREW_HOME: path.join(sb.root, 'crew-home') };
  const ev = JSON.stringify([{ event: 'step_update', step_update: { conversation_id: 'c', step_index: 2, step_type: 'tool', state: 'ACTIVE', tool_name: 'grep' } }]);
  const inWt = { ...sb, repo: wt };
  const a = run(inWt, ['research', '--prompt', 'in worktree'], { ...env, FAKE_AGY_EVENTS: ev, FAKE_AGY_SLEEP_MS: '1500' });
  assert.equal(a.code, 0, a.stderr);
  const id = /research-[\w-]+/.exec(a.stdout)[0];
  assert.ok(fs.existsSync(path.join(wt, '.agy-crew', 'state.json')));
  assert.equal(fs.existsSync(path.join(sb.repo, '.agy-crew', 'state.json')), false, 'main checkout has no state of its own');

  // Follow it from the main checkout while it runs; the footer names the worktree.
  const view = run(sb, ['inspect', id, '--no-color'], env);
  assert.equal(view.code, 0, view.stderr);
  assert.match(view.stdout, /▶ grep/);
  for (let i = 0; i < 60; i++) {
    const s = run(inWt, ['status', id], env);
    if (s.code !== 2) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const done = run(sb, ['inspect', id, '--no-follow', '--no-color'], env);
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /\[feature-wt\]/, 'the footer names the other worktree');

  // No id: the latest job of any worktree.
  const latest = run(sb, ['inspect', '--no-follow', '--no-color'], env);
  assert.equal(latest.code, 0, latest.stderr);
  assert.match(latest.stdout, new RegExp(id));

  // --here limits the view to the current worktree.
  const here = run(sb, ['inspect', id, '--no-follow', '--here'], env);
  assert.equal(here.code, 1);
  assert.match(here.stderr, /no job .* in this repository/);
  assert.doesNotMatch(here.stderr, /worktrees/);
  const miss = run(sb, ['inspect', 'nope', '--no-follow'], env);
  assert.match(miss.stderr, /or any of its worktrees/);

  // A corrupt state file in one worktree is a warning, not a failure.
  fs.mkdirSync(path.join(sb.repo, '.agy-crew'), { recursive: true });
  fs.writeFileSync(path.join(sb.repo, '.agy-crew', 'state.json'), '{nope');
  const warned = run(sb, ['inspect', id, '--no-follow', '--no-color'], env);
  assert.equal(warned.code, 0, warned.stderr);
  assert.match(warned.stderr, /state file is corrupt, skipped/);
});
