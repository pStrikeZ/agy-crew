#!/usr/bin/env node
/**
 * Fake `agy` CLI used by the companion regression tests.
 *
 * Never touches the network. Two behaviours:
 *   --version  → print a version string and exit 0 (what `setup` probes)
 *   otherwise  → append the full argv (JSON array, one line) to
 *                $FAKE_AGY_ARGV_FILE and print a single-line JSON payload
 *                shaped like a real `agy --output-format json` result.
 *
 * Env knobs (all optional):
 *   FAKE_AGY_ARGV_FILE       where to record argv (JSONL)
 *   FAKE_AGY_RESPONSE        response text            (default "fake answer")
 *   FAKE_AGY_STATUS          status field             (default "SUCCESS")
 *   FAKE_AGY_CONVERSATION_ID conversation id          (default "conv-1")
 *   FAKE_AGY_SLEEP_MS        stall before answering   (default 0)
 *   FAKE_AGY_EXIT            process exit code        (default 0)
 *   FAKE_AGY_TOUCH_FILE      create this file mid-"run" (default: touch nothing)
 *                            — simulates agy dirtying the working tree, which
 *                            the review/research delta report must catch
 *   FAKE_AGY_STDERR          text written to stderr alongside the payload
 *                            (or before dying under FAKE_AGY_NO_JSON)
 *   FAKE_AGY_ERROR           payload `error` field (default: absent)
 *   FAKE_AGY_NO_JSON         die before printing any payload (default exit 1),
 *                            with FAKE_AGY_STDERR on stderr — simulates agy
 *                            being killed by a harness sandbox pre-JSON
 *   FAKE_AGY_ENV_FILE        append JSON {HOME, USERPROFILE, SSH_CONNECTION,
 *                            account_email} per invocation (email from the
 *                            token under $HOME) — pool isolation checks
 *   FAKE_AGY_LOGIN_EMAIL     login simulation (argv has --log-file, no -p):
 *                            write the file-token marker to the log and a token
 *                            for this email under $HOME; FAKE_AGY_LOGIN_FAIL=1
 *                            writes nothing and exits 1
 *   FAKE_AGY_QUOTA_EMAILS    comma list: runs whose $HOME token email is listed
 *                            answer ERROR / empty / RESOURCE_EXHAUSTED
 *                            (FAKE_AGY_QUOTA_AFTER_CONVERSATION=0 omits the
 *                            conversation id, to exercise failover)
 *   FAKE_AGY_REFRESH_TOKEN   mark the $HOME token as rewritten by this run
 *   FAKE_AGY_NEW_ACCESS_TOKEN  store this access_token in the $HOME token
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
if (process.env.FAKE_AGY_CWD_FILE) fs.writeFileSync(process.env.FAKE_AGY_CWD_FILE, process.cwd());

if (argv.includes('--version')) {
  process.stdout.write('1.1.13-fake\n');
  process.exit(0);
}

// Pool helpers: the account a run belongs to is whatever token lives in $HOME.
const homeDir = process.env.HOME || process.env.USERPROFILE || '';
const tokenFile = path.join(homeDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
function tokenEmail() {
  try {
    const json = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    const jwt = json.token?.id_token || json.id_token;
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')).email || null;
  } catch { return null; }
}
if (process.env.FAKE_AGY_ENV_FILE && !argv.includes('--version')) {
  try {
    fs.appendFileSync(process.env.FAKE_AGY_ENV_FILE, JSON.stringify({
      HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SSH_CONNECTION: process.env.SSH_CONNECTION,
      account_email: tokenEmail(),
    }) + '\n');
  } catch { /* recording is best-effort */ }
}

const logIndex = argv.indexOf('--log-file');
if (logIndex >= 0 && !argv.includes('-p')) {
  if (process.env.FAKE_AGY_LOGIN_FAIL === '1') process.exit(1);
  const email = process.env.FAKE_AGY_LOGIN_EMAIL || 'login@example.com';
  fs.writeFileSync(argv[logIndex + 1], 'Using file-based token storage\n');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, JSON.stringify({ token: {
    access_token: 'fake-access', expiry: new Date(Date.now() + 3600_000).toISOString(),
    id_token: `${b64({ alg: 'none' })}.${b64({ email })}.`,
  } }));
  process.exit(0);
}

const argvFile = process.env.FAKE_AGY_ARGV_FILE;
if (argvFile) {
  try {
    fs.appendFileSync(argvFile, JSON.stringify(argv) + '\n');
  } catch {
    /* recording is best-effort */
  }
}

if (argv[0] === 'models' || argv.includes('models')) {
  if (process.env.FAKE_AGY_MODELS_ERROR) {
    process.stderr.write(process.env.FAKE_AGY_MODELS_ERROR + '\n');
    process.exit(Number(process.env.FAKE_AGY_MODELS_EXIT || 1));
  }
  const defaultModels =
    process.env.FAKE_AGY_MODELS_OUTPUT ??
    [
      'Fetching available models...',
      'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
      'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
      'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
      'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
      'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)',
      'gemini-3.7-flash-low\tGemini 3.7 Flash (Low)',
      'gemini-3.6-flash-high\tGemini 3.6 Flash (High)',
      'gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)',
      'gemini-3.6-flash-low\tGemini 3.6 Flash (Low)',
      'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',
      'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
    ].join('\n');
  process.stdout.write(defaultModels + '\n');
  process.exit(0);
}

