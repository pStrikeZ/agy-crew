// `inspect`: a live, human-readable view of a job's AGY event stream.
// Read-only: it tails <job>.events.jsonl and never touches state.json, so it
// can run beside `wait` without resetting deadlines. Detaching never cancels.
import fs from 'node:fs';
import { createParser, excerpt } from './observation.mjs';

const oneLine = (value, limit) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return excerpt(text.replace(/\s+/g, ' ').trim(), limit).text;
};

const fmtDuration = (seconds) => {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};

const fmtCount = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

/** Turns AGY events into display lines. Pure: no I/O, so it is unit-testable.
 *  accept(event) → string[] of finished lines; stats feeds the footer. */
export function createRenderer({ color = false } = {}) {
  const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const stats = { steps: 0, tools: 0, errors: 0, input_tokens: 0, output_tokens: 0, last_tool: null };
  const tools = new Map();   // step_index -> tool name, for the DONE line
  const usageSeen = new Set();
  let partial = '';          // response text not yet ended by a newline

  const closeText = (lines) => {
    if (partial) lines.push(partial);
    partial = '';
  };

  const accept = (event) => {
    const lines = [];
    if (event.event === 'init') {
      const init = event.init || {};
      const bits = [['session', event.conversation_id], ['model', init.model], ['cwd', init.cwd]].filter(([, v]) => v);
      if (bits.length) lines.push(paint('2', bits.map(([k, v]) => `${k} ${v}`).join('  ')));
      return lines;
    }
    if (event.event === 'result') {
      closeText(lines);
      const r = event.result || {};
      lines.push(paint(r.status === 'SUCCESS' ? '32' : '31', `■ result ${r.status || '?'}`));
      return lines;
    }
    const step = event.step_update;
    if (event.event !== 'step_update' || !step || !Number.isInteger(step.step_index)) return lines;

    const usage = step.usage;
    if (usage && !usageSeen.has(step.step_index)) {
      usageSeen.add(step.step_index);
      stats.input_tokens += usage.input_tokens || 0;
      stats.output_tokens += usage.output_tokens || 0;
    }

    if (step.step_type === 'agent_response') {
      if (typeof step.text_delta === 'string' && step.text_delta) {
        const parts = (partial + step.text_delta).split('\n');
        partial = parts.pop();
        lines.push(...parts);
      }
      if (step.state === 'DONE') { closeText(lines); stats.steps++; }
      return lines;
    }

    closeText(lines);
    if (step.step_type !== 'tool') return lines;

    const info = step.tool_info || {};
    const name = step.tool_name || info.name || tools.get(step.step_index) || 'tool';
    if (step.state === 'ACTIVE') {
      if (!tools.has(step.step_index)) { stats.tools++; stats.steps++; }
      tools.set(step.step_index, name);
      stats.last_tool = name;
      const args = info.parameters !== undefined ? '  ' + paint('2', oneLine(info.parameters, 160)) : '';
      lines.push(`${paint('36', '▶')} ${paint('1', name)}${args}`);
    } else if (step.state === 'DONE' || /ERROR|FAIL/.test(step.state || '')) {
      if (!tools.has(step.step_index)) { stats.tools++; stats.steps++; tools.set(step.step_index, name); }
      const failed = !!(info.error || step.error || /ERROR|FAIL/.test(step.state || ''));
      if (failed) stats.errors++;
      const took = typeof step.duration_seconds === 'number' ? ` ${step.duration_seconds.toFixed(1)}s` : '';
      const body = info.error || step.error || info.output;
      const tail = body !== undefined && body !== '' ? '  ' + paint('2', oneLine(body, 120)) : '';
      lines.push(`${failed ? paint('31', '✗') : paint('32', '✓')} ${name}${paint('2', took)}${tail}`);
    }
    return lines;
  };

  return { accept, stats, flush: () => { const lines = []; closeText(lines); return lines; } };
}

