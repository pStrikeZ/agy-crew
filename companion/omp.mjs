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

const DEFAULT_FAMILY = 'gemini-3.8-flash';
const OMP_BIN = process.env.OMP_BIN || 'omp';

const OMP_USAGE = `usage: ${PRODUCT} omp [--account auto|<name>] [--family <family>] [-- <omp args>...]`;

function parseOmpArgs(rest, defaultFamily) {
  let account = 'auto';
  let family = modelFamily(defaultFamily || DEFAULT_FAMILY);
  let familyExplicit = false;
  let help = false;
  const args = [];
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i];
    if (value === '--') {
      args.push(...rest.slice(i + 1));
      break;
    }
    if (value === '--help' || value === '-h') help = true;
    else if (value === '--account' || value === '-a') {
      account = rest[++i];
      if (!account || account.startsWith('-')) throw new PoolError('flag --account needs a value');
    } else if (value.startsWith('--account=')) account = value.slice('--account='.length);
    else if (value === '--family') {
      family = rest[++i];
      if (!family || family.startsWith('-')) throw new PoolError('flag --family needs a value');
      family = modelFamily(family);
      familyExplicit = true;
    } else if (value.startsWith('--family=')) {
      family = modelFamily(value.slice('--family='.length));
      familyExplicit = true;
    } else args.push(value);
  }

  const model = modelArg(args);
  if (!familyExplicit) {
    const parsed = model ? modelFamily(String(model).split('/').pop()) : null;
    if (parsed) family = parsed;
  }
  return { account, family, args, help };
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

  --account auto|<name>        auto by default
  --family <family>            quota family for selection (default ${DEFAULT_FAMILY})
  -- <omp args>...             passed to omp unchanged

The omp extension must be installed:
  agy-crew install --hosts omp
or, from the npm package:
  omp plugin install agy-crew
`;
}

/** Resolve to omp's exit code. deps: { agyCommand, defaultFamily }. */
export async function cmdOmp(rest, deps) {
  const { account, family, args, help } = parseOmpArgs(rest, deps.defaultFamily);
  if (help) {
    process.stdout.write(ompHelp());
    return 0;
  }
  const picked = acquire(account, family);
  try {
    await ensureFresh(picked.name, deps.agyCommand);
    const env = {
      AGY_CREW_HOME: globalHome(),
      AGY_CREW_OMP_ACCOUNT: picked.name,
      AGY_CREW_OMP_FAMILY: family,
    };
    env.AGY_CREW_OMP_HOLD = picked.holdId;
    return await runOmp(args, env);
  } finally {
    release(picked.holdId);
  }
}
