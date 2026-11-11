import test from 'node:test';
import assert from 'node:assert/strict';
import { isTransientTransportError, rewordTransportError, wrapFetch } from '../omp/transport.mjs';

const URL_OK = 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse';
const EPROTO = () => Object.assign(new Error('The TLS handshake failed. Does the server speak TLS on this port?'), { code: 'EPROTO' });
// omp's transient wording (subset): the reworded text must match it.
const OMP_TRANSIENT = /network.?error|connection.?error|fetch failed/i;

test('a failed TLS handshake is reworded into wording omp retries', () => {
  for (const error of [EPROTO(), new Error('EPROTO: The TLS handshake failed.'), new Error('read ECONNRESET'), new TypeError('x', { cause: EPROTO() })]) {
    assert.ok(isTransientTransportError(error));
    const reworded = rewordTransportError(error);
    assert.match(reworded.message, OMP_TRANSIENT);
    assert.equal(reworded.cause, error);
  }
  assert.equal(rewordTransportError(EPROTO()).code, 'EPROTO');
});

test('other errors pass through unchanged', () => {
  const api = new Error('Cloud Code Assist API error (400): invalid argument');
  assert.equal(rewordTransportError(api), api);
  const abort = Object.assign(new Error('The operation was aborted. ECONNRESET'), { name: 'AbortError' });
  assert.equal(rewordTransportError(abort), abort);
  const already = new Error('fetch failed: ECONNRESET');
  assert.equal(rewordTransportError(already), already);
});

test('the wrapped fetch rewords a rejected Cloud Code request and nothing else', async () => {
  const fetchImpl = wrapFetch(async () => { throw EPROTO(); });
  await assert.rejects(fetchImpl(URL_OK), /network error .*TLS handshake failed/);
  await assert.rejects(fetchImpl(new URL(URL_OK)), /network error/);
  await assert.rejects(fetchImpl('https://example.com/x'), (error) => error.code === 'EPROTO' && !/network error/.test(error.message));
  assert.equal(wrapFetch(fetchImpl), fetchImpl, 'wrapping is idempotent');
});

test('a caller abort is never reworded', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchImpl = wrapFetch(async () => { throw EPROTO(); });
  await assert.rejects(fetchImpl(URL_OK, { signal: controller.signal }), (error) => !/network error/.test(error.message));
});

test('a body that breaks mid-stream fails with the reworded error; a healthy one is intact', async () => {
  const encoder = new TextEncoder();
  const respond = (fail) => {
    let sent = false;
    const body = new ReadableStream({
      pull(controller) {
        if (!sent) { sent = true; controller.enqueue(encoder.encode('data: {"a":1}\n\n')); return; }
        if (fail) controller.error(EPROTO());
        else controller.close();
      },
    });
    const response = new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-test': '1' } });
    Object.defineProperty(response, 'url', { value: URL_OK });
    return response;
  };

  const ok = await wrapFetch(async () => respond(false))(URL_OK);
  assert.equal(ok.status, 200);
  assert.equal(ok.url, URL_OK, 'omp replays empty streams against response.url');
  assert.equal(ok.headers.get('x-test'), '1');
  assert.equal(await ok.text(), 'data: {"a":1}\n\n');

  const broken = await wrapFetch(async () => respond(true))(URL_OK);
  const reader = broken.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: {"a":1}\n\n');
  await assert.rejects(reader.read(), /network error .*TLS handshake failed/);
});

test('error responses are returned as they are', async () => {
  const original = new Response('{"error":{"code":503}}', { status: 503 });
  assert.equal(await wrapFetch(async () => original)(URL_OK), original);
});
