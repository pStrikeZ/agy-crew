import fs from 'node:fs';
import { tokenPath } from './state.mjs';

/** The email claim of an unverified JWT (we only label accounts with it). */
function jwtEmail(jwt) {
  try {
    const part = String(jwt).split('.')[1];
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return typeof claims.email === 'string' ? claims.email : null;
  } catch { return null; }
}

/** A plain email field (agy also stores the account as `id_token_email`). */
const plainEmail = (value) => (typeof value === 'string' && /^[^@\s]+@[^@\s]+$/.test(value) ? value : null);

/** Read a file-backed agy token: access token, expiry (ms) and account email.
 *  agy records the account either as an `id_token` JWT or as a plain
 *  `id_token_email`, depending on how it last wrote the file.
 *  null when the file is absent or unreadable. */
export function readToken(home) {
  let json;
  try { json = JSON.parse(fs.readFileSync(tokenPath(home), 'utf8')); } catch { return null; }
  const t = json.token && typeof json.token === 'object' ? json.token : {};
  const expiry = typeof t.expiry === 'number' ? (t.expiry < 1e12 ? t.expiry * 1000 : t.expiry) : Date.parse(t.expiry);
  return {
    access_token: t.access_token || null,
    expiry_ms: Number.isFinite(expiry) ? expiry : null,
    email: jwtEmail(t.id_token) || jwtEmail(json.id_token) || plainEmail(t.id_token_email) || plainEmail(json.id_token_email),
  };
}
