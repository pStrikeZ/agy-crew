/**
 * `agy-crew omp` — run omp on one held pool account.
 *
 * The credential itself is injected inside omp by the `omp/` extension, which
 * is inert unless AGY_CREW_OMP_ACCOUNT is set. This launcher only selects,
 * holds and warms the account, then execs/spawns omp with the environment the
 * extension reads.
 */
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PRODUCT, globalHome } from './identity.mjs';
import { PoolError, accountHome, tokenPath, updatePool } from './pool/state.mjs';
import { activeCooldown, chooseLender, exhaustedSnapshot, findAccount } from './pool/select.mjs';
import { modelFamily } from './pool/results.mjs';
import { readToken } from './pool/token.mjs';
import { warmUp } from './pool/quota.mjs';
import { readOmpCredential } from '../omp/credential.mjs';
import { installOmpExtension, ompExtensionPath, uninstallOmpExtension } from './install.mjs';

const DEFAULT_FAMILY = 'gemini-3.8-flash';
const OMP_BIN = process.env.OMP_BIN || 'omp';

const OMP_USAGE = `usage: ${PRODUCT} omp --use-at-my-own-risk [<name>] [--family <family>] [-- <omp args>...]`;

function parseOmpArgs(rest, defaultFamily) {
  const split = rest.indexOf('--');
  const own = split < 0 ? rest : rest.slice(0, split);
  const args = split < 0 ? [] : rest.slice(split + 1);
  let account = null;
  let family = modelFamily(defaultFamily || DEFAULT_FAMILY);
  let familyExplicit = false;
  let help = false;
  let risk = false;
  for (let i = 0; i < own.length; i++) {
    const value = own[i];
    if (value === '--help' || value === '-h') help = true;
    else if (value === '--use-at-my-own-risk') risk = true;
    else if (value === '--family') {
      family = own[++i];
      if (!family || family.startsWith('-')) throw new PoolError('flag --family needs a value');
      family = modelFamily(family);
      familyExplicit = true;
    } else if (value.startsWith('--family=')) {
      family = modelFamily(value.slice('--family='.length));
      familyExplicit = true;
    } else if (value.startsWith('-')) {
      throw new PoolError(`unknown flag ${value} (${OMP_USAGE}; omp's own flags go after --)`);
    } else if (account) {
      throw new PoolError(OMP_USAGE);
    } else {
      account = value;
    }
  }

  const model = modelArg(args);
  if (!familyExplicit) {
    const parsed = model ? modelFamily(String(model).split('/').pop()) : null;
    if (parsed) family = parsed;
  }
  return { account: account || 'auto', family, args, help, risk };
}

function modelArg(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' || args[i] === '-m') return args[i + 1] || null;
    if (args[i].startsWith('--model=')) return args[i].slice('--model='.length);
  }
  return null;
}

function chooseForOmp(pool, requested, family, now) {
  if (!pool.accounts.length) {
    return { refused: `No pool accounts yet. Add one with \`${PRODUCT} accounts login <name>\` first.` };
  }

  if (requested && requested !== 'auto') {
    const account = findAccount(pool, requested);
    if (!account) return { refused: `unknown account "${requested}" (see \`${PRODUCT} accounts list\`)` };
    if (account.disabled) return { refused: `account ${requested} is disabled (${PRODUCT} accounts enable ${requested})` };
    if (account.auth_error_at || !fs.existsSync(tokenPath(accountHome(requested)))) {
      return { refused: `account ${requested} needs login (${PRODUCT} accounts login ${requested})` };
    }
    if (pool.leases.some((lease) => lease.account === requested)) {
      return { refused: `account ${requested} is in use; try again when it is idle` };
    }
    const cooling = activeCooldown(pool, requested, family, now);
    const exhausted = exhaustedSnapshot(pool, requested, family, now);
    if (cooling || exhausted) {
      const until = cooling?.retry_at || exhausted?.reset_at;
      return { refused: `account ${requested} has no ${family} quota until ${until}` };
    }
    return { name: requested, email: account.email };
  }

  const name = chooseLender(pool, { family, now });
  if (!name) {
    return {
      refused: `no pool account is idle with ${family} quota; see \`${PRODUCT} accounts list\` and \`accounts quota\``,
    };
  }
  return { name, email: findAccount(pool, name)?.email || null };
}

function acquire(requested, family) {
  const now = Date.now();
  const outcome = updatePool((pool) => {
    const picked = chooseForOmp(pool, requested, family, now);
    if (picked.refused) return { refused: picked.refused };
    const account = findAccount(pool, picked.name);
    const hold = {
      id: randomUUID().slice(0, 8),
      account: picked.name,
      role: 'hold',
      pid: process.pid,
      job_id: null,
      started_at: new Date(now).toISOString(),
      family,
    };
    pool.leases.push(hold);
    account.last_used_at = hold.started_at;
    return { picked: { ...picked, holdId: hold.id } };
  });
  if (outcome.refused) throw new PoolError(outcome.refused);
  return outcome.picked;
}

