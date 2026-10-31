// Full-screen, tmux-style `inspect`: one tab per job, all tailed live.
// Read-only like the plain view: it never writes state, and quitting never
// cancels a job. The screen is diffed row by row, so idle ticks write nothing.
import { createRenderer, createTail, footer } from './inspect.mjs';

const MAX_LINES = 5000;
const SGR = /\x1b\[[0-9;]*m/y;
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Terminal cell width of a code point: 2 for East Asian wide and emoji. */
export function charWidth(cp) {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp >= 0x300 && cp <= 0x36f) return 0;
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd) ? 2 : 1;
}

export const visibleWidth = (text) => {
  let w = 0;
  for (const ch of stripAnsi(text)) w += charWidth(ch.codePointAt(0));
  return w;
};

/** Hard-wrap one line to `width` cells. Colour set before a break is
 *  re-applied on the next row, so wrapped rows keep their styling. */
export function wrapAnsi(line, width) {
  const rows = [];
  let row = '', w = 0, active = '';
  for (let i = 0; i < line.length;) {
    SGR.lastIndex = i;
    const m = SGR.exec(line);
    if (m) {
      row += m[0];
      active = m[0] === '\x1b[0m' ? '' : active + m[0];
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(i));
    i += ch.length;
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > width && w > 0) {
      rows.push(row + (active ? '\x1b[0m' : ''));
      row = active; w = 0;
    }
    row += ch; w += cw;
  }
  rows.push(row);
  return rows;
}

const clip = (text, width) => wrapAnsi(text, Math.max(1, width))[0];
const pad = (text, width) => text + ' '.repeat(Math.max(0, width - visibleWidth(text)));

const DOTS = { running: ['33', '●'], done: ['32', '●'], error: ['31', '●'], crashed: ['31', '●'],
  canceled: ['35', '●'], attention: ['33', '!'] };
const dot = (status) => { const [c, g] = DOTS[status] || ['0', '●']; return `\x1b[${c}m${g}\x1b[0m`; };

/** "research-mvwgxqz7-e58263f0" → "research·e582" */
export const tabLabel = (job) => `${job.mode}·${String(job.id).split('-').pop().slice(0, 4)}`;