/** One-line footer: status, ids and counters. */
export function footer({ job, status, stats, now = Date.now(), color = false }) {
  const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const dot = { running: paint('33', '●'), done: paint('32', '●'), error: paint('31', '●'), crashed: paint('31', '●'),
    canceled: paint('35', '●'), attention: paint('33', '●') }[status] || '●';
  const elapsed = fmtDuration(((job.finished_at ? Date.parse(job.finished_at) : now) - Date.parse(job.started_at)) / 1000);
  const parts = [`${dot} ${status}`, job.id, job.model, job.account, elapsed,
    `${stats.tools} tools`, stats.errors ? `${stats.errors} errors` : null,
    `in ${fmtCount(stats.input_tokens)} out ${fmtCount(stats.output_tokens)}`,
    status === 'running' && stats.last_tool ? `last ${stats.last_tool}` : null];
  return parts.filter(Boolean).join('  ');
}

/** Incrementally feeds new bytes of an NDJSON file to onEvent.
 *  pull() → false when the file does not exist (yet, or any more). */
export function createTail(getFile, onEvent) {
  const parser = createParser(onEvent, () => {});
  let offset = 0;
  return {
    end: () => parser.end(),
    pull() {
      const file = getFile();
      if (!file) return false;
      let fd;
      try {
        fd = fs.openSync(file, 'r');
        const size = fs.fstatSync(fd).size;
        if (size < offset) offset = 0;
        while (offset < size) {
          const buffer = Buffer.alloc(Math.min(size - offset, 1 << 20));
          const n = fs.readSync(fd, buffer, 0, buffer.length, offset);
          if (!n) break;
          offset += n;
          parser.write(buffer.subarray(0, n));
        }
        return true;
      } catch { return false; } finally { if (fd !== undefined) fs.closeSync(fd); }
    },
  };
}

/** Tail the job's event file until the job leaves `running`.
 *  getJob() re-reads the (read-only) job record; getStatus(job) resolves it.
 *  Resolves with the final status. */
export async function follow({ getJob, getStatus, out = process.stdout, input = process.stdin,
  follow: live = true, color = false, pollMs = 150, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const tty = !!out.isTTY && live;
  const renderer = createRenderer({ color });
  const width = () => Math.max(20, out.columns || 100);
  const clip = (line) => {
    // Clip only visible text on a TTY; escape sequences carry no width.
    const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
    return plain.length <= width() ? line : excerpt(plain, width() - 1).text + '…';
  };
  let job = getJob();
  let status = getStatus(job);
  let footerShown = false;
  const showFooter = () => {
    if (!tty) return;
    out.write('\r\x1b[2K' + clip(footer({ job, status, stats: renderer.stats, color })));
    footerShown = true;
  };
  const write = (lines) => {
    if (!lines.length) return;
    if (footerShown) { out.write('\r\x1b[2K'); footerShown = false; }
    out.write(lines.map((l) => (tty ? clip(l) : l)).join('\n') + '\n');
  };

  const tail = createTail(() => job.events_file, (event) => write(renderer.accept(event)));
  const drain = () => tail.pull();
  let stop = false;

  // q / Ctrl-C detach from the view. The job itself keeps running.
  let restore = () => {};
  if (tty && input.isTTY && typeof input.setRawMode === 'function') {
    input.setRawMode(true); input.resume();
    const onKey = (key) => { if (key[0] === 3 || key[0] === 0x71 || key[0] === 0x51) stop = true; };
    input.on('data', onKey);
    restore = () => { input.off('data', onKey); input.setRawMode(false); input.pause(); };
  }

  try {
    let announced = false;
    for (;;) {
      const seen = drain();
      if (!seen && !announced && status !== 'running') {
        write(['No event stream is kept for this job (it finished cleanly and its raw output was cleaned up). ' +
          `Use \`result ${job.id}\` for the report.`]);
        announced = true;
      }
      if (status !== 'running' || !live || stop) break;
      showFooter();
      await sleep(pollMs);
      job = getJob() || job;
      status = getStatus(job);
      if (status !== 'running') drain();   // last bytes written before exit
    }
    tail.end();
    write(renderer.flush());
    if (stop && status === 'running') {
      write([`detached; ${job.id} keeps running (inspect ${job.id} to rejoin, cancel ${job.id} to stop it)`]);
    } else if (tty || !live) {
      out.write(footer({ job, status, stats: renderer.stats, color }) + '\n');
    }
    return { status, detached: stop && status === 'running' };
  } finally {
    restore();
  }
}
