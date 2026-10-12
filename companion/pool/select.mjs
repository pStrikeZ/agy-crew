import fs from 'node:fs';
import { accountHome, tokenPath } from './state.mjs';
import { quotaPool } from './results.mjs';

export const findAccount = (pool, name) => pool.accounts.find((a) => a.name === name) || null;
export const leasesOn = (pool, name) => pool.leases.filter((l) => l.account === name);
const defaultHasToken = (name) => fs.existsSync(tokenPath(accountHome(name)));

export function activeCooldown(pool, name, family, now) {
  const c = pool.cooldowns[`${name}|${family}`];
  return c && Date.parse(c.retry_at) > now ? c : null;
}

/** Cloud Code snapshot says a window of this family's quota pool is empty and not yet reset. */
export function exhaustedSnapshot(pool, name, family, now) {
  const group = pool.quota?.[name]?.pools?.[quotaPool(family)];
  if (!group) return null;
  for (const window of ['short', 'weekly']) {
    const w = group[window];
    if (w && w.remaining === 0 && Date.parse(w.reset_at) > now) return w;
  }
  return null;
}

/** Smallest known remaining fraction across windows, or null when unknown. */
function knownRemaining(pool, name, family) {
  const group = pool.quota?.[name]?.pools?.[quotaPool(family)];
  const values = ['short', 'weekly'].map((w) => group?.[w]?.remaining).filter((v) => typeof v === 'number');
  return values.length ? Math.min(...values) : null;
}

function usable(pool, a, family, now, hasToken) {
  return !a.disabled && !a.auth_error_at && hasToken(a.name) &&
    !activeCooldown(pool, a.name, family, now) && !exhaustedSnapshot(pool, a.name, family, now);
}

// Remaining quota counts in 5% steps: accounts that are about equally full
// rotate by least recent use instead of the fullest one winning every time.
const QUOTA_STEPS = 20;
const quotaBucket = (remaining) => (remaining === null ? -1 : Math.round(remaining * QUOTA_STEPS));

// fewer leases, then more known quota (unknown after known > 0), then least recently used, then insertion order
function rank(pool, family, withLeases) {
  return (a, b) => {
    if (withLeases) {
      const d = leasesOn(pool, a.name).length - leasesOn(pool, b.name).length;
      if (d) return d;
    }
    const ra = quotaBucket(knownRemaining(pool, a.name, family));
    const rb = quotaBucket(knownRemaining(pool, b.name, family));
    if (ra !== rb) return rb - ra;
    const ua = a.last_used_at || '', ub = b.last_used_at || '';
    if (ua !== ub) return ua < ub ? -1 : 1;
    return pool.accounts.indexOf(a) - pool.accounts.indexOf(b);
  };
}

const unavailableCooldown = (c) => c?.reason === 'upstream_unavailable';

function coolingError(pool, accounts, family, now) {
  const rows = accounts.map((a) => {
    const c = activeCooldown(pool, a.name, family, now);
    const s = exhaustedSnapshot(pool, a.name, family, now);
    return { name: a.name, at: c?.retry_at || s?.reset_at || null, capacity: unavailableCooldown(c) && !s };
  });
  const times = rows.map((r) => r.at).filter(Boolean).sort();
  const detail = rows.map((r) => `  ${r.name}: ${r.at ? `retry after ${r.at}` : 'unavailable'}`).join('\n');
  const capacity = rows.every((r) => r.capacity);
  const reason = capacity ? 'upstream_unavailable' : 'quota_exhausted';
  const intro = capacity
    ? `every pool account recently got ${family} unavailable upstream (503, upstream_unavailable).`
    : `every pool account is out of ${family} quota (quota_exhausted).`;
  return { error: { reason, retry_at: times[0] || null,
    message: `${intro}\n${detail}\nUse \`--account live\` (your own agy login) or another model family.` } };
}

/** Pick the account for a run. Pure: callers add the lease. Returns
 *  { account, auto?, needsLoan?, retry_at? } or { error: { message, reason?, retry_at? } }. */
export function chooseAccount(pool, { requested = 'auto', family, conversation = null, conversationAccount = null, now = Date.now(), hasToken = defaultHasToken }) {
  const explicit = requested && requested !== 'auto';
  if (conversationAccount) {
    if (explicit && requested !== conversationAccount) {
      return { error: { message: `conversation ${conversation} belongs to account ${conversationAccount}; --account ${requested} cannot continue it` } };
    }
    if (conversationAccount === 'live') return { account: 'live' };
    const a = findAccount(pool, conversationAccount);
    if (!a) return { error: { message: `conversation ${conversation} belongs to account ${conversationAccount}, which no longer exists` } };
    if (a.disabled) return { error: { message: `conversation ${conversation} belongs to account ${a.name}, which is disabled (accounts enable ${a.name})` } };
    if (a.auth_error_at || !hasToken(a.name)) return { error: { message: `conversation ${conversation} belongs to account ${a.name}, which needs login (accounts login ${a.name})` } };
    const c = activeCooldown(pool, a.name, family, now);
    if (c) return { account: a.name, needsLoan: true, retry_at: c.retry_at, reason: c.reason || 'quota_exhausted' };
    return { account: a.name };
  }
  if (requested === 'live') return { account: 'live' };
  if (explicit) {
    const a = findAccount(pool, requested);
    if (!a) return { error: { message: `unknown account "${requested}" (see \`accounts list\`)` } };
    if (a.disabled) return { error: { message: `account ${a.name} is disabled (accounts enable ${a.name})` } };
    if (a.auth_error_at || !hasToken(a.name)) return { error: { message: `account ${a.name} needs login (accounts login ${a.name})` } };
    const c = activeCooldown(pool, a.name, family, now);
    if (c) {
      const why = unavailableCooldown(c) ? `was unavailable upstream (503) for ${family}; retry after` : `has no ${family} quota until`;
      return { error: { reason: c.reason || 'quota_exhausted', retry_at: c.retry_at,
        message: `account ${a.name} ${why} ${c.retry_at}. Use \`--account auto\`, another account, or another model family.` } };
    }
    return { account: a.name };
  }
  const enabled = pool.accounts.filter((a) => !a.disabled);
  if (!enabled.length) return { account: 'live' };
  const candidates = enabled.filter((a) => usable(pool, a, family, now, hasToken));
  if (!candidates.length) {
    const cooling = enabled.filter((a) => activeCooldown(pool, a.name, family, now) || exhaustedSnapshot(pool, a.name, family, now));
    if (cooling.length) return coolingError(pool, cooling, family, now);
    return { error: { message: 'no pool account is ready: each enabled account needs login (see `accounts list`)' } };
  }
  candidates.sort(rank(pool, family, true));
  return { account: candidates[0].name, auto: true };
}

/** An idle account that can lend its credential to a borrower. */
export function chooseLender(pool, { family, exclude = [], now = Date.now(), hasToken = defaultHasToken }) {
  const inLoan = new Set(pool.loans.flatMap((l) => [l.borrower, l.lender]));
  const candidates = pool.accounts.filter((a) => !exclude.includes(a.name) && !inLoan.has(a.name) &&
    leasesOn(pool, a.name).length === 0 && usable(pool, a, family, now, hasToken));
  candidates.sort(rank(pool, family, false));
  return candidates[0]?.name || null;
}

