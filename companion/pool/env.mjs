/** Environment for one agy process. A pool account is a private HOME holding
 *  its own file-backed token; the SSH markers make agy store credentials in
 *  files instead of the OS keyring (which would be shared across HOMEs).
 *  `live` (home == null) is the user's own login and inherits the environment
 *  unchanged. */
export function accountEnv(home, base = process.env) {
  if (!home) return base;
  const env = { ...base, HOME: home };
  if (process.platform === 'win32') env.USERPROFILE = home;
  env.SSH_CONNECTION = '127.0.0.1 1 127.0.0.1 1';
  env.SSH_CLIENT = '127.0.0.1 1 1';
  env.SSH_TTY = 'agy-crew-account';
  return env;
}
