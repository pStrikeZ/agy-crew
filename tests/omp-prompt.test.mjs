import test from 'node:test';
import assert from 'node:assert/strict';
import { IDENTITY_SENTINEL, identityText, sanitizeOmpUrlText, sanitizeTools, stripOmpRole, transformBlock0 } from '../omp/prompt.mjs';

const BLOCK0 = `RFC 2119 keywords: MUST, REQUIRED, SHOULD.

§ Role
You are omp's trusted coding assistant.

# Engineering
- Correctness, then six-month maintainability.
- Visuals: first fit wins.

# Internal URLs
- \`cfg://\`: omp settings; ONLY when asked.
- \`omp://\`: harness docs, AVOID unless asked.
- \`skill://<name>\`: instructions; append /<path>.`;

test('identityText renders the pair-programming and autonomous branches', () => {
  const pair = identityText();
  assert.match(pair, /^You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding\./);
  assert.match(pair, /You are pair programming with a USER/);
  assert.doesNotMatch(pair, /not available to respond/);

  const autonomous = identityText({ autonomous: true });
  assert.match(autonomous, /You are working for a USER/);
  assert.match(autonomous, /The USER is not available to respond to questions or requests for approval\. Work autonomously\./);
});

test('stripOmpRole removes only the role sentence and its heading', () => {
  const stripped = stripOmpRole(BLOCK0);
  assert.doesNotMatch(stripped, /You are omp's trusted coding assistant/);
  assert.doesNotMatch(stripped, /§ Role/);
  assert.match(stripped, /# Engineering/);
  assert.match(stripped, /Correctness, then six-month maintainability/);
  assert.doesNotMatch(stripped, /`cfg:\/\/`/);
  assert.doesNotMatch(stripped, /`omp:\/\/`/);
  assert.match(stripped, /`skill:\/\/<name>`/);
});

test('transformBlock0 prepends identity, keeps tool text, and is idempotent', () => {
  const once = transformBlock0(BLOCK0);
  assert.ok(once.startsWith(IDENTITY_SENTINEL));
  assert.doesNotMatch(once, /You are omp's trusted coding assistant/);
  assert.match(once, /# Engineering/);
  assert.match(once, /Visuals: first fit wins/);
  assert.match(once, /`skill:\/\/<name>`/);
  assert.doesNotMatch(once, /`cfg:\/\/`/);
  assert.doesNotMatch(once, /`omp:\/\/`/);

  const twice = transformBlock0(once);
  assert.equal(twice, once);
  assert.equal(twice.match(/You are Antigravity, a powerful agentic AI coding assistant/g).length, 1);
});

test('sanitizeOmpUrlText removes omp:// examples but keeps other schemes', () => {
  assert.equal(
    sanitizeOmpUrlText('internal URLs (`local://*.md`, `omp://**/*.md`)'),
    'internal URLs (`local://*.md`)',
  );
  assert.equal(
    sanitizeOmpUrlText('internal URL (`omp://`, `omp://<file>.md`, `skill://<name>`, `local://…`)'),
    'internal URL (`skill://<name>`, `local://…`)',
  );
  assert.equal(sanitizeOmpUrlText('plain omp://docs/models.md link'), 'plain  link');
});

test('sanitizeTools rewrites descriptions and parameter schemas only', () => {
  const tools = [{
    functionDeclarations: [{
      name: 'glob',
      description: 'internal URLs (`local://*.md`, `omp://**/*.md`)',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'host path or `omp://x`' } },
      },
    }],
  }];
  const cleaned = sanitizeTools(tools);
  assert.equal(cleaned[0].functionDeclarations[0].description, 'internal URLs (`local://*.md`)');
  assert.equal(cleaned[0].functionDeclarations[0].parameters.properties.path.description, 'host path or ');
  assert.equal(cleaned[0].functionDeclarations[0].name, 'glob');
});
