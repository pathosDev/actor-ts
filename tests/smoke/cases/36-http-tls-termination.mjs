/**
 * Smoke case: the HTTP server **terminates TLS on every runtime**, through one
 * option shape (#1522).
 *
 * `tests/unit/http/HttpServerTls.test.ts` proves the mechanism on Bun — and
 * drives the Node runner under Bun, since `@hono/node-server` sits on
 * `node:https` / `node:http2`, which Bun implements.  What that cannot show is
 * the runtime the user actually runs: `Deno.serve({ cert, key })` is reached
 * only on Deno, and `http2.createSecureServer` is Node's own only on Node.
 * This case binds the Hono backend with the test certificate on whichever
 * runtime the harness is on, and fetches over HTTPS **verifying against the
 * test CA** — never `rejectUnauthorized: false`, because a client that skips
 * verification would pass against a listener terminating with the wrong
 * material, and "the process is the TLS endpoint" is the whole claim.
 *
 * The client is `node:https` with `ca`, which all three runtimes provide, so
 * the case stays runtime-neutral: the one runtime-specific thing in it is the
 * server, and that is the thing under test.
 *
 * Skips when `hono` cannot be loaded on this runtime, like the other Hono
 * cases — but once a server binds, the verified HTTPS request MUST succeed and
 * a cleartext request to the same port MUST fail.
 *
 * On Node it also holds the header deadline over TLS (#870), which is the one
 * place `bun test` cannot reach: Node's TLS server hands `'connection'` the raw
 * TCP socket and a request the separate TLS socket, while Bun hands both the
 * same object.  A deadline that stayed on the TCP socket therefore reset every
 * healthy HTTPS connection on Node one header timeout after it opened, and
 * wrote its `408` beneath TLS where no client could read it.  Hono on Node
 * exposes its `https.Server` to the guard; on Bun and Deno it runs on
 * `Bun.serve` / `Deno.serve`, which expose no server for it at all, so there
 * is nothing to observe there — `tests/unit/http/HeaderDeadlineTransports.test.ts`
 * covers Bun's own TLS and HTTP/2 servers.
 *
 * On Node it also holds `idle-timeout` on an HTTP/2 session (#870), the other
 * thing only Node's own `http2.createSecureServer` can show: `keepAliveTimeout`
 * is an HTTP/1.1 property no HTTP/2 session reads, so the bound reaches a
 * session through the session's own timer.  Measured on node v26.10.0, an idle
 * session closed 0.81 s after its response under an 800 ms idle-timeout, and
 * was still open past 5 s with the timer left unarmed.  Bun fires the same
 * timer at twice the value; `tests/unit/http/Http2SessionIdle.test.ts` covers
 * that under `bun test`.
 */
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { connect as http2Connect } from 'node:http2';
import { connect as tlsConnect } from 'node:tls';

export const name = 'http tls termination';
export const description = 'the Hono backend terminates TLS with a CA-verified client on every runtime, and on Node holds the header deadline inside TLS and idle-timeout on an HTTP/2 session';

const FIXTURES = new URL('../../fixtures/tls/', import.meta.url);
const SETTLE_TIMEOUT_MS = 5_000;
/** The header deadline the server is bound with — short, so the Node checks stay quick. */
const HEADER_DEADLINE_MS = 1_000;
/** How long a connection that must survive the deadline is watched. */
const SURVIVAL_WINDOW_MS = 2_500;
/** How long a slow-loris may take to be cut: the deadline plus slack for a loaded runner. */
const EXPIRY_WINDOW_MS = 4_000;
/** The idle-timeout the HTTP/2 server is bound with. */
const H2_IDLE_TIMEOUT_MS = 1_000;
/** The latest an idle session may close on Node — the value plus slack for a loaded runner. */
const H2_CLOSE_WITHIN_MS = H2_IDLE_TIMEOUT_MS + 1_500;
/** The earliest it may: half the value, so a session closed at once reads as wrong too. */
const H2_CLOSE_NOT_BEFORE_MS = H2_IDLE_TIMEOUT_MS / 2;
/** How long the idle session is watched — past the window, so a session never closed says so. */
const H2_WATCH_MS = 4_000;

