/**
 * Build the omp `OAuthCredential` for one pool account.
 *
 * Everything here is local except the project probe, which is skipped when
 * agy already cached the project. Token material is never printed or returned
 * in error messages.
 */
import { discoverProject } from "./project.mjs";
import { poolAccount, readCachedProject, readOmpToken, writeCachedProject } from './token.mjs';

export class OmpCredentialError extends Error {}

function credentialFrom(name, token, account, projectId) {
  if (!token?.access) {
    throw new OmpCredentialError(`account ${name} has no access token (run \`agy-crew accounts login ${name}\`)`);
  }
  if (!token.refresh) {
    throw new OmpCredentialError(`account ${name} has no refresh token (re-run \`agy-crew accounts login ${name}\`)`);
  }
  const email = token.email || account.email;
  if (!email) {
    // Without an email, omp would fall back to the shared project identity key
    // and two accounts would overwrite each other.
    throw new OmpCredentialError(`account ${name} has no email identity`);
  }
  if (!projectId) {
    throw new OmpCredentialError(
      `account ${name} has no Cloud Code project id; run \`agy-crew accounts quota --refresh\` once`,
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

/** Synchronous credential for provider registration. Never probes the network:
 *  returns null when the project has not been cached yet. */
export function readOmpCredentialCached(name) {
  const account = poolAccount(name);
  if (!account) throw new OmpCredentialError(`unknown agy-crew account "${name}"`);
  try {
    return credentialFrom(name, readOmpToken(name), account, readCachedProject(name));
  } catch {
    return null;
  }
}

export async function readOmpCredential(name, { fetchImpl, timeoutMs } = {}) {
  const account = poolAccount(name);
  if (!account) throw new OmpCredentialError(`unknown agy-crew account "${name}"`);
  const token = readOmpToken(name);
  if (!token?.access) {
    throw new OmpCredentialError(`account ${name} has no access token (run \`agy-crew accounts login ${name}\`)`);
  }
  const cachedProject = readCachedProject(name);
  const projectId = cachedProject || (await discoverProject(token.access, { fetchImpl, timeoutMs }));
  if (!cachedProject && projectId) writeCachedProject(name, projectId);
  return credentialFrom(name, token, account, projectId);
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
