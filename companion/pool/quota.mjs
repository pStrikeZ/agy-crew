import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { accountEnv } from './env.mjs';
import { accountDir, accountHome, updatePool } from './state.mjs';
import { quotaPool } from './results.mjs';
import { readToken } from './token.mjs';

const WARM_UP_TIMEOUT_MS = 30_000;
const WARM_UP_POLL_MS = 100;

const tokenChanged = (before, after) => {
  if (!after?.access_token) return false;
  if (!before?.access_token) return true;
  if (after.access_token !== before.access_token) return true;
  return Boolean(after.expiry_ms && before.expiry_ms && after.expiry_ms > before.expiry_ms);
};

/** Run agy once so it refreshes the file-backed token itself, then stop it as
 *  soon as the token file changes. A real agy can refresh the token in a few
 *  hundred milliseconds but keep the print turn open indefinitely; waiting for
 *  the process to exit would make every refresh look like a timeout. Async so
 *  the progress line keeps drawing meanwhile. */
export async function warmUp(home, agyCommand) {
  const before = readToken(home);
  const agy = agyCommand(['-p', 'reply with one word: pong', '--output-format', 'json']);
  return new Promise((resolve) => {
    let settled = false;
    let poll = null;
    let deadline = null;
    let child = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      if (deadline) clearTimeout(deadline);
      try { child?.kill(); } catch { /* already gone */ }
      resolve();
    };
    try {
      child = spawn(agy.cmd, agy.args, { cwd: home, env: accountEnv(home), stdio: 'ignore', timeout: WARM_UP_TIMEOUT_MS, windowsHide: true });
    } catch {
      finish();
      return;
    }
    child.on('error', finish);
    child.on('close', finish);
    poll = setInterval(() => {
      if (tokenChanged(before, readToken(home))) finish();
    }, WARM_UP_POLL_MS);
    deadline = setTimeout(finish, WARM_UP_TIMEOUT_MS);
  });
}

const bucketId = (b) => b.id || b.name || '';

/** Quota pool of one agy usage group: bucket id prefixes first, then its labels. */
function groupPool(group, buckets) {
  for (const b of buckets) {
    const id = String(bucketId(b));
    if (id.startsWith('gemini-')) return 'gemini';
    if (id.startsWith('3p-')) return 'other';
  }
  const label = `${group.name || ''} ${group.description || ''}`.toLowerCase();
  if (label.includes('gemini')) return 'gemini';
  if (/claude|gpt/.test(label)) return 'other';
  return null;
}

/** Pools from the `groups` of `agy -p /usage`: { gemini|other: { short|weekly: { remaining, reset_at } } }. */
export function parseQuotaSummary(data) {
  const pools = {};
  for (const group of data?.groups || []) {
    const buckets = group.buckets || [];
    const name = groupPool(group, buckets);
    if (!name) continue;
    for (const b of buckets) {
      const window = String(b.window || '').toLowerCase();
      const key = window === '5h' ? 'short' : window === 'weekly' ? 'weekly' : null;
      if (!key) continue;
      // proto3 JSON omits a zero fraction, so a bucket with a reset time but no fraction is empty
      const remaining = typeof b.remaining_fraction === 'number' ? b.remaining_fraction : b.reset_time ? 0 : null;
      if (remaining === null) continue;
      (pools[name] ||= {})[key] = { remaining, reset_at: b.reset_time ? new Date(b.reset_time).toISOString() : null };
    }
  }
  return pools;
}

const USAGE_TIMEOUT_MS = 20_000; // a signed-out agy would wait a minute for a browser login
const USAGE_OUTPUT_LIMIT = 64 * 1024;

class UsageError extends Error {
  constructor(message, { authFailed = false } = {}) {
    super(message);
    this.authFailed = authFailed;
  }
}

const AUTH_REQUIRED = /Authentication required|authentication (?:failed|interrupted)/i;

/** Run `agy -p /usage --output-format json` with the account's HOME. agy reads
 *  the quota itself (renewing the token if it must), so the pool never talks to
 *  the provider directly. Resolves to the parsed print-mode payload. */