/** One request through `node:https` / `node:http`; resolves with status and body, rejects on any socket error. */
function requestOnce(transport, options) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no response within ${SETTLE_TIMEOUT_MS}ms`)), SETTLE_TIMEOUT_MS);
    const req = transport({ method: 'GET', path: '/', ...options }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, body }); });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

/**
 * A CA-verified TLS connection that writes `payload` once the handshake is
 * done, watched until the server closes it or `withinMs` passes.  The socket
 * is destroyed on every path, so no outcome leaves a handle open.
 */
function watchTls({ port, ca, payload, withinMs }) {
  return new Promise((resolve) => {
    let received = '';
    let settled = false;
    let timer;
    const socket = tlsConnect({ host: '127.0.0.1', port, ca, servername: 'localhost' }, () => { socket.write(payload); });
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ closed, received });
    };
    socket.on('data', (chunk) => { received += chunk.toString('latin1'); });
    socket.on('error', () => { /* a reset is observed as the 'close' that follows */ });
    socket.once('close', () => finish(true));
    timer = setTimeout(() => finish(false), withinMs);
  });
}

/** One request on an HTTP/2 session; resolves with status and when the response ended, rejects on error or after the settle timeout. */
function http2RequestOnce(session) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no HTTP/2 response within ${SETTLE_TIMEOUT_MS}ms`)), SETTLE_TIMEOUT_MS);
    const req = session.request({ ':path': '/' });
    let status;
    req.on('response', (headers) => { status = headers[':status']; });
    req.on('data', () => { /* drained, or 'end' never comes */ });
    req.on('end', () => { clearTimeout(timer); resolve({ status, endedAt: performance.now() }); });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/** How long after `since` the server closed `session`, or `null` if it is still open after `withinMs`. */
function sessionClosedAfter(session, since, withinMs) {
  return new Promise((resolve) => {
    if (session.closed || session.destroyed) {
      resolve(performance.now() - since);
      return;
    }
    const timer = setTimeout(() => resolve(null), withinMs);
    session.once('close', () => { clearTimeout(timer); resolve(performance.now() - since); });
  });
}

/**
 * Node only: an HTTP/2 session that completed a request is closed at
 * idle-timeout.  A server of its own, because the HTTP/1.1 legs above must
 * outlive a header deadline that an idle bound this short would cut first.
 * The binding and the client session are released on every path.
 */
async function http2IdleLeg({ system, HttpExtensionId, HttpServerOptions, routes, cert, key, ca }) {
  const serverOptions = HttpServerOptions.create()
    .withTls({ cert, key })
    .withHttp2()
    .withIdleTimeoutMs(H2_IDLE_TIMEOUT_MS);
  const binding = await system.extension(HttpExtensionId)
    .newServerAt('127.0.0.1', 0)
    .withServerOptions(serverOptions)
    .bind(routes);
  let session;
  try {
    session = http2Connect(`https://127.0.0.1:${binding.port}`, { ca, servername: 'localhost' });
    session.on('error', () => { /* a reset is observed as the 'close' that follows */ });
    const answered = await http2RequestOnce(session);
    if (session.alpnProtocol !== 'h2') {
      throw new Error(`the HTTP/2 leg negotiated ${session.alpnProtocol}, not h2 — it proves nothing about sessions`);
    }
    if (answered.status !== 200) throw new Error(`the HTTP/2 request answered ${answered.status}`);
    const closedAfterMs = await sessionClosedAfter(session, answered.endedAt, H2_WATCH_MS);
    if (closedAfterMs === null) {
      throw new Error(`an idle HTTP/2 session was still open ${H2_WATCH_MS}ms after its response under a ${H2_IDLE_TIMEOUT_MS}ms idle-timeout — the bound never reached the session`);
    }
    if (closedAfterMs > H2_CLOSE_WITHIN_MS || closedAfterMs < H2_CLOSE_NOT_BEFORE_MS) {
      throw new Error(`an idle HTTP/2 session closed ${Math.round(closedAfterMs)}ms after its response, outside ${H2_CLOSE_NOT_BEFORE_MS}–${H2_CLOSE_WITHIN_MS}ms for a ${H2_IDLE_TIMEOUT_MS}ms idle-timeout`);
    }
  } finally {
    session?.destroy();
    await binding.unbind().catch(() => {});
  }
}

