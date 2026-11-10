import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPool, runAsync, seedPool } from './pool-helpers.mjs';
import { sandbox } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_OMP = path.join(HERE, 'fake-omp.mjs');

test('agy-crew omp holds the named account and passes omp args through', async () => {
  const sb = sandbox();
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }, { name: 'b', email: 'b@example.com' }]);
  const out = path.join(sb.root, 'omp.json');

  const result = await runAsync(
    sb,
    ['omp', '--account', 'a', '--', '--model', 'google-antigravity/gemini-3.8-flash'],
    { OMP_BIN: FAKE_OMP, FAKE_OMP_OUT: out },
  );

  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(payload.account, 'a');
  assert.equal(payload.family, 'gemini-3.8-flash');
  assert.equal(payload.holds, 1, 'the account is held while omp runs');
  assert.deepEqual(payload.argv, ['--model', 'google-antigravity/gemini-3.8-flash']);
  assert.equal(readPool(sb).leases.filter((lease) => lease.role === 'hold').length, 0, 'hold is released on exit');
});

test('agy-crew omp auto chooses an idle pool account', async () => {
  const sb = sandbox();
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }, { name: 'b', email: 'b@example.com' }]);
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
  const result = await runAsync(sb, ['omp', '--account', 'missing'], { OMP_BIN: FAKE_OMP });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown account "missing"/);
});
