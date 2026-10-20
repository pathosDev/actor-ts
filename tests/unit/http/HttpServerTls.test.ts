import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { connect as http2Connect } from 'node:http2';
import { connect as tlsConnect } from 'node:tls';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { ConfigError } from '../../../src/config/Config.js';
import type { ConfigObject } from '../../../src/config/HoconParser.js';
import { ExpressBackend } from '../../../src/http/backend/ExpressBackend.js';
import { FastifyBackend, fastifyFactoryOptions } from '../../../src/http/backend/FastifyBackend.js';
import type { ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import {
  HttpServerOptions,
  HttpServerOptionsValidator,
  type HttpServerOptionsType,
  type HttpTlsOptionsType,
} from '../../../src/http/HttpServerOptions.js';
import { completeText, get, path } from '../../../src/http/Route.js';
import { WebsocketServerActor } from '../../../src/http/websocket/WebsocketServerActor.js';
import { websocket } from '../../../src/http/websocket/WebsocketRoute.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { setRuntimeOverride } from '../../../src/runtime/Detect.js';
import { BUN_HTTP2_SINCE, BunHonoRunner, bunSupportsHttp2 } from '../../../src/runtime/http/BunHonoRunner.js';
import type { HonoServerHandle, HonoServerRunner } from '../../../src/runtime/http/HonoServerRunner.js';
import { NodeHonoRunner } from '../../../src/runtime/http/NodeHonoRunner.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

/**
 * #1522 — TLS termination and HTTP/2 on the HTTP backends.
 *
 * Every live case here verifies the server's certificate against the test CA
 * in `tests/fixtures/tls/`, never `rejectUnauthorized: false`: a client that
 * skips verification would pass against a listener that terminates TLS with
 * the wrong material, and "the process is the TLS endpoint" is the claim.
 *
 * HTTP/2 is asserted through what a client negotiated, not through the option
 * having been set.  A `node:http2` client reports `alpnProtocol`, and a plain
 * `fetch` on the same port reports whether HTTP/1.1 stayed available beside
 * it — the property the issue asks for is both on one socket.
 *
 * The runners are driven directly as well as through `HttpExtension`,
 * because the runner is where each runtime spells the pair differently and
 * the backend is where the framework decides who gets told.  Both the Bun and
 * the Node runner run here: `@hono/node-server` sits on `node:https` /
 * `node:http2`, which Bun implements, so the Node path is exercised under
 * `bun test` and again for real by `tests/smoke/cases/36-http-tls-termination.mjs`.
 *
 * Express builds the server it listens on, so under `tls` that server is
 * `node:https` and everything the plain one carries has to come along: the
 * header cap, the server timeouts, the WebSocket upgrade path and the HOCON
 * `tls` block.  HTTP/2 is refused on Express alone — Express reassigns each
 * request and response onto `node:http`'s prototypes, which `node:http2`'s
 * compatibility objects do not survive — and the refusal carries what was
 * measured.  The fixtures hold no client certificate, so client verification
 * is shown from the side they can show: a demand refuses a client that
 * presents none, and the same server without it answers.
 */

const FIXTURES = new URL('../../fixtures/tls/', import.meta.url);
const CERT = readFileSync(new URL('localhost-cert.pem', FIXTURES), 'utf8');
const KEY = readFileSync(new URL('localhost-key.pem', FIXTURES), 'utf8');
const CA = readFileSync(new URL('test-ca.pem', FIXTURES), 'utf8');

/** Bun's `fetch` takes the trust anchor here; it is not part of the WHATWG signature. */
const verifiedFetch = (url: string, init: RequestInit = {}): Promise<Response> =>
  fetch(url, { ...init, tls: { ca: CA } } as RequestInit);

/** One `node:http2` request; resolves with what was negotiated and answered. */
function http2Request(port: number): Promise<{ alpn: string | false | null | undefined; status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const session = http2Connect(`https://127.0.0.1:${port}`, { ca: CA });
    session.on('error', reject);
    const request = session.request({ ':path': '/' });
    request.on('error', reject);
    let body = '';
    let status = 0;
    request.on('response', (headers) => { status = Number(headers[':status']); });
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      const alpn = session.alpnProtocol;
      session.close();
      resolve({ alpn, status, body });
    });
    request.end();
  });
}

