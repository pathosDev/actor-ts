/**
 * Smoke case: the HTTP server **terminates TLS on every runtime**, through one
 * option shape (#1522), on the Hono backend and on the Express backend.
 *
 * `tests/unit/http/HttpServerTls.test.ts` proves the mechanism on Bun — and
 * drives the Node runner under Bun, since `@hono/node-server` sits on
 * `node:https` / `node:http2`, which Bun implements.  What that cannot show is
 * the runtime the user actually runs: `Deno.serve({ cert, key })` is reached
 * only on Deno, and `http2.createSecureServer` is Node's own only on Node.
 * This case binds each backend with the test certificate on whichever runtime
 * the harness is on, and fetches over HTTPS **verifying against the test CA**
 * — never `rejectUnauthorized: false`, because a client that skips
 * verification would pass against a listener terminating with the wrong
 * material, and "the process is the TLS endpoint" is the whole claim.
 *
 * The client is `node:https` with `ca`, which all three runtimes provide, so
 * the case stays runtime-neutral: the one runtime-specific thing in it is the
 * server, and that is the thing under test.
 *
 * Each arm skips when its framework cannot be loaded on this runtime, like the
 * other Hono and Express cases — but once a server binds, the verified HTTPS
 * request MUST succeed and a cleartext request to the same port MUST fail.  The
 * Express arm does not skip on a failed bind either: Express builds its server
 * with `node:https` on every runtime, so a bind that fails once `express` loads
 * is a regression, not a runtime gap.
 *
 * Client certificates are checked per backend and per runtime, since that is
 * where the runtimes part ways.  On Node and Bun a `requestClientCert` demand
 * is enforced against the configured `ca` by Hono, Fastify and Express alike:
 * a client certificate minted for the run and signed by that CA is answered,
 * one signed by an unrelated CA — or none — is refused.  On Deno neither
 * `Deno.serve` nor its `node:https` enforces a demand, so every backend must
 * refuse to bind under one (#1522).
 *
 * On Node it also holds the header deadline over TLS (#870), on both backends,
 * which is the one place `bun test` cannot reach: Node's TLS server hands
 * `'connection'` the raw TCP socket and a request the separate TLS socket,
 * while Bun hands both the same object.  A deadline that stayed on the TCP
 * socket therefore reset every healthy HTTPS connection on Node one header
 * timeout after it opened, and wrote its `408` beneath TLS where no client
 * could read it.  Hono on Node and Express everywhere expose their
 * `https.Server` to the guard; Hono on Bun and Deno runs on `Bun.serve` /
 * `Deno.serve`, which expose no server for it at all, and Deno's `node:https`
 * emits no `'connection'` for Express — so there is nothing to observe off
 * Node, and `tests/unit/http/HeaderDeadlineTransports.test.ts` covers Bun's own
 * TLS and HTTP/2 servers.
 *
 * On Node it also holds `idle-timeout` on an HTTP/2 session (#870), the other
 * thing only Node's own `http2.createSecureServer` can show: `keepAliveTimeout`
 * is an HTTP/1.1 property no HTTP/2 session reads, so the bound reaches a
 * session through the session's own timer.  Measured on node v26.10.0, an idle
 * session closed 0.81 s after its response under an 800 ms idle-timeout, and
 * was still open past 5 s with the timer left unarmed.  Bun fires the same
 * timer at twice the value; `tests/unit/http/Http2SessionIdle.test.ts` covers
 * that under `bun test`.  Hono only: Express refuses `http2`.
 */
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { connect as http2Connect } from 'node:http2';
import { connect as tlsConnect } from 'node:tls';

export const name = 'http tls termination';
export const description = 'the Hono and Express backends terminate TLS with a CA-verified client on every runtime, Hono, Fastify and Express verify a client certificate against the configured ca (or, on Deno, refuse the demand), and on Node both hold the header deadline inside TLS and Hono idle-timeout on an HTTP/2 session';

const FIXTURES = new URL('../../fixtures/tls/', import.meta.url);
const SETTLE_TIMEOUT_MS = 5_000;
/** The header deadline the servers are bound with — short, so the Node checks stay quick. */
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

/**
 * One request through `node:https` / `node:http`; resolves with status and
 * body, rejects on any socket error or after the settle timeout.  The request
 * is destroyed on the timeout path too: a socket left open there keeps Deno's
 * event loop alive after the last case (#1196).
 */
