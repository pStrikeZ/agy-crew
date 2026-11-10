/**
 * omp extension for `agy-crew omp`.
 *
 * Installed as part of agy-crew, but inert unless the launcher sets
 * AGY_CREW_OMP_ACCOUNT. In that mode it:
 *   1. takes the paused google-antigravity id back with a custom OAuth provider
 *      registration (omp's documented opt-in escape hatch);
 *   2. installs the selected account as the session's runtime bearer, refreshed
 *      in the background by agy warm-up;
 *   3. replaces omp's block-0 role sentence with the upstream Antigravity
 *      identity and strips the omp/cfg/omp URL fingerprints.
 */
import { readOmpCredential, readOmpCredentialCached, toStructuredApiKey } from './credential.mjs';
import { warmUp } from '../companion/pool/quota.mjs';
import { accountHome } from './paths.mjs';
import { IDENTITY_SENTINEL, identityText, sanitizeTools, transformBlock0 } from './prompt.mjs';

const PROVIDER = 'google-antigravity';
const ACCOUNT = process.env.AGY_CREW_OMP_ACCOUNT || '';
const AUTONOMOUS = process.env.AGY_CREW_OMP_AUTONOMOUS === '1';
const INSTALL_GUARD = Symbol.for('agy-crew.omp.extension');

let seeded = false;
let refreshTimer = null;
let currentCredential = null;
const REFRESH_MARGIN_MS = 5 * 60_000;

function authOf(ctx) {
  return ctx?.modelRegistry?.authStorage;
}

function isTarget(ctx) {
  return Boolean(ACCOUNT) && ctx?.model?.provider === PROVIDER;
}

/** Highest-priority bearer for this session; independent of the credential store. */
function installRuntimeKey(pi, auth, credential) {
  try {
    auth.keys.setRuntime?.(PROVIDER, toStructuredApiKey(credential));
  } catch (error) {
    pi.logger?.warn?.(`agy-crew omp: failed to set runtime key: ${error?.message || String(error)}`);
  }
}

/** Let agy refresh the file-backed token, then update the runtime bearer.
 *  `warmUp` stops agy once the token file changes; a real agy can keep the
 *  print turn open long after the credential is already usable. */
async function refreshRuntimeKey(pi, auth) {
  if (!ACCOUNT) return null;
  const home = accountHome(ACCOUNT);
  const bin = process.env.AGY_BIN || 'agy';
  await warmUp(home, (args) => ({ cmd: bin, args }));
  try {
    const credential = await readOmpCredential(ACCOUNT);
    currentCredential = credential;
    installRuntimeKey(pi, auth, credential);
    scheduleRefresh(pi, auth);
    return credential;
  } catch (error) {
    pi.logger?.warn?.(`agy-crew omp: runtime credential refresh failed: ${error?.message || String(error)}`);
    scheduleRefresh(pi, auth, 60_000);
    return null;
  }
}

/** Refresh before the access token expires; the timer is unref'd so it cannot hold omp open. */
function scheduleRefresh(pi, auth, delayOverride) {
  if (refreshTimer) clearTimeout(refreshTimer);
  const expires = currentCredential?.expires ?? 0;
  const delay = delayOverride ?? Math.max(30_000, expires - Date.now() - REFRESH_MARGIN_MS);
  refreshTimer = setTimeout(() => refreshRuntimeKey(pi, auth), delay);
  refreshTimer.unref?.();
}

async function ensureCredential(pi, ctx) {
  if (seeded) return;
  const auth = authOf(ctx);
  if (!auth) return;

  let credential;
  try {
    credential = await readOmpCredential(ACCOUNT);
  } catch (error) {
    pi.logger?.warn?.(`agy-crew omp: ${error?.message || String(error)}`);
    return;
  }

  seeded = true;
  currentCredential = credential;
  // Runtime key is the whole injection: it bypasses the paused provider's
  // OAuth store path and never touches agent.db or session pins.
  installRuntimeKey(pi, auth, credential);
  scheduleRefresh(pi, auth);
}

export default function agyCrewOmp(pi) {
  if (!ACCOUNT) return; // installed but not launched through `agy-crew omp`
  // The package manifest and the installer's loader can both register this
  // factory; only one may install handlers in a process.
  if (globalThis[INSTALL_GUARD]) return;
  globalThis[INSTALL_GUARD] = true;

  // omp ships google-antigravity paused (`providerDisabledReason`). Registering
  // an OAuth provider under the same id is the documented escape hatch: it takes
  // the id back for this opt-in run without changing normal omp behavior.
  //
  // The fallback `apiKey` is read synchronously at factory time so model
  // discovery sees a credential before `session_start` runs. Without it, omp
  // reports the role default as unavailable and falls back to another provider.
  const bootstrap = (() => {
    try { return readOmpCredentialCached(ACCOUNT); } catch { return null; }
  })();
  if (bootstrap) currentCredential = bootstrap;
  pi.registerProvider(PROVIDER, {
    ...(bootstrap ? { apiKey: toStructuredApiKey(bootstrap) } : {}),
    oauth: {
      name: 'Google Antigravity (agy-crew)',
      async login() {
        throw new Error('Use `agy-crew omp --account <name>` to select an Antigravity account.');
      },
      async refreshToken(credentials) {
        return credentials;
      },
      getApiKey(credentials) {
        return JSON.stringify({
          token: credentials.access,
          projectId: credentials.projectId,
          refreshToken: credentials.refresh,
          expiresAt: credentials.expires,
          email: credentials.email,
          accountId: credentials.accountId,
        });
      },
    },
  });

  pi.on('session_start', async (_event, ctx) => {
    await ensureCredential(pi, ctx);
  });

  pi.on('before_agent_start', (event, ctx) => {
    if (!isTarget(ctx)) return;
    const blocks = Array.isArray(event.systemPrompt) ? [...event.systemPrompt] : [];
    if (blocks.length === 0) return { systemPrompt: [identityText({ autonomous: AUTONOMOUS })] };
    blocks[0] = transformBlock0(blocks[0], { autonomous: AUTONOMOUS });
    return { systemPrompt: blocks };
  });

  // Cache warmer, side turns, and another extension replacing the prompt all
  // still go through the provider payload. Keep the identity first and strip
  // omp:// examples from tool declarations there too.
  pi.on('before_provider_request', (event, ctx) => {
    if (!isTarget(ctx)) return;
    const payload = event.payload;
    const request = payload?.request;
    if (!request || payload.userAgent !== 'antigravity') return;

    let nextRequest = request;
    let changed = false;

    if (Array.isArray(request.tools)) {
      const tools = sanitizeTools(request.tools);
      if (tools !== request.tools) {
        nextRequest = { ...nextRequest, tools };
        changed = true;
      }
    }

    const parts = request.systemInstruction?.parts;
    if (
      Array.isArray(parts) &&
      !parts.some((part) => typeof part?.text === 'string' && part.text.includes(IDENTITY_SENTINEL))
    ) {
      // A side turn or a cache-warmer rebuild may bypass before_agent_start.
      // Apply the same block-0 rewrite here, so the omp role sentence is gone.
      const first = parts[0];
      const nextParts =
        first && typeof first.text === 'string'
          ? [{ ...first, text: transformBlock0(first.text, { autonomous: AUTONOMOUS }) }, ...parts.slice(1)]
          : [{ text: identityText({ autonomous: AUTONOMOUS }) }, ...parts];
      nextRequest = {
        ...nextRequest,
        systemInstruction: { ...nextRequest.systemInstruction, parts: nextParts },
      };
      changed = true;
    }

    return changed ? { ...payload, request: nextRequest } : undefined;
  });
}