const hello = () => new Response('hello over tls');

const COMPLETE_REQUEST = 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n';
/** The slow-loris shape: a header block that never gets its terminating blank line. */
const PARTIAL_REQUEST = 'GET / HTTP/1.1\r\nHost: localhost\r\n';

/**
 * A CA-verified TLS connection that writes `payload` once the handshake is
 * done, watched until the server closes it or `withinMs` passes.  The socket
 * is destroyed on every path, so no outcome leaves it open.
 */
function watchTls(port: number, payload: string, withinMs: number): Promise<{ closed: boolean; received: string }> {
  return new Promise((resolve) => {
    let received = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const socket = tlsConnect({ host: '127.0.0.1', port, ca: CA, servername: 'localhost' }, () => { socket.write(payload); });
    const finish = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ closed, received });
    };
    // Draining is not decoration: a paused socket never emits 'close'.
    socket.on('data', (chunk: Buffer) => { received += chunk.toString('latin1'); });
    socket.on('error', () => { /* a reset is observed as the 'close' that follows */ });
    socket.once('close', () => { finish(true); });
    timer = setTimeout(() => { finish(false); }, withinMs);
  });
}

type Ping = { kind: 'ping'; n: number };
type Pong = { kind: 'pong'; n: number };

class TlsEcho extends WebsocketServerActor<Pong, Ping> {
  onMessage(message: Ping): void {
    this.reply({ kind: 'pong', n: message.n });
  }
}

/**
 * Bun's `WebSocket` takes the trust anchor under `tls` in its second argument;
 * the DOM signature the dev compile resolves names only protocols there.
 */
const BunWebSocket = WebSocket as unknown as new (url: string, options: { tls: { ca: string } }) => WebSocket;

/** A `wss://` socket that verifies the server against the test CA, open or refused within `timeoutMs`. */
function openVerifiedSocket(url: string, timeoutMs = 4_000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new BunWebSocket(url, { tls: { ca: CA } });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('timeout opening the wss socket'));
    }, timeoutMs);
    socket.onopen = () => { clearTimeout(timer); resolve(socket); };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('the wss socket errored before it opened')); };
    socket.onclose = (event) => { clearTimeout(timer); reject(new Error(`the wss socket closed before it opened (code ${event.code})`)); };
  });
}

function nextMessage<T>(socket: WebSocket, timeoutMs = 4_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for a message')), timeoutMs);
    socket.addEventListener('message', (event: MessageEvent) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(event.data)) as T);
    }, { once: true });
  });
}