function release(holdId) {
  if (!holdId) return;
  try {
    updatePool((pool) => {
      pool.leases = pool.leases.filter((lease) => lease.id !== holdId);
    });
  } catch {
    // A crashed launcher's hold is reaped by the next pool update.
  }
}

async function ensureFresh(name, agyCommand) {
  const token = readToken(accountHome(name));
  if (token?.access_token && (!token.expiry_ms || token.expiry_ms - Date.now() > 120_000)) return;
  process.stderr.write(`${PRODUCT}: refreshing credential for ${name}...\n`);
  await warmUp(accountHome(name), agyCommand);
  const after = readToken(accountHome(name));
  if (!after?.access_token) {
    throw new PoolError(`account ${name} needs login (${PRODUCT} accounts login ${name})`);
  }
  if (after.expiry_ms && after.expiry_ms - Date.now() <= 120_000) {
    throw new PoolError(`account ${name} could not refresh its credential; run \`${PRODUCT} accounts login ${name}\` or try again`);
  }
}

function ompCommand(args) {
  if (/\.(mjs|cjs|js)$/i.test(OMP_BIN)) return { cmd: process.execPath, args: [OMP_BIN, ...args] };
  return { cmd: OMP_BIN, args };
}

function runOmp(args, env) {
  const omp = ompCommand(args);
  const ignore = () => {};
  const forward = (signal) => {
    try {
      child?.kill(signal);
    } catch {
      // Child already exited.
    }
  };
  let child;
  process.on('SIGINT', ignore);
  for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, forward);
  try {
    child = spawn(omp.cmd, omp.args, {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: 'inherit',
      windowsHide: true,
    });
    return new Promise((resolve, reject) => {
      child.on('error', (error) => reject(new PoolError(`failed to launch omp: ${error.message}`)));
      child.on('exit', (code, signal) =>
        resolve(code ?? (signal ? 128 + (os.constants.signals[signal] || 0) : 1)),
      );
    });
  } finally {
    process.off('SIGINT', ignore);
    for (const signal of ['SIGTERM', 'SIGHUP']) process.off(signal, forward);
  }
}

function ompHelp() {
  return `${OMP_USAGE}

Run omp with one agy-crew pool account. The account is held until omp exits;
the bundled omp extension seeds its credential and rewrites omp's block-0 role.

  --use-at-my-own-risk        required: the omp extension is installed for this
                              run only and removed when omp exits
  <name>                      pool account; auto by default
  --family <family>           quota family for selection (default ${DEFAULT_FAMILY})
  -- <omp args>...            passed to omp unchanged

The extension is written to ${ompExtensionPath()} before omp starts and removed
afterwards. A file you put there yourself is never overwritten.
`;
}

const OMP_RISK_MESSAGE =
  `${PRODUCT} omp refuses to run without --use-at-my-own-risk.\n` +
  `It writes the ${PRODUCT} omp extension to ${ompExtensionPath()}, runs omp with a pool ` +
  'credential, and removes the extension when omp exits. Loading an installed extension into ' +
  'omp this way is not a supported omp interface and can break the session.\n' +
  `Pass --use-at-my-own-risk to accept that risk:\n  ${OMP_USAGE}`;

/** Resolve to omp's exit code. deps: { agyCommand, defaultFamily }. */
export async function cmdOmp(rest, deps) {
  const { account, family, args, help, risk } = parseOmpArgs(rest, deps.defaultFamily);
  if (help) {
    process.stdout.write(ompHelp());
    return 0;
  }
  if (!risk) throw new PoolError(OMP_RISK_MESSAGE);
  // Install the extension only for this run: omp must load it at startup, and
  // nothing is left behind when the session ends.
  const extension = installOmpExtension();
  try {
    const picked = acquire(account, family);
    try {
      await ensureFresh(picked.name, deps.agyCommand);
      // Resolve and cache the Cloud Code project before omp starts. The extension
      // registers a synchronous credential at load time; without the cached
      // project, model discovery would see no credential and fall back.
      try {
        await readOmpCredential(picked.name);
      } catch (error) {
        throw new PoolError(error?.message || String(error));
      }
      const env = {
        AGY_CREW_HOME: globalHome(),
        AGY_CREW_OMP_ACCOUNT: picked.name,
        AGY_CREW_OMP_FAMILY: family,
        // Antigravity Flash carries a 60s first-event budget in omp's catalog.
        // A cold Gemini start can exceed it, and omp then aborts the turn with
        // "Request was aborted" before any token arrives. Give the bridge the
        // same five-minute budget omp uses for other providers; an explicit
        // user setting still wins.
        PI_STREAM_FIRST_EVENT_TIMEOUT_MS: process.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS ?? '300000',
      };
      env.AGY_CREW_OMP_HOLD = picked.holdId;
      return await runOmp(args, env);
    } finally {
      release(picked.holdId);
    }
  } finally {
    if (!uninstallOmpExtension(extension)) {
      process.stderr.write(`${PRODUCT} warning: could not remove the temporary omp extension ${extension.dest}\n`);
    }
  }
}
