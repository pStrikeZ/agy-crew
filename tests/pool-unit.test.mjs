import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailureText, isAuthFailed, isQuotaExhausted, isUpstreamUnavailable, modelFamily, parseResetsIn, quotaPool } from '../companion/pool/results.mjs';
import { recordCooldown } from '../companion/pool/lease.mjs';
import { accountEnv } from '../companion/pool/env.mjs';
import { chooseAccount, chooseLender } from '../companion/pool/select.mjs';
import { parseQuotaSummary } from '../companion/pool/quota.mjs';
import { loadPool, updatePool, validateAccountName } from '../companion/pool/state.mjs';
import { emptyPool } from './pool-helpers.mjs';

const NOW = Date.parse('2026-06-01T12:00:00Z');
const FAMILY = 'gemini-3.8-flash';
const hasToken = () => true;
const poolOf = (...names) => {
  const pool = emptyPool();
  names.forEach((name, i) => pool.accounts.push({ name, email: `${name}@x`, added_at: '', last_used_at: null, disabled: false, auth_error_at: null, auth_error: null, i }));
  return pool;
};
const choose = (pool, extra = {}) => chooseAccount(pool, { family: FAMILY, now: NOW, hasToken, ...extra });

test('modelFamily strips effort suffixes and quotaPool groups families', () => {
  assert.equal(modelFamily('gemini-3.8-flash-low'), 'gemini-3.8-flash');
  assert.equal(modelFamily('gemini-3.1-pro-high'), 'gemini-3.1-pro');
  assert.equal(modelFamily('claude-sonnet-4-6'), 'claude-sonnet-4-6');
  assert.equal(modelFamily('gpt-oss-120b-medium'), 'gpt-oss-120b');
  assert.equal(quotaPool('gemini-3.8-flash'), 'gemini');
  assert.equal(quotaPool('claude-opus-4-6-thinking'), 'other');
});

test('quota and auth classifiers require both halves of their signature', () => {
  assert.equal(isQuotaExhausted('RESOURCE_EXHAUSTED: Individual quota reached. Resets in 2h.'), true);
  assert.equal(isQuotaExhausted('resource_exhausted: weekly quota reached'), true);
  assert.equal(isQuotaExhausted('RESOURCE_EXHAUSTED: capacity'), false);
  assert.equal(isQuotaExhausted('Individual quota reached'), false);
  assert.equal(isAuthFailed('HTTP 401 Unauthenticated: invalid token'), true);
  assert.equal(isAuthFailed('403 login required'), true);
  assert.equal(isAuthFailed('401 not found'), false);
  assert.equal(isAuthFailed('token expired'), false);
  assert.equal(classifyFailureText('RESOURCE_EXHAUSTED Individual quota reached'), 'quota_exhausted');
  assert.equal(classifyFailureText('401 bad credential'), 'authentication_failed');
  assert.equal(classifyFailureText('something else'), null);
});

test('upstream 503 is its own failure kind and never shadows quota or auth', () => {
  const real = 'Our servers are experiencing high traffic right now, please try again in a minute. (UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server)';
  assert.equal(isUpstreamUnavailable(real), true);
  assert.equal(isUpstreamUnavailable('UNAVAILABLE (code 503)'), true);
  assert.equal(isUpstreamUnavailable('No capacity available for model x'), true);
  assert.equal(isUpstreamUnavailable('UNAVAILABLE: try later'), false);
  assert.equal(isUpstreamUnavailable('HTTP 503 from proxy'), false);
  assert.equal(classifyFailureText(real), 'upstream_unavailable');
  assert.equal(classifyFailureText(`RESOURCE_EXHAUSTED: Individual quota reached. ${real}`), 'quota_exhausted');
  assert.equal(classifyFailureText(`401 unauthenticated token. ${real}`), 'authentication_failed');
});

