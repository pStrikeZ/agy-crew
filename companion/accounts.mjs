/**
 * `accounts` subcommands: manage the pool of private agy logins.
 *
 * Pool state lives in <globalHome()>/pool.json, never in the repository, so
 * nothing here calls the companion's ensureStateDir. Failures are thrown as
 * PoolError; main() prints them and exits 1.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PRODUCT } from './identity.mjs';
import { accountEnv } from './pool/env.mjs';
import { accountDir, accountHome, accountSettingsPath, loadPool, poolExists, poolPaths, tokenPath,
  updatePool, validateAccountName, PoolError } from './pool/state.mjs';
import { accountInLoan } from './pool/loans.mjs';
import { readToken } from './pool/token.mjs';
import { refreshQuotas } from './pool/quota.mjs';
import { formatAgo, renderCooldowns, renderQuotaTable, renderTable } from './pool/format.mjs';
import { replaceFile } from './state-lock.mjs';

const out = (text) => process.stdout.write(text + '\n');
const printJson = (value) => out(JSON.stringify(value, null, 2));
const FILE_TOKEN_MARKER = 'Using file-based token storage';

/** Current pool with dead leases and loans reaped (only when a pool exists). */
function currentPool() {
  if (!poolExists()) return loadPool();
  return updatePool((pool) => structuredClone(pool));
}

const busy = (pool, name) => pool.leases.some((l) => l.account === name) || accountInLoan(pool, name);

function requireAccount(pool, name) {
  if (!name) throw new PoolError('this command needs an account name (see `accounts list`)');
  const account = pool.accounts.find((a) => a.name === name);
  if (!account) throw new PoolError(`unknown account "${name}" (see \`accounts list\`)`);
  return account;
}

function accountState(pool, account, now) {
  if (account.disabled) return 'disabled';
  if (account.auth_error_at || !fs.existsSync(tokenPath(accountHome(account.name)))) return 'needs login';
  const cooling = Object.entries(pool.cooldowns).filter(([key, c]) => key.startsWith(`${account.name}|`) && Date.parse(c.retry_at) > now);
  if (cooling.length) return cooling.map(([key, c]) => `cooling ${key.split('|')[1]} until ${c.retry_at}`).join('; ');
  const n = pool.leases.filter((l) => l.account === account.name).length;
  return n ? `busy ${n}` : 'ready';
}

/** Text-mode state: the per-family cooldown detail lives in the COOLDOWNS section. */
const stateLabel = (state) => (state.startsWith('cooling ') ? 'cooling' : state);

function cmdList(opts) {
  const pool = currentPool();
  const now = Date.now();
  const rows = pool.accounts.map((a) => ({
    name: a.name, email: a.email, state: accountState(pool, a, now), last_used_at: a.last_used_at || null,
    quota: pool.quota[a.name] || null,
    cooldowns: Object.entries(pool.cooldowns).filter(([k]) => k.startsWith(`${a.name}|`)).map(([k, c]) => ({ family: k.split('|')[1], ...c })),
  }));
  if (opts.json) return printJson({ accounts: rows, live: { description: 'your own agy login; never pooled' } });
  if (!rows.length) out('No pool accounts. Add one with `accounts login <name>`.');
  const table = rows.map((r) => [r.name, r.email || 'unknown', stateLabel(r.state), formatAgo(r.last_used_at, now)]);
  table.push({ lead: ['live'], text: 'your own agy login, never pooled' });
  const lines = renderTable(['ACCOUNT', 'EMAIL', 'STATE', 'LAST USED'], table);
  if (rows.length) lines.push('', ...renderQuotaTable(rows.map((r) => ({ name: r.name, snapshot: r.quota })), now));
  const cooling = rows.flatMap((r) => r.cooldowns.filter((c) => Date.parse(c.retry_at) > now).map((c) => ({ name: r.name, ...c })));
  if (cooling.length) lines.push('', ...renderCooldowns(cooling, now));
  out(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// login / import
// ---------------------------------------------------------------------------

/** Copy only the permission rules from the live settings file, so a pooled run
 *  gets the same allow/deny lists without inheriting anything else. */
function seedSettings(home, liveSettings) {
  const target = accountSettingsPath(home);
  if (fs.existsSync(target)) return;
  try {
    const live = JSON.parse(fs.readFileSync(liveSettings, 'utf8'));
    if (!live.permissions) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ permissions: live.permissions }, null, 2) + '\n');
  } catch { /* no usable live settings: the account starts with agy defaults */ }
}

function assertUniqueEmail(pool, email, self = null) {
  if (!email) throw new PoolError('could not read an email from the token; refusing to add an account that cannot be told apart');
  const dup = pool.accounts.find((a) => a.email === email && a.name !== self);
  if (dup) throw new PoolError(`${email} is already enrolled as account "${dup.name}"`);
}

function newAccountRecord(name, email) {
  return { name, email, added_at: new Date().toISOString(), last_used_at: null, disabled: false, auth_error_at: null, auth_error: null };
}

