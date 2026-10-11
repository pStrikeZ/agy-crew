/**
 * Human-readable rendering of the account pool: durations, clock times and
 * aligned tables. Pure functions; every time-dependent one takes `now`.
 */

const pad2 = (n) => String(n).padStart(2, '0');

/** Length of a span of time, e.g. `<1m`, `12m`, `1h02m`, `1d 3h`. Sign is ignored. */
export function formatDuration(ms) {
  const minutes = Math.floor(Math.abs(ms) / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h${pad2(minutes % 60)}m`;
  return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
}

/** `delta` is target minus now in ms: negative reads "12m ago", otherwise "in 12m". */
export function formatRelative(delta) {
  const text = formatDuration(delta);
  return delta < 0 ? `${text} ago` : `in ${text}`;
}

/** Local `HH:MM` when `date` is on the same local day as `now`, else `MM-DD HH:MM`. */
export function formatClock(date, now) {
  const d = new Date(date);
  const n = new Date(now);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return time;
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${time}`;
}

/** Relative age of an ISO timestamp, or `never` when it is missing. */
export function formatAgo(iso, now) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? formatRelative(t - now) : 'never';
}

export const formatPercent = (remaining) => `${Math.round(remaining * 100)}%`;

/** `<pct>  resets in <rel> (<clock>)`; pct is padded to `pctWidth` (right-aligned). */
export function formatWindow(window, now, pctWidth = 0) {
  if (!window || typeof window.remaining !== 'number') return '';
  const pct = formatPercent(window.remaining).padStart(pctWidth);
  const reset = Date.parse(window.reset_at);
  if (!Number.isFinite(reset)) return pct;
  if (reset <= now) return `${pct}  reset since refresh`;
  return `${pct}  resets in ${formatDuration(reset - now)} (${formatClock(reset, now)})`;
}

/** Pool names in display order: gemini, other, then the rest alphabetically. */
export function orderedPools(names) {
  const rank = (n) => (n === 'gemini' ? 0 : n === 'other' ? 1 : 2);
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * Plain-text table. Cells are padded to the widest entry of their column and
 * joined with two spaces; lines carry no trailing spaces. A row is an array of
 * cells, or `{ lead: [cells], text }` for a message that runs on after its
 * leading cells (it does not widen any column beyond its lead cells).
 */
export function renderTable(headers, rows) {
  const widths = headers.map((h) => h.length);
  for (const row of rows) {
    const cells = Array.isArray(row) ? row : row.lead;
    cells.forEach((c, i) => { widths[i] = Math.max(widths[i], String(c).length); });
  }
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
  const lines = [line(headers)];
  for (const row of rows) {
    if (Array.isArray(row)) lines.push(line(row));
    else lines.push(`${row.lead.map((c, i) => String(c).padEnd(widths[i])).join('  ')}  ${row.text}`.trimEnd());
  }
  return lines;
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

/**
 * QUOTA table lines. `entries` is [{ name, snapshot }]. The account name shows
 * on its first row only; AS OF sits on the first pool row.
 */
export function renderQuotaTable(entries, now) {
  const windowRows = [];
  const layout = entries.map(({ name, snapshot }) => {
    if (!snapshot) return { name, message: 'not refreshed (run `accounts quota --refresh`)' };
    if (snapshot.error) return { name, message: `error: ${clip(String(snapshot.error).replace(/\s+/g, ' '), 60)}` };
    const pools = orderedPools(Object.keys(snapshot.pools || {}));
    if (!pools.length) return { name, message: 'no quota data' };
    const rows = pools.map((pool) => ({ pool, short: snapshot.pools[pool].short, weekly: snapshot.pools[pool].weekly }));
    windowRows.push(...rows);
    return { name, snapshot, rows };
  });
  const pctWidth = (key) => Math.max(0, ...windowRows.filter((r) => r[key]).map((r) => formatPercent(r[key].remaining).length));
  const shortW = pctWidth('short');
  const weeklyW = pctWidth('weekly');
  const rows = [];
  for (const item of layout) {
    if (item.message) { rows.push({ lead: [item.name], text: item.message }); continue; }
    item.rows.forEach((r, i) => rows.push([
      i === 0 ? item.name : '', r.pool,
      formatWindow(r.short, now, shortW), formatWindow(r.weekly, now, weeklyW),
      i === 0 ? formatAgo(item.snapshot.refreshed_at, now) : '',
    ]));
  }
  return renderTable(['QUOTA', 'POOL', '5H', 'WEEKLY', 'AS OF'], rows);
}

/** COOLDOWNS lines (header included), or [] when `cooldowns` is empty. Items: { name, family, retry_at }. */
export function renderCooldowns(cooldowns, now) {
  if (!cooldowns.length) return [];
  const rows = cooldowns.map((c) => [c.name, c.family,
    `until ${formatClock(c.retry_at, now)} (${formatRelative(Date.parse(c.retry_at) - now)})`]);
  return ['COOLDOWNS', ...renderTable(['', '', ''], rows).slice(1)];
}