function requestOnce(transport, options) {
  return new Promise((resolve, reject) => {
    let req;
    const timer = setTimeout(() => {
      req?.destroy();
      reject(new Error(`no response within ${SETTLE_TIMEOUT_MS}ms`));
    }, SETTLE_TIMEOUT_MS);
    req = transport({ method: 'GET', path: '/', ...options }, (res) => {
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

/** Whether `specifier` can be imported on this runtime, and why not when it cannot. */
async function loadable(specifier) {
  try {
    await import(specifier);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * The two claims every arm makes on every runtime: a CA-verified HTTPS request
 * is answered, and cleartext to the same port is refused at the socket — not a
 * redirect and not a 400, since the socket speaks TLS or nothing and the
 * client-side failure is what proves the listener is the TLS endpoint.
 */
async function assertTerminatesTls({ label, port, ca }) {
  let verified;
  try {
    verified = await requestOnce(httpsRequest, { host: '127.0.0.1', port, ca, servername: 'localhost' });
  } catch (e) {
    throw new Error(`[${label}] the verified HTTPS request failed — ${e.message}`);
  }
  if (verified.status !== 200 || verified.body !== 'tls on this runtime') {
    throw new Error(`[${label}] verified HTTPS request answered ${verified.status} ${JSON.stringify(verified.body)}`);
  }
  let cleartext;
  try {
    cleartext = await requestOnce(httpRequest, { host: '127.0.0.1', port });
  } catch {
    cleartext = null;
  }
  if (cleartext !== null) {
    throw new Error(`[${label}] a cleartext request to the TLS port was answered ${cleartext.status} — TLS is not being terminated`);
  }
}

/**
 * Node only: the header deadline follows the connection into TLS.  A kept-alive
 * HTTPS connection outlives it, and a TLS slow-loris is still cut and answered
 * `408` inside TLS.
 */
async function assertHeaderDeadlineInsideTls({ label, port, ca }) {
  const complete = 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n';
  const kept = await watchTls({ port, ca, payload: complete, withinMs: SURVIVAL_WINDOW_MS });
  if (!kept.received.includes('200')) {
    throw new Error(`[${label}] the kept-alive HTTPS request was not answered: ${JSON.stringify(kept.received.slice(0, 60))}`);
  }
  if (kept.closed) {
    throw new Error(`[${label}] a kept-alive HTTPS connection was torn down by the header deadline — it stayed on the TCP socket instead of following the connection into TLS`);
  }

  const partial = 'GET / HTTP/1.1\r\nHost: localhost\r\n';
  const slow = await watchTls({ port, ca, payload: partial, withinMs: EXPIRY_WINDOW_MS });
  if (!slow.closed) {
    throw new Error(`[${label}] a TLS slow-loris was not cut within ${EXPIRY_WINDOW_MS}ms of a ${HEADER_DEADLINE_MS}ms header deadline`);
  }
  if (!slow.received.includes('408 Request Timeout')) {
    throw new Error(`[${label}] a TLS slow-loris was cut without a readable 408 — the status line went out beneath TLS`);
  }
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

/** The Hono arm: the backend the system is configured with, on this runtime's runner. */
async function honoArm(context) {
  const { system, runtime, HttpExtensionId, serverOptions, routes, ca } = context;
  let binding;
  try {
    try {
      binding = await system.extension(HttpExtensionId)
        .newServerAt('127.0.0.1', 0)
        .withServerOptions(serverOptions)
        .bind(routes);
    } catch (e) {
      console.log(`  (hono arm skipped: could not bind a TLS server on this runtime — ${e.message})`);
      return false;
    }
    await assertTerminatesTls({ label: 'hono', port: binding.port, ca });
    if (runtime === 'node') {
      await assertHeaderDeadlineInsideTls({ label: 'hono', port: binding.port, ca });
      await http2IdleLeg(context);
    }
    return true;
  } finally {
    if (binding) await binding.unbind().catch(() => {});
  }
}

/*
 * Client certificates minted for the run — the fixtures hold none, and no
 * private key is committed for one.  `node:crypto` makes the key pairs and
 * signs, but nothing in the platform builds a certificate, so the DER is
 * written here: ECDSA P-256 with SHA-256, a CA marked `CA:TRUE` with
 * `keyCertSign`, a leaf marked `CA:FALSE` with `digitalSignature` and
 * `clientAuth`, valid 2020-2049 so nothing reads the clock.  The same shape
 * as `tests/unit/http/_TestCertificateAuthority.ts`, kept in this file because
 * the cases are self-contained.
 */
function derConcat(parts) {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function derElement(tag, ...content) {
  const body = derConcat(content);
  const length = [];
  for (let rest = body.length; rest > 0; rest = Math.floor(rest / 256)) length.unshift(rest % 256);
  const header = body.length < 0x80 ? [tag, body.length] : [tag, 0x80 | length.length, ...length];
  return derConcat([Uint8Array.from(header), body]);
}

function derObjectIdentifier(dotted) {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const out = [40 * first + second];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let high = Math.floor(arc / 128); high > 0; high = Math.floor(high / 128)) chunk.unshift(0x80 | (high & 0x7f));
    out.push(...chunk);
  }
  return derElement(0x06, Uint8Array.from(out));
}

async function mintCertificate(commonName, issuer, authority) {
  const { createHash, generateKeyPairSync, randomBytes, sign } = await import('node:crypto');
  const { Buffer } = await import('node:buffer');
  const text = (value) => new TextEncoder().encode(value);
  const sequence = (...content) => derElement(0x30, ...content);
  const yes = () => derElement(0x01, Uint8Array.of(0xff));
  const name = (common) => sequence(derElement(0x31, sequence(derObjectIdentifier('2.5.4.3'), derElement(0x0c, text(common)))));
  const extension = (id, critical, value) => sequence(derObjectIdentifier(id), ...(critical ? [yes()] : []), derElement(0x04, value));
  const ecdsaWithSha256 = derObjectIdentifier('1.2.840.10045.4.3.2');
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const subjectPublicKeyInfo = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }));
  const keyIdentifier = new Uint8Array(createHash('sha1').update(subjectPublicKeyInfo).digest());
  const signer = issuer ?? { commonName, privateKey, keyIdentifier };
  const serial = new Uint8Array(randomBytes(16));
  // Positive, non-zero and minimally encoded whatever the draw.
  serial[0] = (serial[0] & 0x3f) | 0x40;
  const usage = authority
    ? [extension('2.5.29.19', true, sequence(yes())), extension('2.5.29.15', true, derElement(0x03, Uint8Array.of(1, 0x06)))]
    : [
        extension('2.5.29.19', true, sequence()),
        extension('2.5.29.15', true, derElement(0x03, Uint8Array.of(7, 0x80))),
        extension('2.5.29.37', false, sequence(derObjectIdentifier('1.3.6.1.5.5.7.3.2'))),
      ];
  const toBeSigned = sequence(
    derElement(0xa0, derElement(0x02, Uint8Array.of(2))),
    derElement(0x02, serial),
    sequence(ecdsaWithSha256),
    name(signer.commonName),
    sequence(derElement(0x17, text('200101000000Z')), derElement(0x17, text('491231235959Z'))),
    name(commonName),
    subjectPublicKeyInfo,
    derElement(0xa3, sequence(
      ...usage,
      extension('2.5.29.14', false, derElement(0x04, keyIdentifier)),
      extension('2.5.29.35', false, sequence(derElement(0x80, signer.keyIdentifier))),
    )),
  );
  const signature = new Uint8Array(sign('sha256', toBeSigned, signer.privateKey));
  const der = sequence(toBeSigned, sequence(ecdsaWithSha256), derElement(0x03, Uint8Array.of(0), signature));
  const lines = Buffer.from(der).toString('base64').match(/.{1,64}/g);
  return {
    commonName,
    privateKey,
    keyIdentifier,
    cert: `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

/**
 * Client certificates differ by runtime, which only a real runtime can show,
 * so each backend is asked for one under the same `withTls(...)`: Hono on this
 * runtime's runner, the framework-built Fastify a system with no backend
 * configured gets — the default — and Express.
 *
 * Node and Bun verify the certificate against the configured `ca`: a client
 * certificate signed by it is answered, and one signed by an unrelated CA, or
 * none, is refused in the handshake.  That is what holds the `ca` mapping to
 * account — a listener that dropped it verifies against the runtime's default
 * trust store, and refuses the configured CA's client too.  On Deno neither
 * `Deno.serve` nor its `node:https` enforces a demand, so every backend must
 * refuse to bind under one, naming `tls.requestClientCert` (#1522).
 */
async function clientCertificateLeg(context, { label, system, backend }) {
  const { runtime, HttpExtensionId, HttpServerOptions, routes, cert, key, ca, clients } = context;
  const demanding = HttpServerOptions.create().withTls({ cert, key, ca: clients?.authority.cert ?? ca, requestClientCert: true });
  let binding;
  try {
    try {
      let builder = system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0);
      if (backend) builder = builder.useBackend(backend());
      binding = await builder.withServerOptions(demanding).bind(routes);
    } catch (e) {
      if (runtime === 'deno' && e.message.includes('tls.requestClientCert')) return;
      throw new Error(`[${label}] binding under requestClientCert failed on ${runtime} — ${e.message}`);
    }
    if (runtime === 'deno') {
      throw new Error(`[${label}] bound under requestClientCert on Deno, which enforces no client-certificate demand`);
    }
    const presenting = async (client) => {
      try {
        const response = await requestOnce(httpsRequest, {
          host: '127.0.0.1', port: binding.port, ca, servername: 'localhost', agent: false,
          ...(client ? { cert: client.cert, key: client.key } : {}),
        });
        return response.status;
      } catch {
        return null;
      }
    };
    const admitted = await presenting(clients.configured);
    if (admitted !== 200) {
      throw new Error(`[${label}] a client certificate signed by the configured ca was not answered (${admitted ?? 'refused'}) on ${runtime}`);
    }
    for (const [who, client] of [['one signed by an unrelated CA', clients.unrelated], ['a client without a certificate', undefined]]) {
      const answered = await presenting(client);
      if (answered !== null) throw new Error(`[${label}] ${who} was answered ${answered} under requestClientCert on ${runtime}`);
    }
  } finally {
    if (binding) await binding.unbind().catch(() => {});
  }
}

/** Two CAs and a client certificate from each; the first CA is the one the servers are configured with. */
async function mintClients() {
  const authority = await mintCertificate('actor-ts smoke client CA', undefined, true);
  const unrelatedAuthority = await mintCertificate('actor-ts smoke unrelated CA', undefined, true);
  return {
    authority,
    configured: await mintCertificate('client of the configured CA', authority, false),
    unrelated: await mintCertificate('client of an unrelated CA', unrelatedAuthority, false),
  };
}

/**
 * The Express arm: the backend builds `https.createServer` for itself under
 * the same `withTls(...)`, so the same claims hold — and on Node the header
 * deadline must follow its connections into TLS as it does for Hono.
 */
async function expressArm(context) {
  const { system, runtime, HttpExtensionId, ExpressBackend, serverOptions, routes, ca } = context;
  let binding;
  try {
    binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .useBackend(new ExpressBackend())
      .withServerOptions(serverOptions)
      .bind(routes);
    await assertTerminatesTls({ label: 'express', port: binding.port, ca });
    if (runtime === 'node') await assertHeaderDeadlineInsideTls({ label: 'express', port: binding.port, ca });
  } finally {
    if (binding) await binding.unbind().catch(() => {});
  }
}

export async function run({ actorTs, runtime, loadEntry }) {
  const { ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } = actorTs;
  const { HttpExtensionId, HttpServerOptions, ExpressBackend, completeText, get, path } = await loadEntry('http');

  const hono = await loadable('hono');
  const express = await loadable('express');
  const fastify = await loadable('fastify');
  if (!hono.ok && !express.ok && !fastify.ok) {
    console.log(`  (skipped: neither hono, express nor fastify loadable on this runtime — ${hono.reason})`);
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
  // No backend configured: the one a demand reaches by default, Fastify.
  const defaultBackendOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const defaultBackendSystem = ActorSystem.create('smoke-http-tls-default-backend', defaultBackendOptions);
  const routes = path('', get(() => completeText(200, 'tls on this runtime')));
  const serverOptions = HttpServerOptions.create()
    .withTls({ cert, key })
    .withHeaderTimeoutMs(HEADER_DEADLINE_MS);
  // Deno refuses every demand at bind, so it never needs a client certificate.
  const clients = runtime === 'deno' ? undefined : await mintClients();
  const context = { system, runtime, HttpExtensionId, HttpServerOptions, ExpressBackend, serverOptions, routes, cert, key, ca, clients };
  try {
    const honoBound = hono.ok && await honoArm(context);
    if (!hono.ok) console.log(`  (hono arm skipped: hono not loadable on this runtime — ${hono.reason})`);
    if (express.ok) await expressArm(context);
    else console.log(`  (express arm skipped: express not loadable on this runtime — ${express.reason})`);
    if (honoBound) await clientCertificateLeg(context, { label: 'hono', system });
    if (fastify.ok) await clientCertificateLeg(context, { label: 'fastify', system: defaultBackendSystem });
    else console.log(`  (fastify client-certificate leg skipped: fastify not loadable on this runtime — ${fastify.reason})`);
    if (express.ok) await clientCertificateLeg(context, { label: 'express', system, backend: () => new ExpressBackend() });
  } finally {
    await system.terminate();
    await defaultBackendSystem.terminate();
  }
}
