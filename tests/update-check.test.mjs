import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandbox, run } from './helpers.mjs';
import {
  UPDATE_CHECK_INTERVAL_MS,
  checkForUpdate,
  compareVersions,
  isHarnessInvocation,
  isInteractiveUpdateCheck,
  maybeNotifyUpdate,
  readUpdateCache,
  updateNotice,
} from '../companion/update-check.mjs';

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const cacheFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-crew-update-')), 'update-check.json');
const response = (version) => async () => ({ ok: true, json: async () => ({ version }) });

test('semver comparison orders releases and prereleases', () => {
  assert.equal(compareVersions('0.9.13', '0.9.12'), 1);
  assert.equal(compareVersions('0.9.12', '0.9.12'), 0);
  assert.equal(compareVersions('v0.9.13', '0.9.12'), 1);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.11'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-beta'), 1);
  assert.equal(compareVersions('not-a-version', '1.0.0'), null);
});

test('a notice is produced only when the registry version is newer', () => {
  assert.match(updateNotice('0.9.12', '0.9.13'), /agy-crew 0\.9\.13 is available/);
  assert.match(updateNotice('0.9.12', '0.9.13'), /npm install -g agy-crew@latest/);
  assert.equal(updateNotice('0.9.12', '0.9.12'), null);
  assert.equal(updateNotice('0.9.12', '0.9.11'), null);
  assert.equal(updateNotice('0.9.12', '0.9.12-beta.1'), null);
});

test('the interactive gate accepts start, inspect, and human account tables', () => {
  const tty = { stdinIsTTY: true, stdoutIsTTY: true, env: {} };
  assert.equal(isInteractiveUpdateCheck('start', [], tty), true);
  assert.equal(isInteractiveUpdateCheck('inspect', [], tty), true);
  assert.equal(isInteractiveUpdateCheck('inspect', ['--plain'], tty), false);
  assert.equal(isInteractiveUpdateCheck('inspect', ['--no-follow'], tty), false);
  assert.equal(isInteractiveUpdateCheck('accounts', ['list'], tty), true);
  assert.equal(isInteractiveUpdateCheck('accounts', ['quota'], tty), true);
  assert.equal(isInteractiveUpdateCheck('accounts', ['quota', '--refresh'], tty), true);
  assert.equal(isInteractiveUpdateCheck('accounts', ['list', '--json'], tty), false);

  // Agent skill commands never qualify, even in a terminal.
  for (const cmd of ['staffer', 'research', 'review', 'implement', 'ask', 'wait', 'status']) {
    assert.equal(isInteractiveUpdateCheck(cmd, [], tty), false, cmd);
  }
  assert.equal(isInteractiveUpdateCheck('accounts', [], tty), false);
  assert.equal(isInteractiveUpdateCheck('start', [], { ...tty, stdinIsTTY: false }), false);
  assert.equal(isInteractiveUpdateCheck('start', [], { ...tty, stdoutIsTTY: false }), false);
  assert.equal(isInteractiveUpdateCheck('start', [], { ...tty, env: { AGY_CREW_NO_UPDATE_CHECK: '1' } }), false);
});

