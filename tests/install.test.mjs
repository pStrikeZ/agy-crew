import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, run, COMPANION, FAKE_AGY } from './helpers.mjs';
import { generateSkills, ROOT } from '../scripts/generate-skills.mjs';

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const PERSONAS = ['accounts', 'ask', 'implementer', 'jobs', 'lead', 'researcher', 'reviewer', 'staffer'];
const HOST_DIRS = {
  claude: ['.claude', 'skills'],
  codex: ['.agents', 'skills'],
  omp: ['.omp', 'agent', 'skills'],
  opencode: ['.config', 'opencode', 'skills'],
  dsh: ['.dsh', 'skills'],
};

function env(sb) {
  return { AGY_CREW_HOME: path.join(sb.root, 'crew-home') };
}
const install = (sb, args = [], extra = {}) => run(sb, ['install', ...args], { ...env(sb), ...extra });
const skillsDir = (sb, host) => path.join(sb.home, ...HOST_DIRS[host]);
const sharedSkillsDir = sb => path.join(sb.root, 'crew-home', 'shared', 'home', '.agents', 'skills');
const bundlesDir = sb => path.join(sb.root, 'crew-home', 'bundles');
const fwd = p => p.replaceAll('\\', '/');
const norm = p => path.resolve(p.replace(/^\\\\\?\\/, '')).toLowerCase();

function listBundleSkillMd(bundleDir) {
  const out = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.md')) out.push(full);
    }
  };
  walk(bundleDir);
  return out;
}

test('no host present: install fails and creates nothing', () => {
  const sb = sandbox('inst-none');
  const r = install(sb);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no supported harness detected; pass --hosts <list> or --all/);
  assert.equal(fs.existsSync(bundlesDir(sb)), false);
  assert.deepEqual(fs.readdirSync(sb.home), []);
});

test('unknown host key is rejected with the valid keys', () => {
  const sb = sandbox('inst-badhost');
  const r = install(sb, ['--hosts', 'nope']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown host nope; valid hosts: claude, codex, omp, opencode, dsh/);
});

