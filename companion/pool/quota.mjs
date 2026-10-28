import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { accountEnv } from './env.mjs';
import { accountHome, updatePool } from './state.mjs';
import { quotaPool } from './results.mjs';
import { readToken } from './token.mjs';

const baseUrl = () => process.env.AGY_CREW_CLOUDCODE_URL || 'https://cloudcode-pa.googleapis.com';
const WARM_UP_MS = 120_000;
// Cloud Code leaves the Gemini group out of retrieveUserQuotaSummary unless the
// User-Agent names a recent agy CLI (`antigravity/cli/<version> (...)`, as agy
// itself sends); a bare `antigravity` gets only the Claude/GPT group. Used when
// `agy --version` cannot be read.
const FALLBACK_AGY_VERSION = '1.4.9';
const AGY_ARCH = { x64: 'amd64', arm64: 'arm64', ia32: '386' };
const AGY_OS = { win32: 'windows' };

/** The User-Agent agy sends, built from the installed agy's version. */
export function clientUserAgent(agyCommand, { platform = process.platform, arch = process.arch } = {}) {
  let version = null;
  try {
    const agy = agyCommand(['--version']);
    const r = spawnSync(agy.cmd, agy.args, { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    version = r.status === 0 ? /\d+\.\d+\.\d+\S*/.exec(r.stdout)?.[0] || null : null;
  } catch { /* fall back below */ }
  return `antigravity/cli/${version || FALLBACK_AGY_VERSION} (aidev_client; os_type=${AGY_OS[platform] || platform}; arch=${AGY_ARCH[arch] || arch})`;
}
const projectCache = (home) => path.join(home, '.gemini', 'antigravity-cli', 'cache', 'default_project_id.txt');

/** Run agy once so it refreshes the file-backed token itself. Async, so the
 *  progress line keeps drawing meanwhile. */
function warmUp(home, agyCommand) {
  const agy = agyCommand(['-p', 'reply with one word: pong', '--output-format', 'json']);
  return new Promise((resolve) => {
    const child = spawn(agy.cmd, agy.args, { cwd: home, env: accountEnv(home), stdio: 'ignore', timeout: 60_000, windowsHide: true });
    child.on('error', resolve);
    child.on('close', resolve);
  });
}

async function post(endpoint, accessToken, body, userAgent) {
  const response = await fetch(`${baseUrl()}/v1internal:${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'User-Agent': userAgent },
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

async function queryCloudCode(home, accessToken, userAgent) {
  const meta = { metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } };
  const load = await post('loadCodeAssist', accessToken, meta, userAgent);
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
  const summary = await post('retrieveUserQuotaSummary', accessToken, { project }, userAgent);
  if (summary.status === 401) return { status: 401 };
  if (summary.status >= 400) return { status: summary.status, error: `retrieveUserQuotaSummary HTTP ${summary.status}` };
  return { status: 200, plan_type: load.json?.planInfo?.planType || null, pools: parseQuotaSummary(summary.json) };
}

const needsWarmUp = (tok) => !tok?.access_token || (tok.expiry_ms !== null && tok.expiry_ms - Date.now() < WARM_UP_MS);

/** Query Cloud Code for one account. Never throws, never prints tokens.
 *  onStage('warmup' | 'query') reports what it is waiting on. */
export async function fetchSnapshot(name, { agyCommand, userAgent = clientUserAgent(agyCommand) }, onStage = () => {}) {
  const home = accountHome(name);
  const snapshot = { refreshed_at: new Date().toISOString(), plan_type: null, pools: {}, error: null };
  let authFailed = false;
  try {
    let tok = readToken(home);
    if (needsWarmUp(tok)) { onStage('warmup'); await warmUp(home, agyCommand); tok = readToken(home); }
    if (!tok?.access_token) throw new Error('no access token (run `accounts login`)');
    onStage('query');
    let result = await queryCloudCode(home, tok.access_token, userAgent);
    if (result.status === 401) {
      onStage('warmup');
      await warmUp(home, agyCommand);
      onStage('query');
      tok = readToken(home);
      result = tok?.access_token ? await queryCloudCode(home, tok.access_token, userAgent) : { status: 401 };
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

/** Fetch snapshots one account at a time (parallel requests from one machine
 *  for several Google accounts look like abuse), then store them in one locked
 *  update. A pool with quota left clears that account's cooldowns for its
 *  families. progress: { stage(name, stage), done(name, snapshot) }. */
export async function refreshQuotas(names, deps, progress = {}) {
  const fetched = [];
  if (names.length) deps = { ...deps, userAgent: clientUserAgent(deps.agyCommand) };
  for (const name of names) {
    progress.stage?.(name, 'start');
    const result = await fetchSnapshot(name, deps, (stage) => progress.stage?.(name, stage));
    fetched.push([name, result]);
    progress.done?.(name, result.snapshot);
  }
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