test('known harness environments are excluded even on a TTY', () => {
  const tty = { stdinIsTTY: true, stdoutIsTTY: true };
  for (const marker of ['AGENT', 'CLAUDECODE', 'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'OMPCODE', 'PI_SESSION_ID', 'OPENCODE']) {
    const env = { [marker]: '1' };
    assert.equal(isHarnessInvocation(env), true, marker);
    assert.equal(isInteractiveUpdateCheck('accounts', ['list'], { ...tty, env }), false, marker);
    assert.equal(isInteractiveUpdateCheck('start', [], { ...tty, env }), false, marker);
  }
  assert.equal(isHarnessInvocation({}), false);
  assert.equal(isHarnessInvocation({ TERM_PROGRAM: 'vscode' }), false);
});

test('a fresh cache notifies without another registry request', async () => {
  const file = cacheFile();
  fs.writeFileSync(file, JSON.stringify({ checked_at: NOW - 1000, latest: '0.9.13' }));
  let calls = 0;

  const notice = await checkForUpdate({
    currentVersion: '0.9.12',
    file,
    now: NOW,
    fetchImpl: async () => { calls += 1; throw new Error('must not fetch'); },
  });

  assert.match(notice, /agy-crew 0\.9\.13 is available/);
  assert.equal(calls, 0);
  assert.equal(readUpdateCache(file).notified_version, '0.9.13');

  // A notice is shown once per discovered version, even while the cache is fresh.
  const again = await checkForUpdate({ currentVersion: '0.9.12', file, now: NOW + 1000, fetchImpl: response('0.9.14') });
  assert.equal(again, null);

  // The next day's check notifies again if the user still has not upgraded.
  const tomorrow = await checkForUpdate({
    currentVersion: '0.9.12', file, now: NOW + UPDATE_CHECK_INTERVAL_MS, fetchImpl: response('0.9.13'),
  });
  assert.match(tomorrow, /0\.9\.13/);
});

test('a stale cache fetches once and stores the latest version', async () => {
  const file = cacheFile();
  fs.writeFileSync(file, JSON.stringify({ checked_at: NOW - UPDATE_CHECK_INTERVAL_MS - 1, latest: '0.9.12' }));
  let calls = 0;

  const notice = await checkForUpdate({
    currentVersion: '0.9.12',
    file,
    now: NOW,
    fetchImpl: async () => { calls += 1; return (await response('0.9.13')()); },
  });

  assert.match(notice, /0\.9\.13/);
  assert.equal(calls, 1);
  const cache = readUpdateCache(file);
  assert.equal(cache.latest, '0.9.13');
  assert.equal(cache.checked_at, NOW);

  const second = await checkForUpdate({
    currentVersion: '0.9.12', file, now: NOW + 60_000,
    fetchImpl: async () => { calls += 1; return (await response('0.9.14')()); },
  });
  assert.equal(second, null);
  assert.equal(calls, 1, 'same-day checks do not hit the registry again');
});

test('an older or equal registry version produces no notice', async () => {
  const file = cacheFile();
  const notice = await checkForUpdate({
    currentVersion: '0.9.12', file, now: NOW, fetchImpl: response('0.9.12'),
  });
  assert.equal(notice, null);
  assert.equal(readUpdateCache(file).latest, '0.9.12');

  const older = await checkForUpdate({
    currentVersion: '0.9.12', file: cacheFile(), now: NOW, fetchImpl: response('0.9.11'),
  });
  assert.equal(older, null);
});

test('a failed registry request is silent and cached for the day', async () => {
  const file = cacheFile();
  let calls = 0;
  const failed = async () => { calls += 1; throw new Error('offline'); };

  const notice = await checkForUpdate({ currentVersion: '0.9.12', file, now: NOW, fetchImpl: failed });
  assert.equal(notice, null);
  assert.equal(calls, 1);
  assert.equal(readUpdateCache(file).checked_at, NOW);

  const second = await checkForUpdate({ currentVersion: '0.9.12', file, now: NOW + 60_000, fetchImpl: failed });
  assert.equal(second, null);
  assert.equal(calls, 1, 'the failed attempt still counts as the daily check');
});

test('a hanging registry request times out without affecting the command', async () => {
  const file = cacheFile();
  const hanging = (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  });

  const notice = await checkForUpdate({
    currentVersion: '0.9.12', file, now: NOW, fetchImpl: hanging, timeoutMs: 20,
  });
  assert.equal(notice, null);
  assert.equal(readUpdateCache(file).checked_at, NOW);
});

test('maybeNotifyUpdate prints to the supplied stderr and never throws', async () => {
  let output = '';
  const stderr = { write: (text) => { output += text; } };
  await maybeNotifyUpdate({
    currentVersion: '0.9.12', file: cacheFile(), now: NOW,
    fetchImpl: response('0.9.13'), stderr,
  });
  assert.match(output, /agy-crew 0\.9\.13 is available/);

  output = '';
  await maybeNotifyUpdate({
    currentVersion: '0.9.12', file: cacheFile(), now: NOW,
    fetchImpl: async () => { throw new Error('offline'); }, stderr,
  });
  assert.equal(output, '');
});

test('a non-interactive agent command never creates the update cache', () => {
  const sb = sandbox('update-noninteractive');
  const result = run(sb, ['status']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(sb.home, '.agy-crew', 'update-check.json')), false);
  assert.doesNotMatch(result.stderr, /is available \(current /);
});
