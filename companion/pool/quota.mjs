import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { accountEnv } from './env.mjs';
import { accountHome, updatePool } from './state.mjs';
import { quotaPool } from './results.mjs';
import { readToken } from './token.mjs';

const baseUrl = () => process.env.AGY_CREW_CLOUDCODE_URL || 'https://cloudcode-pa.googleapis.com';
const WARM_UP_MS = 120_000;
const projectCache = (home) => path.join(home, '.gemini', 'antigravity-cli', 'cache', 'default_project_id.txt');

/** Run agy once so it refreshes the file-backed token itself. */
function warmUp(home, agyCommand) {
  const agy = agyCommand(['-p', 'reply with one word: pong', '--output-format', 'json']);
  spawnSync(agy.cmd, agy.args, { cwd: home, env: accountEnv(home), encoding: 'utf8', timeout: 60_000, windowsHide: true });
}

async function post(endpoint, accessToken, body) {
  const response = await fetch(`${baseUrl()}/v1internal:${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'User-Agent': 'antigravity' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  let json = null;
  try { json = await response.json(); } catch { /* non-JSON error body */ }
  return { status: response.status, json };
}

const bucketId = (b) => b.id || b.bucketId || b.quotaBucketId || b.name || '';

/** Quota pool of one Cloud Code group: bucket id prefixes first, then its labels. */
function groupPool(group, buckets) {
  for (const b of buckets) {
    const id = String(bucketId(b));
    if (id.startsWith('gemini-')) return 'gemini';
    if (id.startsWith('3p-')) return 'other';
  }
  const label = `${group.displayName || ''} ${group.description || ''}`.toLowerCase();
  if (label.includes('gemini')) return 'gemini';
  if (/claude|gpt/.test(label)) return 'other';
  return null;
}

export function parseQuotaSummary(json) {
  const pools = {};
  for (const group of json?.groups || []) {
    const buckets = group.buckets || group.quotaBuckets || [];
    const name = groupPool(group, buckets);
    if (!name) continue;
    for (const b of buckets) {
      const window = String(b.window || b.windowType || b.period || '').toLowerCase();
      const key = window === '5h' ? 'short' : window === 'weekly' ? 'weekly' : null;
      if (!key) continue;
      // proto3 JSON omits a zero fraction, so a bucket with a reset time but no fraction is empty
      const remaining = typeof b.remainingFraction === 'number' ? b.remainingFraction : b.resetTime ? 0 : null;
      if (remaining === null) continue;
      (pools[name] ||= {})[key] = { remaining, reset_at: b.resetTime ? new Date(b.resetTime).toISOString() : null };
    }
  }
  return pools;
}

async function queryCloudCode(home, accessToken) {
  const meta = { metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } };
  const load = await post('loadCodeAssist', accessToken, meta);
  if (load.status === 401) return { status: 401 };
  if (load.status >= 400) return { status: load.status, error: `loadCodeAssist HTTP ${load.status}` };
  let project = load.json?.cloudaicompanionProject;
  project = typeof project === 'string' ? project : project?.id;
  if (project) {
    try { fs.mkdirSync(path.dirname(projectCache(home)), { recursive: true }); fs.writeFileSync(projectCache(home), project); } catch {}
  } else {
    try { project = fs.readFileSync(projectCache(home), 'utf8').trim(); } catch {}
  }
  if (!project) return { status: 200, error: 'no Cloud Code project id available' };
  const summary = await post('retrieveUserQuotaSummary', accessToken, { project });
  if (summary.status === 401) return { status: 401 };
  if (summary.status >= 400) return { status: summary.status, error: `retrieveUserQuotaSummary HTTP ${summary.status}` };
  return { status: 200, plan_type: load.json?.planInfo?.planType || null, pools: parseQuotaSummary(summary.json) };
}

const needsWarmUp = (tok) => !tok?.access_token || (tok.expiry_ms !== null && tok.expiry_ms - Date.now() < WARM_UP_MS);

/** Query Cloud Code for one account. Never throws, never prints tokens. */
export async function fetchSnapshot(name, { agyCommand }) {
  const home = accountHome(name);
  const snapshot = { refreshed_at: new Date().toISOString(), plan_type: null, pools: {}, error: null };
  let authFailed = false;
  try {
    let tok = readToken(home);
    if (needsWarmUp(tok)) { warmUp(home, agyCommand); tok = readToken(home); }
    if (!tok?.access_token) throw new Error('no access token (run `accounts login`)');
    let result = await queryCloudCode(home, tok.access_token);
    if (result.status === 401) {
      warmUp(home, agyCommand);
      tok = readToken(home);
      result = tok?.access_token ? await queryCloudCode(home, tok.access_token) : { status: 401 };
      if (result.status === 401) { authFailed = true; throw new Error('Cloud Code rejected the credential (HTTP 401)'); }
    }
    if (result.error) throw new Error(result.error);
    snapshot.plan_type = result.plan_type;
    snapshot.pools = result.pools;
  } catch (error) {
    snapshot.error = String(error.message || error).slice(0, 300);
  }
  return { snapshot, authFailed };
}

/** Fetch snapshots, then store them in one locked update. A pool with quota
 *  left clears that account's cooldowns for its families. */
export async function refreshQuotas(names, deps) {
  const fetched = [];
  for (const name of names) fetched.push([name, await fetchSnapshot(name, deps)]);
  updatePool((pool) => {
    for (const [name, { snapshot, authFailed }] of fetched) {
      const account = pool.accounts.find((a) => a.name === name);
      if (!account) continue;
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

/** One-line quota summary for list/quota output. */
export function summarizeSnapshot(snapshot) {
  if (!snapshot) return 'quota: not refreshed';
  if (snapshot.error) return `quota: error (${snapshot.error})`;
  const pct = (w) => (w ? `${Math.round(w.remaining * 100)}%` : '?');
  const parts = Object.entries(snapshot.pools).map(([g, w]) => `${g} 5h ${pct(w.short)} weekly ${pct(w.weekly)}`);
  return `quota: ${parts.join(' | ') || 'no data'}${snapshot.plan_type ? ` (${snapshot.plan_type})` : ''}`;
}
