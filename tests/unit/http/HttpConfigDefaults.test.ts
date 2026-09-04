import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { ConfigObject } from '../../../src/config/HoconParser.js';
import { ConfigError } from '../../../src/config/Config.js';
import { FastifyBackend } from '../../../src/http/backend/FastifyBackend.js';
import { HttpResponseTooLargeError } from '../../../src/http/HttpClient.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { complete, get, path, type Route } from '../../../src/http/Route.js';
import { cors } from '../../../src/http/middleware/Cors.js';
import { CorsOptions } from '../../../src/http/middleware/CorsOptions.js';
import { Status } from '../../../src/http/Types.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import type { NodeHttpServerLike, ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import {
  DEFAULT_HTTP_SERVER_REQUEST_TIMEOUT_MS,
  HttpServerOptions,
} from '../../../src/http/HttpServerOptions.js';

/**
 * `actor-ts.http.backend` and `actor-ts.http.shutdown-grace-period` were
 * documented but inert (#653).  These drive them through the real
 * `newServerAt(...).bind()` path rather than asserting on a reader.
 */

let running: { system: ActorSystem; binding: ServerBinding } | null = null;

function systemWith(config: ConfigObject): ActorSystem {
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(config);
  return ActorSystem.create('http-config', options);
}

afterEach(async () => {
  if (running) {
    await running.binding.unbind();
    await running.system.terminate();
    running = null;
  }
});

describe('actor-ts.http.backend', () => {
  test('an unset key keeps the built-in Fastify backend', async () => {
    const system = systemWith({});
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .bind(get(() => complete(Status.OK, 'ok')));
    running = { system, binding };

    const response = await fetch(`http://${binding.host}:${binding.port}/`);
    expect(response.status).toBe(200);
  });

  test('a backend passed in code wins over the config file', async () => {
    // `useBackend` is the explicit layer.  The config names a backend that
    // does not exist, so if it were consulted at all this would throw —
    // which is what makes the assertion mean something.
    const system = systemWith({ 'actor-ts': { http: { backend: 'not-a-backend' } } });
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .useBackend(new FastifyBackend({ logger: false }))
      .bind(get(() => complete(Status.OK, 'ok')));
    running = { system, binding };

    const response = await fetch(`http://${binding.host}:${binding.port}/`);
    expect(response.status).toBe(200);
  });

  test('an unknown backend name fails with a ConfigError naming the key', async () => {
    // `bun` is the case worth pinning: reference.conf advertised it as a
    // backend for a long time and it never existed.
    const system = systemWith({ 'actor-ts': { http: { backend: 'bun' } } });

    const bind = (): Promise<ServerBinding> => system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .bind(get(() => complete(Status.OK, 'ok')));

    await expect(bind()).rejects.toThrow(ConfigError);
    await expect(bind()).rejects.toThrow('actor-ts.http.backend');
    await system.terminate();
  });
});

/**
 * The outbound bounds were operable only from code (#602): the shared client
 * took the built-in numbers and offered no way to move them, so a deployment
 * that needed a different ceiling had to stop using the shared client.  These
 * drive the real request path — a framework server on one end, the system's
 * own client on the other — rather than asserting on the reader.
 */
