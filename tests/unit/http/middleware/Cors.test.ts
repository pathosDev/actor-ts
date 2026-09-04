import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { FastifyBackend } from '../../../../src/http/backend/FastifyBackend.js';
import { ExpressBackend } from '../../../../src/http/backend/ExpressBackend.js';
import { HonoBackend } from '../../../../src/http/backend/HonoBackend.js';
import { HttpExtensionId } from '../../../../src/http/HttpExtension.js';
import { compile, complete, concat, get, options, path, post, type Route } from '../../../../src/http/Route.js';
import { cors } from '../../../../src/http/middleware/Cors.js';
import { CorsOptions } from '../../../../src/http/middleware/CorsOptions.js';
import type { HttpServerBackend, ServerBinding } from '../../../../src/http/backend/HttpServerBackend.js';
import { Status, type HttpRequest } from '../../../../src/http/Types.js';
import { DEFAULT_WEBSOCKET_POLICY } from '../../../../src/http/websocket/WebsocketPolicy.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';

describe('cors — validation + compile', () => {
  test('origins is required', () => {
    expect(() => cors({}, get(() => complete(Status.OK, '')))).toThrow(/origins is required/);
  });

  test('credentials cannot combine with a wildcard origin', () => {
    expect(() => cors(CorsOptions.create().withAnyOrigin().withCredentials(), get(() => complete(Status.OK, ''))))
      .toThrow(/credentials cannot be combined/);
  });

  test('synthesises exactly one OPTIONS preflight per pattern', () => {
    const compiled = compile(cors(
      CorsOptions.create().withAnyOrigin(),
      path('api', concat(get(() => complete(Status.OK, 'g')), post(() => complete(Status.Created, 'p')))),
    ));
    const options = compiled.filter((c) => c.kind === 'http' && c.method === 'OPTIONS');
    expect(options).toHaveLength(1);
    expect(options[0]!.kind === 'http' && options[0]!.pattern).toBe('/api');
    // the real routes survive
    const verbs = compiled.filter((c) => c.kind === 'http').map((c) => c.kind === 'http' && `${c.method} ${c.pattern}`);
    expect(verbs).toContain('GET /api');
    expect(verbs).toContain('POST /api');
  });

  test('does not add a second OPTIONS when the user already defined one', () => {
    const compiled = compile(cors(
      CorsOptions.create().withAnyOrigin(),
      path('api', concat(get(() => complete(Status.OK, 'g')), options(() => complete(Status.OK, 'custom')))),
    ));
    const optionsRoutes = compiled.filter((c) => c.kind === 'http' && c.method === 'OPTIONS');
    expect(optionsRoutes).toHaveLength(1);
  });

  test("merges Origin into a handler's mixed-case Vary, leaving exactly one key (#603)", async () => {
    const compiled = compile(cors(
      CorsOptions.create().withOrigins('https://app.example'),
      path('api', get(() => complete(Status.OK, 'data', { Vary: 'Cookie' }))),
    ));
    const route = compiled.find((c) => c.kind === 'http' && c.method === 'GET');
    if (!route || route.kind !== 'http') throw new Error('expected a GET route');
    const response = await route.handler({
      method: 'GET', path: '/api', headers: { origin: 'https://app.example' }, query: {}, params: {}, body: null,
    });
    // Two spellings in the record would render correctly only by accident of
    // insertion order, and any middleware reading Vary would see the wrong one.
    const varyKeys = Object.keys(response.headers ?? {}).filter((k) => k.toLowerCase() === 'vary');
    expect(varyKeys).toHaveLength(1);
    expect(response.headers?.[varyKeys[0]!]).toBe('Cookie, Origin');
  });

  test('folds an origin check into a websocket upgrade in the subtree', async () => {
    const wsLiteral: Route = {
      kind: 'websocket',
      connect: () => {},
      resolvePolicy: () => DEFAULT_WEBSOCKET_POLICY,
    };
    const compiled = compile(cors(CorsOptions.create().withOrigins('https://ok.example'), path('ws', wsLiteral)));
    const ws = compiled.find((c) => c.kind === 'websocket');
    if (!ws || ws.kind !== 'websocket') throw new Error('expected a websocket route');
    const request = (headers: Record<string, string>): HttpRequest => ({ method: 'GET', path: '/ws', headers, query: {}, params: {}, body: null });
    expect((await ws.authorize(request({ origin: 'https://evil.example' })))?.status).toBe(403);
    expect(await ws.authorize(request({ origin: 'https://ok.example' }))).toBeNull();
    expect(await ws.authorize(request({}))).toBeNull(); // no Origin → not treated as cross-origin
  });
});

const backends: Array<[string, () => HttpServerBackend]> = [
  ['fastify', () => new FastifyBackend({ logger: false })],
  ['express', () => new ExpressBackend()],
  ['hono', () => new HonoBackend()],
];

const live: Array<{ binding: ServerBinding; system: ActorSystem }> = [];
afterEach(async () => {
  while (live.length) {
    const { binding, system } = live.shift()!;
    await binding.unbind();
    await system.terminate();
  }
});

