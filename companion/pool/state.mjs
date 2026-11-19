import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PRODUCT, globalHome } from '../identity.mjs';
import { withStateLock, replaceFile } from '../state-lock.mjs';
import { readToken } from './token.mjs';
import { cooldownKey } from './results.mjs';

export const POOL_SCHEMA = 1;
export const RESERVED_NAMES = ['live', 'auto'];
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
export const LOAN_BACKUP_NAME = '.antigravity-oauth-token.agy-crew.loan-backup';

export class PoolError extends Error {}

export function validateAccountName(name) {
  if (!NAME_RE.test(String(name || ''))) {
    throw new PoolError(`invalid account name "${name}": use 1-32 chars of a-z 0-9 . _ - starting with a letter or digit`);
  }
  if (RESERVED_NAMES.includes(name)) throw new PoolError(`"${name}" is a reserved account name`);
  return name;
}

export function poolPaths() {
  const root = globalHome();
  return { root, file: path.join(root, 'pool.json'), lock: path.join(root, 'pool.json.lock'),
    accountsDir: path.join(root, 'accounts'), enrollDir: path.join(root, 'enroll') };
}
export const accountDir = (name) => path.join(poolPaths().accountsDir, name);
export const accountHome = (name) => path.join(accountDir(name), 'home');
export const tokenPath = (home) => path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
export const accountSettingsPath = (home) => path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
/** The Cloud Code project agy last used, which belongs to the signed-in account. */
export const projectCachePath = (home) => path.join(home, '.gemini', 'antigravity-cli', 'cache', 'default_project_id.txt');
/** The HOME of `start` without an account name: it belongs to no account, so
 *  its conversations survive switching credentials. */
export const sharedHome = () => path.join(poolPaths().root, 'shared', 'home');
/** The user's own HOME, for `start` when the pool setting `start_home` is `real`. */
export const realHome = () => os.homedir();
export const START_HOMES = ['shared', 'real'];
/** Which HOME `start` runs agy in: the pool setting, `shared` by default. */
export const startHomeMode = (pool) => (START_HOMES.includes(pool.settings?.start_home) ? pool.settings.start_home : 'shared');
export const SHARED_BACKUP_SUFFIX = '.agy-crew.shared-backup';

export const emptyPool = () => ({ schema: POOL_SCHEMA, accounts: [], cooldowns: {}, leases: [], conversations: {}, loans: [], quota: {}, shared: null, settings: {} });

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

export function poolExists() {
  return fs.existsSync(poolPaths().file);
}

/** Missing file = empty pool. A corrupt or newer-schema file is an error and is
 *  never reset: the pool holds the only record of conversation bindings. */
export function loadPool() {
  const { file } = poolPaths();
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return emptyPool();
    throw new PoolError(`cannot read ${file}: ${error.message}`);
  }
  let pool;
  try { pool = JSON.parse(raw); } catch { throw new PoolError(`pool.json is corrupt: ${file} - fix or delete it, then retry`); }
  if (!pool || typeof pool !== 'object') throw new PoolError(`pool.json is corrupt: ${file} - fix or delete it, then retry`);
  if (pool.schema > POOL_SCHEMA) throw new PoolError(`pool.json was written by a newer ${PRODUCT} (schema ${pool.schema}); upgrade before using the account pool: ${file}`);
  return { ...emptyPool(), ...pool };
}

function savePool(pool) {
  const { file } = poolPaths();
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(pool, null, 2) + '\n');
  replaceFile(tmp, file);
}

const copyAtomic = (from, to) => {
  const tmp = `${to}.tmp-${process.pid}`;
  fs.copyFileSync(from, tmp);
  replaceFile(tmp, to);
};

/** Undo a credential loan's file swap: the borrower's current token (agy may
 *  have refreshed the lender's credential in it) goes back to the lender, the
 *  borrower's own token returns from its backup. Idempotent. */
export function restoreLoanFiles(loan) {
  const tb = tokenPath(accountHome(loan.borrower));
  const tl = tokenPath(accountHome(loan.lender));
  const backup = path.join(path.dirname(tb), LOAN_BACKUP_NAME);
  if (fs.existsSync(tb) && fs.existsSync(path.dirname(tl))) copyAtomic(tb, tl);
  fs.rmSync(tb, { force: true });
  if (loan.host_had_token && fs.existsSync(backup)) replaceFile(backup, tb);
}

