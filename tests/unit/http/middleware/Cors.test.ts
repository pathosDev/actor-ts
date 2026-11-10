import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { serializeCookie } from '../../../../src/http/Cookies.js';
import { MAXIMUM_ECHOED_CORS_HEADERS_LENGTH } from '../../../../src/http/Constants.js';
import type { HttpServerBackend, ServerBinding } from '../../../../src/http/backend/HttpServerBackend.js';
import { Status, type HttpRequest } from '../../../../src/http/Types.js';
import { DEFAULT_WEBSOCKET_POLICY } from '../../../../src/http/websocket/WebsocketPolicy.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';

describe('cors — validation + compile', () => {
  /**
   * The required-`origins` guard moved from `cors()` to the compile step
   * (#878): a configuration file may now be the sole source of `origins`, and
   * `cors()` runs before any `ActorSystem` exists, so it cannot tell "nobody
   * set it" from "nobody set it *in code*".  Both halves are pinned — that
   * building the node no longer throws, and that compiling it still does.
   */
  test('origins is required — at compile time, not at construction', () => {
    const route = cors({}, get(() => complete(Status.OK, '')));
    expect(() => compile(route)).toThrow(/origins is required/);
    // The message has to name both ways out, or an operator who put the
    // allowlist in HOCON and mistyped the key is told to edit their code.
    expect(() => compile(route)).toThrow(/actor-ts\.http\.cors\.origins/);
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

  /**
   * The filter is RFC 7230's `tchar` production, and every positive fixture
   * above happens to be alphanumeric-plus-hyphen.  So a filter narrowed to
   * `/^[A-Za-z0-9-]+$/` — which silently drops legal names carrying any of
   * `_ . ! # $ % & ' * + ^ \` | ~` — passes all of them.  That is not a
   * hypothetical narrowing: `_` alone appears in real header names, and a
   * dropped element is invisible to the client, which simply finds the header
   * it asked for missing from the allow list.
   */
  test('every legal tchar survives, not just the alphanumeric ones', async () => {
    // One name per non-alphanumeric tchar, each on its own element so a drop
    // names the character that caused it.
    const punctuation = ['!', '#', '$', '%', '&', "'", '*', '+', '.', '^', '_', '`', '|', '~', '-'];
    const names = punctuation.map((character) => `x${character}a`);
    expect(await echoedAllowHeaders(names.join(', '))).toBe(names.join(', '));
  });

  /**
   * The token production is documented as "deliberately the same production
   * as `COOKIE_NAME_RE` in `../Cookies.ts`; both validate an HTTP token" —
   * two copies of one grammar, in two files, with nothing making them agree.
   *
   * Asserted through both public surfaces rather than by comparing the two
   * regex literals, so an equivalent respelling of either is not a failure
   * and a genuine divergence is.  `serializeCookie` throws on a name its own
   * production refuses, which is the cookie side's answer to the same
   * question the CORS echo answers by dropping the element.
   */
  test('the token production matches the cookie-name one, character for character', async () => {
    const accepts = (character: string): boolean => {
      try {
        serializeCookie(`x${character}a`, 'v');
        return true;
      } catch {
        return false;
      }
    };
    // Every printable ASCII character, so the two sets are compared whole
    // rather than at a handful of sampled points.  One request per character:
    // a single list of 94 names would be subject to the length cap as well,
    // which is a different mechanism and has its own test below.
    const printableAscii = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) => String.fromCharCode(0x21 + i));
    const survivors = new Set<string>();
    for (const character of printableAscii) {
      const name = `x${character}a`;
      if (await echoedAllowHeaders(name) === name) survivors.add(name);
    }

    const echoAccepts = printableAscii.filter((character) => survivors.has(`x${character}a`));
    const cookieAccepts = printableAscii.filter((character) => accepts(character));
    expect(echoAccepts).toEqual(cookieAccepts);
    // Guards the comparison from passing vacuously: a filter that dropped
    // every element, or a `serializeCookie` that accepted every name, agrees
    // with a matching partner just as well.  `tchar` is 62 alphanumerics plus
    // 15 punctuation marks, out of the 94 printable ASCII characters.
    expect(echoAccepts).toHaveLength(77);
  });

  /**
   * The cap is pinned from above by the test three cases up
   * (`toBeLessThanOrEqual(1024)`) and, until this, from nowhere below: an
   * accidental shrink to any value in 40…1023 truncated legitimate preflight
   * echoes with the whole suite green.  A browser that asked for a header and
   * did not get it back simply fails the request, so the failure is a CORS
   * error at the client with nothing logged here.
   */
  test('the cap is wide enough for a realistic preflight, not merely bounded', async () => {
    expect(MAXIMUM_ECHOED_CORS_HEADERS_LENGTH).toBe(1024);
    // 20 names of 40 characters plus their separators — 838 characters, well
    // inside the documented budget and well outside a shrunken one.
    const names = Array.from({ length: 20 }, (_, i) => `x-tenant-request-header-${String(i).padStart(16, '0')}`);
    const requested = names.join(', ');
    expect(requested.length).toBeLessThanOrEqual(MAXIMUM_ECHOED_CORS_HEADERS_LENGTH);
    expect(await echoedAllowHeaders(requested)).toBe(requested);
  });

  /**
   * The number lives in four hand-maintained places — the constant, the
   * bound above, and the English and German prose — and nothing tied the two
   * halves together.  Reading the docs here is the cheapest binding that
   * fails when the constant moves without them, and it is the same shape the
   * `reference.conf` documented-defaults pin already uses.
   */
  test('both documentation mirrors quote the cap the code enforces', () => {
    const documentationRoot = join(import.meta.dir, '..', '..', '..', '..', 'docs', 'src', 'content', 'docs');
    const pages: ReadonlyArray<readonly [string, string]> = [
      [join(documentationRoot, 'http', 'middleware', 'cors.mdx'), '-character cap'],
      [join(documentationRoot, 'de', 'http', 'middleware', 'cors.mdx'), '-Zeichen-Limit'],
    ];
    for (const [page, phrase] of pages) {
      expect(readFileSync(page, 'utf8')).toContain(`${MAXIMUM_ECHOED_CORS_HEADERS_LENGTH}${phrase}`);
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

/**
 * The echoed `Access-Control-Allow-Origin` (#1516).
 *
 * `allowOriginValue` returned the request's `Origin` verbatim for every
 * configuration but the uncredentialed wildcard, and one of those reaches it
 * with text nothing constrained: `withOriginPredicate` answers a boolean about
 * a string it was handed, so whatever satisfied the predicate went into the
 * header.  The sibling guard four functions above it (#792) had already argued
 * the case — an echo that is load-bearing must not depend on the layers
 * beneath it — and this one was not touched at the time.
 *
 * These drive the compiled handler for the reason the #792 block records: no
 * runtime's request parser will deliver a bare CR/LF to a handler, so a
 * live-server test cannot put the bytes where the guard has to see them.
 */
describe('cors — the echoed Access-Control-Allow-Origin (#1516)', () => {
  const HOSTILE_ORIGIN = 'https://evil\r\nSet-Cookie: stolen=1.example';
  const WELL_FORMED = 'https://good.example';

  const echoedOrigin = async (
    options: CorsOptions,
    origin: string,
    method: 'OPTIONS' | 'GET' = 'OPTIONS',
  ): Promise<string | undefined> => {
    const compiled = compile(cors(options, path('api', get(() => complete(Status.OK, 'data')))));
    const route = compiled.find((c) => c.kind === 'http' && c.method === method);
    if (!route || route.kind !== 'http') throw new Error(`expected a ${method} route`);
    const response = await route.handler({
      method,
      path: '/api',
      headers: { origin, 'access-control-request-method': 'GET' },
      query: {},
      params: {},
      body: null,
    });
    const headers = response.headers ?? {};
    const key = Object.keys(headers).find((k) => k.toLowerCase() === 'access-control-allow-origin');
    return key === undefined ? undefined : headers[key];
  };

  const predicateAllowingEverything = (): CorsOptions =>
    CorsOptions.create().withOriginPredicate(() => true);

  test('a predicate that accepts a malformed origin does not put it in the header', async () => {
    // The reported defect, on the preflight path.
    expect(await echoedOrigin(predicateAllowingEverything(), HOSTILE_ORIGIN)).toBeUndefined();
  });

  test('and not on the actual-response path either', async () => {
    // `decorateResponse` is a second call site with its own deny branch; the
    // first version of this fix guarded only the preflight.
    expect(await echoedOrigin(predicateAllowingEverything(), HOSTILE_ORIGIN, 'GET')).toBeUndefined();
  });

  test('a predicate that accepts a well-formed origin still echoes it', async () => {
    // The control that keeps this a guard rather than a removal: refusing
    // everything would satisfy the case above and break the feature.
    expect(await echoedOrigin(predicateAllowingEverything(), WELL_FORMED)).toBe(WELL_FORMED);
  });

  test('the opaque origin `null` is echoed, because a browser really sends it', async () => {
    // A sandboxed iframe, a `data:` document, a cross-origin form post that
    // redirected. Refusing it would deny requests the Fetch spec expects an
    // answer to, and it is the one value that cannot survive a URL round trip.
    expect(await echoedOrigin(predicateAllowingEverything(), 'null')).toBe('null');
  });

  test.each([
    ['a trailing slash', 'https://good.example/'],
    ['a path', 'https://good.example/admin'],
    ['embedded credentials', 'https://user:pw@good.example'],
    ['a leading space', ' https://good.example'],
    ['an embedded tab', 'https://good\texample'],
  ])('refuses %s', async (_label, origin) => {
    // Each is a value the URL parser normalises away rather than preserves, so
    // echoing it would hand the browser a string it never sent — which fails
    // the client's own byte comparison while reading as success on this side.
    expect(await echoedOrigin(predicateAllowingEverything(), origin)).toBeUndefined();
  });

  test('the wildcard and exact-allowlist paths are unchanged', async () => {
    // Neither can produce attacker-shaped text — the wildcard answers a
    // literal and an allowlist match *is* a configured string — so the fix
    // deliberately does not reach them, and that is asserted rather than
    // assumed.
    expect(await echoedOrigin(CorsOptions.create().withAnyOrigin(), HOSTILE_ORIGIN)).toBe('*');
    expect(await echoedOrigin(CorsOptions.create().withOrigins(WELL_FORMED), WELL_FORMED))
      .toBe(WELL_FORMED);
  });
});
