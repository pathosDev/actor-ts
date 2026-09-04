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
import type { ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';

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
