/**
 * `install` / `uninstall`: put agy-crew's skills into the user-level skill
 * directories of every detected harness from one shared bundle.
 *
 * One rendered bundle lives under <globalHome>/bundles/<version>-<digest>/;
 * every host gets one directory link per skill pointing into it. A destination
 * is "managed" only when it is a link into <globalHome>/bundles/; anything else
 * is user content and is never overwritten or removed. Installation is
 * all-or-nothing: conflicts (including the upstream agy-staff) abort before
 * anything is written.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PRODUCT, SKILL_PREFIX, UPSTREAM, globalHome } from './identity.mjs';
import { skillFiles } from '../scripts/generate-skills.mjs';

const WIN = process.platform === 'win32';
const STAGING_GRACE_MS = 5 * 60 * 1000;

export const HOSTS = {
  claude: { skills: ['.claude', 'skills'], detect: ['.claude'] },
  codex: { skills: ['.agents', 'skills'], detect: ['.codex'] },
  omp: { skills: ['.omp', 'agent', 'skills'], detect: ['.omp'] },
  opencode: { skills: ['.config', 'opencode', 'skills'], detect: ['.config', 'opencode'] },
  dsh: { skills: ['.dsh', 'skills'], detect: ['.dsh'] },
};

const home = (...parts) => path.join(os.homedir(), ...parts);
const hostDir = key => home(...HOSTS[key].skills);
const hostPresent = key => fs.existsSync(home(...HOSTS[key].detect));
const fwd = p => p.replaceAll('\\', '/');
const bundlesRoot = () => path.join(globalHome(), 'bundles');

function fail(message) {
  throw Object.assign(new Error(message), { exitCode: 1 });
}

function norm(p) {
  const r = path.resolve(p.replace(/^\\\\\?\\/, ''));
  return WIN ? r.toLowerCase() : r;
}
const inside = (child, parent) => norm(child).startsWith(norm(parent) + path.sep);

function lstat(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}

/** Resolved link target when `p` is a link, else null. */
function linkTarget(p) {
  const st = lstat(p);
  if (!st || !st.isSymbolicLink()) return null;
  try {
    return path.resolve(path.dirname(p), fs.readlinkSync(p).replace(/^\\\\\?\\/, ''));
  } catch { return null; }
}

/** Managed = a link whose target lies inside <globalHome>/bundles/. Returns the target or null. */
function managedTarget(p) {
  const t = linkTarget(p);
  return t && inside(t, bundlesRoot()) ? t : null;
}

function removeLink(p) {
  try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); }
}

// ---------------------------------------------------------------------------
// bundle rendering
// ---------------------------------------------------------------------------

export function packageRoot() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const need of ['skills', path.join('companion', 'agy-companion.mjs'), 'package.json']) {
    if (!fs.existsSync(path.join(root, need))) fail(`package root ${root} is missing ${need}`);
  }
  return root;
}

/** Render the bundle in memory. Returns { version, digest, name, bundleDir, files, personas }. */
export function renderBundle(root = packageRoot()) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const rootFwd = fwd(root).replace(/\/$/, '');
  const raw = skillFiles(root, 'user');
  const files = new Map(); // relative path inside the bundle -> Buffer
  const personas = new Set();
  for (const [rel, content] of [...raw].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const inner = rel.split(path.sep).join('/').replace(/^user-skills\//, '');
    personas.add(inner.split('/')[0].slice(SKILL_PREFIX.length));
    let out = content;
    if (inner.endsWith('.md')) {
      out = Buffer.from(content.toString('utf8')
        .replaceAll('<skill-dir>/../../', `${rootFwd}/`)
        .replaceAll('../../', `${rootFwd}/`));
    }
    files.set(inner, out);
  }
  // The digest is taken before the bundle's own location is substituted
  // (rule 3), which would otherwise make it circular.
  const hash = crypto.createHash('sha256');
  for (const [rel, content] of files) hash.update(rel).update('\0').update(content).update('\0');
  const digest = hash.digest('hex').slice(0, 12);
  const name = `${version}-${digest}`;
  const bundleDir = path.join(bundlesRoot(), name);
  for (const [rel, content] of files) {
    if (!rel.endsWith('.md')) continue;
    const text = content.toString('utf8').replaceAll('<plugin-root>/user-skills/', `${fwd(bundleDir)}/`);
    const left = /<skill-dir>|<plugin-root>|\.\.\/\.\.\//.exec(text);
    if (left) fail(`rendered ${rel} still contains ${left[0]}`);
    files.set(rel, Buffer.from(text));
  }
  return { version, digest, name, bundleDir, files, personas: [...personas].sort() };
}