async function start(mk: () => HttpServerBackend, routes: Route): Promise<string> {
  const sysOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('http-cors-test', sysOptions);
  const binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).useBackend(mk()).bind(routes);
  live.push({ binding, system });
  return `http://${binding.host}:${binding.port}`;
}

const ALLOWED = 'https://app.example';

/**
 * The echoed `Access-Control-Allow-Headers` (#792).
 *
 * These go through `compile()` and call the synthesised OPTIONS handler
 * directly, and that is not a shortcut — it is the only way to run them.
 * Every hostile value below is one `fetch` refuses to send (undici validates a
 * header value before it reaches a socket) and one no HTTP parser would hand
 * back intact anyway, so a live-server test cannot deliver the input this
 * function is supposed to defend against.  Driving the handler is what puts
 * the bytes where `sanitiseRequestHeaders` actually sees them.
 *
 * The point being pinned is that the function is self-sufficient.  Nothing
 * here can split a response today: all three runtimes' parsers reject a bare
 * CR/LF in a request header value, and `setHeader` / `Headers.set` reject one
 * on the way out.  But a guard whose stated job is stripping a character class
 * has to strip it whether or not something underneath would have caught the
 * miss, and the two characters that *did* survive every one of those layers —
 * HTAB and U+00A0 — are in here for the same reason.
 */