test('a short 503 cooldown never shortens a quota cooldown that is still running', () => {
  const later = new Date(Date.now() + 2 * 3_600_000).toISOString();
  updatePool((pool) => { pool.cooldowns = { [`z|${FAMILY}`]: { retry_at: later, reason: 'quota_exhausted' } }; });
  const kept = recordCooldown('z', FAMILY, 'UNAVAILABLE (code 503)', null, 'upstream_unavailable');
  assert.equal(kept.retry_at, later);
  assert.equal(loadPool().cooldowns[`z|${FAMILY}`].reason, 'quota_exhausted');

  const fresh = recordCooldown('y', FAMILY, 'UNAVAILABLE (code 503)', 'job1', 'upstream_unavailable');
  assert.equal(fresh.reason, 'upstream_unavailable');
  assert.equal(Date.parse(fresh.retry_at) - Date.parse(fresh.recorded_at), 3 * 60_000);
  assert.equal(loadPool().cooldowns[`y|${FAMILY}`].job_id, 'job1');

  const quota = recordCooldown('y', FAMILY, 'Resets in 1h', null);
  assert.equal(quota.reason, 'quota_exhausted', 'a quota failure replaces the short cooldown');
  assert.equal(Date.parse(quota.retry_at) - Date.parse(quota.recorded_at), 3_600_000);
  updatePool((pool) => { pool.cooldowns = {}; });
});

test('parseResetsIn reads compact and spaced duration tokens', () => {
  assert.equal(parseResetsIn('Resets in 2h3m.'), 2 * 3_600_000 + 3 * 60_000);
  assert.equal(parseResetsIn('quota reached. resets in 1d 4h'), 28 * 3_600_000);
  assert.equal(parseResetsIn('Resets in 45s'), 45_000);
  assert.equal(parseResetsIn('Resets in 1h 30m 15s!'), 5_415_000);
  assert.equal(parseResetsIn('no hint here'), null);
  assert.equal(parseResetsIn('resets in soon'), null);
});

test('accountEnv isolates HOME and forces file token storage; live is untouched', () => {
  const base = { PATH: 'p', HOME: '/real' };
  const env = accountEnv('/pool/a/home', base);
  assert.equal(env.HOME, '/pool/a/home');
  assert.equal(env.SSH_CONNECTION, '127.0.0.1 1 127.0.0.1 1');
  assert.equal(env.SSH_CLIENT, '127.0.0.1 1 1');
  assert.equal(env.SSH_TTY, 'agy-crew-account');
  assert.equal(env.PATH, 'p');
  if (process.platform === 'win32') assert.equal(env.USERPROFILE, '/pool/a/home');
  assert.equal(base.HOME, '/real');
  assert.equal(accountEnv(null, base), base);
});

test('account names are validated and reserved words refused', () => {
  for (const ok of ['a', 'work-1', 'x.y_z', '0abc']) assert.equal(validateAccountName(ok), ok);
  for (const bad of ['', 'Bad', '-a', 'a b', 'x'.repeat(33), 'live', 'auto']) assert.throws(() => validateAccountName(bad));
});

test('auto selection: empty pool is live, then least loaded, most quota, least recently used', () => {
  assert.deepEqual(choose(poolOf()), { account: 'live' });
  assert.deepEqual(choose(poolOf('a'), { requested: 'live' }), { account: 'live' });

  const pool = poolOf('a', 'b', 'c');
  assert.equal(choose(pool).account, 'a'); // insertion order breaks the full tie
  pool.accounts[0].last_used_at = '2026-06-01T11:00:00Z';
  assert.equal(choose(pool).account, 'b'); // oldest last_used_at wins
  pool.leases.push({ id: 'l', account: 'b', pid: 1, role: 'run' });
  assert.equal(choose(pool).account, 'c'); // fewest leases first
  pool.quota.a = { pools: { gemini: { short: { remaining: 0.9, reset_at: null }, weekly: { remaining: 0.8, reset_at: null } } } };
  pool.quota.c = { pools: { gemini: { short: { remaining: 0.2, reset_at: null } } } };
  pool.leases = [];
  assert.equal(choose(pool).account, 'a'); // known remaining beats unknown, higher wins
  assert.equal(choose(pool).auto, true);
});