function sameContent(dir, files) {
  try {
    for (const [rel, content] of files) {
      if (!fs.readFileSync(path.join(dir, rel)).equals(content)) return false;
    }
    return true;
  } catch { return false; }
}

function writeBundle(bundle) {
  const root = bundlesRoot();
  fs.mkdirSync(root, { recursive: true });
  if (fs.existsSync(bundle.bundleDir) && sameContent(bundle.bundleDir, bundle.files)) return;
  const staging = path.join(root, `.staging-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    for (const [rel, content] of bundle.files) {
      const target = path.join(staging, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    if (fs.existsSync(bundle.bundleDir)) fs.rmSync(bundle.bundleDir, { recursive: true, force: true }); // damaged copy
    fs.renameSync(staging, bundle.bundleDir);
  } catch (error) {
    // A concurrent install may have won the race with identical content.
    if (!(fs.existsSync(bundle.bundleDir) && sameContent(bundle.bundleDir, bundle.files))) throw error;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// host selection and classification
// ---------------------------------------------------------------------------

function selectHosts(opts, { defaultPresent }) {
  if (opts.hosts && opts.all) fail('--hosts and --all are mutually exclusive');
  if (opts.hosts) {
    const keys = opts.hosts.split(',').map(s => s.trim()).filter(Boolean);
    const bad = keys.filter(k => !Object.hasOwn(HOSTS, k));
    if (bad.length || !keys.length) fail(`unknown host ${bad.join(', ') || '(empty)'}; valid hosts: ${Object.keys(HOSTS).join(', ')}`);
    return [...new Set(keys)];
  }
  if (opts.all) return Object.keys(HOSTS);
  return defaultPresent();
}

/** Managed `agy-crew-*` entries currently in a host's skills dir: [{ name, dest, target }]. */
function managedEntries(key) {
  const dir = hostDir(key);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter(n => n.startsWith(SKILL_PREFIX) && !n.includes('.tmp-'))
    .map(name => ({ name, dest: path.join(dir, name), target: managedTarget(path.join(dir, name)) }))
    .filter(e => e.target);
}

function classify(dest, target) {
  if (!lstat(dest)) return 'created';
  const current = managedTarget(dest);
  if (!current) return 'conflict';
  return norm(current) === norm(target) ? 'unchanged' : 'updated';
}

function upstreamConflicts(selected, personas) {
  const out = [];
  const add = (p, reason, remedy) => out.push({ path: p, reason, remedy });
  const readText = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

  const installed = home('.claude', 'plugins', 'installed_plugins.json');
  const text = readText(installed);
  if (text !== null) {
    try {
      const json = JSON.parse(text);
      if (json && json.plugins && Object.hasOwn(json.plugins, UPSTREAM.pluginId)) {
        add(installed, `upstream ${UPSTREAM.product} plugin ${UPSTREAM.pluginId} is installed in Claude Code`, `claude plugin uninstall ${UPSTREAM.pluginId}`);
      }
    } catch { /* unparsable: not ours to judge */ }
  }

  const codexCache = home('.codex', 'plugins', 'cache', UPSTREAM.product);
  if (fs.existsSync(codexCache)) {
    add(codexCache, `upstream ${UPSTREAM.product} plugin is installed in Codex`, `remove the ${UPSTREAM.product} plugin from Codex (see codex plugin --help) and restart Codex`);
  }

  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const file = home('.config', 'opencode', name);
    const body = readText(file);
    if (body !== null && body.includes(`${UPSTREAM.product}@`)) {
      add(file, `upstream ${UPSTREAM.product} plugin is configured in OpenCode`, `remove the ${UPSTREAM.product} plugin entry from ${file}`);
    }
  }

  const pi = home('.pi');
  if (fs.existsSync(pi)) {
    const walk = (dir, depth) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < 3) { const hit = walk(full, depth + 1); if (hit) return hit; }
        } else if (entry.isFile()) {
          try {
            if (fs.statSync(full).size <= 1024 * 1024 && fs.readFileSync(full, 'utf8').includes(UPSTREAM.product)) return full;
          } catch { /* unreadable */ }
        }
      }
      return null;
    };
    const hit = walk(pi, 1);
    if (hit) add(hit, `upstream ${UPSTREAM.product} is referenced in the Pi configuration`, `uninstall the ${UPSTREAM.product} Pi package (pi remove / pi list)`);
  }

  for (const key of selected) {
    for (const persona of personas) {
      const entry = path.join(hostDir(key), `${UPSTREAM.skillPrefix}${persona}`);
      if (lstat(entry)) add(entry, `upstream ${UPSTREAM.product} skill (or a conflicting user skill)`, `remove ${entry} if it is the ${UPSTREAM.product} skill`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// pruning
// ---------------------------------------------------------------------------

function prune(currentName) {
  const root = bundlesRoot();
  try {
    if (!fs.existsSync(root)) return;
    const referenced = new Set();
    for (const key of Object.keys(HOSTS)) {
      for (const { target } of managedEntries(key)) {
        referenced.add(norm(path.join(root, path.relative(root, target).split(path.sep)[0])));
      }
    }
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const full = path.join(root, entry.name);
      try {
        if (entry.name === currentName) continue;
        if (entry.name.startsWith('.staging-')) {
          if (Date.now() - fs.statSync(full).mtimeMs < STAGING_GRACE_MS) continue;
        } else if (referenced.has(norm(full))) continue;
        fs.rmSync(full, { recursive: true, force: true });
      } catch (error) {
        process.stderr.write(`${PRODUCT} warning: could not prune ${full}: ${error.message}\n`);
      }
    }
  } catch (error) {
    process.stderr.write(`${PRODUCT} warning: pruning bundles failed: ${error.message}\n`);
  }
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

function counts(skills) {
  const tally = {};
  for (const s of skills) tally[s.change] = (tally[s.change] || 0) + 1;
  return ['created', 'updated', 'unchanged'].filter(k => tally[k]).map(k => `${tally[k]} ${k}`).join(', ') || '0 changed';
}

function makeLink(target, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  if (lstat(tmp)) removeLink(tmp);
  fs.symlinkSync(target, tmp, WIN ? 'junction' : 'dir');
  try {
    fs.renameSync(tmp, dest);
  } catch {
    try {
      if (managedTarget(dest)) removeLink(dest);
      fs.renameSync(tmp, dest);
    } catch (error) {
      try { removeLink(tmp); } catch { /* best effort */ }
      throw error;
    }
  }
}

export function cmdInstall(opts) {
  if (opts.status) return cmdStatus(opts);
  const bundle = renderBundle();
  const selected = selectHosts(opts, {
    defaultPresent: () => {
      const present = Object.keys(HOSTS).filter(hostPresent);
      if (!present.length) fail('no supported harness detected; pass --hosts <list> or --all');
      return present;
    },
  });

  const conflicts = upstreamConflicts(selected, bundle.personas);
  const plan = selected.map(key => ({
    host: key,
    dir: hostDir(key),
    skills: bundle.personas.map(persona => {
      const name = `${SKILL_PREFIX}${persona}`;
      const dest = path.join(hostDir(key), name);
      const change = classify(dest, path.join(bundle.bundleDir, name));
      if (change === 'conflict') {
        conflicts.push({ path: dest, reason: 'exists and was not created by agy-crew', remedy: `move or remove ${dest}, then re-run install` });
      }
      return { name, dest, change };
    }),
  }));
  const publicPlan = plan.map(h => ({ host: h.host, dir: h.dir, skills: h.skills.map(({ name, change }) => ({ name, change })) }));

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ version: bundle.version, bundle: bundle.bundleDir, hosts: publicPlan, conflicts }, null, 2)}\n`);
    if (conflicts.length) throw Object.assign(new Error('conflicts'), { exitCode: 1, alreadyPrinted: true });
  } else if (conflicts.length) {
    const lines = [`${PRODUCT}: install aborted, nothing was written. ${conflicts.length} conflict(s):`];
    for (const c of conflicts) lines.push(`  ${c.path}`, `    reason: ${c.reason}`, `    remedy: ${c.remedy}`);
    process.stderr.write(`${lines.join('\n')}\n`);
    throw Object.assign(new Error('conflicts'), { exitCode: 1, alreadyPrinted: true });
  }

  if (opts['dry-run']) {
    if (opts.json) return;
    const lines = [`${PRODUCT} ${bundle.version} (dry run) → ${bundle.bundleDir}`];
    for (const h of plan) {
      lines.push(`${h.host}  ${h.dir}`);
      for (const s of h.skills) lines.push(`  ${s.name}  ${s.change}`);
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  writeBundle(bundle);
  const done = []; // { dest, previous }
  try {
    for (const h of plan) {
      for (const s of h.skills) {
        if (s.change === 'unchanged') continue;
        const previous = s.change === 'updated' ? managedTarget(s.dest) : null;
        makeLink(path.join(bundle.bundleDir, s.name), s.dest);
        done.push({ dest: s.dest, previous });
      }
    }
  } catch (error) {
    for (const { dest, previous } of done.reverse()) {
      try {
        removeLink(dest);
        if (previous) makeLink(previous, dest);
      } catch { /* best effort rollback */ }
    }
    fail(`install failed and was rolled back: ${error.message}`);
  }
  prune(bundle.name);

  if (!opts.json) {
    const lines = [`${PRODUCT} ${bundle.version} → ${bundle.bundleDir}`];
    for (const h of plan) lines.push(`${h.host.padEnd(9)} ${counts(h.skills).padEnd(22)} ${h.dir}`);
    lines.push(`Restart the harnesses (or open a new session) to load the skills. Smoke test: /${SKILL_PREFIX}ask reply with OK`);
    process.stdout.write(`${lines.join('\n')}\n`);
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function cmdStatus(opts) {
  const bundle = renderBundle();
  const hosts = Object.keys(HOSTS).map(key => ({
    host: key,
    present: hostPresent(key),
    dir: hostDir(key),
    skills: bundle.personas.map(persona => {
      const name = `${SKILL_PREFIX}${persona}`;
      const dest = path.join(hostDir(key), name);
      const change = classify(dest, path.join(bundle.bundleDir, name));
      const state = { created: 'missing', unchanged: 'managed-current', updated: 'managed-stale', conflict: 'conflict' }[change];
      return { name, state };
    }),
  }));
  let bundles = [];
  try { bundles = fs.readdirSync(bundlesRoot()).sort(); } catch { /* none */ }
  const listing = bundles.map(name => ({ name, current: name === bundle.name }));
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ version: bundle.version, bundle: bundle.bundleDir, hosts, bundles: listing }, null, 2)}\n`);
    return;
  }
  const lines = [`${PRODUCT} ${bundle.version} current bundle: ${bundle.bundleDir}`];
  for (const h of hosts) {
    lines.push(`${h.host.padEnd(9)} ${h.present ? 'present' : 'absent'}  ${h.dir}`);
    for (const s of h.skills) lines.push(`  ${s.name.padEnd(22)} ${s.state}`);
  }
  lines.push(`bundles (${bundlesRoot()}):`);
  if (!listing.length) lines.push('  (none)');
  for (const b of listing) lines.push(`  ${b.name}${b.current ? '  (current)' : ''}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

export function cmdUninstall(opts) {
  const selected = selectHosts(opts, {
    defaultPresent: () => Object.keys(HOSTS).filter(key => managedEntries(key).length),
  });
  const result = [];
  for (const key of selected) {
    let removed = 0;
    for (const { dest } of managedEntries(key)) {
      try { removeLink(dest); removed++; } catch (error) {
        process.stderr.write(`${PRODUCT} warning: could not remove ${dest}: ${error.message}\n`);
      }
    }
    result.push({ host: key, dir: hostDir(key), removed });
  }
  const remaining = Object.keys(HOSTS).some(key => managedEntries(key).length);
  if (remaining) prune(null);
  else {
    try { fs.rmSync(bundlesRoot(), { recursive: true, force: true }); } catch (error) {
      process.stderr.write(`${PRODUCT} warning: could not remove ${bundlesRoot()}: ${error.message}\n`);
    }
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ hosts: result }, null, 2)}\n`);
    return;
  }
  if (!result.length) process.stdout.write(`${PRODUCT}: nothing to uninstall\n`);
  for (const h of result) process.stdout.write(`${h.host.padEnd(9)} ${h.removed} removed  ${h.dir}\n`);
}
