import os from 'node:os';
import path from 'node:path';

/** Product identity. Every user-visible name derives from these constants. */
export const PRODUCT = 'agy-crew';
/** Prefix of flat, user-level skill directory names: agy-crew-staffer, agy-crew-jobs, ... */
export const SKILL_PREFIX = `${PRODUCT}-`;
/** Harness plugin invocation prefixes rewritten by the skill generator: Claude Code, Codex. */
export const PLUGIN_INVOCATIONS = [`/${PRODUCT}:`, `$${PRODUCT}:`];
/** Per-repository state directory (jobs, logs, config). */
export const STATE_DIR_NAME = `.${PRODUCT}`;
/** Environment variable overriding the global (per-user) state directory. */
export const HOME_ENV = 'AGY_CREW_HOME';
/** Global per-user directory (account pool, installed skill bundles). */
export function globalHome() {
  const override = process.env[HOME_ENV];
  return override ? path.resolve(override) : path.join(os.homedir(), STATE_DIR_NAME);
}
/** The upstream project this fork must never be installed alongside. */
export const UPSTREAM = {
  product: 'agy-staff',
  pluginId: 'agy@agy-staff',
  skillPrefix: 'agy-',
  repo: 'https://github.com/keli-wen/agy-staff',
};