function runUsage(name, agyCommand) {
  const home = accountHome(name);
  const logFile = path.join(accountDir(name), 'usage.log');
  try { fs.rmSync(logFile, { force: true }); } catch { /* best effort */ }
  const agy = agyCommand(['-p', '/usage', '--output-format', 'json', '--log-file', logFile]);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try { child?.kill(); } catch { /* already gone */ }
      fn(value);
    };
    const failure = (message) => new UsageError(message, { authFailed: AUTH_REQUIRED.test(`${stdout}\n${stderr}`) });
    const deadline = setTimeout(() => finish(reject, failure(`agy /usage did not answer within ${USAGE_TIMEOUT_MS / 1000}s`)), USAGE_TIMEOUT_MS);
    try {
      child = spawn(agy.cmd, agy.args, { cwd: home, env: accountEnv(home), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      finish(reject, new UsageError(`failed to launch agy: ${error.message}`));
      return;
    }
    child.stdout.on('data', (c) => { if (stdout.length < USAGE_OUTPUT_LIMIT) stdout += c; });
    child.stderr.on('data', (c) => { if (stderr.length < USAGE_OUTPUT_LIMIT) stderr += c; });
    child.on('error', (error) => finish(reject, new UsageError(`failed to launch agy: ${error.message}`)));
    child.on('close', (code) => {
      let print = null;
      try { print = JSON.parse(stdout.trim()); } catch { /* not JSON */ }
      const groups = print?.command?.data?.groups;
      if (print?.status === 'SUCCESS' && Array.isArray(groups)) {
        // Without file-backed storage agy would read the OS keyring, shared by
        // every HOME, and report some other account's quota.
        let log = '';
        try { log = fs.readFileSync(logFile, 'utf8'); } catch { /* checked below */ }
        if (!log.includes('Using file-based token storage')) {
          finish(reject, new UsageError('agy did not use file-based token storage'));
        } else finish(resolve, { groups });
        return;
      }
      const reason = print?.error || (print ? `agy /usage reported ${print.status}` : `agy /usage exited with ${code} without a readable report`);
      finish(reject, failure(String(reason)));
    });
  });
}

/** Ask agy for one account's quota. Never throws, never prints tokens.
 *  onStage('query') reports what it is waiting on. */
export async function fetchSnapshot(name, { agyCommand }, onStage = () => {}) {
  const snapshot = { refreshed_at: new Date().toISOString(), pools: {}, error: null };
  let authFailed = false;
  try {
    if (!readToken(accountHome(name))?.access_token) throw new UsageError('no access token (run `accounts login`)');
    onStage('query');
    snapshot.pools = parseQuotaSummary(await runUsage(name, agyCommand));
  } catch (error) {
    authFailed = Boolean(error.authFailed);
    snapshot.error = String(error.message || error).slice(0, 300);
  }
  return { snapshot, authFailed };
}

/** Borrowers of a live credential loan. Reaps dead loans first, which puts
 *  their tokens back. */
const loanBorrowers = () => updatePool((pool) => new Set(pool.loans.map((l) => l.borrower)));

/** Fetch snapshots one account at a time (parallel requests from one machine
 *  for several Google accounts look like abuse), then store them in one locked
 *  update. A pool with quota left clears that account's cooldowns for its
 *  families. An account whose credential is on loan is skipped and keeps its
 *  last snapshot: its token file holds the lender's credential, so asking
 *  agy would store the lender's quota under the borrower's name.
 *  progress: { stage(name, stage), done(name, snapshot), skip(name, reason) }. */
export async function refreshQuotas(names, deps, progress = {}) {
  const fetched = [];
  const onLoan = loanBorrowers();
  for (const name of names) {
    if (onLoan.has(name)) { progress.skip?.(name, 'credential on loan to a running job'); continue; }
    progress.stage?.(name, 'start');
    const result = await fetchSnapshot(name, deps, (stage) => progress.stage?.(name, stage));
    fetched.push([name, result]);
    progress.done?.(name, result.snapshot);
  }
  updatePool((pool) => {
    for (const [name, { snapshot, authFailed }] of fetched) {
      const account = pool.accounts.find((a) => a.name === name);
      // A loan that began while this account was being asked may have swapped its token in.
      if (!account || pool.loans.some((l) => l.borrower === name)) continue;
      pool.quota[name] = snapshot;
      if (authFailed) { account.auth_error_at = snapshot.refreshed_at; account.auth_error = snapshot.error; }
      for (const [group, windows] of Object.entries(snapshot.pools)) {
        const values = Object.values(windows).map((w) => w.remaining);
        if (!values.length || Math.min(...values) <= 0) continue;
        for (const key of Object.keys(pool.cooldowns)) {
          const [owner, family] = key.split('|');
          if (owner === name && quotaPool(family) === group) delete pool.cooldowns[key];
        }
      }
    }
  });
  return Object.fromEntries(fetched.map(([name, f]) => [name, f.snapshot]));
}
