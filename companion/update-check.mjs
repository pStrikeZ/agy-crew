/**
 * Daily npm update check for interactive CLI use.
 *
 * The check is deliberately outside the agent path: `start`, the full-screen
 * `inspect` TUI, and the human-facing `accounts list` / `accounts quota` table
 * qualify. Every candidate must have a TTY and must not carry a known coding-
 * harness marker in its environment, so skill-driven calls never read the
 * cache, touch the network, or print anything.
 *
 * At most one registry request is made per 24 hours. The result is cached in
 * <globalHome>/update-check.json so later interactive runs can notify without
 * another request. A notice is shown at most once per day.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PRODUCT, globalHome } from './identity.mjs';
import { replaceFile } from './state-lock.mjs';

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CHECK_TIMEOUT_MS = 1200;
const CACHE_SCHEMA = 1;

/** Environment variables set by coding harnesses for their shell/tool
 *  subprocesses. A user's own terminal does not have them. */
export const HARNESS_ENV_MARKERS = [
  'AGENT',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CODEX_SANDBOX',
  'CODEX_CI',
  'CODEX_THREAD_ID',
  'CODEX_MANAGED_BY_NPM',
  'OMPCODE',
  'PI_SESSION_FILE',
  'PI_SESSION_ID',
  'PI_TOOL_CALL_ID',
  'OPENCODE',
  'OPENCODE_BIN_PATH',
];

export function updateCacheFile() {
  return path.join(globalHome(), 'update-check.json');
}

/** Compare two semver strings, including prerelease ordering.
 *  Returns -1, 0 or 1, or null when either side is not a version. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  if (!pa.prerelease.length && !pb.prerelease.length) return 0;
  if (!pa.prerelease.length) return 1;
  if (!pb.prerelease.length) return -1;
  const length = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const x = pa.prerelease[i];
    const y = pb.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn) return -1;
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

export function updateNotice(currentVersion, latestVersion) {
  if (compareVersions(latestVersion, currentVersion) !== 1) return null;
  return `${PRODUCT} ${latestVersion} is available (current ${currentVersion}). ` +
    `Update with: npm install -g ${PRODUCT}@latest && ${PRODUCT} install`;
}

export function readUpdateCache(file = updateCacheFile()) {
  try {
    const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    return cache && typeof cache === 'object' ? cache : null;
  } catch {
    return null;
  }
}

export function writeUpdateCache(cache, file = updateCacheFile()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ schema: CACHE_SCHEMA, ...cache }, null, 2) + '\n');
    replaceFile(tmp, file);
  } catch {
    // The cache is an optimization; a read-only home must not break a run.
  }
}

async function fetchLatestVersion(registryUrl, fetchImpl, timeoutMs) {
  if (typeof fetchImpl !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(registryUrl, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response || response.ok === false) return null;
    const payload = await response.json();
    const version = typeof payload?.version === 'string' ? payload.version.trim() : '';
    return parseVersion(version) ? version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Return a notice when a newer release exists, or null.
 *  Never throws; a failed request is cached as the day's attempt. */
export async function checkForUpdate({
  currentVersion,
  file = updateCacheFile(),
  fetchImpl = globalThis.fetch,
  registryUrl = `https://registry.npmjs.org/${PRODUCT}/latest`,
  now = Date.now(),
  timeoutMs = UPDATE_CHECK_TIMEOUT_MS,
} = {}) {
  if (!parseVersion(currentVersion)) return null;
  const cache = readUpdateCache(file) || {};
  const age = now - cache.checked_at;
  const fresh = Number.isFinite(cache.checked_at) && age >= 0 && age < UPDATE_CHECK_INTERVAL_MS;

  if (!fresh) {
    const latest = await fetchLatestVersion(registryUrl, fetchImpl, timeoutMs);
    cache.checked_at = now;
    if (latest) cache.latest = latest;
    writeUpdateCache(cache, file);
  }

  const notice = updateNotice(currentVersion, cache.latest);
  if (!notice) return null;
  const notifiedRecently = Number.isFinite(cache.notified_at) && now >= cache.notified_at &&
    now - cache.notified_at < UPDATE_CHECK_INTERVAL_MS;
  if (cache.notified_version === cache.latest && notifiedRecently) return null;
  cache.notified_version = cache.latest;
  cache.notified_at = now;
  writeUpdateCache(cache, file);
  return notice;
}

/** True when the process looks like it was started by a coding harness rather
 *  than from the user's own shell. */
export function isHarnessInvocation(env = process.env) {
  return HARNESS_ENV_MARKERS.some((key) => Boolean(env[key]));
}

/** True only for the human-facing interactive commands. Agent skill calls use
 *  task/status commands, and never pass this gate. */
export function isInteractiveUpdateCheck(cmd, rest = [], {
  stdinIsTTY = Boolean(process.stdin.isTTY),
  stdoutIsTTY = Boolean(process.stdout.isTTY),
  env = process.env,
} = {}) {
  if (!stdinIsTTY || !stdoutIsTTY) return false;
  if (env.AGY_CREW_NO_UPDATE_CHECK === '1') return false;
  if (isHarnessInvocation(env)) return false;
  if (cmd === 'start') return true;
  if (cmd === 'inspect') return !rest.includes('--plain') && !rest.includes('--no-follow');
  if (cmd === 'accounts') {
    if (rest.includes('--json')) return false;
    const subcommand = rest.find((arg) => !arg.startsWith('-'));
    return subcommand === 'list' || subcommand === 'quota';
  }
  return false;
}

export async function maybeNotifyUpdate({ currentVersion, stderr = process.stderr, ...options } = {}) {
  try {
    const notice = await checkForUpdate({ currentVersion, ...options });
    if (notice) stderr.write(`${notice}\n`);
  } catch {
    // Update checks must never affect the command they precede.
  }
}
