import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OmpCredentialError, readOmpCredential, readOmpCredentialCached } from '../omp/credential.mjs';
import { accountHomeOf, globalHomeOf, seedPool, tokenFileOf, tokenJson } from './pool-helpers.mjs';
import { sandbox } from './helpers.mjs';

const PROJECT = 'cloud-code-project';

function useSandboxHome(sb) {
  const previous = process.env.AGY_CREW_HOME;
  process.env.AGY_CREW_HOME = globalHomeOf(sb);
  return () => {
    if (previous === undefined) delete process.env.AGY_CREW_HOME;
    else process.env.AGY_CREW_HOME = previous;
  };
}

function writeProject(sb, name) {
  const file = path.join(accountHomeOf(sb, name), '.gemini', 'antigravity-cli', 'cache', 'default_project_id.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PROJECT);
}

test('readOmpCredential maps access, refresh, expiry, email and project', async () => {
  const sb = sandbox();
  const restore = useSandboxHome(sb);
  try {
    seedPool(sb, [{ name: 'a', email: 'a@example.com' }]);
    writeProject(sb, 'a');
    const credential = await readOmpCredential('a');
  assert.equal(readOmpCredentialCached('a').projectId, PROJECT);
  assert.equal(credential.type, 'oauth');
  assert.equal(credential.access, 'fake-access');
  assert.equal(credential.refresh, 'fake-refresh');
  assert.equal(credential.email, 'a@example.com');
  assert.equal(credential.projectId, PROJECT);
    assert.ok(credential.expires > Date.now());
  } finally { restore(); }
});

test('readOmpCredential refuses a token without a refresh token', async () => {
  const sb = sandbox();
  const restore = useSandboxHome(sb);
  try {
    seedPool(sb, [{ name: 'a', email: 'a@example.com' }]);
    writeProject(sb, 'a');
    const token = tokenJson('a@example.com').token;
    delete token.refresh_token;
    fs.writeFileSync(tokenFileOf(sb, 'a'), JSON.stringify({ token }));
    await assert.rejects(() => readOmpCredential('a'), OmpCredentialError);
  } finally { restore(); }
});

test('readOmpCredential refuses an account without an email identity', async () => {
  const sb = sandbox();
  const restore = useSandboxHome(sb);
  try {
    seedPool(sb, [{ name: 'a', email: null }]);
    writeProject(sb, 'a');
    const json = tokenJson('a@example.com');
    delete json.token.id_token;
    fs.writeFileSync(tokenFileOf(sb, 'a'), JSON.stringify(json));
    await assert.rejects(() => readOmpCredential('a'), /no email identity/);
  } finally { restore(); }
});

test('readOmpCredential caches a discovered project for synchronous registration', async () => {
  const sb = sandbox();
  const restore = useSandboxHome(sb);
  try {
    seedPool(sb, [{ name: 'a', email: 'a@example.com' }]);
    const credential = await readOmpCredential('a', {
      fetchImpl: async () => ({ ok: true, json: async () => ({ cloudaicompanionProject: { id: 'discovered-project' } }) }),
    });
    assert.equal(credential.projectId, 'discovered-project');
    assert.equal(readOmpCredentialCached('a').projectId, 'discovered-project');
  } finally { restore(); }
});