export async function run({ actorTs, runtime, loadEntry }) {
  const { ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } = actorTs;
  const { HttpExtensionId, HttpServerOptions, completeText, get, path } = await loadEntry('http');

  try {
    await import('hono');
  } catch (e) {
    console.log(`  (skipped: hono not loadable on this runtime — ${e.message})`);
    return;
  }

  const [cert, key, ca] = await Promise.all([
    readFile(new URL('localhost-cert.pem', FIXTURES), 'utf8'),
    readFile(new URL('localhost-key.pem', FIXTURES), 'utf8'),
    readFile(new URL('test-ca.pem', FIXTURES), 'utf8'),
  ]);

  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig({ 'actor-ts': { http: { backend: 'hono' } } });
  const system = ActorSystem.create('smoke-http-tls', systemOptions);
  const routes = path('', get(() => completeText(200, 'tls on this runtime')));
  let binding;
  try {
    const serverOptions = HttpServerOptions.create()
      .withTls({ cert, key })
      .withHeaderTimeoutMs(HEADER_DEADLINE_MS);
    try {
      binding = await system.extension(HttpExtensionId)
        .newServerAt('127.0.0.1', 0)
        .withServerOptions(serverOptions)
        .bind(routes);
    } catch (e) {
      console.log(`  (skipped: could not bind a TLS server on this runtime — ${e.message})`);
      return;
    }

    /* --- 1. a CA-verified HTTPS request is answered ---------------------- */
    const verified = await requestOnce(httpsRequest, { host: '127.0.0.1', port: binding.port, ca, servername: 'localhost' });
    if (verified.status !== 200 || verified.body !== 'tls on this runtime') {
      throw new Error(`verified HTTPS request answered ${verified.status} ${JSON.stringify(verified.body)}`);
    }

    /* --- 2. cleartext to the same port is refused at the socket ------------ */
    // Not a redirect and not a 400: the socket speaks TLS or nothing, so the
    // client-side failure is what proves the listener is the TLS endpoint.
    let cleartext;
    try {
      cleartext = await requestOnce(httpRequest, { host: '127.0.0.1', port: binding.port });
    } catch {
      cleartext = null;
    }
    if (cleartext !== null) {
      throw new Error(`a cleartext request to the TLS port was answered ${cleartext.status} — TLS is not being terminated`);
    }

    if (runtime === 'node') {
      /* --- 3. a kept-alive HTTPS connection outlives the header deadline ------ */
      const complete = 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n';
      const kept = await watchTls({ port: binding.port, ca, payload: complete, withinMs: SURVIVAL_WINDOW_MS });
      if (!kept.received.includes('200')) {
        throw new Error(`the kept-alive HTTPS request was not answered: ${JSON.stringify(kept.received.slice(0, 60))}`);
      }
      if (kept.closed) {
        throw new Error('a kept-alive HTTPS connection was torn down by the header deadline — it stayed on the TCP socket instead of following the connection into TLS');
      }

      /* --- 4. a TLS slow-loris is still cut, and answered 408 inside TLS ------ */
      const partial = 'GET / HTTP/1.1\r\nHost: localhost\r\n';
      const slow = await watchTls({ port: binding.port, ca, payload: partial, withinMs: EXPIRY_WINDOW_MS });
      if (!slow.closed) {
        throw new Error(`a TLS slow-loris was not cut within ${EXPIRY_WINDOW_MS}ms of a ${HEADER_DEADLINE_MS}ms header deadline`);
      }
      if (!slow.received.includes('408 Request Timeout')) {
        throw new Error('a TLS slow-loris was cut without a readable 408 — the status line went out beneath TLS');
      }

      /* --- 5. an idle HTTP/2 session is closed at idle-timeout ---------------- */
      await http2IdleLeg({ system, HttpExtensionId, HttpServerOptions, routes, cert, key, ca });
    }
  } finally {
    if (binding) await binding.unbind().catch(() => {});
    await system.terminate();
  }
}
