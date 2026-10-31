import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { run, sandbox } from './helpers.mjs';
import { FAMILY, accountHomeOf, readPool, runAsync, seedPool, tokenFileOf, tokenJson, writePool } from './pool-helpers.mjs';
import { clientUserAgent } from '../companion/pool/quota.mjs';

const SUMMARY = { groups: [
  { displayName: 'Gemini models', buckets: [
    { id: 'gemini-flash-5h', window: '5h', remainingFraction: 0.25, resetTime: '2031-01-01T05:00:00Z' },
    { id: 'gemini-flash-weekly', window: 'weekly', remainingFraction: 0.5, resetTime: '2031-01-07T00:00:00Z' }] },
  { displayName: 'Claude and GPT', buckets: [{ id: '3p-5h', window: '5h', remainingFraction: 0.9, resetTime: '2031-01-01T05:00:00Z' }] },
] };

/** Local Cloud Code stand-in. `accept(token)` decides between 200 and 401. */
async function cloudCode(accept, summary = SUMMARY) {   // summary may be a function of the bearer token
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, agent: req.headers['user-agent'], type: req.headers['content-type'], body: JSON.parse(body || '{}') });
      const token = String(req.headers.authorization || '').replace('Bearer ', '');
      if (!accept(token)) { res.writeHead(401).end('{}'); return; }
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1internal:loadCodeAssist') res.end(JSON.stringify({ cloudaicompanionProject: { id: 'proj-9' }, planInfo: { planType: 'pro' } }));
      else if (req.url === '/v1internal:retrieveUserQuotaSummary') res.end(JSON.stringify(typeof summary === 'function' ? summary(token) : summary));
      else res.writeHead(404).end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('quota --refresh stores snapshots, clears recovered cooldowns, and never prints tokens', async () => {
  const sb = sandbox('pool-quota');
  seedPool(sb, [{ name: 'a', email: 'a@x' }], (p) => {
    p.cooldowns[`a|${FAMILY}`] = { retry_at: new Date(Date.now() + 3600_000).toISOString() };
    p.cooldowns['a|claude-sonnet-4-6'] = { retry_at: new Date(Date.now() + 3600_000).toISOString() };
  });
  const server = await cloudCode((token) => token === 'fake-access');
  try {
    const r = await runAsync(sb, ['accounts', 'quota', '--refresh', '--json'], { AGY_CREW_CLOUDCODE_URL: server.url });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes('fake-access') && !r.stderr.includes('fake-access'));
    const [load, summary] = server.seen;
    assert.equal(load.url, '/v1internal:loadCodeAssist');
    assert.equal(load.auth, 'Bearer fake-access');
    assert.match(load.agent, /^antigravity\/cli\/1\.1\.13-fake \(aidev_client; os_type=\S+; arch=\S+\)$/, 'the User-Agent names the installed agy, or Cloud Code hides the Gemini group');
    assert.equal(summary.agent, load.agent);
    assert.equal(load.type, 'application/json');
    assert.deepEqual(load.body, { metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } });
    assert.deepEqual(summary.body, { project: 'proj-9' });

    const snapshot = readPool(sb).quota.a;
    assert.equal(snapshot.plan_type, 'pro');
    assert.equal(snapshot.error, null);
    assert.deepEqual(snapshot.pools.gemini.short, { remaining: 0.25, reset_at: '2031-01-01T05:00:00.000Z' });
    assert.equal(snapshot.pools.gemini.weekly.remaining, 0.5);
    assert.equal(snapshot.pools.other.short.remaining, 0.9);
    assert.equal(fs.readFileSync(path.join(accountHomeOf(sb, 'a'), '.gemini', 'antigravity-cli', 'cache', 'default_project_id.txt'), 'utf8'), 'proj-9');
    assert.deepEqual(readPool(sb).cooldowns, {}, 'quota left in both pools clears the cooldowns');

    const cached = run(sb, ['accounts', 'quota']);
    assert.equal(cached.code, 0);
    assert.match(cached.stdout, /gemini +25%  resets in .* +50%  resets in /);
    const listed = run(sb, ['accounts', 'list']);
    assert.match(listed.stdout, /other +90%  resets in /);
  } finally { await server.close(); }
});

