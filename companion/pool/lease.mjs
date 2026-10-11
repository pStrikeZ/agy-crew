import { randomUUID } from 'node:crypto';
import { accountEnv } from './env.mjs';
import { accountHome, loadPool, poolExists, updatePool } from './state.mjs';
import { parseResetsIn } from './results.mjs';
import { chooseAccount, chooseLender, findAccount } from './select.mjs';
import { beginLoan, endLoan } from './loans.mjs';

export const boundAccount = (pool, conversation) =>
  conversation ? pool.conversations[conversation]?.account || 'live' : null;

const request = (req, pool) => ({
  requested: req.requested, family: req.family, conversation: req.conversation || null,
  conversationAccount: boundAccount(pool, req.conversation), now: Date.now(),
});

/** Read-only check used before a background job is registered. Returns an error
 *  object or null. Never locks or creates anything. */
export function preflight(req) {
  const pool = loadPool();
  return chooseAccount(pool, request(req, pool)).error || null;
}

const liveHeld = (pool, extra = {}) => ({ account: 'live', env: undefined, pooled: pool.accounts.length > 0, release() {}, ...extra });

/** Selection and lease insertion are one locked update, so two runs starting
 *  together cannot both see the same account as idle. Returns
 *  { held } or { error }. held.release() must run after the agy process ends. */
export function acquireRun(req) {
  if (!poolExists()) {
    const pool = loadPool();
    const pick = chooseAccount(pool, request(req, pool));
    return pick.error ? { error: pick.error } : { held: liveHeld(pool) };
  }
  const outcome = updatePool((pool) => {
    const pick = chooseAccount(pool, request(req, pool));
    if (pick.error) return { error: pick.error };
    if (pick.account === 'live') return { held: { account: 'live', pooled: pool.accounts.length > 0 } };
    const base = { pid: process.pid, job_id: req.jobId || null, started_at: new Date().toISOString() };
    const account = findAccount(pool, pick.account);
    account.last_used_at = base.started_at;
    if (pick.needsLoan) {
      const lender = chooseLender(pool, { family: req.family, exclude: [pick.account] });
      if (!lender) {
        return { error: { reason: 'quota_exhausted', retry_at: pick.retry_at,
          message: `account ${pick.account} has no ${req.family} quota until ${pick.retry_at} and no other pool account is idle to lend a credential.` } };
      }
      const loan = beginLoan(pool, { borrower: pick.account, lender, jobId: req.jobId });
      return { held: { account: pick.account, lender, loanId: loan.id, pooled: true } };
    }
    const id = randomUUID().slice(0, 8);
    pool.leases.push({ ...base, id, account: pick.account, role: 'run' });
    return { held: { account: pick.account, leaseId: id, auto: !!pick.auto, pooled: true } };
  });
  if (outcome.error) return outcome;
  const held = outcome.held;
  held.env = held.account === 'live' ? undefined : accountEnv(accountHome(held.account));
  held.release = () => {
    if (!held.leaseId && !held.loanId) return;
    const { leaseId, loanId } = held;
    held.leaseId = held.loanId = null;
    updatePool((pool) => {
      if (loanId) endLoan(pool, loanId);
      if (leaseId) pool.leases = pool.leases.filter((l) => l.id !== leaseId);
    });
  };
  return { held };
}

const DEFAULT_COOLDOWN_MS = 60 * 60_000;

/** Record a quota cooldown for the account whose credential made the request.
 *  Returns the cooldown (retry_at is when the reported reset passes, or one
 *  hour when agy did not say). */
export function recordCooldown(name, family, text, jobId) {
  const now = Date.now();
  const cooldown = { retry_at: new Date(now + (parseResetsIn(text) ?? DEFAULT_COOLDOWN_MS)).toISOString(),
    reason: 'quota_exhausted', recorded_at: new Date(now).toISOString(), job_id: jobId || null,
    message: String(text).trim().slice(0, 500) };
  updatePool((pool) => { pool.cooldowns[`${name}|${family}`] = cooldown; });
  return cooldown;
}

/** An authentication failure parks the account until `accounts login`. */
export function markAuthError(name, text) {
  updatePool((pool) => {
    const account = findAccount(pool, name);
    if (account) { account.auth_error_at = new Date().toISOString(); account.auth_error = String(text).trim().slice(0, 300); }
  });
}
