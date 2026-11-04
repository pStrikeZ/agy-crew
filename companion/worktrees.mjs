// Jobs of every worktree of this repository, for the read-only views.
//
// Each git worktree has its own .agy-crew/ (state.json, jobs/), because the
// state directory sits at `git rev-parse --show-toplevel`. An agent that works
// in an auto-created worktree therefore leaves its jobs there, invisible from
// the main checkout. `inspect` merges them: it only reads, never writes, so no
// state lock is needed and a worktree being written meanwhile is harmless.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { STATE_DIR_NAME } from './identity.mjs';
import { readTextRetry } from './state-lock.mjs';

/** Paths of the repository's worktrees (main one first), as `git worktree list`
 *  reports them. Outside a repository, or if git fails: []. */
const WORKTREE_TTL_MS = 2000;
const worktreeCache = new Map();   // cwd -> { at, roots }

export function listWorktrees(cwd = process.cwd()) {
  // The live view asks several times a second; worktrees come and go rarely.
  const hit = worktreeCache.get(cwd);
  if (hit && Date.now() - hit.at < WORKTREE_TTL_MS) return hit.roots;
  const roots = queryWorktrees(cwd);
  worktreeCache.set(cwd, { at: Date.now(), roots });
  return roots;
}

function queryWorktrees(cwd) {
  const r = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return [];
  return r.stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => path.normalize(l.slice(9).trim()));
}

/** state.json of one worktree: its jobs, or null when it keeps none. A corrupt
 *  file is reported through onWarning and skipped, so one broken worktree never
 *  hides the others. */
function readJobs(root, onWarning) {
  const file = path.join(root, STATE_DIR_NAME, 'state.json');
  let text;
  try { text = readTextRetry(file); } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') onWarning?.(`cannot read ${file}: ${error.message}`);
    return null;
  }
  try {
    const jobs = JSON.parse(text).jobs;
    return Array.isArray(jobs) ? jobs : [];
  } catch {
    onWarning?.(`state file is corrupt, skipped: ${file}`);
    return null;
  }
}

/** All jobs of the repository, oldest first. Every record is a copy tagged with
 *  `worktree` (the worktree root that holds it) and `worktree_name` (its last
 *  path segment). `current` is the worktree this process runs in: its own jobs
 *  win a duplicate id, and it is listed even when git cannot enumerate. */
export function loadWorktreeJobs({ current, here = false, cwd = process.cwd(), onWarning } = {}) {
  const roots = here ? [current] : [...new Set([current, ...listWorktrees(cwd)])];
  const jobs = [];
  const seen = new Set();
  for (const root of roots) {
    for (const job of readJobs(root, onWarning) || []) {
      if (seen.has(job.id)) continue;
      seen.add(job.id);
      jobs.push({ ...job, worktree: root, worktree_name: path.basename(root) });
    }
  }
  return jobs.sort((a, b) => (Date.parse(a.started_at) || 0) - (Date.parse(b.started_at) || 0));
}