describe('actor-ts.http.client', () => {
  /** Bind a route answering `size` bytes, and hand back its URL. */
  async function serveBytes(system: ActorSystem, size: number): Promise<string> {
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .bind(get(() => complete(Status.OK, 'a'.repeat(size))));
    running = { system, binding };
    return `http://${binding.host}:${binding.port}/`;
  }

  test('the shared client takes its response ceiling from the config file', async () => {
    const system = systemWith({ 'actor-ts': { http: { client: { 'max-response-bytes': '1K' } } } });
    const url = await serveBytes(system, 4096);
    await expect(system.extension(HttpExtensionId).client.get(url))
      .rejects.toBeInstanceOf(HttpResponseTooLargeError);
  });

  test('the shared client takes its deadline from the config file', async () => {
    const system = systemWith({ 'actor-ts': { http: { client: { 'default-timeout': '50ms' } } } });
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .bind(get(async () => {
        // The elapsed time IS the assertion: the handler has to outlast the
        // 50 ms client deadline configured above by a wide margin, so that the
        // client aborting rather than resolving is unambiguous.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        return complete(Status.OK, 'late');
      }));
    running = { system, binding };
    // Without the config layer this waits the full 2 s and resolves, so the
    // assertion fails on a value rather than on a timeout.
    const settled = await system.extension(HttpExtensionId)
      .client.get(`http://${binding.host}:${binding.port}/`)
      .then(() => 'resolved', () => 'aborted');
    expect(settled).toBe('aborted');
  });

  test('an explicit option beats the config file, which beats the built-in default', async () => {
    const system = systemWith({ 'actor-ts': { http: { client: { 'max-response-bytes': '1K' } } } });
    const url = await serveBytes(system, 4096);
    const extension = system.extension(HttpExtensionId);
    // Explicit > HOCON: newClient names its own ceiling and gets the body.
    expect((await extension.newClient({ maxResponseBytes: 8192 }).get(url)).body.byteLength).toBe(4096);
    // HOCON > built-in: 1 KiB is nowhere near the built-in 8 MiB.
    await expect(extension.newClient().get(url)).rejects.toBeInstanceOf(HttpResponseTooLargeError);
  });

  test('an unset block leaves the built-in bounds in place', async () => {
    const system = systemWith({});
    const url = await serveBytes(system, 4096);
    expect((await system.extension(HttpExtensionId).client.get(url)).body.byteLength).toBe(4096);
  });

  test('an out-of-domain value is rejected as an OptionsError, not deep in a request', async () => {
    // The whole point of a validated read: a bad value surfaces where the
    // configuration mistake is, not as a redirect policy nobody chose.
    const system = systemWith({ 'actor-ts': { http: { client: { redirect: 'sideways' } } } });
    try {
      expect(() => system.extension(HttpExtensionId)).toThrow(OptionsError);
      expect(() => system.extension(HttpExtensionId)).toThrow('redirect');
    } finally {
      await system.terminate();
    }
  });

  /**
   * #1405 kebab-cased every leaf here.  Ignoring the old spelling would be the
   * one unacceptable outcome: `maxResponseBytes` is a ceiling a deployment
   * lowers on purpose, and an unconverted `application.conf` would come back up
   * on the built-in 8 MiB with nothing said.  So the retired names are refused,
   * naming both spellings.
   */
  test('a retired camelCase leaf is refused at startup, naming both spellings', async () => {
    const system = systemWith({ 'actor-ts': { http: { client: { maxResponseBytes: '1K' } } } });
    try {
      expect(() => system.extension(HttpExtensionId)).toThrow(ConfigError);
      expect(() => system.extension(HttpExtensionId))
        .toThrow(/actor-ts\.http\.client\.maxResponseBytes.*actor-ts\.http\.client\.max-response-bytes/s);
    } finally {
      await system.terminate();
    }
  });

  test('the kebab spelling of that same leaf is read, so the refusal is about the name', async () => {
    // Guards the guard above: without this, a reader that threw on *any*
    // configured leaf would pass it.
    const system = systemWith({ 'actor-ts': { http: { client: { 'max-response-bytes': '1K' } } } });
    const url = await serveBytes(system, 4096);
    await expect(system.extension(HttpExtensionId).client.get(url))
      .rejects.toBeInstanceOf(HttpResponseTooLargeError);
  });
});

/**
 * `actor-ts.http.cors` (#878) — the block, and the seam under it.
 *
 * These drive `newServerAt(...).bind()` rather than calling
 * `resolveCorsPolicy` directly, deliberately: the reader was never the hard
 * part.  What had to be built is the path by which a *route directive* reaches
 * the system's configuration at all — `cors()` runs while the route tree is
 * being built, before any `ActorSystem` exists — and only a real bind exercises
 * it end to end.
 *
 * The nested-object form of the config matters too: `{'actor-ts.http.cors.
 * origins': […]}` would keep the dotted string as one literal top-level key,
 * `hasPath` would resolve the *reference.conf* value underneath it, and the
 * test would assert nothing.
 */
