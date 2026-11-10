/**
 * Read one pool account's file-backed agy token without ever logging it.
 *
 * agy writes `{ token: { access_token, refresh_token, expiry, id_token? },
 * id_token_email? }`. agy-crew's own `readToken()` only needs the access token
 * and email; the omp bridge needs the refresh token and expiry too.
 */
import fs from 'node:fs';
import { accountHome, loadPool, projectCachePath, tokenPath } from './paths.mjs';

const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;

function jwtEmail(jwt) {
  try {
    const part = String(jwt).split('.')[1];
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return typeof claims.email === 'string' && EMAIL_RE.test(claims.email) ? claims.email : null;
  } catch {
    return null;
  }
}

const plainEmail = (value) =>
  typeof value === 'string' && EMAIL_RE.test(value) ? value : null;

function expiryMs(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw < 1e12 ? raw * 1000 : raw;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Raw token fields for one account, or null when the file is absent/unreadable. */
export function readOmpToken(name) {
  return readOmpTokenAt(accountHome(name));
}

/** Token fields from an arbitrary HOME (used for the unpooled `live` login). */
export function readOmpTokenAt(home) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(tokenPath(home), 'utf8'));
  } catch {
    return null;
  }
  const token = json?.token && typeof json.token === 'object' ? json.token : {};
  const refresh = token.refresh_token || json.refresh_token;
  return {
    access: typeof token.access_token === 'string' ? token.access_token : null,
    refresh: typeof refresh === 'string' && refresh.length > 0 ? refresh : null,
    expires: expiryMs(token.expiry),
    email:
      jwtEmail(token.id_token) ||
      jwtEmail(json.id_token) ||
      plainEmail(token.id_token_email) ||
      plainEmail(json.id_token_email),
  };
}

/** The Cloud Code project agy last used for this account, if cached. */
export function readCachedProject(name) {
  return readCachedProjectAt(accountHome(name));
}

/** Cached Cloud Code project for an arbitrary HOME. */
export function readCachedProjectAt(home) {
  try {
    const value = fs.readFileSync(projectCachePath(home), 'utf8').trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Resolve the pool record for `name`, including its email fallback. */
export function poolAccount(name) {
  const pool = loadPool();
  return pool.accounts.find((account) => account.name === name) || null;
}