const hhmm = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '--:--' : d.toTimeString().slice(0, 8); };
const ago = (job, now) => {
  const s = Math.max(0, Math.round(((job.finished_at ? Date.parse(job.finished_at) : now) - Date.parse(job.started_at)) / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m` : s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};

/** The "Jobs" page: what is running now, then recent jobs to open as tabs. */
function overviewRows(state, cols, height, now) {
  const rows = state.rows || [];
  const running = rows.filter((r) => r.status === 'running').length;
  const out = [running ? `${running} running, ${rows.length} recent jobs` : 'No tasks currently running.',
    rows.length ? (running ? '' : 'Recent jobs — select one and press Enter to view it.') : 'Jobs appear here as soon as one is started.'];
  state.cursor = Math.min(Math.max(0, state.cursor || 0), Math.max(0, rows.length - 1));
  const room = Math.max(1, height - out.length);
  const first = Math.min(Math.max(0, state.cursor - room + 1), Math.max(0, rows.length - room));
  state.listFirst = first;
  state.listTop = 1 + out.length;   // 0-based screen row of the first job line (below the tab bar)
  rows.slice(first, first + room).forEach((r, k) => {
    const open = state.known?.has(r.job.id) ? '▪' : ' ';
    const line = `${first + k === state.cursor ? '▸' : ' '}${open}${dot(r.status)} ${pad(tabLabel(r.job), 16)}${pad(r.status, 10)}${pad(ago(r.job, now), 8)}${pad(hhmm(r.job.started_at), 10)}${r.job.model || ''}`;
    out.push(first + k === state.cursor ? `\x1b[7m${pad(clip(line, cols), cols)}\x1b[0m` : line);
  });
  return out;
}

/** Frame for the given state: exactly `rows` strings, none wider than `cols`.
 *  Pages: 0 is the Jobs overview, 1.. are job tabs (state.views[active - 1]).
 *  Layout: tab bar, content, status line, key hints. Mutates view.scroll
 *  (clamped) and state.page (rows per PageUp/PageDown). */
export function renderFrame(state, cols, rows, now = Date.now()) {
  const height = Math.max(1, rows - 3);
  state.page = Math.max(1, height - 1);
  const frame = [];
  const { views } = state;

  // Tab bar: slide a window around the active page when they do not all fit.
  const tabs = [{ text: ' 0 jobs ' }, ...views.map((v, i) => ({ text: ` ${i + 1} ${tabLabel(v.job)} ${dot(v.status)} ` }))];
  let lo = state.active, hi = state.active, used = visibleWidth(tabs[lo].text);
  for (;;) {
    if (hi + 1 < tabs.length && used + visibleWidth(tabs[hi + 1].text) <= cols) { hi++; used += visibleWidth(tabs[hi].text); }
    else if (lo > 0 && used + visibleWidth(tabs[lo - 1].text) <= cols) { lo--; used += visibleWidth(tabs[lo].text); }
    else break;
  }
  let bar = '', col = 1;
  state.tabHits = [];
  for (let i = lo; i <= hi; i++) {
    const w = visibleWidth(tabs[i].text);
    state.tabHits.push({ from: col, to: col + w - 1, index: i });
    col += w;
    bar += i === state.active ? `\x1b[7m${tabs[i].text}\x1b[0m` : tabs[i].text;
  }
  frame.push(pad(clip(bar, cols), cols));

  const view = views[state.active - 1];
  let hint = `Tab switch  0-9 jump  ↑↓ scroll  End live  x close  m mouse ${state.mouse ? 'on' : 'off'}  q quit`;
  let status = '';
  if (!view) {
    const body = overviewRows(state, cols, height, now);
    for (let i = 0; i < height; i++) frame.push(pad(clip(body[i] ?? '', cols), cols));
    const running = (state.rows || []).filter((r) => r.status === 'running').length;
    status = `jobs  ${running} running  ${(state.rows || []).length} recent`;
    hint = `↑↓ select  Enter open  Tab switch  m mouse ${state.mouse ? 'on' : 'off'}  q quit (jobs keep running)`;
  } else {
    const wrapped = view.lines.flatMap((l) => wrapAnsi(l, cols));
    const maxScroll = Math.max(0, wrapped.length - height);
    view.scroll = Math.min(Math.max(0, view.scroll), maxScroll);
    const end = wrapped.length - view.scroll;
    const shown = wrapped.slice(Math.max(0, end - height), end);
    for (const line of shown) frame.push(pad(line, cols));
    for (let i = shown.length; i < height; i++) frame.push(pad('', cols));
    status = footer({ job: view.job, status: view.status, stats: view.renderer.stats, now });
    if (view.scroll > 0) hint = `scrolled back ${view.scroll} lines — End to follow`;
  }
  frame.push(`\x1b[7m${pad(clip(status, cols), cols)}\x1b[0m`);
  frame.push(`\x1b[2m${pad(clip(hint, cols), cols)}\x1b[0m`);
  return frame;
}

/** Split raw terminal input into key tokens (escape sequences kept whole). */
export const parseKeys = (data) => String(data).match(/\x1b\[[<0-9;]*[A-Za-z~]|\x1b.|[\s\S]/gu) || [];

/** Apply one key (or SGR mouse report) to the state. Returns 'quit' to leave.
 *  Opening a job from the overview is left to the run loop: it sets
 *  state.open to the job. state.mouse is applied to the terminal by the loop. */
export function handleKey(state, key) {
  const view = state.views[state.active - 1];
  const pages = state.views.length + 1;
  const go = (i) => { state.active = ((i % pages) + pages) % pages; };
  const rows = state.rows || [];
  // Up/down/page/top/bottom move the cursor on the overview and scroll a job.
  const move = (delta) => {
    if (view) view.scroll = Math.max(0, view.scroll + delta);
    else state.cursor = Math.min(Math.max(0, (state.cursor || 0) - delta), Math.max(0, rows.length - 1));
  };
  const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(key);
  if (mouse) {
    const [button, x, y] = [Number(mouse[1]), Number(mouse[2]), Number(mouse[3])];
    if (button === 64) move(3);          // wheel up: older output / previous job
    else if (button === 65) move(-3);    // wheel down
    else if (button === 0 && mouse[4] === 'M') {   // left press
      if (y === 1) {
        const hit = (state.tabHits || []).find((t) => x >= t.from && x <= t.to);
        if (hit) state.active = hit.index;
      } else if (!view && state.listTop !== undefined) {
        const row = (state.listFirst || 0) + (y - 1 - state.listTop);
        if (y - 1 >= state.listTop && rows[row]) { state.cursor = row; state.open = rows[row].job; }
      }
    }
    return;
  }
  switch (key) {
    case 'm': state.mouse = !state.mouse; break;
    case '\x03': case 'q': case 'Q': return 'quit';
    case '\t': case '\x1b[C': case 'l': go(state.active + 1); break;
    case '\x1b[Z': case '\x1b[D': case 'h': go(state.active - 1); break;
    case '\x1b[A': case 'k': move(1); break;
    case '\x1b[B': case 'j': move(-1); break;
    case '\x1b[5~': case 'b': move(state.page || 10); break;
    case '\x1b[6~': case ' ': move(-(state.page || 10)); break;
    case '\x1b[H': case '\x1b[1~': case 'g': if (view) view.scroll = Infinity; else state.cursor = 0; break;
    case '\x1b[F': case '\x1b[4~': case 'G': if (view) view.scroll = 0; else state.cursor = Math.max(0, rows.length - 1); break;
    case '\r': case '\n': if (!view && rows[state.cursor || 0]) state.open = rows[state.cursor || 0].job; break;
    case 'x':
      if (view) {
        state.views.splice(state.active - 1, 1);
        state.known?.delete(view.job.id);
        state.closed?.add(view.job.id);   // a running job must not reopen by itself
        state.active = Math.min(state.active, state.views.length);
      }
      break;
    default:
      if (/^[0-9]$/.test(key) && Number(key) <= state.views.length) state.active = Number(key);
  }
}

function createView(job, color) {
  const renderer = createRenderer({ color });
  const view = { job, status: 'running', lines: [], scroll: 0, renderer, finished: false, noStream: false };
  const push = (lines) => {
    if (!lines.length) return;
    view.lines.push(...lines);
    if (view.scroll > 0) view.scroll += lines.length;   // keep the page the reader is on
    if (view.lines.length > MAX_LINES) view.lines.splice(0, view.lines.length - MAX_LINES);
  };
  const tail = createTail(() => view.job.events_file, (event) => push(renderer.accept(event)));
  /** Refresh from the job record; returns true when something changed. */
  view.refresh = (job, getStatus) => {
    const before = [view.lines.length, view.status];
    view.job = job || view.job;
    view.status = getStatus(view.job);
    const exists = tail.pull();
    if (view.status !== 'running' && !view.finished) {
      // Final drain: the worker may have written its last bytes just before exiting.
      tail.pull(); tail.end(); push(renderer.flush());
      view.finished = true;
      if (!exists && !view.lines.length) {
        view.noStream = true;
        push([`No event stream is kept for this job (it finished cleanly and its raw output was cleaned up). Use \`result ${view.job.id}\` for the report.`]);
      }
    }
    return before[0] !== view.lines.length || before[1] !== view.status;
  };
  return view;
}

/** Run the full-screen view until the user quits (q / Ctrl-C). It is a
 *  resident window: it stays open when jobs finish or none exist, and picks
 *  up jobs started later. listJobs() → job records (read-only);
 *  getStatus(job) → status string. */
export function runTui({ listJobs, getStatus, focus = null, out = process.stdout, input = process.stdin,
  color = true, pollMs = 200, mouse = true }) {
  return new Promise((resolve) => {
    const state = { views: [], active: 0, page: 10, rows: [], cursor: 0, known: new Map(), closed: new Set(), open: null, mouse };
    let lastFrame = [];
    let done = false;
    let mouseOn = false;   // what the terminal currently has, versus state.mouse
    const applyMouse = () => {
      if (mouseOn === state.mouse) return;
      mouseOn = state.mouse;
      out.write(mouseOn ? '\x1b[?1000h\x1b[?1006h' : '\x1b[?1006l\x1b[?1000l');
    };

    const openView = (job) => {
      const view = createView(job, color);
      state.known.set(job.id, view);
      state.closed.delete(job.id);
      state.views.push(view);
      return view;
    };
    const sync = () => {
      const jobs = listJobs();
      state.rows = jobs.slice(-30).reverse().map((job) => ({ job, status: getStatus(job) }));
      const idle = !state.views.length;
      for (const { job, status } of [...state.rows].reverse()) {
        if (!state.known.has(job.id) && status === 'running' && !state.closed.has(job.id)) {
          openView(job);
          if (idle && state.active === 0 && state.views.length === 1) state.active = 1;   // first job wakes an idle window
        }
      }
      if (state.open) {
        const job = state.open; state.open = null;
        const view = state.known.get(job.id) || openView(job);
        state.active = state.views.indexOf(view) + 1;
      }
      for (const view of state.views) view.refresh(jobs.find((j) => j.id === view.job.id), getStatus);
    };
    const draw = (full = false) => {
      const cols = Math.max(20, out.columns || 80), rows = Math.max(5, out.rows || 24);
      const frame = renderFrame(state, cols, rows);
      let buf = '';
      for (let i = 0; i < frame.length; i++) {
        if (full || frame[i] !== lastFrame[i]) buf += `\x1b[${i + 1};1H${frame[i]}\x1b[K`;
      }
      lastFrame = frame;
      if (buf) out.write(buf);
    };

    // Start on the requested job, else the first running one, else the overview.
    const jobs = listJobs();
    const target = jobs.find((j) => j.id === focus);
    if (target) openView(target);
    sync();
    state.active = target ? state.views.findIndex((v) => v.job.id === target.id) + 1 : Math.min(1, state.views.length);

    const raw = input.isTTY && typeof input.setRawMode === 'function';
    const onData = (data) => {
      for (const key of parseKeys(data)) if (handleKey(state, key) === 'quit') return void finish();
      applyMouse();
      sync();
      draw();
    };
    const onResize = () => draw(true);
    const timer = setInterval(() => { sync(); draw(); }, pollMs);
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      input.off('data', onData);
      out.off?.('resize', onResize);
      process.off('exit', finish);
      process.off('SIGTERM', finish);
      if (raw) { input.setRawMode(false); input.pause(); }
      state.mouse = false; applyMouse();
      out.write('\x1b[?25h\x1b[?1049l');
      resolve({ views: state.views.length });
    };

    out.write('\x1b[?1049h\x1b[?25l\x1b[2J');
    if (raw) { input.setRawMode(true); input.resume(); }
    input.on('data', onData);
    out.on?.('resize', onResize);
    process.on('exit', finish);
    process.on('SIGTERM', finish);
    applyMouse();
    draw(true);
  });
}