test('quota --refresh leaves a borrower alone while its token is on loan, so it never reports the lender quota', async () => {
  const sb = sandbox('pool-quota-loan');
  const stale = { refreshed_at: '2026-01-01T00:00:00.000Z', plan_type: 'pro', error: null,
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
  const lenderQuota = { groups: [{ displayName: 'Gemini models', buckets: [{ id: 'gemini-flash-5h', window: '5h', remainingFraction: 0.9, resetTime: '2031-01-01T05:00:00Z' }] }] };
  const server = await cloudCode(() => true, (token) => (token === 'lender-access' ? lenderQuota : SUMMARY));
  try {
    const r = await runAsync(sb, ['accounts', 'quota', '--refresh'], { AGY_CREW_CLOUDCODE_URL: server.url });
    assert.equal(r.code, 0, r.stderr);
    const after = readPool(sb);
    assert.deepEqual(after.quota.a, stale, 'the borrower keeps its last real snapshot');
    assert.equal(after.quota.b.pools.gemini.short.remaining, 0.9, 'the lender is still refreshed');
    assert.equal(server.seen.filter((x) => x.url.endsWith(':loadCodeAssist')).length, 1, 'no request was made for the borrower');
    assert.match(r.stderr, /- a: skipped, credential on loan/);
    assert.equal(JSON.parse(fs.readFileSync(tokenFileOf(sb, 'a'), 'utf8')).token.access_token, 'lender-access', 'the loaned token file is untouched');
  } finally { await server.close(); }
});

test('an empty gemini window keeps auto selection away from the account until its reset', async () => {
  const sb = sandbox('pool-quota-exhausted');
  seedPool(sb, [{ name: 'a', email: 'a@x' }, { name: 'b', email: 'b@x' }]);
  const emptyGemini = { groups: [{ displayName: 'Gemini', buckets: [{ id: 'gemini-5h', window: '5h', remainingFraction: 0, resetTime: '2031-01-01T05:00:00Z' }] }] };
  const server = await cloudCode(() => true, emptyGemini);
  try {
    const r = await runAsync(sb, ['accounts', 'quota', 'a', '--refresh'], { AGY_CREW_CLOUDCODE_URL: server.url });
    assert.equal(r.code, 0, r.stderr);
  } finally { await server.close(); }
  const envFile = path.join(sb.root, 'env.jsonl');
  assert.equal(run(sb, ['ask', '--prompt', 'hi'], { FAKE_AGY_ENV_FILE: envFile }).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(envFile, 'utf8').trim()).account_email, 'b@x');
});