function interactiveLogin(home, logDir, { agyCommand }) {
  fs.mkdirSync(home, { recursive: true });
  const log = path.join(logDir, `${PRODUCT}-login.log`);
  out(`Signing in to a private agy home: ${home}\n` +
    'agy opens a browser sign-in. Complete it, then exit agy once its prompt appears (Ctrl+C or /exit).');
  const agy = agyCommand(['--log-file', log]);
  const r = spawnSync(agy.cmd, agy.args, { cwd: home, env: accountEnv(home), stdio: 'inherit', windowsHide: true });
  if (r.error) throw new PoolError(`failed to launch agy: ${r.error.message}`);
  let logText = '';
  try { logText = fs.readFileSync(log, 'utf8'); } catch {}
  if (!logText.includes(FILE_TOKEN_MARKER)) {
    throw new PoolError(`agy did not report file-based token storage (see ${log}); the pool needs file-backed tokens`);
  }
  const token = readToken(home);
  if (!token) throw new PoolError(`login did not produce a token file at ${tokenPath(home)}`);
  return token;
}

function cmdLogin(opts, deps) {
  const name = validateAccountName(opts._[1]);
  const existing = currentPool().accounts.find((a) => a.name === name);
  return existing ? reLogin(existing, deps) : firstLogin(name, deps);
}

