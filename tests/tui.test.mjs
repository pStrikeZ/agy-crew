/**
 * Full-screen `inspect`: wrapping, frame layout, key handling and the run loop
 * (driven through fake terminal streams and real event files).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { wrapAnsi, visibleWidth, renderFrame, handleKey, parseKeys, runTui, tabLabel } from '../companion/tui.mjs';

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const view = (id, mode, lines = [], status = 'running') => ({
  job: { id, mode, model: 'm', started_at: new Date(0).toISOString() }, status, lines, scroll: 0,
  renderer: { stats: { tools: 0, errors: 0, input_tokens: 0, output_tokens: 0, last_tool: null } },
});

describe('wrapping', () => {
  test('wide characters count two cells and colour survives a wrap', () => {
    assert.equal(visibleWidth('中文ab'), 6);
    const rows = wrapAnsi('\x1b[31m' + 'x'.repeat(10) + '\x1b[0m', 4);
    assert.deepEqual(rows.map(plain), ['xxxx', 'xxxx', 'xx']);
    assert.ok(rows[1].startsWith('\x1b[31m'), 'second row re-applies the colour');
    assert.deepEqual(wrapAnsi('', 5), ['']);
    assert.deepEqual(wrapAnsi('中中中', 5).map(plain), ['中中', '中']);
  });
});

describe('frame', () => {
  test('tabs, content tail, status and hints fill exactly rows × cols', () => {
    const state = { views: [view('research-aaa-1111', 'research', ['one', 'two', 'three']), view('implement-bbb-2222', 'implement')], active: 1 };
    const frame = renderFrame(state, 80, 8);
    assert.equal(frame.length, 8);
    assert.ok(frame.every((row) => visibleWidth(row) === 80), 'no row over or under width');
    assert.match(plain(frame[0]), /0 jobs.*1 research·1111 ●.*2 implement·2222 ●/);
    assert.deepEqual(frame.slice(1, 4).map((r) => plain(r).trim()), ['one', 'two', 'three']);
    assert.match(plain(frame[6]), /running {2}research-aaa-1111/);
    assert.match(plain(frame[7]), /q quit/);
  });

  test('only the newest rows show, and scrolling back moves the window', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const state = { views: [view('j-a-b', 'research', lines)], active: 1 };
    assert.equal(plain(renderFrame(state, 40, 8)[5]).trim(), 'line 19');
    handleKey(state, '\x1b[5~');
    const back = renderFrame(state, 40, 8);
    assert.equal(plain(back[5]).trim(), 'line 15');
    assert.match(plain(back[7]), /scrolled back 4/);
    handleKey(state, 'G');
    assert.equal(plain(renderFrame(state, 40, 8)[5]).trim(), 'line 19');
    handleKey(state, 'g');
    renderFrame(state, 40, 8);
    assert.equal(plain(renderFrame(state, 40, 8)[1]).trim(), 'line 0', 'clamped to the top');
  });

  test('many tabs slide so the active one stays visible', () => {
    const views = Array.from({ length: 12 }, (_, i) => view(`research-x-${String(i).padStart(4, '0')}`, 'research'));
    const state = { views, active: 12 };
    assert.match(plain(renderFrame(state, 40, 6)[0]), /12 research·0011/);
  });

  test('no jobs yet shows a waiting message', () => {
    assert.match(plain(renderFrame({ views: [], active: 0, rows: [] }, 60, 6)[1]), /No tasks currently running/);
  });
});

describe('overview and keys', () => {
  const row = (id, status) => ({ job: { id, mode: id.split('-')[0], model: 'gemini', started_at: new Date(0).toISOString(), finished_at: new Date(5000).toISOString() }, status });

  test('idle overview says so and still lists recent jobs to pick from', () => {
    const state = { views: [], active: 0, cursor: 1, known: new Map(),
      rows: [row('research-a-aaaa1111', 'done'), row('review-b-bbbb2222', 'error')] };
    const frame = renderFrame(state, 80, 10).map(plain);
    assert.match(frame[1], /No tasks currently running/);
    assert.match(frame[3], /research·aaaa .*done/);
    assert.match(frame[4], /^▸.*review·bbbb .*error/, 'cursor marks the selected row');
    assert.match(frame[8], /0 running {2}2 recent/);
  });

  test('parse escape sequences whole; switch, jump and quit', () => {
    assert.deepEqual(parseKeys('\x1b[C\t1q'), ['\x1b[C', '\t', '1', 'q']);
    const state = { views: [view('a-b-c', 'research'), view('d-e-f', 'review'), view('g-h-i', 'implement')], active: 1, rows: [] };
    handleKey(state, '\t'); assert.equal(state.active, 2);
    handleKey(state, '0'); assert.equal(state.active, 0, '0 is the jobs page');
    handleKey(state, '\x1b[Z'); assert.equal(state.active, 3, 'wraps backwards');
    handleKey(state, '1'); assert.equal(state.active, 1);
    handleKey(state, '9'); assert.equal(state.active, 1, 'out of range ignored');
    assert.equal(handleKey(state, 'q'), 'quit');
    assert.equal(handleKey(state, '\x03'), 'quit');
    assert.equal(tabLabel({ mode: 'review', id: 'review-m1-abcdef12' }), 'review·abcd');
  });

  test('on the overview arrows move the cursor and Enter asks to open that job', () => {
    const state = { views: [], active: 0, cursor: 0, rows: [row('a-1-aaaa', 'done'), row('b-2-bbbb', 'done'), row('c-3-cccc', 'done')] };
    handleKey(state, 'j'); handleKey(state, '\x1b[B');
    assert.equal(state.cursor, 2);
    handleKey(state, '\x1b[A'); assert.equal(state.cursor, 1);
    handleKey(state, '\r');
    assert.equal(state.open.id, 'b-2-bbbb');
  });

  test('x closes the tab and remembers it so a running job does not reopen', () => {
    const state = { views: [view('a-b-c', 'research'), view('d-e-f', 'review')], active: 2, known: new Map([['d-e-f', 1]]), closed: new Set(), rows: [] };
    handleKey(state, 'x');
    assert.equal(state.views.length, 1);
    assert.equal(state.active, 1);
    assert.ok(state.closed.has('d-e-f'));
    assert.equal(state.known.has('d-e-f'), false);
  });
});

describe('mouse', () => {
  const wheelUp = '\x1b[<64;10;5M', wheelDown = '\x1b[<65;10;5M';
  const click = (x, y) => `\x1b[<0;${x};${y}M`;
  const row = (id) => ({ job: { id, mode: id.split('-')[0], model: 'm', started_at: new Date(0).toISOString() }, status: 'done' });

  test('SGR reports stay whole when parsed', () => {
    assert.deepEqual(parseKeys(wheelUp + click(3, 1) + 'q'), [wheelUp, click(3, 1), 'q']);
  });

  test('wheel scrolls a job tab 3 lines at a time and never below the live edge', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const state = { views: [view('j-a-b', 'research', lines)], active: 1, mouse: true };
    renderFrame(state, 40, 8);
    handleKey(state, wheelUp);
    assert.equal(state.views[0].scroll, 3);
    handleKey(state, wheelDown); handleKey(state, wheelDown);
    assert.equal(state.views[0].scroll, 0);
  });

  test('wheel moves the selection on the jobs page', () => {
    const state = { views: [], active: 0, cursor: 5, rows: Array.from({ length: 8 }, (_, i) => row(`r-${i}-xxxx`)) };
    handleKey(state, wheelUp); assert.equal(state.cursor, 2);
    handleKey(state, wheelDown); handleKey(state, wheelDown); assert.equal(state.cursor, 7, 'clamped to the last row');
  });

  test('clicking a tab switches to it; clicking a job row opens that job', () => {
    const state = { views: [view('research-a-aaaa', 'research'), view('review-b-bbbb', 'review')], active: 1, mouse: true,
      rows: [row('research-a-aaaa'), row('review-b-bbbb')], cursor: 0 };
    renderFrame(state, 80, 12);
    const second = state.tabHits.find((t) => t.index === 2);
    handleKey(state, click(second.from + 1, 1));
    assert.equal(state.active, 2);
    handleKey(state, click(0 + state.tabHits[0].from, 1));
    assert.equal(state.active, 0);
    renderFrame(state, 80, 12);
    handleKey(state, click(5, state.listTop + 1 + 1));   // second job row, 1-based screen row
    assert.equal(state.open.id, 'review-b-bbbb');
    assert.equal(state.cursor, 1);
    state.open = null;
    handleKey(state, click(5, 1 + 1 - 0));               // header text rows are not clickable
    assert.equal(state.open, null);
  });

  test('releases and motion are ignored; m toggles and the hint says which', () => {
    const state = { views: [], active: 0, rows: [], mouse: true };
    handleKey(state, '\x1b[<0;3;1m');
    assert.equal(state.active, 0);
    assert.match(plain(renderFrame(state, 80, 8)[7]), /m mouse on/);
    handleKey(state, 'm');
    assert.equal(state.mouse, false);
    assert.match(plain(renderFrame(state, 80, 8)[7]), /m mouse off/);
  });
});

describe('run loop', () => {
  const fakeTerm = () => {
    const out = new EventEmitter();
    out.isTTY = true; out.columns = 70; out.rows = 12; out.written = '';
    out.write = (s) => { out.written += s; return true; };
    const input = new EventEmitter();
    input.isTTY = true; input.raw = false;
    input.setRawMode = (v) => { input.raw = v; };
    input.resume = () => {}; input.pause = () => {};
    return { out, input };
  };

  test('opens a tab per running job, picks up new jobs and output, restores the terminal on q', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-'));
    const tool = (i, state, extra = {}) => JSON.stringify({ event: 'step_update', step_update: { step_index: i, step_type: 'tool', state, tool_name: 'grep', ...extra } }) + '\n';
    const job = (id, status) => ({ id, mode: id.split('-')[0], model: 'm', status, started_at: new Date().toISOString(), events_file: path.join(dir, `${id}.events.jsonl`) });
    const jobs = [job('research-1-aaaa1111', 'running'), job('research-0-done0000', 'done')];
    fs.writeFileSync(jobs[0].events_file, tool(2, 'ACTIVE', { tool_info: { parameters: { q: 'needle' } } }));
    const { out, input } = fakeTerm();
    const finished = runTui({ listJobs: () => jobs, getStatus: (j) => j.status, out, input, pollMs: 20 });
    try {
    assert.equal(input.raw, true);
    assert.match(out.written, /\x1b\[\?1049h/, 'alternate screen entered');
    await new Promise((r) => setTimeout(r, 80));
    assert.match(plain(out.written), /needle/);
    assert.doesNotMatch(plain(out.written), /2 research·done/, 'finished jobs are not opened as tabs unasked');
    input.emit('data', Buffer.from('0'));
    await new Promise((r) => setTimeout(r, 40));
    assert.match(plain(out.written), /research·done.*done/, 'but they are listed on the jobs page');
    input.emit('data', Buffer.from('1'));

    jobs.push(job('implement-2-bbbb2222', 'running'));
    fs.appendFileSync(jobs[0].events_file, tool(2, 'DONE', { duration_seconds: 1, tool_info: { output: 'hit' } }));
    await new Promise((r) => setTimeout(r, 80));
    assert.match(plain(out.written), /2 implement·bbbb/, 'new running job joins as a tab');
    assert.match(plain(out.written), /✓ grep/);

    } finally { input.emit('data', Buffer.from('q')); }
    await finished;
    assert.equal(input.raw, false);
    assert.match(out.written, /\x1b\[\?25h\x1b\[\?1049l$/, 'cursor and screen restored');
  });

  test('a finished job with no stream explains itself', async () => {
    const { out, input } = fakeTerm();
    const j = { id: 'research-9-cccc3333', mode: 'research', model: 'm', status: 'done', started_at: new Date().toISOString(), events_file: '/nonexistent/x.jsonl' };
    const finished = runTui({ listJobs: () => [j], getStatus: (x) => x.status, focus: j.id, out, input, pollMs: 20 });
    await new Promise((r) => setTimeout(r, 60));
    assert.match(plain(out.written), /No event stream is kept/);
    input.emit('data', Buffer.from('\x03'));
    await finished;
  });

  test('stays open with no jobs, wakes when one starts, and survives it finishing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-'));
    const jobs = [];
    const { out, input } = fakeTerm();
    let exited = false;
    const finished = runTui({ listJobs: () => jobs, getStatus: (j) => j.status, out, input, pollMs: 20 }).then(() => { exited = true; });
    try {
      await new Promise((r) => setTimeout(r, 60));
      assert.match(plain(out.written), /No tasks currently running/);

      const job = { id: 'research-1-dddd4444', mode: 'research', model: 'm', status: 'running', started_at: new Date().toISOString(), events_file: path.join(dir, 'x.jsonl') };
      fs.writeFileSync(job.events_file, JSON.stringify({ event: 'step_update', step_update: { step_index: 1, step_type: 'tool', state: 'ACTIVE', tool_name: 'grep' } }) + '\n');
      jobs.push(job);
      await new Promise((r) => setTimeout(r, 80));
      assert.match(plain(out.written), /▶ grep/, 'idle window switched to the new job');

      job.status = 'done';
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(exited, false, 'a finished job does not close the window');
      input.emit('data', Buffer.from('0'));
      await new Promise((r) => setTimeout(r, 40));
      assert.match(plain(out.written), /No tasks currently running/);
      input.emit('data', Buffer.from('x'));   // nothing to close on the jobs page
      input.emit('data', Buffer.from('\r'));  // open the finished job again
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(exited, false);
    } finally { input.emit('data', Buffer.from('q')); }
    await finished;
  });

  test('mouse reporting is enabled on start, follows m, and is always switched off on exit', async () => {
    const { out, input } = fakeTerm();
    const finished = runTui({ listJobs: () => [], getStatus: () => 'done', out, input, pollMs: 20 });
    try {
      assert.match(out.written, /\x1b\[\?1000h\x1b\[\?1006h/);
      out.written = '';
      input.emit('data', Buffer.from('m'));
      assert.match(out.written, /\x1b\[\?1006l\x1b\[\?1000l/, 'm turns reporting off');
      input.emit('data', Buffer.from('m'));
      assert.match(out.written, /\x1b\[\?1000h/, 'and on again');
    } finally { input.emit('data', Buffer.from('q')); }
    await finished;
    assert.match(out.written, /\x1b\[\?1006l\x1b\[\?1000l\x1b\[\?25h\x1b\[\?1049l$/);
  });

  test('mouse: false never turns reporting on', async () => {
    const { out, input } = fakeTerm();
    const finished = runTui({ listJobs: () => [], getStatus: () => 'done', out, input, pollMs: 20, mouse: false });
    input.emit('data', Buffer.from('q'));
    await finished;
    assert.doesNotMatch(out.written, /\?1000h/);
  });
});