test('auto selection rotates among accounts whose known quota is about equal', () => {
  const pool = poolOf('a', 'b', 'c');
  const quota = (remaining) => ({ pools: { gemini: { weekly: { remaining, reset_at: null } } } });
  pool.quota.a = quota(0.99945);
  pool.quota.b = quota(0.989);
  pool.quota.c = quota(0.68);
  assert.equal(choose(pool).account, 'a');
  pool.accounts[0].last_used_at = '2026-06-01T11:00:00Z';
  assert.equal(choose(pool).account, 'b', 'a was just used and b is within one 5% step of a');
  pool.accounts[1].last_used_at = '2026-06-01T11:30:00Z';
  assert.equal(choose(pool).account, 'a', 'back to the least recently used of the near-equal pair');
  pool.quota.a = quota(0.5);
  pool.quota.b = quota(0.5);
  assert.equal(choose(pool).account, 'c', 'a clearly fuller account still wins');
});

test('auto selection skips disabled, auth-failed, cooling and exhausted-snapshot accounts', () => {
  const pool = poolOf('a', 'b', 'c', 'd');
  pool.accounts[0].disabled = true;
  pool.accounts[1].auth_error_at = '2026-06-01T00:00:00Z';
  pool.cooldowns[`c|${FAMILY}`] = { retry_at: '2026-06-01T14:00:00Z' };
  assert.equal(choose(pool).account, 'd');
  pool.quota.d = { pools: { gemini: { short: { remaining: 0, reset_at: '2026-06-01T13:00:00Z' } } } };
  const none = choose(pool);
  assert.equal(none.error.reason, 'quota_exhausted');
  assert.equal(none.error.retry_at, '2026-06-01T13:00:00Z');
  assert.match(none.error.message, /--account live/);
  pool.cooldowns[`c|${FAMILY}`].retry_at = '2026-06-01T11:00:00Z'; // already over
  assert.equal(choose(pool).account, 'c');
  pool.cooldowns[`c|other-family`] = { retry_at: '2026-06-01T14:00:00Z' }; // other family does not matter
  assert.equal(choose(pool).account, 'c');
});

