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
import { sharedHome } from './pool/state.mjs';
import { completionScript } from './completion.mjs';
import { skillFiles } from '../scripts/generate-skills.mjs';

const WIN = process.platform === 'win32';
const STAGING_GRACE_MS = 5 * 60 * 1000;

export const HOSTS = {
  claude: { skills: ['.claude', 'skills'], detect: ['.claude'] },
  codex: { skills: ['.agents', 'skills'], detect: ['.codex'] },
  omp: { skills: ['.omp', 'agent', 'skills'], detect: ['.omp'] },
  opencode: { skills: ['.config', 'opencode', 'skills'], detect: ['.config', 'opencode'] },
  dsh: { skills: ['.dsh', 'skills'], detect: ['.dsh'] },
  // The shared HOME that `start` and every pooled run use for agy itself: agy
  // reads <HOME>/.agents/skills, so the personas are available inside it too.
  // It belongs to agy-crew, so it is installed by default, detected or not.
  shared: { base: sharedHome, skills: ['.agents', 'skills'], detect: [], always: true },
};

const home = (...parts) => path.join(os.homedir(), ...parts);
const hostBase = key => (HOSTS[key].base ? HOSTS[key].base() : os.homedir());
const hostDir = key => path.join(hostBase(key), ...HOSTS[key].skills);
const hostPresent = key => HOSTS[key].always || fs.existsSync(path.join(hostBase(key), ...HOSTS[key].detect));
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
// shell completion
// ---------------------------------------------------------------------------
//
// The completion scripts live in <globalHome>/completions/ and are refreshed on
// every install. bash and zsh get one marked block in their rc file that sources
// the script; fish autoloads ~/.config/fish/completions, so it gets a copy of
// the script there. Only text between the markers (or a fish file carrying the
// marker) is ever touched, and uninstall removes exactly that.

const RC_BEGIN = `# >>> ${PRODUCT} completion >>>`;
const RC_END = `# <<< ${PRODUCT} completion <<<`;
const FISH_MARKER = `# managed by ${PRODUCT} install`;
const completionsRoot = () => path.join(globalHome(), 'completions');
const scriptFile = shell => path.join(completionsRoot(), `${PRODUCT}.${shell}`);

const SHELL_TARGETS = {
  bash: { rc: () => home('.bashrc'), detect: () => fs.existsSync(home('.bashrc')) },
  zsh: { rc: () => path.join(process.env.ZDOTDIR || os.homedir(), '.zshrc'), detect: () => fs.existsSync(path.join(process.env.ZDOTDIR || os.homedir(), '.zshrc')) },
  fish: { rc: () => home('.config', 'fish', 'completions', `${PRODUCT}.fish`), detect: () => fs.existsSync(home('.config', 'fish')) },
};

/** Shells to set up: those with an rc file (or fish config) plus the login shell. */
function completionShells() {
  const login = path.basename(process.env.SHELL || '').replace(/\.exe$/, '');
  return Object.keys(SHELL_TARGETS).filter(sh => SHELL_TARGETS[sh].detect() || sh === login);
}

const rcBlock = shell => `${RC_BEGIN}\n[ -r "${fwd(scriptFile(shell))}" ] && . "${fwd(scriptFile(shell))}"\n${RC_END}\n`;
const BLOCK_RE = new RegExp(`\\n?${RC_BEGIN}[\\s\\S]*?${RC_END}\\n?`);

function readOr(file, fallback = '') { try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; } }

function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Set one shell up. Returns 'created' | 'updated' | 'unchanged'; throws on I/O errors. */
function installCompletion(shell) {
  const script = completionScript(shell);
  const target = SHELL_TARGETS[shell].rc();
  if (shell === 'fish') {
    const text = `${FISH_MARKER}\n${script}`;
    const existing = readOr(target, null);
    if (existing !== null && !existing.startsWith(FISH_MARKER)) return 'conflict';
    if (existing === text) return 'unchanged';
    writeFileAtomic(target, text);
    return existing === null ? 'created' : 'updated';
  }
  writeFileAtomic(scriptFile(shell), script);
  const rc = readOr(target, null);
  const block = rcBlock(shell);
  if (rc === null) { writeFileAtomic(target, block); return 'created'; }
  const next = BLOCK_RE.test(rc) ? rc.replace(BLOCK_RE, (m) => (m.startsWith('\n') ? '\n' : '') + block) : `${rc}${rc && !rc.endsWith('\n') ? '\n' : ''}\n${block}`;
  if (next === rc) return 'unchanged';
  writeFileAtomic(target, next);
  return BLOCK_RE.test(rc) ? 'updated' : 'created';
}

