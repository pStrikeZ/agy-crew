/**
 * Make transient transport failures on the Cloud Code endpoints retryable.
 *
 * omp decides whether a failed turn is replayed by matching the error text
 * against its transient-transport wording. A dropped TLS connection surfaces
 * from Bun as `EPROTO: The TLS handshake failed. ...` (or a bare ECONNRESET /
 * EPIPE), which that wording does not cover, so one flaky connection ends the
 * turn instead of using omp's own retry budget (`retry.maxRetries`). agy
 * itself retries these.
 *
 * The shim wraps `fetch` for the Cloud Code hosts only and rewords exactly
 * those errors, both when the request is rejected and when the response body
 * breaks mid-stream. It never retries by itself and never touches a request to
 * any other host; the retry policy stays omp's.
 */

const CLOUD_CODE_HOST = /(?:^|[.-])cloudcode-pa(?:\.sandbox)?\.googleapis\.com$/i;
const TRANSIENT_CODE = /^(?:EPROTO|ECONNRESET|EPIPE|ERR_SSL_[A-Z0-9_]+|ERR_TLS_HANDSHAKE[A-Z0-9_]*)$/i;
const TRANSIENT_TEXT = /\bEPROTO\b|\bECONNRESET\b|\bEPIPE\b|\bTLS handshake\b|\bERR_SSL_[A-Z0-9_]+\b/i;
/** Wording omp already treats as transient; such errors are left untouched. */
const ALREADY_RETRYABLE = /network.?error|connection.?error|fetch failed|timed? out|timeout|socket connection (?:was )?closed unexpectedly/i;
const REWORD_PREFIX = 'network error (transient connection failure, retrying is safe): ';
const SHIM = Symbol.for('agy-crew.omp.transport-shim');
const MAX_CAUSE_DEPTH = 4;

function hostOf(input) {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    return raw ? new URL(raw).hostname : '';
  } catch {
    return '';
  }
}

export function isCloudCodeRequest(input) {
  return CLOUD_CODE_HOST.test(hostOf(input));
}

/** True for a dropped-connection / failed-handshake error anywhere in the cause chain. */
export function isTransientTransportError(error) {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current && typeof current === 'object'; depth++) {
    if (current.name === 'AbortError') return false;
    if (typeof current.code === 'string' && TRANSIENT_CODE.test(current.code)) return true;
    if (typeof current.message === 'string' && TRANSIENT_TEXT.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

/** Reword a transient transport error so omp's retry classification accepts it. */
export function rewordTransportError(error) {
  if (!isTransientTransportError(error)) return error;
  const message = typeof error?.message === 'string' && error.message ? error.message : String(error);
  if (ALREADY_RETRYABLE.test(message)) return error;
  const reworded = new Error(`${REWORD_PREFIX}${message}`, { cause: error });
  if (typeof error?.code === 'string') reworded.code = error.code;
  return reworded;
}

/** Same response, but a body that breaks mid-stream fails with the reworded error. */
function guardBody(response) {
  if (!response?.ok || !response.body) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(rewordTransportError(error));
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const guarded = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  // omp replays an empty stream against `response.url`; a constructed Response has none.
  for (const key of ['url', 'redirected']) {
    Object.defineProperty(guarded, key, { value: response[key], configurable: true });
  }
  return guarded;
}

/** Wrap one fetch implementation. Exported for tests. */
export function wrapFetch(original) {
  if (original[SHIM]) return original;
  const wrapped = async function fetch(input, init) {
    if (!isCloudCodeRequest(input)) return original.call(this, input, init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    try {
      return guardBody(await original.call(this, input, init));
    } catch (error) {
      if (signal?.aborted) throw error;
      throw rewordTransportError(error);
    }
  };
  // Keep runtime extras such as Bun's `fetch.preconnect`.
  for (const key of Reflect.ownKeys(original)) {
    if (key in wrapped) continue;
    try {
      Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(original, key));
    } catch {
      // Non-configurable built-in property; nothing to copy.
    }
  }
  wrapped[SHIM] = true;
  return wrapped;
}

/** Install the shim on the process-wide fetch once. */
export function installTransportShim(target = globalThis) {
  if (typeof target.fetch !== 'function') return false;
  target.fetch = wrapFetch(target.fetch);
  return true;
}
