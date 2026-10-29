/**
 * Smoke case: the connection bounds of the default backend's HTTP/2
 * listener — Fastify over `withTls` + `withHttp2` — on the runtime the user
 * actually runs (#870).
 *
 * `tests/unit/http/Http2StreamRequestTimeout.test.ts` proves the mechanism
 * under `bun test`, which is always Bun's HTTP/2 server.  This case binds the
 * same listener on whichever runtime the harness is on, so Node's own
 * `http2.createSecureServer` is held to the same rules:
 *
 *   - **request-timeout bounds an HTTP/2 stream's receive.**  A POST that
 *     announces 1000 bytes and sends 10 is answered `408` and reset at the
 *     deadline, and a request received in full is left to a handler slower
 *     than the deadline.  Measured before the stream deadline existed, the
 *     stalled stream was still open 12 s later on both runtimes.
 *
 * Skipped where the runtime cannot build `node:http2`'s `createSecureServer`,
 * which Fastify serves HTTP/2 from — Deno 2.6.8 answers `ERR_NOT_IMPLEMENTED`,
 * and Fastify on Deno is not a supported pair — and the skip names the
 * runtime's own answer.  Every binding, session and stream is released on
 * every path.
 */
import { readFile } from 'node:fs/promises';
import { connect as http2Connect } from 'node:http2';

export const name = 'http2 connection bounds';
export const description = 'request-timeout answers a stalled HTTP/2 stream 408 at the deadline and leaves a request received in full to its handler, on Fastify\'s HTTP/2 listener';

const FIXTURES = new URL('../../fixtures/tls/', import.meta.url);
/** The request deadline the listener is bound with. */
const REQUEST_TIMEOUT_MS = 1_000;
/** The latest a stalled stream may be answered — the deadline plus slack for a loaded runner. */
const CUT_WITHIN_MS = REQUEST_TIMEOUT_MS + 1_500;
/** The earliest: half the deadline, so a stream cut at once reads as wrong too. */
const CUT_NOT_BEFORE_MS = REQUEST_TIMEOUT_MS / 2;
/** A handler slower than the deadline. */
const SLOW_HANDLER_MS = REQUEST_TIMEOUT_MS + 800;
/** How long a stream is watched before it counts as never answered. */
const WATCH_MS = 4_000;

/**
 * Open a stream with `headers`, let `feed` write to it, and resolve with the
 * status the server answered and how long after opening the stream closed —
 * `null` when it was still open after {@link WATCH_MS}.  The stream is
 * destroyed on every path.
 */
function watchStream(session, headers, feed) {
  return new Promise((resolve) => {
    const openedAt = performance.now();
    const stream = session.request(headers, { endStream: false });
    let status;
    stream.on('response', (response) => { status = Number(response[':status']); });
    stream.on('data', () => { /* drained so the stream can end */ });
    stream.on('error', () => { /* a reset is an outcome, read from 'close' */ });
    feed(stream);
    const finish = (closedAfterMs) => {
      clearTimeout(watch);
      stream.destroy();
      resolve({ status, closedAfterMs });
    };
    const watch = setTimeout(() => finish(null), WATCH_MS);
    stream.once('close', () => finish(performance.now() - openedAt));
  });
}

/** Bind Fastify over TLS + HTTP/2 under `configure`, run `leg` with a client session, and release both on every path. */
async function withListener({ system, HttpExtensionId, HttpServerOptions, routes, cert, key, ca }, configure, leg) {
  const serverOptions = configure(HttpServerOptions.create().withTls({ cert, key }).withHttp2());
  const binding = await system.extension(HttpExtensionId)
    .newServerAt('127.0.0.1', 0)
    .withServerOptions(serverOptions)
    .bind(routes);
  let session;
  try {
    session = http2Connect(`https://127.0.0.1:${binding.port}`, { ca, servername: 'localhost' });
    session.on('error', () => { /* observed through the stream outcomes */ });
    await leg(session, binding);
  } finally {
    session?.destroy();
    await binding.unbind().catch(() => {});
  }
}