function uninstallCompletion(shell) {
  const target = SHELL_TARGETS[shell].rc();
  const text = readOr(target, null);
  let removed = false;
  if (text !== null) {
    if (shell === 'fish') {
      if (text.startsWith(FISH_MARKER)) { fs.rmSync(target); removed = true; }
    } else if (BLOCK_RE.test(text)) {
      const next = text.replace(BLOCK_RE, '\n').replace(/\n{3,}/g, '\n\n');
      if (next.trim()) fs.writeFileSync(target, next.replace(/^\n+/, '')); else fs.writeFileSync(target, '');
      removed = true;
    }
  }
  fs.rmSync(scriptFile(shell), { force: true });
  return removed;
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
      const present = Object.keys(HOSTS).filter(k => !HOSTS[k].always && hostPresent(k));
      if (!present.length) fail('no supported harness detected; pass --hosts <list> or --all');
      return [...present, ...Object.keys(HOSTS).filter(k => HOSTS[k].always)];
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

  const shells = opts['no-completion'] ? [] : completionShells();

  if (opts['dry-run']) {
    if (opts.json) return;
    const lines = [`${PRODUCT} ${bundle.version} (dry run) → ${bundle.bundleDir}`];
    for (const h of plan) {
      lines.push(`${h.host}  ${h.dir}`);
      for (const s of h.skills) lines.push(`  ${s.name}  ${s.change}`);
    }
    for (const sh of shells) lines.push(`completion ${sh}  ${SHELL_TARGETS[sh].rc()}`);
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

  // Completion is a convenience: a read-only rc file must not fail the install.
  const completion = shells.map((shell) => {
    try { return { shell, file: SHELL_TARGETS[shell].rc(), change: installCompletion(shell) }; } catch (error) {
      process.stderr.write(`${PRODUCT} warning: could not set up ${shell} completion: ${error.message}\n`);
      return { shell, file: SHELL_TARGETS[shell].rc(), change: 'failed' };
    }
  });

  if (!opts.json) {
    const lines = [`${PRODUCT} ${bundle.version} → ${bundle.bundleDir}`];
    for (const h of plan) lines.push(`${h.host.padEnd(9)} ${counts(h.skills).padEnd(22)} ${h.dir}`);
    for (const c of completion) lines.push(`${('completion ' + c.shell).padEnd(9)} ${c.change.padEnd(22)} ${c.file}`);
    if (completion.some(c => ['created', 'updated'].includes(c.change))) lines.push('Open a new shell to load tab completion.');
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
  const completionRemoved = [];
  const remaining = Object.keys(HOSTS).some(key => managedEntries(key).length);
  if (remaining) prune(null);
  else {
    try { fs.rmSync(bundlesRoot(), { recursive: true, force: true }); } catch (error) {
      process.stderr.write(`${PRODUCT} warning: could not remove ${bundlesRoot()}: ${error.message}\n`);
    }
  }
  if (!remaining) {
    for (const shell of Object.keys(SHELL_TARGETS)) {
      try { if (uninstallCompletion(shell)) completionRemoved.push(shell); } catch (error) {
        process.stderr.write(`${PRODUCT} warning: could not remove ${shell} completion: ${error.message}\n`);
      }
    }
    try { fs.rmdirSync(completionsRoot()); } catch { /* not empty or absent */ }
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ hosts: result, completion: completionRemoved }, null, 2)}\n`);
    return;
  }
  if (completionRemoved.length) process.stdout.write(`${'completion'.padEnd(9)} removed from ${completionRemoved.join(', ')}\n`);
  if (!result.length) process.stdout.write(`${PRODUCT}: nothing to uninstall\n`);
  for (const h of result) process.stdout.write(`${h.host.padEnd(9)} ${h.removed} removed  ${h.dir}\n`);
}