// Side effect knob: write a file while the "model" is working, i.e. strictly
// between the companion's before/after `git status --porcelain` snapshots.
const touch = process.env.FAKE_AGY_TOUCH_FILE;
if (touch) {
  const target = path.resolve(touch);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'written by fake agy\n');
}

const streaming = argv[argv.indexOf('--output-format') + 1] === 'stream-json';
if (streaming && !process.env.FAKE_AGY_NO_JSON) {
  process.stdout.write(JSON.stringify({ event: 'init', init: { conversation_id: process.env.FAKE_AGY_CONVERSATION_ID ?? 'conv-1' } }) + '\n');
  if (process.env.FAKE_AGY_EVENTS) {
    for (const event of JSON.parse(process.env.FAKE_AGY_EVENTS)) process.stdout.write(JSON.stringify(event) + '\n');
  }
}

if (process.env.FAKE_AGY_CHILD_PID_FILE) {
  const descendantCode = "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 30000); setInterval(() => {}, 1000)";
  if (process.env.FAKE_AGY_ORPHAN_RELEASE_FILE) {
    const intermediary = `const fs = require('fs'); const child = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], { detached: true, stdio: 'ignore' }); child.unref(); fs.writeFileSync(process.env.FAKE_AGY_CHILD_PID_FILE, String(child.pid)); setInterval(() => { if (fs.existsSync(process.env.FAKE_AGY_ORPHAN_RELEASE_FILE)) process.exit(0); }, 25);`;
    spawn(process.execPath, ['-e', intermediary], { stdio: 'ignore' });
  } else {
    const child = spawn(process.execPath, ['-e', descendantCode], { detached: !process.env.FAKE_AGY_INHERIT_STDIO, stdio: process.env.FAKE_AGY_INHERIT_STDIO ? ['ignore', 1, 2] : 'ignore' });
    fs.writeFileSync(process.env.FAKE_AGY_CHILD_PID_FILE, String(child.pid));
  }
}
if (process.env.FAKE_AGY_IGNORE_TERM) process.on('SIGTERM', () => {});

const sleepMs = Number(process.env.FAKE_AGY_SLEEP_MS || 0);
if (sleepMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, sleepMs));
}
if (process.env.FAKE_AGY_RELEASE_FILE) {
  while (!fs.existsSync(process.env.FAKE_AGY_RELEASE_FILE)) await new Promise(resolve => setTimeout(resolve, 25));
}

// Crash knob: emulate agy dying before it can print JSON (e.g. blocked by a
// harness sandbox). Writes FAKE_AGY_STDERR to stderr, prints no payload.
if (process.env.FAKE_AGY_NO_JSON) {
  if (process.env.FAKE_AGY_STDOUT) process.stdout.write(process.env.FAKE_AGY_STDOUT + '\n');
  if (process.env.FAKE_AGY_STDERR) process.stderr.write(process.env.FAKE_AGY_STDERR + '\n');
  process.exit(Number(process.env.FAKE_AGY_EXIT || 1));
}

const quotaEmails = (process.env.FAKE_AGY_QUOTA_EMAILS || '').split(',').filter(Boolean);
const quotaHit = quotaEmails.length > 0 && quotaEmails.includes(tokenEmail());
const withConversation = process.env.FAKE_AGY_QUOTA_AFTER_CONVERSATION !== '0';
// Token refresh simulation: a real agy rewrites its token file while it runs.
if (!quotaHit && fs.existsSync(tokenFile) && (process.env.FAKE_AGY_REFRESH_TOKEN || process.env.FAKE_AGY_NEW_ACCESS_TOKEN)) {
  const json = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  if (process.env.FAKE_AGY_REFRESH_TOKEN) json.refreshed_by_run = true;
  if (process.env.FAKE_AGY_NEW_ACCESS_TOKEN) json.token.access_token = process.env.FAKE_AGY_NEW_ACCESS_TOKEN;
  fs.writeFileSync(tokenFile, JSON.stringify(json));
}
const payload = {
  status: process.env.FAKE_AGY_STATUS || 'SUCCESS',
  response: process.env.FAKE_AGY_RESPONSE ?? 'fake answer',
  conversation_id: process.env.FAKE_AGY_CONVERSATION_ID ?? 'conv-1',
  duration_seconds: 1,
  num_turns: 1,
  usage: { input_tokens: 1, output_tokens: 1 },
};
if (process.env.FAKE_AGY_ERROR) payload.error = process.env.FAKE_AGY_ERROR;
if (quotaHit) {
  payload.status = 'ERROR';
  payload.response = '';
  payload.error = 'RESOURCE_EXHAUSTED: Individual quota reached. Resets in 2h3m.';
  if (!withConversation) delete payload.conversation_id;
}

if (process.env.FAKE_AGY_STDERR) process.stderr.write(process.env.FAKE_AGY_STDERR + '\n');
await new Promise((resolve) => process.stdout.write(JSON.stringify(streaming ? { event: 'result', result: payload } : payload) + '\n', resolve));
if (process.env.FAKE_AGY_RESULT_FILE) fs.writeFileSync(process.env.FAKE_AGY_RESULT_FILE, 'result sent');
if (process.env.FAKE_AGY_AFTER_RESULT_MS) await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_AGY_AFTER_RESULT_MS)));
process.exit(Number(process.env.FAKE_AGY_EXIT || 0));
