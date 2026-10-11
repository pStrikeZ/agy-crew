import fs from 'node:fs';
import path from 'node:path';
import { PRODUCT, globalHome } from '../identity.mjs';
import { withStateLock, replaceFile } from '../state-lock.mjs';

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

export const emptyPool = () => ({ schema: POOL_SCHEMA, accounts: [], cooldowns: {}, leases: [], conversations: {}, loans: [], quota: {} });

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
  for (const [key, c] of Object.entries(pool.cooldowns)) if (Date.parse(c.retry_at) <= now) delete pool.cooldowns[key];
  return pool;
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
