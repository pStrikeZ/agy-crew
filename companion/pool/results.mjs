/** Classifiers for agy failure text. */

const EFFORT_SUFFIX = /-(minimal|low|medium|high|xhigh|max)$/;

/** gemini-3.8-flash-low -> gemini-3.8-flash */
export function modelFamily(model) {
  return String(model || '').replace(EFFORT_SUFFIX, '');
}

/** Cloud Code reports two quota groups: gemini and everything else. */
export function quotaPool(family) {
  return String(family).startsWith('gemini') ? 'gemini' : 'other';
}

export function isQuotaExhausted(text) {
  const t = String(text || '').toLowerCase();
  return t.includes('resource_exhausted') && (t.includes('individual quota reached') || t.includes('weekly quota reached'));
}

export function isAuthFailed(text) {
  const t = String(text || '').toLowerCase();
  return ['401', '403', 'unauthenticated'].some((a) => t.includes(a)) &&
    ['auth', 'credential', 'login', 'token'].some((b) => t.includes(b));
}

/** 'quota_exhausted' | 'authentication_failed' | null */
export function classifyFailureText(text) {
  if (isQuotaExhausted(text)) return 'quota_exhausted';
  if (isAuthFailed(text)) return 'authentication_failed';
  return null;
}

/** "Resets in 2h3m" / "1d 4h" / "45s" -> milliseconds, or null. */
export function parseResetsIn(text) {
  const m = /resets in ((?:\d+\s*[dhms]\s*)+)/i.exec(String(text || ''));
  if (!m) return null;
  const unit = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
  let total = 0;
  for (const part of m[1].matchAll(/(\d+)\s*([dhms])/gi)) total += Number(part[1]) * unit[part[2].toLowerCase()];
  return total > 0 ? total : null;
}
