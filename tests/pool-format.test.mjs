import test from 'node:test';
import assert from 'node:assert/strict';
import { run, sandbox } from './helpers.mjs';
import { FAMILY, seedPool } from './pool-helpers.mjs';
import { formatDuration, formatRelative, formatClock, formatWindow, orderedPools, renderTable, renderQuotaTable, renderCooldowns } from '../companion/pool/format.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date(2026, 9, 11, 12, 0, 0).getTime(); // local noon

test('durations and relative times use the compact forms', () => {
  assert.equal(formatDuration(0), '<1m');
  assert.equal(formatDuration(59_999), '<1m');
  assert.equal(formatDuration(12 * MIN), '12m');
  assert.equal(formatDuration(HOUR + 2 * MIN), '1h02m');
  assert.equal(formatDuration(4 * HOUR + 12 * MIN), '4h12m');
  assert.equal(formatDuration(23 * HOUR + 59 * MIN), '23h59m');
  assert.equal(formatDuration(27 * HOUR), '1d 3h');
  assert.equal(formatDuration(6 * 24 * HOUR + 2 * HOUR), '6d 2h');
  assert.equal(formatRelative(-9 * MIN), '9m ago');
  assert.equal(formatRelative(4 * HOUR + 12 * MIN), 'in 4h12m');
  assert.equal(formatRelative(-5000), '<1m ago');
});

test('clock is HH:MM today and MM-DD HH:MM otherwise (local time)', () => {
  assert.equal(formatClock(new Date(2026, 9, 11, 15, 5), NOW), '15:05');
  assert.equal(formatClock(new Date(2026, 9, 12, 10, 40), NOW), '10-12 10:40');
  assert.equal(formatClock(new Date(2026, 9, 10, 23, 59), NOW), '10-10 23:59');
});

test('window cells show percent, reset, or stale data', () => {
  const at = (ms) => new Date(NOW + ms).toISOString();
  assert.match(formatWindow({ remaining: 0.994, reset_at: at(4 * HOUR + 12 * MIN) }, NOW), /^99%  resets in 4h12m \(/);
  assert.equal(formatWindow({ remaining: 1, reset_at: null }, NOW, 4), '100%');
  assert.equal(formatWindow({ remaining: 0.5, reset_at: at(-HOUR) }, NOW, 3), '50%  reset since refresh');
  assert.equal(formatWindow({ remaining: 0.07 }, NOW, 3), ' 7%');
  assert.equal(formatWindow(undefined, NOW), '');
});

test('pools are ordered gemini, other, then alphabetically', () => {
  assert.deepEqual(orderedPools(['zeta', 'other', 'alpha', 'gemini']), ['gemini', 'other', 'alpha', 'zeta']);
});

test('tables pad by content, never leave trailing spaces, and message rows do not widen columns', () => {
  const lines = renderTable(['A', 'BB', 'C'], [['xxxx', 'y', ''], { lead: ['k'], text: 'a long message that spans' }]);
  assert.deepEqual(lines, ['A     BB  C', 'xxxx  y', 'k     a long message that spans']);
  assert.ok(lines.every((l) => l === l.trimEnd()));
});

test('quota table covers pools, missing snapshots and errors; cooldowns list family and time', () => {
  const iso = (ms) => new Date(NOW + ms).toISOString();
  const lines = renderQuotaTable([
    { name: 'a', snapshot: { refreshed_at: iso(-55 * MIN), error: null, pools: {
      other: { short: { remaining: 1, reset_at: iso(HOUR) } },
      gemini: { short: { remaining: 0.99, reset_at: iso(HOUR) }, weekly: { remaining: 0.37, reset_at: iso(2 * 24 * HOUR) } } } } },
    { name: 'b', snapshot: null },
    { name: 'c', snapshot: { refreshed_at: iso(0), error: 'x'.repeat(100), pools: {} } },
  ], NOW);
  assert.match(lines[0], /^QUOTA {2}POOL {4}5H/);
  assert.match(lines[1], /^a {6}gemini {3}99%  resets in 1h00m \(\d\d:\d\d\) +37%  resets in 2d 0h \(.*\) +55m ago$/);
  assert.match(lines[2], /^ {7}other {3}100%  resets in 1h00m/);
  assert.match(lines[3], /^b {6}not refreshed \(run `accounts quota --refresh`\)$/);
  assert.match(lines[4], /^c {6}error: x{57}\.\.\.$/);
  const cool = renderCooldowns([{ name: 'a', family: 'gemini-3.8-flash', retry_at: iso(62 * MIN) }], NOW);
  assert.equal(cool[0], 'COOLDOWNS');
  assert.match(cool[1], /^a {2}gemini-3.8-flash {2}until .*\(in 1h02m\)$/);
  assert.deepEqual(renderCooldowns([], NOW), []);
});

test('accounts list aligns its columns and puts quota and cooldowns in their own sections', () => {
  const sb = sandbox('pool-format-list');
  const later = (ms) => new Date(Date.now() + ms).toISOString();
  seedPool(sb, [{ name: 'a', email: 'a@x.io', last_used_at: later(-9 * MIN - 30_000) }, { name: 'longer-name', email: 'longer@example.org' }], (p) => {
    p.leases.push({ id: 'l', account: 'longer-name', pid: process.pid, job_id: null, role: 'run', started_at: '' });
    p.cooldowns[`a|${FAMILY}`] = { retry_at: later(HOUR + 5 * MIN + 30_000) };
    p.quota.a = { refreshed_at: later(-2 * MIN - 30_000), plan_type: 'pro', error: null, pools: {
      gemini: { short: { remaining: 0.25, reset_at: later(3 * HOUR + 30_000) }, weekly: { remaining: 1, reset_at: later(3 * 24 * HOUR + 30_000) } } } };
  });
  const r = run(sb, ['accounts', 'list']);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.split('\n');
  assert.ok(lines.every((l) => l === l.trimEnd()), 'no trailing spaces');
  const head = lines[0];
  const rows = lines.filter((l) => /^(a|longer-name) /.test(l)).slice(0, 2);
  assert.equal(rows.length, 2);
  const col = head.indexOf('STATE');
  assert.equal(head.indexOf('EMAIL'), 'longer-name'.length + 2);
  assert.match(rows[0].slice(col), /^cooling +9m ago$/);
  assert.match(rows[1].slice(col), /^busy 1 +never$/);
  assert.ok(lines.includes('live         your own agy login, never pooled'));
  assert.ok(lines.some((l) => /^QUOTA {8}POOL/.test(l)));
  assert.ok(lines.some((l) => /^a {12}gemini {2}25%  resets in 3h00m .* 100%  resets in 3d 0h .* 2m ago$/.test(l)), r.stdout);
  assert.ok(lines.some((l) => /^longer-name {2}not refreshed/.test(l)));
  const i = lines.indexOf('COOLDOWNS');
  assert.ok(i > 0);
  assert.match(lines[i + 1], new RegExp(`^a {2}${FAMILY} {2}until .*\\(in 1h05m\\)$`));
});
