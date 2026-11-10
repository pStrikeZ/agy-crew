/** Pool paths for the omp extension. Kept self-contained so the plugin can be
 *  installed without the companion's module tree. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function globalHome() {
  const override = process.env.AGY_CREW_HOME;
  return override ? path.resolve(override) : path.join(os.homedir(), '.agy-crew');
}

export const accountHome = (name) => path.join(globalHome(), 'accounts', name, 'home');
export const tokenPath = (home) => path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
export const projectCachePath = (home) =>
  path.join(home, '.gemini', 'antigravity-cli', 'cache', 'default_project_id.txt');

export function loadPool() {
  return JSON.parse(fs.readFileSync(path.join(globalHome(), 'pool.json'), 'utf8'));
}