test('a pool that is cooling only because of 503s reports upstream_unavailable', () => {
  const pool = poolOf('a', 'b');
  pool.cooldowns[`a|${FAMILY}`] = { retry_at: '2026-06-01T12:03:00Z', reason: 'upstream_unavailable' };
  pool.cooldowns[`b|${FAMILY}`] = { retry_at: '2026-06-01T12:02:00Z', reason: 'upstream_unavailable' };
  const none = choose(pool);
  assert.equal(none.error.reason, 'upstream_unavailable');
  assert.equal(none.error.retry_at, '2026-06-01T12:02:00Z');
  assert.match(none.error.message, /unavailable upstream \(503/);
  assert.doesNotMatch(none.error.message, /out of .* quota/);
  const explicit = choose(pool, { requested: 'a' });
  assert.equal(explicit.error.reason, 'upstream_unavailable');
  assert.match(explicit.error.message, /unavailable upstream \(503\) for gemini-3\.8-flash; retry after 2026-06-01T12:03:00Z/);

  pool.cooldowns[`b|${FAMILY}`] = { retry_at: '2026-06-01T14:00:00Z', reason: 'quota_exhausted' };
  assert.equal(choose(pool).error.reason, 'quota_exhausted', 'any quota cooldown makes it a quota error');

  const bound = choose(pool, { conversation: 'c1', conversationAccount: 'a' });
  assert.equal(bound.needsLoan, true);
  assert.equal(bound.reason, 'upstream_unavailable');
});

test('explicit selection refuses unknown, disabled, login-needed and cooling accounts', () => {
  const pool = poolOf('a', 'b');
  assert.equal(choose(pool, { requested: 'a' }).account, 'a');
  assert.match(choose(pool, { requested: 'zzz' }).error.message, /unknown account/);
  pool.accounts[0].disabled = true;
  assert.match(choose(pool, { requested: 'a' }).error.message, /disabled/);
  pool.accounts[1].auth_error_at = 'x';
  assert.match(choose(pool, { requested: 'b' }).error.message, /needs login/);
  pool.accounts[1].auth_error_at = null;
  pool.cooldowns[`b|${FAMILY}`] = { retry_at: '2026-06-01T14:00:00Z' };
  const cooling = choose(pool, { requested: 'b' });
  assert.equal(cooling.error.reason, 'quota_exhausted');
  assert.match(cooling.error.message, /2026-06-01T14:00:00Z/);
  assert.match(cooling.error.message, /--account auto/);
});

test('a bound conversation must use its account; cooling asks for a loan', () => {
  const pool = poolOf('a', 'b');
  const bound = { conversation: 'c1', conversationAccount: 'a' };
  assert.equal(choose(pool, bound).account, 'a');
  assert.equal(choose(pool, { ...bound, requested: 'a' }).account, 'a');
  assert.equal(choose(pool, { ...bound, requested: 'auto' }).account, 'a');
  assert.match(choose(pool, { ...bound, requested: 'b' }).error.message, /conversation c1 belongs to account a/);
  assert.equal(choose(pool, { conversation: 'c0', conversationAccount: 'live' }).account, 'live');
  assert.match(choose(pool, { conversation: 'c0', conversationAccount: 'live', requested: 'a' }).error.message, /belongs to account live/);
  pool.cooldowns[`a|${FAMILY}`] = { retry_at: '2026-06-01T14:00:00Z' };
  const loan = choose(pool, bound);
  assert.equal(loan.account, 'a');
  assert.equal(loan.needsLoan, true);
  assert.equal(loan.retry_at, '2026-06-01T14:00:00Z');
});

test('chooseLender needs an idle, usable account outside any loan', () => {
  const pool = poolOf('a', 'b', 'c');
  const lender = (extra = {}) => chooseLender(pool, { family: FAMILY, exclude: ['a'], now: NOW, hasToken, ...extra });
  assert.equal(lender(), 'b');
  pool.leases.push({ id: 'l', account: 'b', pid: 1, role: 'run' });
  assert.equal(lender(), 'c');
  pool.loans.push({ id: 'x', borrower: 'c', lender: 'a', pid: 1 });
  assert.equal(lender(), null);
  pool.loans = [];
  pool.cooldowns[`c|${FAMILY}`] = { retry_at: '2026-06-01T14:00:00Z' };
  assert.equal(lender(), null);
});

test('a held account is never picked or lent, refuses --account, and lends its conversation a credential', () => {
  const pool = poolOf('a', 'b');
  pool.leases.push({ id: 'h', account: 'a', pid: 1, role: 'hold' });
  assert.equal(choose(pool).account, 'b');
  const explicit = choose(pool, { requested: 'a' });
  assert.equal(explicit.error.reason, 'held');
  assert.match(explicit.error.message, /held by another process/);
  const bound = choose(pool, { conversation: 'c1', conversationAccount: 'a' });
  assert.deepEqual([bound.account, bound.needsLoan, bound.reason], ['a', true, 'held']);
  assert.equal(chooseLender(pool, { family: FAMILY, exclude: ['b'], now: NOW, hasToken }), null);
  pool.leases.push({ id: 'h2', account: 'b', pid: 1, role: 'hold' });
  assert.match(choose(pool).error.message, /no pool account is ready/);
});

test('parseQuotaSummary maps groups to pools and windows', () => {
  const pools = parseQuotaSummary({ groups: [
    { displayName: 'Gemini', buckets: [
      { id: 'gemini-x-5h', window: '5h', remainingFraction: 0.5, resetTime: '2030-01-01T00:00:00Z' },
      { id: 'gemini-x-w', window: 'weekly', resetTime: '2030-01-02T00:00:00Z' },
      { id: 'gemini-x-d', window: 'daily', remainingFraction: 1 }] },
    { description: 'Claude and GPT models', buckets: [{ id: 'misc', window: '5h', remainingFraction: 0.1 }] },
    { displayName: 'Unrelated', buckets: [{ id: 'q', window: '5h', remainingFraction: 1 }] },
  ] });
  assert.deepEqual(pools.gemini.short, { remaining: 0.5, reset_at: '2030-01-01T00:00:00.000Z' });
  assert.equal(pools.gemini.weekly.remaining, 0); // proto3 JSON omits zero
  assert.equal(pools.gemini.daily, undefined);
  assert.equal(pools.other.short.remaining, 0.1);
  assert.equal(Object.keys(pools).length, 2);
});
