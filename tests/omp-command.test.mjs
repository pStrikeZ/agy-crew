import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountHomeOf, readPool, runAsync, seedPool } from './pool-helpers.mjs';
import { sandbox } from './helpers.mjs';
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

function installExtension(sb, content = extensionContent()) {
  fs.mkdirSync(path.dirname(loaderOf(sb)), { recursive: true });
  fs.writeFileSync(loaderOf(sb), content);
}

test('agy-crew omp holds the named account and passes omp args through', async () => {
  const sb = sandbox();
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }, { name: 'b', email: 'b@example.com' }]);
  seedProjects(sb, ['a', 'b']);
  installExtension(sb);
  const out = path.join(sb.root, 'omp.json');

  const result = await runAsync(
    sb,
    ['omp', 'a', '--', '--model', 'google-antigravity/gemini-3.8-flash'],
    { OMP_BIN: FAKE_OMP, FAKE_OMP_OUT: out },
  );

  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(payload.account, 'a');
  assert.equal(payload.family, 'gemini-3.8-flash');
  assert.equal(payload.firstEventTimeout, '300000', 'the bridge raises Antigravity\'s 60s first-event budget');
  assert.equal(payload.holds, 1, 'the account is held while omp runs');
  assert.deepEqual(payload.argv, ['--model', 'google-antigravity/gemini-3.8-flash']);
  assert.equal(readPool(sb).leases.filter((lease) => lease.role === 'hold').length, 0, 'hold is released on exit');
});

test('agy-crew omp auto chooses an idle pool account', async () => {
  const sb = sandbox();
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }, { name: 'b', email: 'b@example.com' }]);
  seedProjects(sb, ['a', 'b']);
  installExtension(sb);
  const out = path.join(sb.root, 'omp.json');

  const result = await runAsync(sb, ['omp'], { OMP_BIN: FAKE_OMP, FAKE_OMP_OUT: out });
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(['a', 'b'].includes(payload.account));
  assert.equal(payload.holds, 1);
  assert.equal(readPool(sb).leases.filter((lease) => lease.role === 'hold').length, 0);
});

test('agy-crew omp refuses an unknown account', async () => {
  const sb = sandbox();
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }]);
  installExtension(sb);
  const result = await runAsync(sb, ['omp', 'missing'], { OMP_BIN: FAKE_OMP });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown account "missing"/);
});

test('agy-crew omp refuses to start when the omp extension is not installed', async () => {
  const sb = sandbox();
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }]);
  seedProjects(sb, ['a']);
  const out = path.join(sb.root, 'omp.json');

  const result = await runAsync(sb, ['omp', 'a'], { OMP_BIN: FAKE_OMP, FAKE_OMP_OUT: out });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /the omp extension is not installed/);
  assert.match(result.stderr, /agy-crew install --hosts omp/);
  assert.equal(fs.existsSync(out), false, 'omp is never launched');
  assert.equal(readPool(sb).leases.length, 0, 'no account is held');
});

test('agy-crew omp refuses a loader that points at a removed package', async () => {
  const sb = sandbox();
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }]);
  seedProjects(sb, ['a']);
  installExtension(sb, extensionContent(path.join(sb.root, 'gone')));
  const out = path.join(sb.root, 'omp.json');

  const result = await runAsync(sb, ['omp', 'a'], { OMP_BIN: FAKE_OMP, FAKE_OMP_OUT: out });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /points at a missing file/);
  assert.equal(fs.existsSync(out), false);
});

test('agy-crew omp accepts the extension installed as an omp plugin', async () => {
  const sb = sandbox();
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }]);
  seedProjects(sb, ['a']);
  const plugin = path.join(sb.home, '.omp', 'agent', 'plugins', 'node_modules', 'agy-crew', 'omp');
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(plugin, 'extension.mjs'), 'export default () => {};\n');
  const out = path.join(sb.root, 'omp.json');

  const result = await runAsync(sb, ['omp', 'a'], { OMP_BIN: FAKE_OMP, FAKE_OMP_OUT: out });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).account, 'a');
});
