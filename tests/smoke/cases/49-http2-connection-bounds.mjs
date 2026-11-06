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
 *   - **idle-timeout bounds a session with no stream open**, at the same
 *     value on every runtime: a session pinged every 250 ms is closed about
 *     800 ms after its response, and a handler slower than the bound is
 *     answered with no GOAWAY under it.
 *   - **The binding report says which protocol a bound holds for.**  On Bun
 *     idle-timeout and request-timeout hold for HTTP/2 only; on Node the
 *     header cap holds for HTTP/1.1 only — and bind() warns in those words.
 *     On Deno the server holds no header cap at all, so a set
 *     max-header-bytes refuses the bind, and the two timeouts are in effect.
 *
 * Skipped where the runtime cannot build `node:http2`'s `createSecureServer`,
 * which Fastify serves HTTP/2 from — deno 2.6.8 answers `ERR_NOT_IMPLEMENTED`;
 * 2.7.13 is the first that serves from one — and the skip names the runtime's
 * own answer.  Fastify on Deno is not a supported
 * pair, which is the reason it is held to what it says rather than skipped
 * once it binds (#1793).  Every binding, session and stream is released on
 * every path.
 */
import { readFile } from 'node:fs/promises';
import { connect as http2Connect } from 'node:http2';

export const name = 'http2 connection bounds';
export const description = 'request-timeout answers a stalled HTTP/2 stream 408 at the deadline and leaves a request received in full to its handler, and idle-timeout closes a session with no stream open at the same value on every runtime, PINGs or not, on the Fastify HTTP/2 listener';

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
/** The idle bound the idle legs bind with. */
const IDLE_TIMEOUT_MS = 800;
/** The latest an idle session may close — the value plus slack, and short of the doubled runtime timer Bun fires. */
const IDLE_CLOSE_WITHIN_MS = IDLE_TIMEOUT_MS + 700;
/** A client that pings well inside the idle bound. */
const PING_INTERVAL_MS = 250;
/** A handler that outlasts the idle bound, and the doubled runtime timer, by a margin jitter does not close. */
const SLOW_IDLE_HANDLER_MS = 2 * IDLE_TIMEOUT_MS + 600;

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

/** One request on `session`; resolves with the status and when the response ended, rejects after the watch. */
function requestOnce(session, requestPath) {
  return new Promise((resolve, reject) => {
    const stream = session.request({ ':path': requestPath });
    let status;
    const watch = setTimeout(() => { stream.destroy(); reject(new Error(`no answer on ${requestPath} within ${WATCH_MS}ms`)); }, WATCH_MS);
    stream.on('response', (response) => { status = Number(response[':status']); });
    stream.on('data', () => { /* drained so the stream can end */ });
    stream.on('error', (e) => { clearTimeout(watch); reject(e); });
    stream.on('end', () => { clearTimeout(watch); resolve({ status, endedAt: performance.now() }); });
    stream.end();
  });
}

/** How long after `since` the server closed `session`, or `null` while it is still open after the watch. */
function sessionClosedAfter(session, since) {
  return new Promise((resolve) => {
    if (session.closed || session.destroyed) { resolve(performance.now() - since); return; }
    const watch = setTimeout(() => resolve(null), WATCH_MS);
    session.once('close', () => { clearTimeout(watch); resolve(performance.now() - since); });
  });
}

/**
 * idle-timeout bounds a session with no stream open — the same value on every
 * runtime, PINGs or not — and never sends a GOAWAY under a request in flight.
 * Before the bound counted streams it was the runtime's own session timer:
 * Bun fired it at twice the value, a PING every 300 ms kept a Bun session open
 * indefinitely, and on both runtimes it fired under a handler still working.
 */
async function idleTimeoutLeg(context, runtime) {
  await withListener(context, (options) => options.withIdleTimeoutMs(IDLE_TIMEOUT_MS), async (session) => {
    const answered = await requestOnce(session, '/');
    const pinger = setInterval(() => {
      if (!session.closed && !session.destroyed) session.ping(() => { /* the answer is not the point */ });
    }, PING_INTERVAL_MS);
    let closedAfterMs;
    try {
      closedAfterMs = await sessionClosedAfter(session, answered.endedAt);
    } finally {
      clearInterval(pinger);
    }
    if (closedAfterMs === null) {
      throw new Error(`an idle HTTP/2 session pinged every ${PING_INTERVAL_MS}ms was still open ${WATCH_MS}ms after its response under a ${IDLE_TIMEOUT_MS}ms idle-timeout on ${runtime}`);
    }
    if (closedAfterMs > IDLE_CLOSE_WITHIN_MS || closedAfterMs < IDLE_TIMEOUT_MS / 2) {
      throw new Error(`an idle HTTP/2 session closed ${Math.round(closedAfterMs)}ms after its response, outside ${IDLE_TIMEOUT_MS / 2}–${IDLE_CLOSE_WITHIN_MS}ms for a ${IDLE_TIMEOUT_MS}ms idle-timeout on ${runtime}`);
    }
  });
  await withListener(context, (options) => options.withIdleTimeoutMs(IDLE_TIMEOUT_MS), async (session) => {
    let goawayAt = null;
    session.on('goaway', () => { goawayAt ??= performance.now(); });
    const answered = await requestOnce(session, '/slow-get');
    if (answered.status !== 200) {
      throw new Error(`a handler that outlasted idle-timeout was answered ${answered.status} on ${runtime}`);
    }
    if (goawayAt !== null && goawayAt < answered.endedAt) {
      throw new Error(`a GOAWAY arrived ${Math.round(answered.endedAt - goawayAt)}ms before the response of a handler still working on ${runtime} — idle-timeout fired under a request in flight`);
    }
  });
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
  const { HttpExtensionId, HttpServerOptions, completeText, concat, get, path, post } = await loadEntry('http');
  const routes = concat(
    path('', get(() => completeText(200, 'ok'))),
    path('upload', post(() => completeText(200, 'uploaded'))),
    path('slow', post(async () => {
      await new Promise((resolve) => { setTimeout(resolve, SLOW_HANDLER_MS); }); // the handler's own work, which the deadline must not cut
      return completeText(200, 'slow');
    })),
    path('slow-get', get(async () => {
      await new Promise((resolve) => { setTimeout(resolve, SLOW_IDLE_HANDLER_MS); }); // a request in flight, which idle-timeout must not interrupt
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
    await idleTimeoutLeg(context, runtime);
  } finally {
    await system.terminate();
  }
  await reportLeg({ actorTs, HttpExtensionId, HttpServerOptions, routes, cert, key, ca }, runtime);
}

/**
 * The report leg on Deno, whose `node:http2` secure server has no
 * `maxHeaderSize` and ignores the option — a 4 KiB header was answered `200`
 * over its HTTP/1.1 fallback under a 1 KiB cap on deno 2.9.8, where Node
 * answered `431` — so a set max-header-bytes must refuse the bind, naming the
 * key, rather than bind uncapped.  Without it, idle-timeout and
 * request-timeout must read in effect with nothing warned: from deno 2.7.13,
 * the first release that builds this server at all, both hold on its HTTP/1.1
 * fallback as on Node (1.7 s idle close, `408` at 30 s), and the two legs
 * above hold them over HTTP/2.
 */
async function denoReportLeg({ actorTs, HttpExtensionId, HttpServerOptions, routes, cert, key }) {
  const { ActorSystem, ActorSystemOptions, LogLevel } = actorTs;
  const bindUnder = async (server) => {
    const { logger, warnings } = recordingLogger(LogLevel);
    const systemOptions = ActorSystemOptions.create()
      .withLogger(logger)
      .withLogLevel(LogLevel.Info)
      .withConfig({ 'actor-ts': { http: { backend: 'fastify', server } } });
    const system = ActorSystem.create('smoke-http2-report', systemOptions);
    let binding;
    try {
      const serverOptions = HttpServerOptions.create().withTls({ cert, key }).withHttp2();
      binding = await system.extension(HttpExtensionId)
        .newServerAt('127.0.0.1', 0)
        .withServerOptions(serverOptions)
        .bind(routes);
      return { report: binding.serverOptionsReport, said: warnings() };
    } catch (e) {
      return { refused: e };
    } finally {
      if (binding) await binding.unbind().catch(() => {});
      await system.terminate();
    }
  };
  const capped = await bindUnder({ 'idle-timeout': '800ms', 'request-timeout': '20s', 'max-header-bytes': 1024 });
  if (!capped.refused || !capped.refused.message.includes('max-header-bytes')) {
    throw new Error(`the HTTP/2 listener bound under max-header-bytes on deno, whose server holds no header cap — it must refuse, naming the key${capped.refused ? `; it refused with: ${capped.refused.message}` : ''}`);
  }
  const uncapped = await bindUnder({ 'idle-timeout': '800ms', 'request-timeout': '20s' });
  if (uncapped.refused) throw new Error(`the HTTP/2 listener did not bind on deno without max-header-bytes: ${uncapped.refused.message}`);
  const actual = { idleTimeoutMs: uncapped.report?.idleTimeoutMs, requestTimeoutMs: uncapped.report?.requestTimeoutMs, held: uncapped.report?.heldForOneProtocol ?? {} };
  const expected = { idleTimeoutMs: true, requestTimeoutMs: true, held: {} };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`the HTTP/2 listener's report on deno is ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}`);
  }
  if (uncapped.said.length !== 0) throw new Error(`bind() warned on deno about bounds that hold: ${JSON.stringify(uncapped.said)}`);
}

/** Collects what the system logged, children included — the shape the unit suites use for bind()'s warnings. */
function recordingLogger(LogLevel) {
  const records = [];
  const make = () => ({
    level: LogLevel.Info,
    debug: (message) => { records.push({ level: 'debug', message: String(message) }); },
    info: (message) => { records.push({ level: 'info', message: String(message) }); },
    warn: (message) => { records.push({ level: 'warn', message: String(message) }); },
    error: (message) => { records.push({ level: 'error', message: String(message) }); },
    withSource: () => make(),
    withFields: () => make(),
  });
  return { logger: make(), warnings: () => records.filter((record) => record.level === 'warn').map((record) => record.message) };
}

/**
 * What the binding report and bind()'s warning say about the HTTP/2 listener
 * on this runtime, and the runtime facts they rest on.  A connection that
 * negotiates HTTP/1.1 on Bun's HTTP/2 listener reads neither keepAliveTimeout
 * nor requestTimeout, so there the two bounds hold for HTTP/2 only; under
 * Node they hold for both.  The header cap is the other way round: Bun caps an
 * HTTP/2 stream's header list with it (a 4 KiB one is reset under 1 KiB) and
 * Node does not (the same stream reaches the handler), so under Node it holds
 * for HTTP/1.1 only.  Before the report said so, every one of these read "in
 * effect" and bind() said nothing.
 */
async function reportLeg(context, runtime) {
  if (runtime === 'deno') {
    await denoReportLeg(context);
    return;
  }
  const { actorTs, HttpExtensionId, HttpServerOptions, routes, cert, key, ca } = context;
  const { ActorSystem, ActorSystemOptions, LogLevel } = actorTs;
  const { logger, warnings } = recordingLogger(LogLevel);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(logger)
    .withLogLevel(LogLevel.Info)
    .withConfig({
      'actor-ts': {
        http: {
          backend: 'fastify',
          server: { 'idle-timeout': '800ms', 'request-timeout': '20s', 'max-header-bytes': 1024 },
        },
      },
    });
  const system = ActorSystem.create('smoke-http2-report', systemOptions);
  let binding;
  let session;
  try {
    const serverOptions = HttpServerOptions.create().withTls({ cert, key }).withHttp2();
    binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .withServerOptions(serverOptions)
      .bind(routes);
    const report = binding.serverOptionsReport;
    const held = report?.heldForOneProtocol ?? {};
    const said = warnings();
    if (said.length !== 1) {
      throw new Error(`bind() logged ${said.length} warnings on ${runtime}, not one: ${JSON.stringify(said)}`);
    }
    const expected = runtime === 'bun'
      ? { idleTimeoutMs: false, requestTimeoutMs: false, maxHeaderBytes: true, held: { idleTimeoutMs: 'HTTP/2', requestTimeoutMs: 'HTTP/2' } }
      : { idleTimeoutMs: true, requestTimeoutMs: true, maxHeaderBytes: false, held: { maxHeaderBytes: 'HTTP/1.1' } };
    const actual = { idleTimeoutMs: report?.idleTimeoutMs, requestTimeoutMs: report?.requestTimeoutMs, maxHeaderBytes: report?.maxHeaderBytes, held };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`the HTTP/2 listener's report on ${runtime} is ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}`);
    }
    const phrase = runtime === 'bun' ? 'for HTTP/2 only' : 'for HTTP/1.1 only';
    if (!said[0].includes(phrase)) {
      throw new Error(`bind()'s warning on ${runtime} does not say the bound holds ${phrase}: ${said[0]}`);
    }
    // The runtime fact the header-cap answer rests on: a 4 KiB header list
    // over HTTP/2 under the 1 KiB cap.
    session = http2Connect(`https://127.0.0.1:${binding.port}`, { ca, servername: 'localhost' });
    session.on('error', () => { /* observed through the stream outcome */ });
    const oversized = await watchStream(session, { ':method': 'GET', ':path': '/', 'x-padding': 'a'.repeat(4096) }, (stream) => { stream.end(); });
    const capped = oversized.status === undefined;
    if (capped !== (runtime === 'bun')) {
      throw new Error(`a 4 KiB HTTP/2 header list under max-header-bytes = 1024 was ${capped ? 'refused' : `answered ${oversized.status}`} on ${runtime} — the runtime no longer does what the report says it does`);
    }
  } finally {
    session?.destroy();
    if (binding) await binding.unbind().catch(() => {});
    await system.terminate();
  }
}