function firstLogin(name, deps) {
  const staging = path.join(poolPaths().enrollDir, randomUUID().slice(0, 8));
  const home = path.join(staging, 'home');
  try {
    const token = interactiveLogin(home, staging, deps);
    seedSettings(home, deps.liveSettings);
    const dest = accountDir(name);
    updatePool((pool) => {
      if (pool.accounts.some((a) => a.name === name)) throw new PoolError(`account "${name}" already exists`);
      assertUniqueEmail(pool, token.email);
      fs.mkdirSync(dest, { recursive: true });
      fs.renameSync(home, path.join(dest, 'home'));
      pool.accounts.push(newAccountRecord(name, token.email));
    });
    out(`Added account ${name} <${token.email}>.`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function reLogin(account, deps) {
  const home = accountHome(account.name);
  updatePool((pool) => { if (busy(pool, account.name)) throw new PoolError(`account ${account.name} is in use (lease or loan); try again when it is idle`); });
  const token = tokenPath(home);
  const backup = `${token}.agy-crew.login-backup`;
  const hadToken = fs.existsSync(token);
  if (hadToken) replaceFile(token, backup);
  const restore = () => { fs.rmSync(token, { force: true }); if (hadToken) replaceFile(backup, token); };
  try {
    const fresh = interactiveLogin(home, accountDir(account.name), deps);
    if (account.email && fresh.email !== account.email) {
      throw new PoolError(`re-login produced ${fresh.email}, but account ${account.name} is ${account.email}; restored the previous token`);
    }
    updatePool((pool) => {
      const a = requireAccount(pool, account.name);
      assertUniqueEmail(pool, fresh.email, a.name);
      a.email = fresh.email;
      a.auth_error_at = null;
      a.auth_error = null;
    });
  } catch (error) {
    restore();
    throw error;
  }
  fs.rmSync(backup, { force: true });
  out(`Re-login complete for ${account.name}.`);
}

/** Token and settings files of a HOME-shaped directory (e.g. an agy-cli-manager
 *  account dir) or a bare `.gemini/antigravity-cli` style tree. */
function findTokenFile(dir) {
  const candidates = [
    path.join(dir, '.gemini', 'antigravity-cli'), path.join(dir, 'antigravity-cli'), dir,
  ];
  for (const base of candidates) {
    const file = path.join(base, 'antigravity-oauth-token');
    if (fs.existsSync(file)) return { token: file, settings: path.join(base, 'settings.json') };
  }
  return null;
}

function cmdImport(opts) {
  const name = validateAccountName(opts._[1]);
  if (!opts.home) throw new PoolError('accounts import needs --home <dir>');
  const dir = path.resolve(opts.home);
  if (!fs.existsSync(dir)) throw new PoolError(`--home directory does not exist: ${dir}`);
  const real = fs.realpathSync.native(dir);
  if (real === fs.realpathSync.native(os.homedir())) throw new PoolError('refusing to import the live home: your own agy login is never pooled');
  const found = findTokenFile(dir);
  if (!found) throw new PoolError(`no antigravity-oauth-token found under ${dir}`);
  const home = accountHome(name);
  const staged = readTokenFrom(found.token);
  updatePool((pool) => {
    if (pool.accounts.some((a) => a.name === name)) throw new PoolError(`account "${name}" already exists`);
    assertUniqueEmail(pool, staged.email);
    fs.mkdirSync(path.dirname(tokenPath(home)), { recursive: true });
    fs.copyFileSync(found.token, tokenPath(home));
    if (fs.existsSync(found.settings)) fs.copyFileSync(found.settings, accountSettingsPath(home));
    pool.accounts.push(newAccountRecord(name, staged.email));
  });
  out(`Imported account ${name} <${staged.email}>.`);
}

function readTokenFrom(file) {
  // readToken works on a HOME; mirror the layout in a scratch dir only when the source is not HOME-shaped
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `${PRODUCT}-import-`));
  try {
    fs.mkdirSync(path.dirname(tokenPath(scratch)), { recursive: true });
    fs.copyFileSync(file, tokenPath(scratch));
    const token = readToken(scratch);
    if (!token) throw new PoolError(`cannot read the token file ${file}`);
    return token;
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// remove / enable / disable / cooldown
// ---------------------------------------------------------------------------

function cmdRemove(opts) {
  const name = opts._[1];
  if (!opts.yes) {
    const pool = currentPool();
    requireAccount(pool, name);
    const bound = Object.values(pool.conversations).filter((c) => c.account === name).length;
    out(`Would delete account ${name}: ${accountDir(name)}, its cooldowns, quota snapshot and ${bound} conversation binding(s).\nRerun with --yes to delete.`);
    return;
  }
  const bound = updatePool((pool) => {
    requireAccount(pool, name);
    if (busy(pool, name)) throw new PoolError(`account ${name} is in use (lease or loan); try again when it is idle`);
    pool.accounts = pool.accounts.filter((a) => a.name !== name);
    for (const key of Object.keys(pool.cooldowns)) if (key.startsWith(`${name}|`)) delete pool.cooldowns[key];
    delete pool.quota[name];
    const gone = Object.entries(pool.conversations).filter(([, c]) => c.account === name).map(([id]) => id);
    for (const id of gone) delete pool.conversations[id];
    fs.rmSync(accountDir(name), { recursive: true, force: true });
    return gone.length;
  });
  out(`Removed account ${name}. ${bound} conversation(s) bound to it can no longer be continued.`);
}

function cmdToggle(opts, disabled) {
  const name = opts._[1];
  updatePool((pool) => { requireAccount(pool, name).disabled = disabled; });
  out(`Account ${name} ${disabled ? 'disabled' : 'enabled'}.`);
}

function cmdCooldown(opts) {
  if (opts._[1] !== 'clear') throw new PoolError('usage: accounts cooldown clear <name> [--family <family>]');
  const name = opts._[2];
  const cleared = updatePool((pool) => {
    requireAccount(pool, name);
    const keys = Object.keys(pool.cooldowns).filter((k) => k.startsWith(`${name}|`) && (!opts.family || k === `${name}|${opts.family}`));
    for (const key of keys) delete pool.cooldowns[key];
    return keys.length;
  });
  out(`Cleared ${cleared} cooldown(s) for ${name}.`);
}

async function cmdQuota(opts, deps) {
  const pool = currentPool();
  const names = opts._.slice(1);
  for (const name of names) requireAccount(pool, name);
  const targets = names.length ? names : pool.accounts.map((a) => a.name);
  if (opts.refresh) await refreshQuotas(targets, deps);
  const latest = currentPool();
  const now = Date.now();
  const rows = targets.map((name) => ({ name, snapshot: latest.quota[name] || null,
    cooldowns: Object.entries(latest.cooldowns).filter(([k, c]) => k.startsWith(`${name}|`) && Date.parse(c.retry_at) > now)
      .map(([k, c]) => ({ family: k.split('|')[1], retry_at: c.retry_at })) }));
  if (opts.json) return printJson({ accounts: rows });
  if (!rows.length) return out('No pool accounts. Add one with `accounts login <name>`.');
  const lines = renderQuotaTable(rows.map((r) => ({ name: r.name, snapshot: r.snapshot })), now);
  const cooling = rows.flatMap((r) => r.cooldowns.map((c) => ({ name: r.name, ...c })));
  if (cooling.length) lines.push('', ...renderCooldowns(cooling, now));
  out(lines.join('\n'));
}

/** settings.json of every pool account, for `setup --apply`. */
export function poolSettingsFiles() {
  return loadPool().accounts.map((a) => ({ name: a.name, file: accountSettingsPath(accountHome(a.name)) }));
}

/** deps: { agyCommand, liveSettings } injected by the companion (avoids an import cycle). */
export async function cmdAccounts(opts, deps) {
  const sub = opts._[0];
  switch (sub) {
    case 'list': return cmdList(opts);
    case 'login': return cmdLogin(opts, deps);
    case 'import': return cmdImport(opts);
    case 'remove': return cmdRemove(opts);
    case 'enable': return cmdToggle(opts, false);
    case 'disable': return cmdToggle(opts, true);
    case 'cooldown': return cmdCooldown(opts);
    case 'quota': return cmdQuota(opts, deps);
    default:
      throw new PoolError('usage: accounts <list|login|import|remove|enable|disable|cooldown clear|quota> ...\n' +
        '  accounts list [--json]\n  accounts login <name>\n  accounts import <name> --home <dir>\n' +
        '  accounts remove <name> [--yes]\n  accounts enable|disable <name>\n' +
        '  accounts cooldown clear <name> [--family <f>]\n  accounts quota [<name>...] [--refresh] [--json]');
  }
}
