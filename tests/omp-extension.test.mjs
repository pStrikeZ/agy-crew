import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { globalHomeOf, accountHomeOf, seedPool } from './pool-helpers.mjs';
import { sandbox } from './helpers.mjs';

const EXT = pathToFileURL(path.join(import.meta.dirname, '..', 'omp', 'extension.mjs')).href;
const BLOCK0 = `§ Role
You are omp's trusted coding assistant.

# Engineering
- Keep the tool policy.`;

async function load(tag) {
  delete globalThis[Symbol.for('agy-crew.omp.extension')];
  return import(`${EXT}?${tag}`);
}

test('the extension is inert without AGY_CREW_OMP_ACCOUNT', async () => {
  delete process.env.AGY_CREW_OMP_ACCOUNT;
  const { default: init } = await load('inert');
  let registered = 0;
  let provider = 0;
  init({ on() { registered++; }, registerProvider() { provider++; }, logger: { warn() {} } });
  assert.equal(provider, 0);
  assert.equal(registered, 0);
});

test('with the launcher env, block 0 loses the omp role and gains identity', async () => {
  process.env.AGY_CREW_OMP_ACCOUNT = 'a';
  const { default: init } = await load('active');
  const handlers = new Map();
  const providers = [];
  init({ on(name, fn) { handlers.set(name, fn); }, registerProvider(name, config) { providers.push({ name, config }); }, logger: { warn() {} } });
  assert.equal(providers[0].name, 'google-antigravity');
  assert.ok(providers[0].config.oauth);

  const ctx = { model: { provider: 'google-antigravity' }, modelRegistry: { authStorage: null }, sessionManager: { getSessionId: () => 's1' } };
  const result = await handlers.get('before_agent_start')({ systemPrompt: [BLOCK0] }, ctx);
  assert.ok(result.systemPrompt[0].startsWith('You are Antigravity, a powerful agentic AI coding assistant'));
  assert.doesNotMatch(result.systemPrompt[0], /You are omp's trusted coding assistant/);
  assert.match(result.systemPrompt[0], /Keep the tool policy/);

  const payload = { userAgent: 'antigravity', request: { systemInstruction: { parts: [{ text: 'tool policy' }] } } };
  const replaced = handlers.get('before_provider_request')({ payload }, ctx);
  assert.equal(replaced.request.systemInstruction.parts.length, 1);
  assert.ok(replaced.request.systemInstruction.parts[0].text.startsWith('You are Antigravity'));
  assert.match(replaced.request.systemInstruction.parts[0].text, /tool policy/);
});

test('session_start installs the selected account as the runtime key', async () => {
  const sb = sandbox();
  seedPool(sb, [{ name: 'a', email: 'a@example.com' }]);
  const project = path.join(accountHomeOf(sb, 'a'), '.gemini', 'antigravity-cli', 'cache', 'default_project_id.txt');
  fs.mkdirSync(path.dirname(project), { recursive: true });
  fs.writeFileSync(project, 'project-a');

  process.env.AGY_CREW_HOME = globalHomeOf(sb);
  process.env.AGY_CREW_OMP_ACCOUNT = 'a';
  const { default: init } = await load('session');
  const handlers = new Map();
  const providers = [];
  init({ on(name, fn) { handlers.set(name, fn); }, registerProvider(name, config) { providers.push({ name, config }); }, logger: { warn() {} } });
  assert.equal(providers[0].name, 'google-antigravity');
  assert.ok(providers[0].config.oauth);

  const runtime = [];
  const auth = { keys: { setRuntime: (provider, key) => runtime.push({ provider, key }) } };
  const ctx = { model: { provider: 'google-antigravity' }, modelRegistry: { authStorage: auth } };
  await handlers.get('session_start')({}, ctx);

  assert.equal(runtime.length, 1);
  assert.equal(runtime[0].provider, 'google-antigravity');
  const key = JSON.parse(runtime[0].key);
  assert.equal(key.projectId, 'project-a');
  assert.equal(key.email, 'a@example.com');
  assert.equal(key.refreshToken, 'fake-refresh');
});

test('provider hook sanitizes tool declarations even when identity is already present', async () => {
  process.env.AGY_CREW_OMP_ACCOUNT = 'a';
  const { default: init } = await load('tools');
  const handlers = new Map();
  const providers = [];
  init({ on(name, fn) { handlers.set(name, fn); }, registerProvider(name, config) { providers.push({ name, config }); }, logger: { warn() {} } });
  assert.equal(providers[0].name, 'google-antigravity');
  assert.ok(providers[0].config.oauth);
  const ctx = { model: { provider: 'google-antigravity' }, modelRegistry: { authStorage: null }, sessionManager: { getSessionId: () => 's1' } };

  const payload = {
    userAgent: 'antigravity',
    request: {
      systemInstruction: { parts: [{ text: 'You are Antigravity, a powerful agentic AI coding assistant. body' }] },
      tools: [{
        functionDeclarations: [{
          name: 'glob',
          description: 'internal URLs (`local://*.md`, `omp://**/*.md`)',
          parameters: { type: 'object', properties: { path: { type: 'string', description: 'or `omp://x`' } } },
        }],
      }],
    },
  };
  const replaced = handlers.get('before_provider_request')({ payload }, ctx);
  assert.ok(replaced, 'tools changed even though identity was present');
  const declaration = replaced.request.tools[0].functionDeclarations[0];
  assert.equal(declaration.description, 'internal URLs (`local://*.md`)');
  assert.equal(declaration.parameters.properties.path.description, 'or ');
  assert.equal(replaced.request.systemInstruction.parts[0].text, payload.request.systemInstruction.parts[0].text);
});