describe('actor-ts.http.cors', () => {
  const ALLOWED = 'https://app.example';

  /** Bind `routes` and hand back the base URL. */
  async function serve(system: ActorSystem, routes: Route): Promise<string> {
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .bind(routes);
    running = { system, binding };
    return `http://${binding.host}:${binding.port}`;
  }

  const corsConfig = (block: ConfigObject): ConfigObject => ({ 'actor-ts': { http: { cors: block } } });
  const apiRoutes = (options: CorsOptions = {}): Route =>
    cors(options, path('api', get(() => complete(Status.OK, 'data'))));

  const preflight = async (url: string, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${url}/api`, {
      method: 'OPTIONS',
      headers: { origin: ALLOWED, 'access-control-request-method': 'GET', ...headers },
    });

  test('an allowlist that exists only in the config file is honoured', async () => {
    const system = systemWith(corsConfig({ origins: [ALLOWED] }));
    const url = await serve(system, apiRoutes());

    const allowed = await fetch(`${url}/api`, { headers: { origin: ALLOWED } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    const disallowed = await fetch(`${url}/api`, { headers: { origin: 'https://evil.example' } });
    expect(disallowed.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('a code option beats the config file per field, and the rest still falls through', async () => {
    const system = systemWith(corsConfig({ origins: ['https://ignored.example'], credentials: true }));
    // `origins` in code, `credentials` only in config: both have to take
    // effect, which a whole-object override would not manage.
    const url = await serve(system, apiRoutes(CorsOptions.create().withOrigins(ALLOWED)));

    const response = await fetch(`${url}/api`, { headers: { origin: ALLOWED } });
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    // The origin the config named lost, rather than being merged in alongside.
    const other = await fetch(`${url}/api`, { headers: { origin: 'https://ignored.example' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('the four comment-only leaves change nothing while they stay unset', async () => {
    // The regression guard for shipping a block at all: with only the two
    // published leaves in play, every header is byte-for-byte what it was
    // before this key existed.
    const system = systemWith({});
    const url = await serve(system, apiRoutes(CorsOptions.create().withOrigins(ALLOWED)));

    const response = await preflight(url, { 'access-control-request-headers': 'x-custom' });
    // methods: the ones registered at the pattern, not a fleet-wide list.
    expect(response.headers.get('access-control-allow-methods')).toBe('GET');
    // allowed-headers: the request's, echoed.
    expect(response.headers.get('access-control-allow-headers')).toBe('x-custom');
    // max-age: no header at all.
    expect(response.headers.get('access-control-max-age')).toBeNull();
    // credentials = off, exposed-headers = [] — both absent from the wire.
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    const actual = await fetch(`${url}/api`, { headers: { origin: ALLOWED } });
    expect(actual.headers.get('access-control-expose-headers')).toBeNull();
  });

  test('the other four leaves are read when a deployment does set them', async () => {
    const system = systemWith(corsConfig({
      origins: [ALLOWED],
      methods: ['GET', 'DELETE'],
      'allowed-headers': ['x-from-config'],
      'exposed-headers': ['x-trace-id'],
      'max-age': 3600,
    }));
    const url = await serve(system, apiRoutes());

    const response = await preflight(url, { 'access-control-request-headers': 'x-custom' });
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, DELETE');
    expect(response.headers.get('access-control-allow-headers')).toBe('x-from-config');
    expect(response.headers.get('access-control-max-age')).toBe('3600');
    const actual = await fetch(`${url}/api`, { headers: { origin: ALLOWED } });
    expect(actual.headers.get('access-control-expose-headers')).toBe('x-trace-id');
  });

  test('max-age is an integer count of seconds, and a duration string is refused', async () => {
    // The assertion above cannot carry this on its own: `3600` reads
    // identically through `getInt` and `getDuration`, because `getDuration`
    // returns a bare number unchanged.  Only a *string* separates them — and
    // it separates them by a factor of 1000, since the field is written raw
    // into `Access-Control-Max-Age` while `getDuration` answers in
    // milliseconds.  `1h` therefore has to be refused rather than quietly
    // becoming `3600000`, which nothing else in the repository would catch.
    const system = systemWith(corsConfig({ origins: [ALLOWED], 'max-age': '1h' }));
    const bind = (): Promise<ServerBinding> => system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .bind(apiRoutes());

    await expect(bind()).rejects.toThrow(ConfigError);
    await expect(bind()).rejects.toThrow('actor-ts.http.cors.max-age');
    await system.terminate();
  });

  test('origins in neither code nor config still fails, loudly, from bind()', async () => {
    const system = systemWith({});
    await expect(system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).bind(apiRoutes()))
      .rejects.toThrow(/origins is required/);
    await system.terminate();
  });

  test('a wildcard in the config file is refused, naming the key', async () => {
    // #128 was "CORS defaults may be too permissive".  One line in an
    // application.conf that widened every cors() route in the process to any
    // origin would be that issue again, so the wildcard stays code-only.
    const system = systemWith(corsConfig({ origins: ['*'] }));
    const bind = (): Promise<ServerBinding> => system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .bind(apiRoutes());

    await expect(bind()).rejects.toThrow(ConfigError);
    await expect(bind()).rejects.toThrow('actor-ts.http.cors.origins');
    await system.terminate();
  });

  test('withAnyOrigin() in code is untouched by that refusal', async () => {
    // Guards the guard above: a reader that refused the wildcard everywhere
    // would pass it while breaking the documented opt-in.
    const system = systemWith({});
    const url = await serve(system, apiRoutes(CorsOptions.create().withAnyOrigin()));
    const response = await fetch(`${url}/api`, { headers: { origin: ALLOWED } });
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  test('a value outside its domain is an OptionsError from bind(), not a bad header', async () => {
    const system = systemWith(corsConfig({ origins: [ALLOWED], methods: ['GETT'] }));
    await expect(system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).bind(apiRoutes()))
      .rejects.toThrow(OptionsError);
    await system.terminate();
  });
});

/**
 * `actor-ts.http.server` — the connection-level bounds of the listening socket
 * itself (#870).  Driven through the real `newServerAt(...).bind()` path, and
 * observed from a raw socket rather than from `fetch`: three of the four keys
 * govern what happens to a connection that is *not* completing a request, and
 * `fetch` cannot express that state at all.
 */
describe('actor-ts.http.server', () => {
  const sockets: Socket[] = [];

  /** A raw client socket on the bound server, destroyed for us afterwards. */
  function open(binding: ServerBinding): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: binding.host, port: binding.port }, () => resolve(socket));
      socket.once('error', reject);
      sockets.push(socket);
    });
  }

  /** Resolve `true` if the server closes `socket` within `withinMs`. */
  function closedWithin(socket: Socket, withinMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      // The 'data' listener is not decoration: without it the socket stays
      // paused and never emits 'close', so every case here would read as "the
      // server left it open" whatever the server actually did.  That mistake
      // produced a full set of confidently wrong measurements while this was
      // being written.
      socket.on('data', () => { /* drain, so 'close' can fire */ });
      socket.once('close', () => resolve(true));
      const timer = setTimeout(() => resolve(false), withinMs);
      (timer as { unref?: () => void }).unref?.();
    });
  }

  afterEach(() => {
    while (sockets.length) sockets.shift()!.destroy();
  });

  async function bindWith(config: ConfigObject, options?: HttpServerOptions): Promise<ServerBinding> {
    const system = systemWith(config);
    const builder = system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0);
    if (options) builder.withServerOptions(options);
    const binding = await builder.bind(get(() => complete(Status.OK, 'ok')));
    running = { system, binding };
    return binding;
  }

  test('max-connections closes the connection past the cap', async () => {
    const binding = await bindWith({ 'actor-ts': { http: { server: { 'max-connections': 1 } } } });

    const first = await open(binding);
    const second = await open(binding);

    expect(await closedWithin(second, 3_000)).toBe(true);
    expect(first.destroyed).toBe(false);
  });

  test('an unset max-connections leaves the server unlimited', async () => {
    // The negative control for the case above.  Without it that test passes
    // against a server that closes every second connection for some other
    // reason, which is not the property being claimed.
    const binding = await bindWith({});

    await open(binding);
    const second = await open(binding);

    expect(await closedWithin(second, 1_000)).toBe(false);
  });

  test('idle-timeout closes a keep-alive connection that goes quiet', async () => {
    const binding = await bindWith({ 'actor-ts': { http: { server: { 'idle-timeout': '100ms' } } } });
    const socket = await open(binding);
    socket.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n');

    // The runtime adds a grace of its own on top of the configured window, so
    // the assertion is "closes soon", not "closes at 100 ms".
    expect(await closedWithin(socket, 5_000)).toBe(true);
  });

  test('an unset idle-timeout leaves the backend\'s own window in place', async () => {
    // Fastify's is 72 s, deliberately — this is what "ships no leaf" buys, and
    // it is the assertion that fails if the block ever starts publishing an
    // idle-timeout value.
    const binding = await bindWith({});
    const socket = await open(binding);
    socket.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n');

    expect(await closedWithin(socket, 2_000)).toBe(false);
  });

  test('the receive deadlines reach the server Fastify built', async () => {
    // Asserted as installed rather than as observed, and the reason is in the
    // runtime: both are enforced by a sweep whose interval is a factory option
    // fixed at 30 s, so a test that waited for the close would have to wait
    // half a minute to learn anything.  `requestTimeout` is the case that
    // matters — Fastify ships it at 0, no bound at all — so this is the
    // assertion that the published 300 s actually lands on the default backend.
    const backend = new FastifyBackend({ logger: false });
    const system = systemWith({ 'actor-ts': { http: { server: { 'header-timeout': '11s' } } } });
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .useBackend(backend)
      .bind(get(() => complete(Status.OK, 'ok')));
    running = { system, binding };

    const server = backend.fastify.server as unknown as NodeHttpServerLike;
    expect(server.headersTimeout).toBe(11_000);
    expect(server.requestTimeout).toBe(DEFAULT_HTTP_SERVER_REQUEST_TIMEOUT_MS);
  });

  test('an explicit option beats the config file, which beats the built-in default', async () => {
    const serverOptions = HttpServerOptions.create().withMaxConnections(4);
    const binding = await bindWith(
      { 'actor-ts': { http: { server: { 'max-connections': 1 } } } },
      serverOptions,
    );

    // Explicit > HOCON: the config's cap of 1 would have closed this one.
    await open(binding);
    const second = await open(binding);
    expect(await closedWithin(second, 1_000)).toBe(false);
  });

  test('a value outside its domain is an OptionsError from bind(), not a broken bound', async () => {
    const system = systemWith({ 'actor-ts': { http: { server: { 'max-connections': 0 } } } });
    const bind = (): Promise<ServerBinding> => system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .bind(get(() => complete(Status.OK, 'ok')));

    await expect(bind()).rejects.toThrow(OptionsError);
    await expect(bind()).rejects.toThrow('maxConnections');
    await system.terminate();
  });
});

describe('actor-ts.http.shutdown-grace-period', () => {
  test('unbind resolves promptly when nothing is in flight', async () => {
    // The grace period is an upper bound, not a sleep: with no in-flight
    // request the backend's close() wins the race immediately.  Worth
    // pinning — a misread would add the full window to every shutdown.
    const system = systemWith({ 'actor-ts': { http: { 'shutdown-grace-period': '30s' } } });
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .bind(get(() => complete(Status.OK, 'ok')));

    const startedAt = Date.now();
    await binding.unbind();
    expect(Date.now() - startedAt).toBeLessThan(5_000);

    await system.terminate();
  });
});