async function requestTimeoutLeg(context, runtime) {
  await withListener(context, (options) => options.withRequestTimeoutMs(REQUEST_TIMEOUT_MS), async (session) => {
    const stalled = await watchStream(
      session,
      { ':method': 'POST', ':path': '/upload', 'content-length': '1000' },
      (stream) => { stream.write(Buffer.alloc(10, 0x61)); },
    );
    if (session.alpnProtocol !== 'h2') {
      throw new Error(`the listener negotiated ${session.alpnProtocol}, not h2 — the case proves nothing about streams`);
    }
    if (stalled.closedAfterMs === null) {
      throw new Error(`a stalled HTTP/2 stream was still open ${WATCH_MS}ms after it opened under a ${REQUEST_TIMEOUT_MS}ms request-timeout on ${runtime}`);
    }
    if (stalled.status !== 408) {
      throw new Error(`a stalled HTTP/2 stream was cut without a 408 (status ${stalled.status}) on ${runtime}`);
    }
    if (stalled.closedAfterMs > CUT_WITHIN_MS || stalled.closedAfterMs < CUT_NOT_BEFORE_MS) {
      throw new Error(`a stalled HTTP/2 stream was cut ${Math.round(stalled.closedAfterMs)}ms after it opened, outside ${CUT_NOT_BEFORE_MS}–${CUT_WITHIN_MS}ms for a ${REQUEST_TIMEOUT_MS}ms request-timeout on ${runtime}`);
    }
    const whole = await watchStream(
      session,
      { ':method': 'POST', ':path': '/slow', 'content-length': '5' },
      (stream) => { stream.end('hello'); },
    );
    if (whole.status !== 200) {
      throw new Error(`a request received in full was answered ${whole.status} while its handler outlasted request-timeout on ${runtime} — the deadline cut a response`);
    }
  });
}

/**
 * Whether this runtime can build the server Fastify serves HTTP/2 from.  Asked
 * of the runtime rather than read off its name: deno 2.6.8 answers
 * `ERR_NOT_IMPLEMENTED`, and a Deno that grows the function should run the
 * case instead of skipping it on reputation.  The probe server is closed on
 * every path.
 */
async function canServeHttp2(cert, key) {
  const { createSecureServer } = await import('node:http2');
  try {
    const server = createSecureServer({ cert, key });
    server.close();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `${e.code ?? ''} ${e.message}`.trim() };
  }
}

export async function run({ actorTs, runtime, loadEntry }) {
  const [cert, key, ca] = await Promise.all([
    readFile(new URL('localhost-cert.pem', FIXTURES), 'utf8'),
    readFile(new URL('localhost-key.pem', FIXTURES), 'utf8'),
    readFile(new URL('test-ca.pem', FIXTURES), 'utf8'),
  ]);
  const http2Server = await canServeHttp2(cert, key);
  if (!http2Server.ok) {
    console.log(`  (skipped: ${runtime} cannot build node:http2's createSecureServer, which Fastify serves HTTP/2 from — ${http2Server.reason})`);
    return;
  }
  const { ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } = actorTs;
  const { HttpExtensionId, HttpServerOptions, completeText, concat, path, post } = await loadEntry('http');
  const routes = concat(
    path('upload', post(() => completeText(200, 'uploaded'))),
    path('slow', post(async () => {
      await new Promise((resolve) => { setTimeout(resolve, SLOW_HANDLER_MS); }); // the handler's own work, which the deadline must not cut
      return completeText(200, 'slow');
    })),
  );
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig({ 'actor-ts': { http: { backend: 'fastify' } } });
  const system = ActorSystem.create('smoke-http2-connection-bounds', systemOptions);
  try {
    const context = { system, HttpExtensionId, HttpServerOptions, routes, cert, key, ca };
    await requestTimeoutLeg(context, runtime);
  } finally {
    await system.terminate();
  }
}
