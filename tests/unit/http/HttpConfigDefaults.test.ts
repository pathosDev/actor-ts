import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { ConfigObject } from '../../../src/config/HoconParser.js';
import { Config, ConfigError } from '../../../src/config/Config.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import { FastifyBackend } from '../../../src/http/backend/FastifyBackend.js';
import { HttpResponseTooLargeError } from '../../../src/http/HttpClient.js';
import {
  DEFAULT_HTTP_CLIENT_MAX_REDIRECTS,
  DEFAULT_HTTP_CLIENT_MAX_RESPONSE_BYTES,
  DEFAULT_HTTP_CLIENT_REDIRECT_MODE,
  DEFAULT_HTTP_CLIENT_TIMEOUT_MS,
} from '../../../src/http/HttpClientOptions.js';
import {
  HttpExtensionId,
  readHttpBackendFromConfig,
  readHttpClientOptionsFromConfig,
  readHttpServerOptionsFromConfig,
  readHttpShutdownGracePeriodFromConfig,
} from '../../../src/http/HttpExtension.js';
import { complete, concat, get, path, withMiddleware, type Route } from '../../../src/http/Route.js';
import { cors } from '../../../src/http/middleware/Cors.js';
import { headerDecorator } from '../../../src/http/middleware/Headers.js';
import { CorsOptions } from '../../../src/http/middleware/CorsOptions.js';
import { Status } from '../../../src/http/Types.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { MAX_TIMER_DELAY_MS } from '../../../src/pattern/Constants.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { expectExactOptions } from '../../util/ExactOptions.js';
import { diagnoseMaxConnections } from '../../util/MaxConnectionsSupport.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';
import type { NodeHttpServerLike, ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import {
  DEFAULT_HTTP_SERVER_HEADER_TIMEOUT_MS,
  DEFAULT_HTTP_SERVER_HTTP2,
  DEFAULT_HTTP_SERVER_REQUEST_TIMEOUT_MS,
  HttpServerOptions,
} from '../../../src/http/HttpServerOptions.js';

/**
 * `actor-ts.http.backend` and `actor-ts.http.shutdown-grace-period` were
 * documented but inert (#653).  The cases per block drive them through the
 * real `newServerAt(...).bind()` path rather than asserting on a reader; the
 * readers themselves are asserted leaf by leaf at the end of the file (#1425).
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

  test.each(['fastify', 'express', 'hono'] as const)('a configured %s is the backend bind() builds', async (name) => {
    // The reader only names a backend; this is the half that builds one, and
    // nothing above would notice an arm that built the wrong one — every
    // backend answers the request.  The bind line names the backend that is
    // actually listening, so it is the observable.
    const logger = new RecordingLogger(LogLevel.Info);
    const options = ActorSystemOptions.create()
      .withLogger(logger)
      .withLogLevel(LogLevel.Info)
      .withConfig({ 'actor-ts': { http: { backend: name } } });
    const system = ActorSystem.create('http-config', options);
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .bind(get(() => complete(Status.OK, 'ok')));
    running = { system, binding };

    expect((await fetch(`http://${binding.host}:${binding.port}/`)).status).toBe(200);
    expect(logger.records.map((record) => record.message))
      .toContain(`HTTP server bound on ${binding.host}:${binding.port} (${name})`);
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

  /**
   * The seam is `compile()` carrying `config` down the tree, and every test
   * above builds the `cors()` node at the **root** — the one shape that needs
   * no carrying at all, because `HttpExtension.bind` hands `compile()` the
   * config and the cors arm reads it straight off its own parameter.  A
   * `cors()` under any combinator only ever sees a config because the arm
   * above it passed one down, and each of those four recursive calls is a
   * separate argument that can be dropped in isolation.  Dropping one is
   * silent: the nested route serves whatever its code options say and the
   * deployment's `application.conf` is ignored with no error at all.
   *
   * So each case here nests `cors({})` under exactly one combinator and puts
   * the *whole* policy in HOCON — no code options, which makes `origins`
   * unreachable unless the arm above delivered the config, and makes each
   * case red under exactly the one dropped argument that concerns it.
   */
  describe('a nested cors() still reaches the config', () => {
    const DENIED = 'https://evil.example';

    /** The nested route's policy is the config's, both ways round. */
    async function expectConfiguredPolicyAt(url: string, routePath: string): Promise<void> {
      const allowed = await fetch(`${url}${routePath}`, { headers: { origin: ALLOWED } });
      expect(allowed.headers.get('access-control-allow-origin')).toBe(ALLOWED);
      const disallowed = await fetch(`${url}${routePath}`, { headers: { origin: DENIED } });
      expect(disallowed.headers.get('access-control-allow-origin')).toBeNull();
    }

    const nestedApi = (): Route => cors({}, path('api', get(() => complete(Status.OK, 'data'))));

    test('under path()', async () => {
      const system = systemWith(corsConfig({ origins: [ALLOWED] }));
      const url = await serve(system, path('v1', cors({}, get(() => complete(Status.OK, 'data')))));
      await expectConfiguredPolicyAt(url, '/v1');
    });

    test('under concat()', async () => {
      const system = systemWith(corsConfig({ origins: [ALLOWED] }));
      // The sibling is deliberately not a cors() node: it makes the concat
      // arm the only recursion between the root and the policy.
      const url = await serve(system, concat(
        path('open', get(() => complete(Status.OK, 'open'))),
        nestedApi(),
      ));
      await expectConfiguredPolicyAt(url, '/api');
    });

    test('under withMiddleware()', async () => {
      const system = systemWith(corsConfig({ origins: [ALLOWED] }));
      const url = await serve(system, withMiddleware(headerDecorator({ 'x-middleware': 'ran' }), nestedApi()));
      await expectConfiguredPolicyAt(url, '/api');
      // The middleware really is in the path — otherwise the assertion above
      // would hold over a tree the compiler had folded the node out of.
      const response = await fetch(`${url}/api`, { headers: { origin: ALLOWED } });
      expect(response.headers.get('x-middleware')).toBe('ran');
    });

    test('under another cors()', async () => {
      const system = systemWith(corsConfig({ origins: [ALLOWED] }));
      // The outer allowlist is disjoint from the configured one, so it can
      // decorate neither request below and every header they do carry is the
      // inner node's — i.e. the HOCON layer it had to have been handed.
      const url = await serve(system, cors(
        CorsOptions.create().withOrigins('https://outer.example'),
        nestedApi(),
      ));
      await expectConfiguredPolicyAt(url, '/api');
    });
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

  /**
   * Connect, and **speak** — a connection the server has never heard from is
   * not a connection it can be asked about.
   *
   * Measured on bun 1.4.0 (#1505): a `node:http` server on Linux surfaces an
   * accepted socket only once its first byte arrives — no `'connection'`
   * event, and `getConnections()` answers 0 — while on Windows and on node
   * the event fires on accept.  A cap test that connects and stays silent
   * therefore asks the Linux server about a connection it does not have, and
   * no cap can act on one it cannot see.  Sending a request makes the two
   * platforms agree, and it is also the connection a cap is about.
   *
   * Only the three connection-cap cases use it.  The header-deadline cases
   * below need the opposite — a connection that never finishes its headers —
   * which is why {@link open} stays silent and this is a second helper rather
   * than a change to that one.
   *
   * An `'error'` after the connect is expected rather than exceptional: the
   * cap refuses by destroying, which reaches the client as `ECONNRESET`, and
   * it is observed as the `'close'` that follows.
   */
  function openSpeaking(binding: ServerBinding): Promise<Socket> {
    return new Promise((resolve, reject) => {
      let connected = false;
      const socket = connect({ host: binding.host, port: binding.port }, () => {
        connected = true;
        resolve(socket);
        socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
      });
      socket.on('error', (error) => { if (!connected) reject(error); });
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

  /**
   * `closedWithin`, keeping what the server wrote on the way out.
   *
   * The bytes are the half a boolean cannot carry: a slow-loris guard that
   * hangs the socket up and one that answers `408` first are the same close,
   * and only one of them is what `http/security.mdx` promises.
   */
  function observeClose(socket: Socket, withinMs: number): Promise<{ closed: boolean; received: string }> {
    return new Promise((resolve) => {
      let received = '';
      socket.on('data', (chunk) => { received += chunk.toString('utf8'); });
      socket.once('close', () => resolve({ closed: true, received }));
      const timer = setTimeout(() => resolve({ closed: false, received }), withinMs);
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

    const first = await openSpeaking(binding);
    const second = await openSpeaking(binding);

    const closed = await closedWithin(second, 3_000);
    // See ServerTuningParity for why the probe is lazy and what it answers.
    expect(closed, closed ? undefined : await diagnoseMaxConnections()).toBe(true);
    expect(first.destroyed).toBe(false);
  });

  test('an unset max-connections leaves the server unlimited', async () => {
    // The negative control for the case above.  Without it that test passes
    // against a server that closes every second connection for some other
    // reason, which is not the property being claimed.
    const binding = await bindWith({});

    await openSpeaking(binding);
    const second = await openSpeaking(binding);

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
  }, 15_000);

  test('the receive deadlines reach the server Fastify built', async () => {
    // `requestTimeout` is asserted as installed rather than as observed, and
    // the reason is in the runtime: it is enforced by a sweep whose interval
    // is a factory option fixed at 30 s, so a test that waited for the close
    // would have to wait half a minute to learn anything.  It is also the
    // case that matters here — Fastify ships it at 0, no bound at all — so
    // this is the assertion that the published 300 s lands on the default
    // backend.
    //
    // `headersTimeout` is asserted the same way for a *different* reason, and
    // it used to be the only assertion this key had: the property is stored
    // and reported back unchanged by every runtime, and enforced by only one
    // of them, so reading it back proves the wiring and nothing about the
    // guard.  The next case observes that half from a socket instead (#870).
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

  test('request-timeout is read from the config file', async () => {
    // The leaf had no reader test of its own: the case above reads back the
    // built-in 300 s, which is also what reference.conf ships, so a reader that
    // dropped the leaf passed it.  90 s is neither — and it sits above the 60 s
    // header default, so the header deadline does not move with it.
    const backend = new FastifyBackend({ logger: false });
    const system = systemWith({ 'actor-ts': { http: { server: { 'request-timeout': '90s' } } } });
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .useBackend(backend)
      .bind(get(() => complete(Status.OK, 'ok')));
    running = { system, binding };

    const server = backend.fastify.server as unknown as NodeHttpServerLike;
    expect(server.requestTimeout).toBe(90_000);
  });

  test('a request-timeout below header-timeout bounds the header phase too', async () => {
    // The docs' own shape: request-timeout lowered, header-timeout left at its
    // 60 s default.  The headers are part of the request, so the shorter
    // deadline is the header deadline — written to the property, where Node
    // would otherwise swap the pair, and armed by the guard, which is what a
    // socket observes on every runtime the guard reaches.
    const backend = new FastifyBackend({ logger: false });
    const system = systemWith({ 'actor-ts': { http: { server: { 'request-timeout': '500ms' } } } });
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .useBackend(backend)
      .bind(get(() => complete(Status.OK, 'ok')));
    running = { system, binding };

    const server = backend.fastify.server as unknown as NodeHttpServerLike;
    expect(server.headersTimeout).toBe(500);
    expect(server.requestTimeout).toBe(500);

    const socket = await open(binding);
    socket.write('GET / HTTP/1.1\r\nHost: x\r\n');
    const observed = await observeClose(socket, 3_000);
    expect(observed.closed, 'a 500 ms request deadline left the header phase open').toBe(true);
    expect(observed.received, 'closed without the documented 408').toContain('408');
  });

  test('an explicit option beats the config file, which beats the built-in default', async () => {
    const serverOptions = HttpServerOptions.create().withMaxConnections(4);
    const binding = await bindWith(
      { 'actor-ts': { http: { server: { 'max-connections': 1 } } } },
      serverOptions,
    );

    // Explicit > HOCON: the config's cap of 1 would have closed this one.
    await openSpeaking(binding);
    const second = await openSpeaking(binding);
    expect(await closedWithin(second, 1_000)).toBe(false);
  });

  test('header-timeout closes a connection that never finishes its headers', async () => {
    // Observed, not read back off the server, and that distinction is the
    // whole test: `server.headersTimeout` is stored and reported unchanged by
    // every runtime here, and honoured by only some of them.  Measured on a
    // bare `node:http` server: node v26.7.0 answers `408` and closes; bun
    // 1.4.0 ignores the property entirely — 2 s, 40 s, 120 s and `0` all
    // produced the same ~12 s close with no `408` — and deno 2.6.8 ignores it
    // and never closes at all.  So the deadline is held here (#870).
    const binding = await bindWith({ 'actor-ts': { http: { server: { 'header-timeout': '500ms' } } } });
    const socket = await open(binding);
    // The slow-loris shape: a header block with no terminating blank line.
    socket.write('GET / HTTP/1.1\r\nHost: x\r\n');

    // Comfortably inside the runner's own 5 s per-test cap, so a guard that
    // never fires reads as a failed assertion rather than as a timed-out test.
    const observed = await observeClose(socket, 3_000);
    expect(observed.closed, 'the header deadline never closed the connection').toBe(true);
    expect(observed.received, 'closed without the documented 408').toContain('408');
  });

  test('a request that does deliver its headers is not cut off by that deadline', async () => {
    // The negative control.  Without it the case above passes against a guard
    // that destroys every connection it is armed on, which would take the
    // whole server down rather than close a slow-loris.
    const binding = await bindWith({ 'actor-ts': { http: { server: { 'header-timeout': '300ms' } } } });
    const socket = await open(binding);
    socket.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n');

    expect(await closedWithin(socket, 3_000)).toBe(false);
  }, 15_000);

  test('header-timeout = 0 arms no deadline, which is what "disables it" has to mean', async () => {
    // The documented opt-out.  A guard that read `0` as "close immediately"
    // would refuse every connection on a server that asked for no guard.
    const binding = await bindWith({ 'actor-ts': { http: { server: { 'header-timeout': 0 } } } });
    const socket = await open(binding);
    socket.write('GET / HTTP/1.1\r\nHost: x\r\n');

    expect(await closedWithin(socket, 3_000)).toBe(false);
  }, 15_000);

  test('a value outside its domain is an OptionsError from bind(), not a broken bound', async () => {
    const system = systemWith({ 'actor-ts': { http: { server: { 'max-connections': 0 } } } });
    const bind = (): Promise<ServerBinding> => system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .bind(get(() => complete(Status.OK, 'ok')));

    await expect(bind()).rejects.toThrow(OptionsError);
    await expect(bind()).rejects.toThrow('maxConnections');
    await system.terminate();
  });

  /**
   * The two leaves that end up in a timer, and the largest delay a timer
   * holds: 2^31 - 1 ms.  Past it `setTimeout` arms 1 ms instead, so the header
   * guard destroyed every fresh connection a millisecond after accept — and
   * HOCON reaches that range in one line, `30d` being 2 592 000 000 ms.
   *
   * `idle-timeout` has a second's less room.  Both runtimes add one to
   * `keepAliveTimeout` before arming the socket's timer, and measured on bun
   * 1.4.2 that sum overflows the same way: `keepAliveTimeout = 2 147 483 647`
   * — the ceiling itself — closed a keep-alive connection 14 ms after its
   * response, while 2 147 482 647 held.  Node truncates the overflow to the
   * ceiling instead, so there it merely warned.
   */
  const IDLE_TIMEOUT_CEILING_MS = MAX_TIMER_DELAY_MS - 1_000;

  /** Bind with `server` as the HOCON block; resolve the refusal, or `undefined` once a bind that worked is torn down again. */
  async function bindRefusal(server: ConfigObject): Promise<unknown> {
    const system = systemWith({ 'actor-ts': { http: { server } } });
    try {
      const binding = await system.extension(HttpExtensionId)
        .newServerAt('127.0.0.1', 0)
        .bind(get(() => complete(Status.OK, 'ok')));
      await binding.unbind();
      return undefined;
    } catch (error) {
      return error;
    } finally {
      await system.terminate();
    }
  }

  test('a header-timeout past what a timer can hold is refused at bind(), naming the field', async () => {
    const refusal = await bindRefusal({ 'header-timeout': '30d' });

    expect(refusal, 'a 30-day header deadline bound, and would cut every connection at 1 ms').toBeInstanceOf(OptionsError);
    expect((refusal as OptionsError).field).toBe('headerTimeoutMs');
  });

  test('an idle-timeout past what a timer can hold is refused at bind(), naming the field', async () => {
    const refusal = await bindRefusal({ 'idle-timeout': '30d' });

    expect(refusal, 'a 30-day idle window bound, and would close every keep-alive at 1 ms').toBeInstanceOf(OptionsError);
    expect((refusal as OptionsError).field).toBe('idleTimeoutMs');
  });

  test('each ceiling is exact: the largest value binds and the next one is refused', async () => {
    expect(await bindRefusal({ 'header-timeout': MAX_TIMER_DELAY_MS })).toBeUndefined();
    expect(await bindRefusal({ 'header-timeout': MAX_TIMER_DELAY_MS + 1 })).toBeInstanceOf(OptionsError);
    expect(await bindRefusal({ 'idle-timeout': IDLE_TIMEOUT_CEILING_MS })).toBeUndefined();
    expect(await bindRefusal({ 'idle-timeout': IDLE_TIMEOUT_CEILING_MS + 1 })).toBeInstanceOf(OptionsError);
  }, 15_000);

  test('a request-timeout past what Node\'s sweep can read is refused at bind(), naming the field', async () => {
    // No timer holds this one; Node's connection sweep reads it as a 32-bit
    // unsigned number and wraps anything larger.  Measured on node v26.10.0
    // with a 500 ms sweep: 2^32 - 1 ms left a stalled body open, 2^32 + 2 000
    // ms closed it at 2.0 s, and HOCON's `60d` came out at about ten days.
    // Bun does not wrap, but the key has to mean one thing everywhere.
    expect(await bindRefusal({ 'request-timeout': 4_294_967_295 })).toBeUndefined();
    const refusal = await bindRefusal({ 'request-timeout': 4_294_967_296 });

    expect(refusal, 'a request deadline Node wraps into a short one was accepted').toBeInstanceOf(OptionsError);
    expect((refusal as OptionsError).field).toBe('requestTimeoutMs');
  });

  test('the idle ceiling is one the runtime can arm: a keep-alive connection outlives its response', async () => {
    // Binds the number above to the runtime rather than to the validator: one
    // second more and bun 1.4.2 closes this socket within milliseconds.
    const binding = await bindWith({ 'actor-ts': { http: { server: { 'idle-timeout': IDLE_TIMEOUT_CEILING_MS } } } });
    const socket = await open(binding);
    socket.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n');

    expect(await closedWithin(socket, 1_500), 'the runtime armed the idle ceiling as an instant close').toBe(false);
  }, 15_000);
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

/**
 * The readers on their own, one exact-object case per leaf (#1425).
 *
 * The cases above prove that a block reaches the server; they cannot prove
 * that every leaf in it is read.  A reader that drops a leaf, reads one key
 * where it meant another whose shipped value happens to agree, or writes an
 * own `undefined` for an unset leaf passes all of them, because the built-in
 * default answers in its place.  These assert on the reader's whole result
 * with {@link expectExactOptions}, so each of those is a failure naming the
 * field: every leaf set to a value no other leaf and no default shares, the
 * shipped `reference.conf` resolving to exactly its documented values, and an
 * unset leaf omitted rather than present as `undefined`.
 *
 * `Config.parseString` throughout, never `Config.fromObject` with dotted keys,
 * which keeps the dotted string as one literal top-level key that no reader
 * would ever look up.
 */
describe('readHttpBackendFromConfig', () => {
  test.each(['fastify', 'express', 'hono'] as const)('reads %s as that name', (name) => {
    expectExactOptions(readHttpBackendFromConfig(Config.parseString(`actor-ts.http.backend = "${name}"`)), name);
  });

  test('an unset key reads as nothing, which leaves the built-in default to bind()', () => {
    expectExactOptions(readHttpBackendFromConfig(Config.parseString('actor-ts.system.name = x')), undefined);
  });

  test('the shipped reference.conf names fastify', () => {
    expectExactOptions(readHttpBackendFromConfig(Config.parseString(REFERENCE_CONF)), 'fastify');
  });

  test('an unknown name is refused by the read itself, naming the key', () => {
    // The reader builds nothing, so a name with no backend behind it has to be
    // refused here — the factory only ever sees a name it has an arm for.
    const config = Config.parseString('actor-ts.http.backend = "bun"');
    expect(() => readHttpBackendFromConfig(config)).toThrow(ConfigError);
    expect(() => readHttpBackendFromConfig(config)).toThrow('actor-ts.http.backend = "bun"');
  });
});

describe('readHttpShutdownGracePeriodFromConfig', () => {
  test('reads the drain window as a duration, unit and all', () => {
    expectExactOptions(
      readHttpShutdownGracePeriodFromConfig(Config.parseString('actor-ts.http.shutdown-grace-period = 3s')),
      3_000,
    );
  });

  test('an unset key reads as nothing, not as a window of zero', () => {
    // Absent is reported as absent, as by every reader here: what an unset
    // key means is decided at unbind(), not invented by the read.
    expectExactOptions(readHttpShutdownGracePeriodFromConfig(Config.parseString('actor-ts.system.name = x')), undefined);
  });

  test('the shipped reference.conf resolves to the documented 0ms', () => {
    expectExactOptions(readHttpShutdownGracePeriodFromConfig(Config.parseString(REFERENCE_CONF)), 0);
  });
});

describe('readHttpClientOptionsFromConfig', () => {
  test('reads every leaf of the block, kebab mapped to camelCase', () => {
    const config = Config.parseString(`
      actor-ts.http.client {
        max-response-bytes = 64KiB
        default-timeout    = 750ms
        redirect           = "manual"
        max-redirects      = 2
      }
    `);
    expectExactOptions(readHttpClientOptionsFromConfig(config), {
      maxResponseBytes: 64 * 1024,
      defaultTimeoutMs: 750,
      redirect: 'manual',
      maxRedirects: 2,
    });
  });

  test('an absent block yields nothing at all, not a bag of undefined', () => {
    expectExactOptions(readHttpClientOptionsFromConfig(Config.parseString('actor-ts.system.name = x')), {});
  });

  test('a partly-set block returns only what was set', () => {
    expectExactOptions(
      readHttpClientOptionsFromConfig(Config.parseString('actor-ts.http.client.max-redirects = 9')),
      { maxRedirects: 9 },
    );
  });

  test('the shipped reference.conf resolves to the documented defaults', () => {
    expectExactOptions(readHttpClientOptionsFromConfig(Config.parseString(REFERENCE_CONF)), {
      maxResponseBytes: DEFAULT_HTTP_CLIENT_MAX_RESPONSE_BYTES,
      defaultTimeoutMs: DEFAULT_HTTP_CLIENT_TIMEOUT_MS,
      redirect: DEFAULT_HTTP_CLIENT_REDIRECT_MODE,
      maxRedirects: DEFAULT_HTTP_CLIENT_MAX_REDIRECTS,
    });
  });

  test.each([
    ['maxResponseBytes = 1K', 'maxResponseBytes', 'max-response-bytes'],
    ['defaultTimeoutMs = 5s', 'defaultTimeoutMs', 'default-timeout'],
    ['maxRedirects = 3', 'maxRedirects', 'max-redirects'],
  ])('a retired %s is refused by the read itself, naming both spellings', (assignment, retired, current) => {
    const config = Config.parseString(`actor-ts.http.client { ${assignment} }`);
    expect(() => readHttpClientOptionsFromConfig(config)).toThrow(ConfigError);
    expect(() => readHttpClientOptionsFromConfig(config))
      .toThrow(new RegExp(`actor-ts\\.http\\.client\\.${retired}[\\s\\S]*actor-ts\\.http\\.client\\.${current}`));
  });
});

describe('readHttpServerOptionsFromConfig', () => {
  test('reads every leaf of the block, the two comment-only ones included', () => {
    const config = Config.parseString(`
      actor-ts.http.server {
        header-timeout  = 11s
        request-timeout = 90s
        http2           = true
        idle-timeout    = 7s
        max-connections = 250
      }
    `);
    expectExactOptions(readHttpServerOptionsFromConfig(config), {
      headerTimeoutMs: 11_000,
      requestTimeoutMs: 90_000,
      http2: true,
      idleTimeoutMs: 7_000,
      maxConnections: 250,
    });
  });

  test('an absent block yields nothing at all, not a bag of undefined', () => {
    expectExactOptions(readHttpServerOptionsFromConfig(Config.parseString('actor-ts.system.name = x')), {});
  });

  test('a partly-set block returns only what was set', () => {
    expectExactOptions(
      readHttpServerOptionsFromConfig(Config.parseString('actor-ts.http.server.request-timeout = 45s')),
      { requestTimeoutMs: 45_000 },
    );
  });

  test('max-connections counts sockets, so a size suffix is refused rather than read as 1024', () => {
    // A bare integer reads the same through getInt and getBytes; only a suffix
    // tells the two apart, and getBytes would take `1K` as a thousand sockets.
    const config = Config.parseString('actor-ts.http.server.max-connections = 1K');
    expect(() => readHttpServerOptionsFromConfig(config)).toThrow(ConfigError);
    expect(() => readHttpServerOptionsFromConfig(config)).toThrow('actor-ts.http.server.max-connections');
  });

  test('the shipped reference.conf resolves to the documented defaults, and nothing for the rest', () => {
    // idle-timeout, max-connections and tls are comment-only there, and their
    // absence is the whole mechanism: present as `undefined`, they would read
    // as set to a spread that does not strip them.
    expectExactOptions(readHttpServerOptionsFromConfig(Config.parseString(REFERENCE_CONF)), {
      headerTimeoutMs: DEFAULT_HTTP_SERVER_HEADER_TIMEOUT_MS,
      requestTimeoutMs: DEFAULT_HTTP_SERVER_REQUEST_TIMEOUT_MS,
      http2: DEFAULT_HTTP_SERVER_HTTP2,
    });
  });

  describe('the tls block', () => {
    let directory = '';

    /** Write `contents` to a file of its own and hand back the HOCON-quoted path. */
    function pemFile(name: string, contents: string): string {
      if (directory === '') directory = mkdtempSync(join(tmpdir(), 'http-server-tls-'));
      const file = join(directory, name);
      writeFileSync(file, contents);
      // JSON's string escapes are HOCON's, so a Windows path survives intact.
      return JSON.stringify(file);
    }

    afterEach(() => {
      if (directory !== '') rmSync(directory, { recursive: true, force: true });
      directory = '';
    });

    test('every leaf is read, the three files as their contents', () => {
      const config = Config.parseString(`
        actor-ts.http.server.tls {
          cert-file           = ${pemFile('cert.pem', 'the certificate')}
          key-file            = ${pemFile('key.pem', 'the key')}
          ca-file             = ${pemFile('ca.pem', 'the authority')}
          request-client-cert = true
          reject-unauthorized = false
        }
      `);
      expectExactOptions(readHttpServerOptionsFromConfig(config), {
        tls: {
          cert: 'the certificate',
          key: 'the key',
          ca: 'the authority',
          requestClientCert: true,
          rejectUnauthorized: false,
        },
      });
    });

    test('a block naming only the pair comes back with the pair and nothing else', () => {
      const config = Config.parseString(`
        actor-ts.http.server.tls {
          cert-file = ${pemFile('cert.pem', 'the certificate')}
          key-file  = ${pemFile('key.pem', 'the key')}
        }
      `);
      expectExactOptions(readHttpServerOptionsFromConfig(config), {
        tls: { cert: 'the certificate', key: 'the key' },
      });
    });
  });
});