describe('cors — echoed Access-Control-Allow-Headers (#792)', () => {
  const echoedAllowHeaders = async (requestedHeaders: string): Promise<string | undefined> => {
    const compiled = compile(cors(
      CorsOptions.create().withOrigins(ALLOWED),
      path('api', get(() => complete(Status.OK, 'data'))),
    ));
    const route = compiled.find((c) => c.kind === 'http' && c.method === 'OPTIONS');
    if (!route || route.kind !== 'http') throw new Error('expected the synthesised OPTIONS route');
    const response = await route.handler({
      method: 'OPTIONS',
      path: '/api',
      headers: {
        origin: ALLOWED,
        'access-control-request-method': 'GET',
        'access-control-request-headers': requestedHeaders,
      },
      query: {},
      params: {},
      body: null,
    });
    return response.headers?.['access-control-allow-headers'];
  };

  test('a well-formed list round-trips unchanged', async () => {
    expect(await echoedAllowHeaders('x-custom, content-type')).toBe('x-custom, content-type');
    // Whitespace around the separators is normalised, not preserved.
    expect(await echoedAllowHeaders('  x-custom ,content-type  ')).toBe('x-custom, content-type');
  });

  test('CR and LF never reach the response header', async () => {
    // The shape from the report: a smuggled second header behind a CRLF.
    const echoed = await echoedAllowHeaders('x-a\r\nSet-Cookie: session=attacker');
    expect(echoed ?? '').not.toMatch(/[\r\n]/);
    expect((echoed ?? '').toLowerCase()).not.toContain('set-cookie');
  });

  test('the whitespace characters that DO survive a real request are stripped', async () => {
    // HTAB and U+00A0 are the two `\s` members that get past llhttp/Deno's
    // parser AND past setHeader/Headers.set on all three runtimes, so before
    // this fix they were echoed verbatim onto the wire.  Written as escapes:
    // an invisible NBSP in a source file is not something review can see.
    expect(await echoedAllowHeaders('x-a\tb')).toBeUndefined();
    expect(await echoedAllowHeaders('x-a\u00a0b')).toBeUndefined();
    // U+2028 cannot arrive from the wire: header values decode as Latin-1, so
    // its UTF-8 encoding lands as three characters `\s` does not match, and even
    // the old regex stripped those.  It is here because it IS a `\s` member, so
    // the negated class kept it, and a caller assembling the value in-process
    // can still supply one.
    expect(await echoedAllowHeaders('x-a\u2028b')).toBeUndefined();
  });

  test('an element with an illegal character is dropped whole, not scrubbed', async () => {
    // Scrubbing turns `x-b:evil` into the plausible-looking `x-bevil`, which
    // is a header name the client never asked for.
    expect(await echoedAllowHeaders('x-good, x-b:evil, x-also-good')).toBe('x-good, x-also-good');
  });

  test('the field is omitted entirely when nothing legal survives', async () => {
    expect(await echoedAllowHeaders('(),<>')).toBeUndefined();
    expect(await echoedAllowHeaders('')).toBeUndefined();
  });

  test('every echoed element is a whole RFC 7230 token, even at the length cap', async () => {
    const token = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
    const names = Array.from({ length: 60 }, (_, i) => `x-header-name-${String(i).padStart(20, '0')}`);
    const echoed = await echoedAllowHeaders(names.join(', ')) ?? '';
    expect(echoed.length).toBeLessThanOrEqual(1024);
    // A `slice()`-style cap cuts the last name in half; dropping whole names
    // keeps the list something a browser can act on.
    for (const element of echoed.split(', ')) {
      expect(element).toMatch(token);
      expect(names).toContain(element);
    }
  });

  test('a configured allowlist still wins over the echo', async () => {
    const compiled = compile(cors(
      CorsOptions.create().withOrigins(ALLOWED).withAllowedHeaders('x-a', 'x-b'),
      path('api', get(() => complete(Status.OK, 'data'))),
    ));
    const route = compiled.find((c) => c.kind === 'http' && c.method === 'OPTIONS');
    if (!route || route.kind !== 'http') throw new Error('expected the synthesised OPTIONS route');
    const response = await route.handler({
      method: 'OPTIONS',
      path: '/api',
      headers: { origin: ALLOWED, 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-a\r\nevil' },
      query: {},
      params: {},
      body: null,
    });
    expect(response.headers?.['access-control-allow-headers']).toBe('x-a, x-b');
  });
});

describe.each(backends)('cors — %s backend', (_name, mk) => {
  const withCors = (): Route => cors(
    CorsOptions.create().withOrigins(ALLOWED),
    path('api', get(() => complete(Status.OK, 'data'))),
  );

  test('answers a preflight for an allowed origin', async () => {
    const url = await start(mk, withCors());
    const response = await fetch(`${url}/api`, {
      method: 'OPTIONS',
      headers: { origin: ALLOWED, 'access-control-request-method': 'GET' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(response.headers.get('access-control-allow-methods')).toContain('GET');
    expect(response.headers.get('vary') ?? '').toContain('Origin');
  });

  test('without cors, a preflight carries no CORS headers (pins the routing constraint)', async () => {
    const url = await start(mk, path('api', get(() => complete(Status.OK, 'data'))));
    const response = await fetch(`${url}/api`, {
      method: 'OPTIONS',
      headers: { origin: ALLOWED, 'access-control-request-method': 'GET' },
    });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('decorates the actual response for an allowed origin', async () => {
    const url = await start(mk, withCors());
    const response = await fetch(`${url}/api`, { headers: { origin: ALLOWED } });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(response.headers.get('vary') ?? '').toContain('Origin');
  });

  test("keeps a handler's own Vary on the wire and merges Origin into it (#603)", async () => {
    const url = await start(mk, cors(
      CorsOptions.create().withOrigins(ALLOWED),
      path('api', get(() => complete(Status.OK, 'data', { Vary: 'Cookie' }))),
    ));
    const response = await fetch(`${url}/api`, { headers: { origin: ALLOWED } });
    // Collapsing this to `Vary: Origin` lets a cache serve one user's
    // cookie-dependent response to another.
    const vary = (response.headers.get('vary') ?? '').toLowerCase();
    expect(vary).toContain('cookie');
    expect(vary).toContain('origin');
  });

  test('omits CORS headers for a disallowed origin', async () => {
    const url = await start(mk, withCors());
    const response = await fetch(`${url}/api`, { headers: { origin: 'https://evil.example' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('withAnyOrigin echoes a literal * (no credentials)', async () => {
    const url = await start(mk, cors(CorsOptions.create().withAnyOrigin(), path('api', get(() => complete(Status.OK, 'd')))));
    const response = await fetch(`${url}/api`, { headers: { origin: ALLOWED } });
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  test('credentials echoes the origin and sets allow-credentials', async () => {
    const url = await start(mk, cors(
      CorsOptions.create().withOrigins(ALLOWED).withCredentials(),
      path('api', get(() => complete(Status.OK, 'd'))),
    ));
    const response = await fetch(`${url}/api`, { headers: { origin: ALLOWED } });
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
  });

  test('echoes the requested headers on a preflight when none are configured', async () => {
    const url = await start(mk, withCors());
    const response = await fetch(`${url}/api`, {
      method: 'OPTIONS',
      headers: { origin: ALLOWED, 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-custom, content-type' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-headers') ?? '').toContain('x-custom');
  });

  test('uses the configured allowed headers + max-age on a preflight', async () => {
    const url = await start(mk, cors(
      CorsOptions.create().withOrigins(ALLOWED).withAllowedHeaders('x-a', 'x-b').withMaxAge(120),
      path('api', get(() => complete(Status.OK, 'd'))),
    ));
    const response = await fetch(`${url}/api`, {
      method: 'OPTIONS',
      headers: { origin: ALLOWED, 'access-control-request-method': 'GET' },
    });
    expect(response.headers.get('access-control-allow-headers')).toBe('x-a, x-b');
    expect(response.headers.get('access-control-max-age')).toBe('120');
  });

  test('a user OPTIONS route still handles a non-preflight OPTIONS', async () => {
    const url = await start(mk, cors(
      CorsOptions.create().withOrigins(ALLOWED),
      path('api', concat(get(() => complete(Status.OK, 'g')), options(() => complete(Status.OK, 'custom-options')))),
    ));
    // No Origin / Access-Control-Request-Method → not a preflight → user handler runs.
    const response = await fetch(`${url}/api`, { method: 'OPTIONS' });
    expect(await response.text()).toBe('custom-options');
  });
});
