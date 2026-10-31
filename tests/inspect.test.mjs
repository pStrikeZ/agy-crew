/**
 * `inspect`: the live human-readable view of a job's event stream.
 * The renderer is pure; the command is checked end to end against fake agy.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer, footer } from '../companion/inspect.mjs';
import { sandbox, run, jobIdOf, waitForJob } from './helpers.mjs';

const step = (index, type, state, extra = {}) => ({ event: 'step_update', step_update: { conversation_id: 'c', step_index: index, step_type: type, state, ...extra } });

describe('renderer', () => {
  test('tool start, finish and failure each get one line', () => {
    const r = createRenderer();
    assert.deepEqual(r.accept(step(2, 'tool', 'ACTIVE', { tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'git status' } } })),
      ['▶ run_command  {"CommandLine":"git status"}']);
    assert.deepEqual(r.accept(step(2, 'tool', 'DONE', { duration_seconds: 0.057, tool_info: { output: 'clean\r\n' } })),
      ['✓ run_command 0.1s  clean']);
    r.accept(step(3, 'tool', 'ACTIVE', { tool_name: 'view_file' }));
    const [line] = r.accept(step(3, 'tool', 'DONE', { tool_info: { error: 'no such file' } }));
    assert.match(line, /^✗ view_file/);
    assert.equal(r.stats.tools, 2);
    assert.equal(r.stats.errors, 1);
  });

  test('response text deltas are joined across events and emitted per line', () => {
    const r = createRenderer();
    assert.deepEqual(r.accept(step(5, 'agent_response', 'ACTIVE', { text_delta: 'Hel' })), []);
    assert.deepEqual(r.accept(step(5, 'agent_response', 'ACTIVE', { text_delta: 'lo\nwor' })), ['Hello']);
    assert.deepEqual(r.accept(step(5, 'agent_response', 'DONE', { text_delta: 'ld' })), ['world']);
  });

  test('an open text fragment is flushed before the next tool line', () => {
    const r = createRenderer();
    r.accept(step(5, 'agent_response', 'ACTIVE', { text_delta: 'thinking' }));
    assert.deepEqual(r.accept(step(6, 'tool', 'ACTIVE', { tool_name: 'grep' })), ['thinking', '▶ grep']);
  });

  test('usage is counted once per step; unknown events are ignored', () => {
    const r = createRenderer();
    const usage = { input_tokens: 10, output_tokens: 2 };
    r.accept(step(1, 'agent_response', 'ACTIVE', { usage }));
    r.accept(step(1, 'agent_response', 'DONE', { usage }));
    assert.deepEqual(r.accept({ event: 'mystery' }), []);
    assert.equal(r.stats.input_tokens, 10);
    assert.equal(r.stats.output_tokens, 2);
  });

  test('footer reports status, counters and the last tool while running', () => {
    const r = createRenderer();
    r.accept(step(2, 'tool', 'ACTIVE', { tool_name: 'grep' }));
    const job = { id: 'j1', model: 'm', started_at: new Date(0).toISOString() };
    const text = footer({ job, status: 'running', stats: r.stats, now: 65_000 });
    assert.match(text, /running {2}j1 {2}m {2}1m05s {2}1 tools.*last grep/);
  });
});

describe('inspect command', () => {
  test('follows a running job to its end and exits with the job code', async () => {
    const sb = sandbox('inspect-follow');
    const events = [
      step(2, 'tool', 'ACTIVE', { tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'ls' } } }),
      step(2, 'tool', 'DONE', { tool_info: { output: 'a.txt' } }),
    ];
    const started = run(sb, ['research', '--prompt', 'a topic'], { FAKE_AGY_EVENTS: JSON.stringify(events), FAKE_AGY_SLEEP_MS: '600' });
    const id = jobIdOf(started.stdout);
    const view = run(sb, ['inspect', id]);
    assert.equal(view.code, 0, view.stderr);
    assert.match(view.stdout, /▶ run_command {2}\{"CommandLine":"ls"\}/);
    await waitForJob(sb, id);
  });

  test('--no-follow prints what exists and unknown jobs fail', () => {
    const sb = sandbox('inspect-nofollow');
    assert.equal(run(sb, ['inspect', 'no-such-job']).code, 1);
    assert.equal(run(sb, ['inspect', '--no-follow']).code, 1, 'no jobs recorded');
  });
});