test('claude present: links, bundle content, repeat run, json, and running the installed command', () => {
  const sb = sandbox('inst-claude');
  fs.mkdirSync(path.join(sb.home, '.claude'));
  // Outside any git repository, from a directory that is not the sandbox repo.
  const first = spawnSyncInstall(sb, ['--hosts', 'claude']);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /claude\s+8 created/);
  assert.match(first.stdout, /Smoke test: \/agy-crew-ask reply with OK/);

  const dir = skillsDir(sb, 'claude');
  assert.deepEqual(fs.readdirSync(dir).sort(), PERSONAS.map(p => `agy-crew-${p}`));
  const bundleNames = fs.readdirSync(bundlesDir(sb));
  assert.equal(bundleNames.length, 1);
  assert.match(bundleNames[0], new RegExp(`^${VERSION.replaceAll('.', '\\.')}-[0-9a-f]{12}$`));
  const bundleDir = path.join(bundlesDir(sb), bundleNames[0]);
  for (const p of PERSONAS) {
    const link = path.join(dir, `agy-crew-${p}`);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), `${link} is a link`);
    assert.equal(norm(fs.readlinkSync(link)), norm(path.join(bundleDir, `agy-crew-${p}`)));
    assert.ok(fs.existsSync(path.join(link, 'SKILL.md')));
  }

  const ask = fs.readFileSync(path.join(bundleDir, 'agy-crew-ask', 'SKILL.md'), 'utf8');
  assert.ok(ask.includes(`node "${fwd(COMPANION)}" ask`), 'absolute companion command');
  assert.match(ask, /\/agy-crew-/);
  for (const bad of ['<skill-dir>', '<plugin-root>', '/agy-crew:', '../../']) {
    assert.ok(!ask.includes(bad), `ask skill must not contain ${bad}`);
  }
  for (const file of listBundleSkillMd(bundleDir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const bad of ['<skill-dir>', '<plugin-root>', '../../']) assert.ok(!text.includes(bad), `${file} contains ${bad}`);
    for (const m of text.matchAll(/`([^`\s]+\.md)`/g)) {
      assert.ok(fs.existsSync(path.resolve(path.dirname(file), m[1])), `${file} references missing ${m[1]}`);
    }
  }
  const jobs = fs.readFileSync(path.join(bundleDir, 'agy-crew-jobs', 'SKILL.md'), 'utf8');
  assert.ok(jobs.includes(`${fwd(ROOT)}/docs/REFERENCE.md`));

  // Execute the command exactly as the installed skill instructs.
  const installed = fs.readFileSync(path.join(dir, 'agy-crew-ask', 'SKILL.md'), 'utf8');
  const cmd = /node "([^"]+agy-companion\.mjs)"/.exec(installed);
  assert.ok(cmd);
  const answer = spawnSync(process.execPath, [cmd[1], 'ask', '--prompt', 'reply with OK'], {
    cwd: sb.root,
    encoding: 'utf8',
    env: { ...process.env, HOME: sb.home, USERPROFILE: sb.home, ...env(sb), AGY_BIN: FAKE_AGY, FAKE_AGY_RESPONSE: 'installed OK' },
  });
  assert.equal(answer.status, 0, answer.stderr);
  assert.match(answer.stdout, /installed OK/);

  const second = install(sb, ['--hosts', 'claude']);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /claude\s+8 unchanged/);
  assert.deepEqual(fs.readdirSync(bundlesDir(sb)), bundleNames);

  const json = JSON.parse(install(sb, ['--hosts', 'claude', '--json']).stdout);
  assert.equal(json.version, VERSION);
  assert.equal(norm(json.bundle), norm(bundleDir));
  assert.deepEqual(json.conflicts, []);
  assert.equal(json.hosts.length, 1);
  assert.equal(json.hosts[0].host, 'claude');
  assert.equal(json.hosts[0].dir, dir);
  assert.deepEqual(json.hosts[0].skills.map(s => s.name), PERSONAS.map(p => `agy-crew-${p}`));
  assert.ok(json.hosts[0].skills.every(s => s.change === 'unchanged'));
});

function spawnSyncInstall(sb, args) {
  return spawnSync(process.execPath, [COMPANION, 'install', ...args], {
    cwd: sb.root,
    encoding: 'utf8',
    env: { ...process.env, HOME: sb.home, USERPROFILE: sb.home, ...env(sb) },
  });
}

test('--all, --status and uninstall --all keep user content', () => {
  const sb = sandbox('inst-all');
  const own = path.join(sb.home, '.claude', 'skills', 'my-own-skill');
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, 'SKILL.md'), 'mine');
  const r = install(sb, ['--all']);
  assert.equal(r.code, 0, r.stderr);
  for (const host of Object.keys(HOST_DIRS)) {
    assert.equal(fs.readdirSync(skillsDir(sb, host)).filter(n => n.startsWith('agy-crew-')).length, 8, host);
  }
  assert.equal(fs.readdirSync(sharedSkillsDir(sb)).filter(n => n.startsWith('agy-crew-')).length, 8, 'shared home');

  const status = JSON.parse(install(sb, ['--status', '--json']).stdout);
  assert.equal(status.hosts.length, 6);
  assert.ok(status.hosts.every(h => h.skills.every(s => s.state === 'managed-current')));
  assert.equal(status.bundles.filter(b => b.current).length, 1);
  const text = install(sb, ['--status']);
  assert.equal(text.code, 0);
  assert.equal((text.stdout.match(/managed-current/g) || []).length, 48);
  assert.match(text.stdout, /\(current\)/);

  const u = run(sb, ['uninstall', '--all'], env(sb));
  assert.equal(u.code, 0, u.stderr);
  assert.equal((u.stdout.match(/8 removed/g) || []).length, 6);
  for (const host of Object.keys(HOST_DIRS)) {
    const left = fs.existsSync(skillsDir(sb, host)) ? fs.readdirSync(skillsDir(sb, host)).filter(n => n.startsWith('agy-crew-')) : [];
    assert.deepEqual(left, [], host);
  }
  assert.equal(fs.readFileSync(path.join(own, 'SKILL.md'), 'utf8'), 'mine');
  assert.equal(fs.existsSync(bundlesDir(sb)), false);
  assert.ok(fs.existsSync(path.join(sb.root, 'crew-home')));
});

test('conflict is all-or-nothing', () => {
  const sb = sandbox('inst-conflict');
  const clash = path.join(sb.home, '.claude', 'skills', 'agy-crew-ask');
  fs.mkdirSync(clash, { recursive: true });
  fs.writeFileSync(path.join(clash, 'SKILL.md'), 'user content');
  fs.mkdirSync(path.join(sb.home, '.codex'));
  const r = install(sb);
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes(clash));
  assert.equal(fs.existsSync(path.join(sb.home, '.agents')), false);
  assert.equal(fs.existsSync(bundlesDir(sb)), false);
  assert.equal(fs.readFileSync(path.join(clash, 'SKILL.md'), 'utf8'), 'user content');
});

test('upstream agy-staff blocks install', () => {
  const sb = sandbox('inst-upstream');
  const plugins = path.join(sb.home, '.claude', 'plugins');
  fs.mkdirSync(plugins, { recursive: true });
  fs.writeFileSync(path.join(plugins, 'installed_plugins.json'), JSON.stringify({ plugins: { 'agy@agy-staff': [{ installPath: 'x' }] } }));
  const r = install(sb);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /claude plugin uninstall agy@agy-staff/);
  assert.equal(fs.existsSync(bundlesDir(sb)), false);

  const sb2 = sandbox('inst-upstream-skill');
  fs.mkdirSync(path.join(sb2.home, '.config', 'opencode', 'skills', 'agy-ask'), { recursive: true });
  const r2 = install(sb2);
  assert.equal(r2.code, 1);
  assert.match(r2.stderr, /upstream/);
  assert.ok(r2.stderr.includes(path.join('skills', 'agy-ask')));
});

test('--dry-run writes nothing', () => {
  const sb = sandbox('inst-dry');
  fs.mkdirSync(path.join(sb.home, '.claude'));
  const r = install(sb, ['--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /created/);
  assert.equal(fs.existsSync(path.join(sb.home, '.claude', 'skills')), false);
  assert.equal(fs.existsSync(bundlesDir(sb)), false);
});

test('stale managed link is updated and the old bundle pruned', () => {
  const sb = sandbox('inst-stale');
  fs.mkdirSync(path.join(sb.home, '.claude', 'skills'), { recursive: true });
  const oldSkill = path.join(bundlesDir(sb), '0.0.1-deadbeefcafe', 'agy-crew-ask');
  fs.mkdirSync(oldSkill, { recursive: true });
  fs.writeFileSync(path.join(oldSkill, 'SKILL.md'), 'old');
  const link = path.join(sb.home, '.claude', 'skills', 'agy-crew-ask');
  fs.symlinkSync(oldSkill, link, process.platform === 'win32' ? 'junction' : 'dir');

  const r = install(sb);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /claude\s+7 created, 1 updated/);
  assert.ok(!fs.readlinkSync(link).includes('deadbeefcafe'));
  assert.ok(fs.readFileSync(path.join(link, 'SKILL.md'), 'utf8').includes('agy-crew-ask'));
  assert.equal(fs.existsSync(path.join(bundlesDir(sb), '0.0.1-deadbeefcafe')), false);
});

test('package bin points at the shebanged companion', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.bin['agy-crew'], 'companion/agy-companion.mjs');
  assert.ok(fs.readFileSync(path.join(ROOT, pkg.bin['agy-crew']), 'utf8').startsWith('#!/usr/bin/env node'));
});

test('user target is virtual and the repository checks still pass', () => {
  assert.throws(() => generateSkills({ target: 'user' }), /Target user is virtual; it is rendered by the install command/);
  const r = spawnSync('npm', ['run', 'check:skills'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(path.join(ROOT, 'user-skills')), false);
});

test('default install also links the skills into the shared home, and uninstall removes them', () => {
  const sb = sandbox('inst-shared');
  fs.mkdirSync(path.join(sb.home, '.claude'));
  const r = install(sb);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /shared +8 created/);
  const names = fs.readdirSync(sharedSkillsDir(sb)).filter(n => n.startsWith('agy-crew-')).sort();
  assert.deepEqual(names, PERSONAS.map(p => `agy-crew-${p}`));
  assert.ok(fs.existsSync(path.join(sharedSkillsDir(sb), 'agy-crew-ask', 'SKILL.md')));
  assert.match(install(sb).stdout, /shared +8 unchanged/);

  // --hosts picks it explicitly, without the other harnesses.
  const only = install(sb, ['--hosts', 'shared', '--dry-run']);
  assert.equal(only.code, 0, only.stderr);
  assert.doesNotMatch(only.stdout, /^claude/m);

  const u = run(sb, ['uninstall'], env(sb));
  assert.equal(u.code, 0, u.stderr);
  assert.match(u.stdout, /shared +8 removed/);
  assert.deepEqual(fs.readdirSync(sharedSkillsDir(sb)).filter(n => n.startsWith('agy-crew-')), []);
});

// ---------------------------------------------------------------------------
// shell completion in the rc files
// ---------------------------------------------------------------------------

const rcEnv = (sb, extra = {}) => ({ ...env(sb), SHELL: '/bin/sh', ZDOTDIR: '', ...extra });
const BEGIN = '# >>> agy-crew completion >>>';

test('install adds one marked completion block to the rc files, keeps the rest, and uninstall removes it', () => {
  const sb = sandbox('inst-completion');
  fs.mkdirSync(path.join(sb.home, '.claude'));
  fs.writeFileSync(path.join(sb.home, '.bashrc'), 'export A=1\n');
  fs.writeFileSync(path.join(sb.home, '.zshrc'), 'export B=2');          // no trailing newline
  fs.mkdirSync(path.join(sb.home, '.config', 'fish'), { recursive: true });
  const e = rcEnv(sb);
  const r = install(sb, [], e);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /completion bash +created/);
  assert.match(r.stdout, /Open a new shell/);
  const bashrc = fs.readFileSync(path.join(sb.home, '.bashrc'), 'utf8');
  assert.ok(bashrc.startsWith('export A=1\n'));
  assert.equal(bashrc.split(BEGIN).length, 2);
  assert.match(bashrc, /\[ -r ".*completions\/agy-crew\.bash" \] && \. ".*completions\/agy-crew\.bash"/);
  assert.ok(fs.readFileSync(path.join(sb.home, '.zshrc'), 'utf8').startsWith('export B=2\n'));
  const fish = fs.readFileSync(path.join(sb.home, '.config', 'fish', 'completions', 'agy-crew.fish'), 'utf8');
  assert.match(fish, /^# managed by agy-crew install\n/);
  assert.ok(fs.existsSync(path.join(sb.root, 'crew-home', 'completions', 'agy-crew.zsh')));

  // Repeat run: nothing changes, no second block.
  const again = install(sb, [], e);
  assert.match(again.stdout, /completion bash +unchanged/);
  assert.equal(fs.readFileSync(path.join(sb.home, '.bashrc'), 'utf8'), bashrc);

  // A partial uninstall keeps completion; the last one removes it.
  run(sb, ['uninstall', '--hosts', 'shared'], e);
  assert.ok(fs.readFileSync(path.join(sb.home, '.bashrc'), 'utf8').includes(BEGIN));
  const u = run(sb, ['uninstall'], e);
  assert.equal(u.code, 0, u.stderr);
  assert.match(u.stdout, /completion +removed from bash, zsh, fish/);
  assert.equal(fs.readFileSync(path.join(sb.home, '.bashrc'), 'utf8').trim(), 'export A=1');
  assert.equal(fs.readFileSync(path.join(sb.home, '.zshrc'), 'utf8').trim(), 'export B=2');
  assert.equal(fs.existsSync(path.join(sb.home, '.config', 'fish', 'completions', 'agy-crew.fish')), false);
  assert.equal(fs.existsSync(path.join(sb.root, 'crew-home', 'completions')), false);
});

test('completion: --no-completion skips it, the login shell gets an rc created, user fish files are left alone', () => {
  const sb = sandbox('inst-completion-opt');
  fs.mkdirSync(path.join(sb.home, '.claude'));
  const skipped = install(sb, ['--no-completion'], rcEnv(sb));
  assert.equal(skipped.code, 0, skipped.stderr);
  assert.equal(fs.existsSync(path.join(sb.home, '.bashrc')), false);
  assert.doesNotMatch(skipped.stdout, /completion (bash|zsh|fish)/);

  const dry = install(sb, ['--dry-run'], rcEnv(sb, { SHELL: '/usr/bin/zsh' }));
  assert.match(dry.stdout, /completion zsh/);
  assert.equal(fs.existsSync(path.join(sb.home, '.zshrc')), false, 'dry run writes nothing');

  const own = path.join(sb.home, '.config', 'fish', 'completions');
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, 'agy-crew.fish'), 'my own\n');
  const r = install(sb, [], rcEnv(sb, { SHELL: '/usr/bin/zsh' }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(sb.home, '.zshrc'), 'utf8'), new RegExp(BEGIN));
  assert.match(r.stdout, /completion fish +conflict/);
  assert.equal(fs.readFileSync(path.join(own, 'agy-crew.fish'), 'utf8'), 'my own\n');
});

for (const [shell, probe] of [
  ['zsh', (rc) => ['-f', '-c', `source ${rc}; print -r -- $_comps[agy-crew]`]],
  ['bash', (rc) => ['--norc', '-c', `source ${rc}; complete -p agy-crew`]],
]) {
  test(`the rc block really loads in ${shell}`, { skip: spawnSync(shell, ['--version']).error ? `${shell} not installed` : false }, () => {
    const sb = sandbox(`inst-completion-${shell}`);
    fs.mkdirSync(path.join(sb.home, '.claude'));
    const rcName = shell === 'zsh' ? '.zshrc' : '.bashrc';
    fs.writeFileSync(path.join(sb.home, rcName), '');
    assert.equal(install(sb, [], rcEnv(sb)).code, 0);
    const r = spawnSync(shell, probe(path.join(sb.home, rcName)), { encoding: 'utf8', env: { ...process.env, HOME: sb.home } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, shell === 'zsh' ? /^_agy_crew$/m : /-F _agy_crew agy-crew/);
  });
}

test('the installed fish completion answers', { skip: spawnSync('fish', ['--version']).error ? 'fish not installed' : false }, () => {
  const sb = sandbox('inst-completion-fish');
  fs.mkdirSync(path.join(sb.home, '.config', 'fish'), { recursive: true });
  fs.mkdirSync(path.join(sb.home, '.claude'));
  assert.equal(install(sb, [], rcEnv(sb)).code, 0);
  const bin = path.join(sb.root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'agy-crew'), `#!/bin/sh\nexec "${process.execPath}" "${COMPANION}" "$@"\n`, { mode: 0o755 });
  const ask = (line) => spawnSync('fish', ['--no-config', '-c',
    `set fish_complete_path ${path.join(sb.home, '.config', 'fish', 'completions')}; complete -C '${line}'`],
  { encoding: 'utf8', env: { ...process.env, HOME: sb.home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...env(sb) } }).stdout.split('\n').filter(Boolean);
  assert.deepEqual(ask('agy-crew inspe'), ['inspect']);
  assert.deepEqual(ask('agy-crew ask --effort '), ['high', 'low', 'medium']);
  assert.deepEqual(ask('agy-crew install --hosts claude,s'), ['claude,shared']);
});