/** The files a shared session takes from its account: the credential and the
 *  account's Cloud Code project. Everything else in the shared HOME stays. */
const SHARED_FILES = [tokenPath, projectCachePath];

/** Put an account's credential into the HOME of a shared session and return
 *  the backups to record in `pool.shared`. The shared HOME is ours; the user's
 *  real HOME may hold a login of its own, so what is there is moved aside and
 *  comes back when the session settles. Called inside updatePool. */
export function beginSharedFiles(account, home = sharedHome()) {
  const real = home !== sharedHome();
  const targets = SHARED_FILES.map((file) => file(home));
  if (real) {
    const stale = targets.find((to) => fs.existsSync(to + SHARED_BACKUP_SUFFIX));
    if (stale) throw new PoolError(`a backup already exists: ${stale}${SHARED_BACKUP_SUFFIX}; resolve it before starting in the real home`);
  }
  const backups = [];
  SHARED_FILES.forEach((file, i) => {
    const from = file(accountHome(account)), to = targets[i];
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (real) {
      const existed = fs.existsSync(to);
      if (existed) replaceFile(to, to + SHARED_BACKUP_SUFFIX);
      backups.push({ file: to, existed });
    }
    if (fs.existsSync(from)) copyAtomic(from, to); else fs.rmSync(to, { force: true });
  });
  return backups;
}

/** End the shared session once its last holder is gone: the credential goes
 *  back to its account (agy may have refreshed it), unless it is no longer that
 *  account's (someone signed in to another one inside agy), and the session's
 *  HOME is left without a credential; a real HOME gets its own files back.
 *  Idempotent. */
export function settleShared(pool) {
  if (!pool.shared || pool.leases.some((l) => l.shared)) return;
  const { account, email } = pool.shared;
  const home = pool.shared.home || sharedHome();
  const ts = tokenPath(home), ta = tokenPath(accountHome(account));
  const token = readToken(home);
  if (token && (!email || token.email === email) && fs.existsSync(path.dirname(ta))) copyAtomic(ts, ta);
  fs.rmSync(ts, { force: true });
  for (const { file, existed } of pool.shared.backups || []) {
    fs.rmSync(file, { force: true });
    if (existed && fs.existsSync(file + SHARED_BACKUP_SUFFIX)) replaceFile(file + SHARED_BACKUP_SUFFIX, file);
  }
  pool.shared = null;
}

/** Drop what belongs to dead processes. Runs at the start of every locked
 *  update so a crashed run never keeps an account busy or a token swapped. */
export function reap(pool, now = Date.now()) {
  pool.leases = pool.leases.filter((l) => alive(l.pid));
  const keep = [];
  for (const loan of pool.loans) {
    if (alive(loan.pid)) { keep.push(loan); continue; }
    try { restoreLoanFiles(loan); } catch { keep.push(loan); continue; } // retry on the next update
    pool.leases = pool.leases.filter((l) => l.loan_id !== loan.id);
  }
  pool.loans = keep;
  try { settleShared(pool); } catch { /* retry on the next update */ }
  for (const [key, c] of Object.entries(pool.cooldowns)) if (Date.parse(c.retry_at) <= now) delete pool.cooldowns[key];
  poolCooldowns(pool);
  return pool;
}

/** Cooldowns recorded per model family (before they were kept per quota pool) move to their
 *  pool's key; families of one pool merge into the cooldown that ends last. */
function poolCooldowns(pool) {
  for (const [key, c] of Object.entries(pool.cooldowns)) {
    const [account, family] = key.split('|');
    const pooled = cooldownKey(account, family);
    if (pooled === key) continue;
    delete pool.cooldowns[key];
    const known = pool.cooldowns[pooled];
    if (!known || Date.parse(c.retry_at) > Date.parse(known.retry_at)) pool.cooldowns[pooled] = c;
  }
}

export function updatePool(change) {
  const { root, lock } = poolPaths();
  fs.mkdirSync(root, { recursive: true });
  return withStateLock(lock, () => {
    const pool = reap(loadPool());
    const value = change(pool);
    savePool(pool);
    return value;
  });
}
