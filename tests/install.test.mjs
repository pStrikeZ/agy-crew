import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, run, COMPANION, FAKE_AGY } from './helpers.mjs';
import { generateSkills, ROOT } from '../scripts/generate-skills.mjs';

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const PERSONAS = ['ask', 'implementer', 'jobs', 'lead', 'researcher', 'reviewer', 'staffer'];
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
  assert.match(first.stdout, /claude\s+7 created/);
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
  assert.match(second.stdout, /claude\s+7 unchanged/);
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
    assert.equal(fs.readdirSync(skillsDir(sb, host)).filter(n => n.startsWith('agy-crew-')).length, 7, host);
  }

  const status = JSON.parse(install(sb, ['--status', '--json']).stdout);
  assert.equal(status.hosts.length, 5);
  assert.ok(status.hosts.every(h => h.skills.every(s => s.state === 'managed-current')));
  assert.equal(status.bundles.filter(b => b.current).length, 1);
  const text = install(sb, ['--status']);
  assert.equal(text.code, 0);
  assert.equal((text.stdout.match(/managed-current/g) || []).length, 35);
  assert.match(text.stdout, /\(current\)/);

  const u = run(sb, ['uninstall', '--all'], env(sb));
  assert.equal(u.code, 0, u.stderr);
  assert.equal((u.stdout.match(/7 removed/g) || []).length, 5);
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
  assert.match(r.stdout, /claude\s+6 created, 1 updated/);
  assert.ok(!fs.readlinkSync(link).includes('deadbeefcafe'));
  assert.ok(fs.readFileSync(path.join(link, 'SKILL.md'), 'utf8').includes('agy-crew-ask'));
  assert.equal(fs.existsSync(path.join(bundlesDir(sb), '0.0.1-deadbeefcafe')), false);
});

test('package bin points at the shebanged companion', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.bin['agy-crew'], './companion/agy-companion.mjs');
  assert.ok(fs.readFileSync(path.join(ROOT, pkg.bin['agy-crew']), 'utf8').startsWith('#!/usr/bin/env node'));
});

test('user target is virtual and the repository checks still pass', () => {
  assert.throws(() => generateSkills({ target: 'user' }), /Target user is virtual; it is rendered by the install command/);
  const r = spawnSync('npm', ['run', 'check:skills'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(path.join(ROOT, 'user-skills')), false);
});
