import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountHomeOf, readPool, runAsync, seedPool } from './pool-helpers.mjs';
import { run, sandbox } from './helpers.mjs';
import { extensionContent } from '../companion/install.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_OMP = path.join(HERE, 'fake-omp.mjs');

function seedProjects(sb, names) {
  for (const name of names) {
    const file = path.join(accountHomeOf(sb, name), '.gemini', 'antigravity-cli', 'cache', 'default_project_id.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `project-${name}\n`);
  }
}

const loaderOf = (sb) => path.join(sb.home, '.omp', 'agent', 'extensions', 'agy-crew-omp.ts');

function writeLoader(sb, content) {
  fs.mkdirSync(path.dirname(loaderOf(sb)), { recursive: true });
  fs.writeFileSync(loaderOf(sb), content);
}

const RISK = '--use-at-my-own-risk';

test('agy-crew omp refuses to run without --use-at-my-own-risk', async () => {
  const sb = sandbox();
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }]);
  seedProjects(sb, ['a']);
  const out = path.join(sb.root, 'omp.json');

  const result = await runAsync(sb, ['omp', 'a'], { OMP_BIN: FAKE_OMP, FAKE_OMP_OUT: out });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /without --use-at-my-own-risk/);
  assert.match(result.stderr, /usage: agy-crew omp --use-at-my-own-risk/);
  assert.equal(fs.existsSync(out), false, 'omp is never launched');
  assert.equal(fs.existsSync(loaderOf(sb)), false, 'no extension is installed');
  assert.equal(readPool(sb).leases.length, 0, 'no account is held');
});

test('agy-crew omp --help works without the risk flag', () => {
  const sb = sandbox();
  const result = run(sb, ['omp', '--help']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /--use-at-my-own-risk\s+required/);
  assert.equal(fs.existsSync(loaderOf(sb)), false);
});

test('agy-crew omp holds the named account, installs the extension for the run, and passes omp args through', async () => {
  const sb = sandbox();
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }, { name: 'b', email: 'b@example.com' }]);
  seedProjects(sb, ['a', 'b']);
  const out = path.join(sb.root, 'omp.json');

  const result = await runAsync(
    sb,
    ['omp', RISK, 'a', '--', '--model', 'google-antigravity/gemini-3.8-flash'],
    { OMP_BIN: FAKE_OMP, FAKE_OMP_OUT: out },
  );

  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(payload.account, 'a');
  assert.equal(payload.family, 'gemini-3.8-flash');
  assert.equal(payload.firstEventTimeout, '300000', 'the bridge raises Antigravity\'s 60s first-event budget');
  assert.equal(payload.holds, 1, 'the account is held while omp runs');
  assert.deepEqual(payload.argv, ['--model', 'google-antigravity/gemini-3.8-flash']);
  assert.ok(payload.loader, 'omp starts with the extension installed');
  assert.equal(payload.loader.path, loaderOf(sb));
  assert.equal(payload.loader.content, extensionContent());
  assert.equal(fs.existsSync(loaderOf(sb)), false, 'the extension is removed on exit');
  assert.equal(readPool(sb).leases.filter((lease) => lease.role === 'hold').length, 0, 'hold is released on exit');
});

test('the risk flag may follow the account name', async () => {
  const sb = sandbox();
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }]);
  seedProjects(sb, ['a']);
  const out = path.join(sb.root, 'omp.json');

  const result = await runAsync(sb, ['omp', 'a', RISK], { OMP_BIN: FAKE_OMP, FAKE_OMP_OUT: out });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).account, 'a');
  assert.equal(fs.existsSync(loaderOf(sb)), false);
});

test('agy-crew omp auto chooses an idle pool account', async () => {
  const sb = sandbox();
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }, { name: 'b', email: 'b@example.com' }]);
  seedProjects(sb, ['a', 'b']);
  const out = path.join(sb.root, 'omp.json');

  const result = await runAsync(sb, ['omp', RISK], { OMP_BIN: FAKE_OMP, FAKE_OMP_OUT: out });
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(['a', 'b'].includes(payload.account));
  assert.equal(payload.holds, 1);
  assert.ok(payload.loader);
  assert.equal(fs.existsSync(loaderOf(sb)), false);
  assert.equal(readPool(sb).leases.filter((lease) => lease.role === 'hold').length, 0);
});

test('agy-crew omp refuses an unknown account', async () => {
  const sb = sandbox();
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }]);
  const result = await runAsync(sb, ['omp', RISK, 'missing'], { OMP_BIN: FAKE_OMP });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown account "missing"/);
  assert.equal(fs.existsSync(loaderOf(sb)), false, 'the extension is removed after a refused run');
});

test('a foreign omp extension is never overwritten', async () => {
  const sb = sandbox();
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }]);
  seedProjects(sb, ['a']);
  writeLoader(sb, '// my own loader\n');
  const out = path.join(sb.root, 'omp.json');

  const result = await runAsync(sb, ['omp', RISK, 'a'], { OMP_BIN: FAKE_OMP, FAKE_OMP_OUT: out });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /was not created by agy-crew/);
  assert.equal(fs.readFileSync(loaderOf(sb), 'utf8'), '// my own loader\n');
  assert.equal(fs.existsSync(out), false, 'omp is never launched');
  assert.equal(readPool(sb).leases.length, 0, 'no account is held');
});

test('a stale managed loader is replaced for the run and removed after it', async () => {
  const sb = sandbox();
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }]);
  seedProjects(sb, ['a']);
  writeLoader(sb, extensionContent(path.join(sb.root, 'gone')));
  const out = path.join(sb.root, 'omp.json');

  const result = await runAsync(sb, ['omp', RISK, 'a'], { OMP_BIN: FAKE_OMP, FAKE_OMP_OUT: out });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).loader.content, extensionContent());
  assert.equal(fs.existsSync(loaderOf(sb)), false, 'the legacy loader is gone after the run');
});

test('accounts parallel does not let omp share an account', async () => {
  const sb = sandbox();
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }], (p) => {
    p.leases.push({ id: 'l', account: 'a', pid: process.pid, job_id: null, role: 'run', started_at: '' });
  });
  seedProjects(sb, ['a']);
  const out = path.join(sb.root, 'omp.json');
  assert.equal(run(sb, ['accounts', 'parallel', 'a', '2']).code, 0);

  const named = await runAsync(sb, ['omp', RISK, 'a'], { OMP_BIN: FAKE_OMP, FAKE_OMP_OUT: out });
  assert.equal(named.code, 1);
  assert.match(named.stderr, /account a is in use/);

  const auto = await runAsync(sb, ['omp', RISK], { OMP_BIN: FAKE_OMP, FAKE_OMP_OUT: out });
  assert.equal(auto.code, 1);
  assert.match(auto.stderr, /no pool account is idle/);
  assert.equal(fs.existsSync(out), false, 'omp is never launched');
  assert.equal(fs.existsSync(loaderOf(sb)), false, 'the extension is removed after a refused run');
});
