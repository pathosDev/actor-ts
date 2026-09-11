import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { connect as http2Connect } from 'node:http2';
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
} from '../../../src/http/HttpServerOptions.js';
import { completeText, get, path } from '../../../src/http/Route.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
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
 */

const FIXTURES = new URL('../../fixtures/tls/', import.meta.url);
const CERT = readFileSync(new URL('localhost-cert.pem', FIXTURES), 'utf8');
const KEY = readFileSync(new URL('localhost-key.pem', FIXTURES), 'utf8');
const CA = readFileSync(new URL('test-ca.pem', FIXTURES), 'utf8');

/** Bun's `fetch` takes the trust anchor here; it is not part of the WHATWG signature. */
const verifiedFetch = (url: string): Promise<Response> =>
  fetch(url, { tls: { ca: CA } } as RequestInit);

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

  test('a Fastify backend built by hand WITH fastifyFactoryOptions terminates TLS', async () => {
    const system = systemWith('http-tls-fastify-factory');
    const serverOptions = HttpServerOptions.create().withTls({ cert: CERT, key: KEY });
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .useBackend(new FastifyBackend(fastifyFactoryOptions(serverOptions as Partial<HttpServerOptionsType>)))
      .withServerOptions(serverOptions)
      .bind(routes);
    bindings.push(binding);
    const response = await verifiedFetch(`https://127.0.0.1:${binding.port}/`);
    expect(response.status).toBe(200);
  });

  test('Express refuses TLS and HTTP/2 rather than binding plain HTTP under them', async () => {
    const system = systemWith('http-tls-express');
    const attempt = system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .useBackend(new ExpressBackend())
      .withServerOptions(HttpServerOptions.create().withTls({ cert: CERT, key: KEY }))
      .bind(routes);
    await expect(attempt).rejects.toThrow(/ExpressBackend cannot terminate TLS/);
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