describe('HttpServerOptions — TLS and HTTP/2 validation (#1522)', () => {
  const validator = new HttpServerOptionsValidator();
  const valid: Partial<HttpServerOptionsType> = { tls: { cert: CERT, key: KEY } };

  test('a certificate and its key open the door; either alone is refused', () => {
    expect(() => validator.validate(valid)).not.toThrow();
    expect(() => validator.validate({ tls: {} })).toThrow(/needs cert and key/);
    expect(() => validator.validate({ tls: { cert: CERT } })).toThrow(/has a cert but no key/);
    expect(() => validator.validate({ tls: { key: KEY } })).toThrow(/has a key but no cert/);
    expect(() => validator.validate({ tls: { key: KEY } })).toThrow(OptionsError);
  });

  test('a refused tls block leaves its private key off the error', () => {
    // `OptionsError.value` rides along into an ERROR log line; for `tls` it
    // would be the key.  The reason names the missing half instead.
    let thrown: unknown;
    try {
      validator.validate({ tls: { key: KEY } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OptionsError);
    expect((thrown as OptionsError).value).toBeUndefined();
    expect((thrown as OptionsError).message).not.toContain('PRIVATE KEY');
    expect((thrown as OptionsError).message).not.toContain('[object Object]');
  });

  test('requestClientCert without a ca is refused — the default trust store would decide who gets in', () => {
    // Without `ca`, node:tls verifies a client certificate against the
    // runtime's default trust store: measured on node v26.10.0 and bun 1.4.2,
    // a certificate signed by a CA added to that store was admitted by a
    // server with `requestCert` and no `ca`.  A "mutual TLS" listener would
    // admit any client certificate a public CA issued.
    const demandWithoutAnchor: Partial<HttpServerOptionsType> = { tls: { cert: CERT, key: KEY, requestClientCert: true } };
    let thrown: unknown;
    try {
      validator.validate(demandWithoutAnchor);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OptionsError);
    expect((thrown as OptionsError).field).toBe('tls.requestClientCert');
    expect((thrown as OptionsError).message).toContain('requestClientCert is true but no `ca` was supplied');
    expect((thrown as OptionsError).message).toContain('default trust store');
    // The object holds the private key, so it stays off the error.
    expect((thrown as OptionsError).value).toBeUndefined();
    expect((thrown as OptionsError).message).not.toContain('PRIVATE KEY');

    // An anchor, or no demand, and the shape is coherent again.
    expect(() => validator.validate({ tls: { cert: CERT, key: KEY, ca: CA, requestClientCert: true } })).not.toThrow();
    expect(() => validator.validate({ tls: { cert: CERT, key: KEY, requestClientCert: false } })).not.toThrow();
    expect(() => validator.validate({ tls: { cert: CERT, key: KEY, ca: CA } })).not.toThrow();
  });

  test('http2 without tls is refused — h2c is not on the table', () => {
    expect(() => validator.validate({ http2: true })).toThrow(/needs tls/);
    expect(() => validator.validate({ http2: true })).toThrow(OptionsError);
    // The shipped default and an explicit off both pass without TLS.
    expect(() => validator.validate({ http2: false })).not.toThrow();
    expect(() => validator.validate({ ...valid, http2: true })).not.toThrow();
  });

  test('the builder spells both', () => {
    const options = HttpServerOptions.create().withTls({ cert: CERT, key: KEY }).withHttp2();
    expect(options).toMatchObject({ tls: { cert: CERT, key: KEY }, http2: true });
  });
});

/**
 * `@hono/node-server` replaces `globalThis.Request` and `Response` with its
 * own lightweight classes the first time `serve()` runs — its documented Node
 * fast path (`overrideGlobalObjects`, default on).  Never reached on Bun in
 * production, where the Bun runner serves; reached here because the Node
 * runner is exercised under `bun test`, and the override then outlives the
 * case: `Bun.serve` in a later case refused the Hono backend's return value as
 * "not a Response" — it was hono-node-server's.  Captured before any runner
 * runs and put back after each.
 */
const nativeGlobals = { Request: globalThis.Request, Response: globalThis.Response };
function restoreNativeGlobals(): void {
  Object.defineProperty(globalThis, 'Request', { value: nativeGlobals.Request, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'Response', { value: nativeGlobals.Response, configurable: true, writable: true });
}

describe('Hono runners — the socket terminates TLS and negotiates h2 (#1522)', () => {
  const handles: HonoServerHandle[] = [];
  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop(false).catch(() => {});
    restoreNativeGlobals();
  });

  async function listening(runner: HonoServerRunner, http2: boolean): Promise<HonoServerHandle> {
    const handle = await runner.serve({ host: '127.0.0.1', port: 0, fetch: hello, tls: { cert: CERT, key: KEY }, http2 });
    handles.push(handle);
    return handle;
  }

  for (const [label, runner] of [['Bun', new BunHonoRunner()], ['Node (under Bun)', new NodeHonoRunner()]] as const) {
    test(`${label}: tls alone serves HTTPS, refuses plain HTTP, and offers no h2`, async () => {
      const handle = await listening(runner, false);

      const response = await verifiedFetch(`https://127.0.0.1:${handle.port}/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('hello over tls');

      // The same port speaks TLS or nothing: a cleartext request is not
      // answered with a redirect or a 400, it fails at the socket.
      await expect(fetch(`http://127.0.0.1:${handle.port}/`)).rejects.toThrow();

      // Without http2 the listener does not offer h2 through ALPN, so an h2
      // client is refused during the handshake rather than silently
      // downgraded — which is what proves the flag below does something.
      await expect(http2Request(handle.port)).rejects.toThrow();
    });

    test(`${label}: tls + http2 negotiates h2 and keeps HTTP/1.1 on the same port`, async () => {
      const handle = await listening(runner, true);

      const negotiated = await http2Request(handle.port);
      expect(negotiated.alpn).toBe('h2');
      expect(negotiated.status).toBe(200);
      expect(negotiated.body).toBe('hello over tls');

      const fallback = await verifiedFetch(`https://127.0.0.1:${handle.port}/`);
      expect(fallback.status).toBe(200);
      expect(await fallback.text()).toBe('hello over tls');
    });
  }

  // #1486: a caller's `serverOptions` and the TLS material travel in the same
  // `@hono/node-server` member, so forwarding the one must not cost the other.
  // Either plain spread order loses a side — the certificate, which the
  // CA-verified client below would refuse, or the caller's header cap, which
  // the oversized request would get past.
  test('Node (under Bun): serveOptions.serverOptions merge beneath the TLS material', async () => {
    const handle = await new NodeHonoRunner().serve({
      host: '127.0.0.1',
      port: 0,
      fetch: hello,
      tls: { cert: CERT, key: KEY },
      serveOptions: { serverOptions: { maxHeaderSize: 1024 } },
    });
    handles.push(handle);

    const response = await verifiedFetch(`https://127.0.0.1:${handle.port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello over tls');

    const oversized = await verifiedFetch(`https://127.0.0.1:${handle.port}/`, { headers: { 'x-oversized': 'a'.repeat(4096) } });
    expect(oversized.status).toBe(431);
  });

  // `Bun.serve` learned `http2` in 1.4.1 and the `engines` floor is 1.3.0.
  // On an older Bun the option would be ignored and HTTP/1.1 served under a
  // setting that says otherwise, so the runner refuses there.  The version
  // read is a pure function, pinned on both sides of the line, and the
  // refusal itself is driven through a stand-in `Bun` whose `version` is
  // below it — the real one here is past it, which the first case asserts.
  test('Bun: http2 is refused on a Bun older than the release that added it', async () => {
    expect(BUN_HTTP2_SINCE).toBe('1.4.1');
    for (const version of ['1.3.0', '1.3.14', '1.4.0', '1.4.0-canary.12']) expect(bunSupportsHttp2(version)).toBe(false);
    for (const version of ['1.4.1', '1.4.1-canary.3', '1.4.2', '1.5.0', '2.0.0']) expect(bunSupportsHttp2(version)).toBe(true);
    expect(bunSupportsHttp2((globalThis as { Bun: { version: string } }).Bun.version)).toBe(true);

    // `globalThis.Bun` is not configurable, so the older Bun is the real
    // one with only its `version` shadowed, handed to the runner directly.
    const realBun = (globalThis as { Bun: object }).Bun;
    const olderBun = Object.create(realBun, { version: { value: '1.4.0' } }) as ConstructorParameters<typeof BunHonoRunner>[0];
    const runner = new BunHonoRunner(olderBun);
    const attempt = runner.serve({ host: '127.0.0.1', port: 0, fetch: hello, tls: { cert: CERT, key: KEY }, http2: true });
    await expect(attempt).rejects.toThrow(/needs Bun >= 1\.4\.1 \(this is 1\.4\.0\)/);
    // TLS alone is fine on that Bun; only the h2 half is gated.
    const handle = await runner.serve({ host: '127.0.0.1', port: 0, fetch: hello, tls: { cert: CERT, key: KEY } });
    handles.push(handle);
    expect((await verifiedFetch(`https://127.0.0.1:${handle.port}/`)).status).toBe(200);
  });
});

describe('HttpExtension — TLS through the backends (#1522)', () => {
  const systems: ActorSystem[] = [];
  const bindings: ServerBinding[] = [];
  afterEach(async () => {
    for (const binding of bindings.splice(0)) await binding.unbind().catch(() => {});
    for (const system of systems.splice(0)) await system.terminate().catch(() => {});
  });

  function systemWith(name: string, config: ConfigObject = {}): ActorSystem {
    const options = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig(config);
    const system = ActorSystem.create(name, options);
    systems.push(system);
    return system;
  }

  const routes = path('', get(() => completeText(200, 'bound over tls')));

  async function boundOverTls(system: ActorSystem, serverOptions = HttpServerOptions.create().withTls({ cert: CERT, key: KEY })): Promise<ServerBinding> {
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .withServerOptions(serverOptions)
      .bind(routes);
    bindings.push(binding);
    return binding;
  }

  test('the Hono backend terminates TLS from withTls', async () => {
    const system = systemWith('http-tls-hono', { 'actor-ts': { http: { backend: 'hono' } } });
    const binding = await boundOverTls(system);
    const response = await verifiedFetch(`https://127.0.0.1:${binding.port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('bound over tls');
  });

  test('the framework-built Fastify backend is constructed with the TLS it was asked for', async () => {
    // Fastify takes its certificate at construction, so this is the case that
    // depends on bind() resolving the options *before* the backend exists.
    const system = systemWith('http-tls-fastify', { 'actor-ts': { http: { backend: 'fastify' } } });
    const binding = await boundOverTls(system);
    const response = await verifiedFetch(`https://127.0.0.1:${binding.port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('bound over tls');
  });

  test('a Fastify backend built by hand without TLS refuses rather than serving plain HTTP', async () => {
    const system = systemWith('http-tls-fastify-by-hand');
    const attempt = system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .useBackend(new FastifyBackend())
      .withServerOptions(HttpServerOptions.create().withTls({ cert: CERT, key: KEY }))
      .bind(routes);
    await expect(attempt).rejects.toThrow(/constructed without TLS/);
    await expect(attempt).rejects.toThrow(/fastifyFactoryOptions/);
  });

  test('a Fastify backend built by hand with TLS but not HTTP/2 refuses withHttp2 rather than serving HTTP/1.1 under it', async () => {
    // HTTP/2 is a construction-time choice in Fastify, like the certificate.
    // Bound, this would be HTTP/1.1 over TLS under a setting that says h2.
    const system = systemWith('http-tls-fastify-h1-under-h2');
    const attempt = system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .useBackend(new FastifyBackend({ https: { cert: CERT, key: KEY } }))
      .withServerOptions(HttpServerOptions.create().withTls({ cert: CERT, key: KEY }).withHttp2())
      .bind(routes);
    // Read as a value rather than through `.rejects`, so a binding the
    // refusal fails to prevent is still closed by the teardown.
    const outcome = await attempt.then(
      (binding) => { bindings.push(binding); return binding; },
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/constructed without HTTP\/2/);
    expect((outcome as Error).message).toMatch(/fastifyFactoryOptions/);
  });

  test('a Fastify backend built by hand WITH fastifyFactoryOptions terminates TLS', async () => {
    const system = systemWith('http-tls-fastify-factory');
    const serverOptions = HttpServerOptions.create().withTls({ cert: CERT, key: KEY });
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .useBackend(new FastifyBackend(fastifyFactoryOptions(serverOptions)))
      .withServerOptions(serverOptions)
      .bind(routes);
    bindings.push(binding);
    const response = await verifiedFetch(`https://127.0.0.1:${binding.port}/`);
    expect(response.status).toBe(200);
  });

  /** Bind `route` on an Express backend built by hand, under `serverOptions`. */
  async function boundOnExpress(system: ActorSystem, serverOptions: HttpServerOptions, route = routes): Promise<ServerBinding> {
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .useBackend(new ExpressBackend())
      .withServerOptions(serverOptions)
      .bind(route);
    bindings.push(binding);
    return binding;
  }

  test('Express terminates TLS from withTls: a verified request is answered, cleartext to the same port is not', async () => {
    const system = systemWith('http-tls-express');
    const binding = await boundOnExpress(system, HttpServerOptions.create().withTls({ cert: CERT, key: KEY }));

    const response = await verifiedFetch(`https://127.0.0.1:${binding.port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('bound over tls');

    // The bound port speaks TLS or nothing: the server the backend listens on
    // is the https one, not a plain one serving beside it.
    await expect(fetch(`http://127.0.0.1:${binding.port}/`)).rejects.toThrow();
    // TLS alone offers no h2 through ALPN, so an h2 client is refused at the
    // handshake rather than silently given HTTP/1.1.
    await expect(http2Request(binding.port)).rejects.toThrow();
  });

  test('Express refuses withHttp2 at bind(), naming http2 and what was measured — TLS is served, HTTP/2 is not', async () => {
    const system = systemWith('http-tls-express-h2');
    const serverOptions = HttpServerOptions.create()
      .withTls({ cert: CERT, key: KEY })
      .withHttp2();
    // Read as a value rather than through `.rejects`, so a binding the
    // refusal fails to prevent is still closed by the teardown.
    const outcome = await boundOnExpress(system, serverOptions).then(
      (binding) => binding,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(Error);
    const message = (outcome as Error).message;
    expect(message).toContain('HttpServerOptions.http2');
    expect(message).toContain('serves TLS but not HTTP/2');
    // The reason travels with the refusal: which Express, which runtimes, and
    // how each one failed — a reader deciding whether to lift it needs all three.
    expect(message).toContain('express 5.2.1');
    expect(message).toContain('node v26.10.0');
    expect(message).toContain('bun 1.4.2');
    expect(message).toContain('never answered');
    expect(message).toContain('deno 2.6.8 does not implement http2.createSecureServer');
  });

  test('Express maps requestClientCert onto node:tls requestCert, and passes rejectUnauthorized through', async () => {
    // The client verifies the server against the test CA and presents no
    // certificate of its own — the fixtures hold none.
    const system = systemWith('http-tls-express-client-certificate');
    const portUnder = async (tls: HttpTlsOptionsType): Promise<number> =>
      (await boundOnExpress(system, HttpServerOptions.create().withTls(tls))).port;

    const demanding = await portUnder({ cert: CERT, key: KEY, ca: CA, requestClientCert: true });
    await expect(verifiedFetch(`https://127.0.0.1:${demanding}/`)).rejects.toThrow();

    // The control: the same material without the demand answers the same
    // client, so the refusal above is the demand and nothing else.
    const trusting = await portUnder({ cert: CERT, key: KEY, ca: CA });
    expect((await verifiedFetch(`https://127.0.0.1:${trusting}/`)).status).toBe(200);

    // The server's own verification switch, not the client's: a demand that
    // does not reject admits a client without a certificate, which holds only
    // if the value reached node:tls.  The client above still verifies the
    // server against the CA.
    const requesting = await portUnder({ cert: CERT, key: KEY, ca: CA, requestClientCert: true, rejectUnauthorized: false });
    expect((await verifiedFetch(`https://127.0.0.1:${requesting}/`)).status).toBe(200);
  });

  test('bind() refuses requestClientCert without a ca, before the Express backend builds a server', async () => {
    const system = systemWith('http-tls-express-demand-without-anchor');
    const serverOptions = HttpServerOptions.create().withTls({ cert: CERT, key: KEY, requestClientCert: true });
    // Read as a value rather than through `.rejects`, so a binding the
    // refusal fails to prevent is still closed by the teardown.
    const outcome = await boundOnExpress(system, serverOptions).then(
      (binding) => binding,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(OptionsError);
    expect((outcome as OptionsError).message).toContain('requestClientCert');
    expect((outcome as OptionsError).value).toBeUndefined();
  });

  test('on Deno, Express refuses requestClientCert rather than accept a demand its node:https ignores', async () => {
    // Decided before anything is built, so the runtime seam reaches it under
    // Bun; the second listen shows the refusal is the demand, not TLS on Deno.
    setRuntimeOverride('deno');
    try {
      const refused = await new ExpressBackend()
        .listen('127.0.0.1', 0, { tls: { cert: CERT, key: KEY, ca: CA, requestClientCert: true } })
        .then(async (binding) => { await binding.unbind(); return binding; }, (error: unknown) => error);
      expect(refused).toBeInstanceOf(Error);
      expect((refused as Error).message).toContain('tls.requestClientCert');
      expect((refused as Error).message).toContain('Deno');

      const served = await new ExpressBackend().listen('127.0.0.1', 0, { tls: { cert: CERT, key: KEY } });
      bindings.push(served);
      expect((await verifiedFetch(`https://127.0.0.1:${served.port}/`)).status).toBe(404);
    } finally {
      setRuntimeOverride(null);
    }
  });

  test('Express holds max-header-bytes over TLS — the cap is built into the https server it listens on', async () => {
    // Asserted as "the handler was not reached", never as a status — a refused
    // request may come back as 431 or as a reset.
    let reached = 0;
    const counted = path('', get(() => {
      reached += 1;
      return completeText(200, 'bound over tls');
    }));
    const system = systemWith('http-tls-express-header-cap');
    const serverOptions = HttpServerOptions.create()
      .withTls({ cert: CERT, key: KEY })
      .withMaxHeaderBytes(1024);
    const binding = await boundOnExpress(system, serverOptions, counted);

    expect((await verifiedFetch(`https://127.0.0.1:${binding.port}/`)).status).toBe(200);
    expect(reached).toBe(1);
    await verifiedFetch(`https://127.0.0.1:${binding.port}/`, { headers: { 'x-oversized': 'a'.repeat(4096) } }).catch(() => undefined);
    expect(reached, 'a 4 KiB header reached the handler through a 1 KiB max-header-bytes on a TLS Express').toBe(1);
    expect(binding.serverOptionsReport?.maxHeaderBytes).toBe(true);
  });

  describe('the server timeouts reach the TLS server Express listens on', () => {
    /** Short enough to keep the suite quick, long enough to be unambiguous under load. */
    const HEADER_DEADLINE_MS = 400;
    /** How long a connection that must survive is watched — five deadlines. */
    const SURVIVAL_WINDOW_MS = 2_000;
    /** How long a connection that must be cut may take — the deadline plus slack for a loaded runner. */
    const EXPIRY_WINDOW_MS = 3_000;
    /** Real sockets and a watch window: past bun's 5 s default, stated rather than inherited. */
    const LIVE_TEST_TIMEOUT_MS = 10_000;

    async function boundWithDeadline(name: string): Promise<ServerBinding> {
      const serverOptions = HttpServerOptions.create()
        .withTls({ cert: CERT, key: KEY })
        .withHeaderTimeoutMs(HEADER_DEADLINE_MS)
        .withRequestTimeoutMs(30_000)
        .withIdleTimeoutMs(30_000)
        .withMaxConnections(64);
      return boundOnExpress(systemWith(name), serverOptions);
    }

    test('all four are installed, and a kept-alive HTTPS connection outlives the header deadline', async () => {
      const binding = await boundWithDeadline('http-tls-express-keep-alive');
      expect(binding.serverOptionsReport).toMatchObject({
        headerTimeoutMs: true,
        requestTimeoutMs: true,
        idleTimeoutMs: true,
        maxConnections: true,
      });

      const kept = await watchTls(binding.port, COMPLETE_REQUEST, SURVIVAL_WINDOW_MS);
      expect(kept.received, 'the kept-alive request was never answered').toContain('200 OK');
      expect(kept.closed, 'a healthy TLS connection was torn down by the header deadline').toBe(false);
    }, LIVE_TEST_TIMEOUT_MS);

    test('a slow-loris over TLS is cut at the header deadline and answered 408 inside TLS', async () => {
      const binding = await boundWithDeadline('http-tls-express-slow-loris');
      const slow = await watchTls(binding.port, PARTIAL_REQUEST, EXPIRY_WINDOW_MS);
      expect(slow.closed, 'the header deadline never closed a TLS slow-loris on Express').toBe(true);
      expect(slow.received, 'the 408 did not reach the TLS client').toContain('408 Request Timeout');
    }, LIVE_TEST_TIMEOUT_MS);

    test('idle-timeout closes a kept-alive HTTPS connection once it goes quiet', async () => {
      // The other half of the first case: there a 30 s idle-timeout kept the
      // connection open through the window, here a short one has to close it
      // — `node:http`'s own 5 s would not, so the setting reached the server.
      const IDLE_TIMEOUT_MS = 300;
      const serverOptions = HttpServerOptions.create()
        .withTls({ cert: CERT, key: KEY })
        .withIdleTimeoutMs(IDLE_TIMEOUT_MS);
      const binding = await boundOnExpress(systemWith('http-tls-express-idle'), serverOptions);

      const idle = await watchTls(binding.port, COMPLETE_REQUEST, SURVIVAL_WINDOW_MS);
      expect(idle.received, 'the kept-alive request was never answered').toContain('200 OK');
      expect(idle.closed, `a kept-alive TLS connection outlived a ${IDLE_TIMEOUT_MS} ms idle-timeout`).toBe(true);
    }, LIVE_TEST_TIMEOUT_MS);
  });

  test('a wss handshake through an Express websocket route succeeds, and the socket carries messages', async () => {
    // The upgrade dispatch hangs off the server the backend builds, so under
    // tls it is the https server's 'upgrade' that has to reach the app.
    const system = systemWith('http-tls-express-wss');
    const echo = system.spawn(TlsEcho, 'echo');
    const binding = await boundOnExpress(system, HttpServerOptions.create().withTls({ cert: CERT, key: KEY }), websocket('/ws', echo));

    const socket = await openVerifiedSocket(`wss://127.0.0.1:${binding.port}/ws`);
    try {
      const reply = nextMessage<Pong>(socket);
      socket.send(JSON.stringify({ kind: 'ping', n: 7 }));
      expect(await reply).toEqual({ kind: 'pong', n: 7 });
    } finally {
      socket.close();
    }
  });

  test('the HOCON tls block binds Express the way it binds Hono — cert-file, key-file and ca-file', async () => {
    const fixturePath = (name: string): string => new URL(name, FIXTURES).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const system = systemWith('http-tls-hocon-express', {
      'actor-ts': {
        http: {
          backend: 'express',
          server: {
            tls: {
              'cert-file': fixturePath('localhost-cert.pem'),
              'key-file': fixturePath('localhost-key.pem'),
              'ca-file': fixturePath('test-ca.pem'),
            },
          },
        },
      },
    });
    const binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).bind(routes);
    bindings.push(binding);

    const response = await verifiedFetch(`https://127.0.0.1:${binding.port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('bound over tls');
    await expect(fetch(`http://127.0.0.1:${binding.port}/`)).rejects.toThrow();
  });

  test('the framework-built Fastify holds max-header-bytes over TLS — the cap travels in the https factory bag (#1488)', async () => {
    // Once `https` is set, Fastify hands only that bag to the server factory,
    // so a cap placed in `http` is inert on a TLS listener: measured on node
    // v26.10.0 and bun 1.4.2, a 4 KiB header reached the handler with
    // `{ http: { maxHeaderSize: 1024 }, https }`.  Asserted as "the handler was
    // not reached", never as a status — a refused request may come back as
    // 431 or as a reset.
    let reached = 0;
    const counted = path('', get(() => {
      reached += 1;
      return completeText(200, 'bound over tls');
    }));
    const system = systemWith('http-tls-fastify-header-cap', { 'actor-ts': { http: { backend: 'fastify' } } });
    const serverOptions = HttpServerOptions.create()
      .withTls({ cert: CERT, key: KEY })
      .withMaxHeaderBytes(1024);
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .withServerOptions(serverOptions)
      .bind(counted);
    bindings.push(binding);

    expect((await verifiedFetch(`https://127.0.0.1:${binding.port}/`)).status).toBe(200);
    expect(reached).toBe(1);
    await verifiedFetch(`https://127.0.0.1:${binding.port}/`, { headers: { 'x-oversized': 'a'.repeat(4096) } }).catch(() => undefined);
    expect(reached, 'a 4 KiB header reached the handler through a 1 KiB max-header-bytes on a TLS Fastify').toBe(1);
  });

  test('http2 without tls is refused at bind(), naming the field', async () => {
    const system = systemWith('http-tls-h2c', { 'actor-ts': { http: { backend: 'hono' } } });
    const attempt = system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .withServerOptions(HttpServerOptions.create().withHttp2())
      .bind(routes);
    await expect(attempt).rejects.toThrow(OptionsError);
    await expect(attempt).rejects.toThrow(/http2/);
  });

  test('the HOCON tls block names files, and the files are read as PEM', async () => {
    const certFile = new URL('localhost-cert.pem', FIXTURES).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const keyFile = new URL('localhost-key.pem', FIXTURES).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const system = systemWith('http-tls-hocon', {
      'actor-ts': { http: { backend: 'hono', server: { tls: { 'cert-file': certFile, 'key-file': keyFile } } } },
    });
    const binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).bind(routes);
    bindings.push(binding);
    const response = await verifiedFetch(`https://127.0.0.1:${binding.port}/`);
    expect(response.status).toBe(200);
  });

  test('a tls file that cannot be read is a ConfigError naming the key, at bind()', async () => {
    const system = systemWith('http-tls-hocon-missing', {
      'actor-ts': { http: { backend: 'hono', server: { tls: { 'cert-file': '/nowhere/cert.pem', 'key-file': '/nowhere/key.pem' } } } },
    });
    const attempt = system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).bind(routes);
    await expect(attempt).rejects.toThrow(ConfigError);
    await expect(attempt).rejects.toThrow(/actor-ts\.http\.server\.tls\.cert-file/);
  });
});
