/**
 * Resolve the Cloud Code project for an Antigravity account.
 *
 * The account's own `default_project_id.txt` is authoritative and offline.
 * When it is absent, ask `loadCodeAssist` exactly as agy / omp's OAuth login
 * does; never invent a project id.
 */

const ENDPOINT = "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const USER_AGENT = `antigravity/hub/2.26.0 (aidev_client; os_type=${process.platform === "win32" ? "windows" : process.platform}; arch=${process.arch === "x64" ? "amd64" : process.arch}; cl=1005016104)`;

function projectFrom(payload) {
  const value = payload?.cloudaicompanionProject;
  if (typeof value === "string" && value.length > 0) return value;
  if (value && typeof value.id === "string" && value.id.length > 0) return value.id;
  return null;
}

/** Best-effort network probe; returns null on any failure. */
export async function discoverProject(access, { fetchImpl = fetch, timeoutMs = 8_000 } = {}) {
  if (!access) return null;
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return projectFrom(await response.json());
  } catch {
    return null;
  }
}
