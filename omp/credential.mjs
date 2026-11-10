/**
 * Build the omp `OAuthCredential` for one pool account.
 *
 * Everything here is local except the project probe, which is skipped when
 * agy already cached the project. Token material is never printed or returned
 * in error messages.
 */
import { discoverProject } from "./project.mjs";
import os from 'node:os';
import { accountHome } from './paths.mjs';
import { poolAccount, readCachedProjectAt, readOmpTokenAt } from './token.mjs';

export class OmpCredentialError extends Error {}

export async function readOmpCredential(name, { fetchImpl, timeoutMs } = {}) {
  const live = name === 'live';
  const account = live ? null : poolAccount(name);
  if (!live && !account) throw new OmpCredentialError(`unknown agy-crew account "${name}"`);

  const home = live ? os.homedir() : accountHome(name);
  const token = readOmpTokenAt(home);
  const label = live ? 'the live agy login' : `account ${name}`;
  if (!token?.access) {
    throw new OmpCredentialError(`${label} has no access token (run \`agy\` once to sign in)`);
  }
  if (!token.refresh) {
    throw new OmpCredentialError(`${label} has no refresh token; re-run \`agy\` to sign in`);
  }
  const email = token.email || account?.email;
  if (!email) {
    // Without an email, omp would fall back to the shared project identity key
    // and two accounts would overwrite each other.
    throw new OmpCredentialError(`${label} has no email identity`);
  }

  const projectId = readCachedProjectAt(home) || (await discoverProject(token.access, { fetchImpl, timeoutMs }));
  if (!projectId) {
    throw new OmpCredentialError(
      `${label} has no Cloud Code project id; run \`agy-crew accounts quota --refresh\` once`,
    );
  }

  return {
    type: "oauth",
    access: token.access,
    refresh: token.refresh,
    expires: token.expires ?? 0,
    email,
    projectId,
  };
}

/** Identity keys omp's session restriction should accept for this credential. */
export function identityKeys(credential) {
  const keys = new Set();
  if (credential.email) keys.add(`email:${credential.email}`);
  if (credential.accountId) keys.add(`account:${credential.accountId}`);
  return [...keys];
}

/** The structured API-key JSON omp's google-antigravity provider expects. */
export function toStructuredApiKey(credential) {
  return JSON.stringify({
    token: credential.access,
    projectId: credential.projectId,
    refreshToken: credential.refresh,
    expiresAt: credential.expires,
    email: credential.email,
    accountId: credential.accountId,
  });
}
