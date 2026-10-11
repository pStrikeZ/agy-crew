/**
 * Shared fixtures for the account-pool suites: seed accounts straight into a
 * sandbox's global home (the sandbox HOME makes globalHome() private), and an
 * async companion runner for tests that must serve HTTP while it runs.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { COMPANION, FAKE_AGY } from './helpers.mjs';

export const globalHomeOf = (sb) => path.join(sb.home, '.agy-crew');
export const poolFile = (sb) => path.join(globalHomeOf(sb), 'pool.json');
export const accountHomeOf = (sb, name) => path.join(globalHomeOf(sb), 'accounts', name, 'home');
export const tokenFileOf = (sb, name) => path.join(accountHomeOf(sb, name), '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
export const FAMILY = 'gemini-3.8-flash';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export const tokenJson = (email, extra = {}) => ({
  token: { access_token: 'fake-access', expiry: new Date(Date.now() + 3600_000).toISOString(), id_token: `${b64({ alg: 'none' })}.${b64({ email })}.` },
  ...extra,
});

export function emptyPool() {
  return { schema: 1, accounts: [], cooldowns: {}, leases: [], conversations: {}, loans: [], quota: {} };
}

export function readPool(sb) {
  return JSON.parse(fs.readFileSync(poolFile(sb), 'utf8'));
}

export function writePool(sb, pool) {
  fs.mkdirSync(globalHomeOf(sb), { recursive: true });
  fs.writeFileSync(poolFile(sb), JSON.stringify(pool, null, 2));
}

/** Seed accounts [{name, email, ...record overrides}] with file-backed tokens. */
export function seedPool(sb, accounts, mutate = () => {}) {
  const pool = emptyPool();
  let n = 0;
  for (const a of accounts) {
    const { name, email, ...rest } = a;
    fs.mkdirSync(path.dirname(tokenFileOf(sb, name)), { recursive: true });
    fs.writeFileSync(tokenFileOf(sb, name), JSON.stringify(tokenJson(email)));
    pool.accounts.push({ name, email, added_at: new Date(Date.UTC(2026, 0, 1, 0, 0, n++)).toISOString(),
      last_used_at: null, disabled: false, auth_error_at: null, auth_error: null, ...rest });
  }
  mutate(pool);
  writePool(sb, pool);
  return pool;
}

export const emailOfToken = (file) => {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  return JSON.parse(Buffer.from(json.token.id_token.split('.')[1], 'base64url').toString('utf8')).email;
};

/** Every {HOME, USERPROFILE, SSH_CONNECTION, account_email} the fake agy recorded. */
export function envCalls(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** A pid that is certainly dead. */
export async function deadPid() {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => child.on('close', resolve));
  return child.pid;
}

/** Async twin of helpers.run(): lets the test process serve HTTP meanwhile. */
export function runAsync(sb, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [COMPANION, ...args], {
      cwd: sb.repo,
      env: { ...process.env, HOME: sb.home, USERPROFILE: sb.home, AGY_CREW_HOME: globalHomeOf(sb), AGY_BIN: FAKE_AGY, FAKE_AGY_ARGV_FILE: sb.argvFile, FAKE_AGY_SLEEP_MS: '50', ...extraEnv },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