test('a 401 triggers one warm-up run with the account env and then a retry', async () => {
  const sb = sandbox('pool-quota-401');
  seedPool(sb, [{ name: 'a', email: 'a@x' }]);
  const envFile = path.join(sb.root, 'warm.jsonl');
  const cwdFile = path.join(sb.root, 'warm-cwd');
  const server = await cloudCode((token) => token === 'fresh');
  try {
    const r = await runAsync(sb, ['accounts', 'quota', '--refresh'], {
      AGY_CREW_CLOUDCODE_URL: server.url, FAKE_AGY_NEW_ACCESS_TOKEN: 'fresh', FAKE_AGY_ENV_FILE: envFile, FAKE_AGY_CWD_FILE: cwdFile,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(server.seen[0].auth, 'Bearer fake-access');
    assert.ok(server.seen.slice(1).every((s) => s.auth === 'Bearer fresh'));
    const warm = fs.readFileSync(envFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(warm.length, 1);
    assert.equal(warm[0].HOME, accountHomeOf(sb, 'a'));
    assert.equal(warm[0].SSH_CONNECTION, '127.0.0.1 1 127.0.0.1 1');
    assert.equal(fs.readFileSync(cwdFile, 'utf8'), accountHomeOf(sb, 'a'));
    const argv = JSON.parse(fs.readFileSync(sb.argvFile, 'utf8').trim().split('\n')[0]);
    assert.deepEqual(argv, ['-p', 'reply with one word: pong', '--output-format', 'json']);
    assert.equal(readPool(sb).quota.a.error, null);
    assert.equal(readPool(sb).accounts[0].auth_error_at, null);
  } finally { await server.close(); }
});

test('a credential that is still rejected after the warm-up marks the account as needing login', async () => {
  const sb = sandbox('pool-quota-401-final');
  seedPool(sb, [{ name: 'a', email: 'a@x' }]);
  const server = await cloudCode(() => false);
  try {
    const r = await runAsync(sb, ['accounts', 'quota', '--refresh', '--json'], { AGY_CREW_CLOUDCODE_URL: server.url });
    assert.equal(r.code, 0, r.stderr);
    const pool = readPool(sb);
    assert.match(pool.quota.a.error, /401/);
    assert.ok(pool.accounts[0].auth_error_at);
  } finally { await server.close(); }
  const list = JSON.parse(run(sb, ['accounts', 'list', '--json']).stdout);
  assert.equal(list.accounts[0].state, 'needs login');
});

test('quota --refresh warms up an expiring token before the first request', async () => {
  const sb = sandbox('pool-quota-expiring');
  seedPool(sb, [{ name: 'a', email: 'a@x' }]);
  const tokenFile = path.join(accountHomeOf(sb, 'a'), '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  const json = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  json.token.expiry = new Date(Date.now() + 30_000).toISOString();
  fs.writeFileSync(tokenFile, JSON.stringify(json));
  const server = await cloudCode((token) => token === 'renewed');
  try {
    const r = await runAsync(sb, ['accounts', 'quota', 'a', '--refresh'], { AGY_CREW_CLOUDCODE_URL: server.url, FAKE_AGY_NEW_ACCESS_TOKEN: 'renewed' });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(server.seen.every((s) => s.auth === 'Bearer renewed'), 'no request used the expiring token');
    assert.equal(readPool(sb).quota.a.plan_type, 'pro');
  } finally { await server.close(); }
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
  const server = await cloudCode((token) => token === 'fake-access');
  try {
    const text = await runAsync(sb, ['accounts', 'quota', '--refresh'], { AGY_CREW_CLOUDCODE_URL: server.url });
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stderr, /^Refreshing quota for 2 account\(s\), one at a time\.\.\.\n  ✓ a \(\d+\.\ds\)\n  ✓ b \(\d+\.\ds\)\n$/);
    assert.doesNotMatch(text.stdout, /Refreshing/);
    const json = await runAsync(sb, ['accounts', 'quota', '--refresh', '--json'], { AGY_CREW_CLOUDCODE_URL: server.url });
    assert.equal(json.code, 0, json.stderr);
    assert.equal(json.stderr, '');
  } finally { await server.close(); }
});

test('clientUserAgent mirrors agy and falls back to a known version', () => {
  const fake = (out, status = 0) => () => ({ cmd: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(out)}); process.exit(${status})`] });
  assert.equal(clientUserAgent(fake('1.4.9\n'), { platform: 'linux', arch: 'x64' }), 'antigravity/cli/1.4.9 (aidev_client; os_type=linux; arch=amd64)');
  assert.equal(clientUserAgent(fake('agy version 2.0.1-rc.1\n'), { platform: 'win32', arch: 'arm64' }), 'antigravity/cli/2.0.1-rc.1 (aidev_client; os_type=windows; arch=arm64)');
  assert.match(clientUserAgent(fake('', 1), { platform: 'darwin', arch: 'arm64' }), /^antigravity\/cli\/\d+\.\d+\.\d+ \(aidev_client; os_type=darwin; arch=arm64\)$/);
});
