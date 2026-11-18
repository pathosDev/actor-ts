/**
 * #1056 — a 3xx whose `location` leaves the request's origin is refused with
 * a 500 on every backend, whichever way the response was built.
 *
 * `redirect()` already refused an off-origin target (#125), but a handler
 * that writes the header itself — `complete(Status.Found, null, { location })`
 * — went straight past it.  The guard now runs on the response the route
 * tree produced, so a hand-built literal, a thrown `HttpError` carrying a
 * `location`, and a `fallback()` answer are all checked.  `redirectExternal()`
 * stays the per-route opt-in, and `withAllowedRedirectOrigins(...)` the
 * server-wide one.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { ExpressBackend } from '../../../src/http/backend/ExpressBackend.js';
import { FastifyBackend } from '../../../src/http/backend/FastifyBackend.js';
import { HonoBackend } from '../../../src/http/backend/HonoBackend.js';
import type { HttpServerBackend, ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { HttpExtensionId, type ServerBuilder } from '../../../src/http/HttpExtension.js';
import { securityHeaders } from '../../../src/http/middleware/SecurityHeaders.js';
import {
  complete,
  concat,
  fallback,
  get,
  path,
  queryParam,
  redirectExternal,
  withMiddleware,
  type Route,
} from '../../../src/http/Route.js';
import { HttpError, Status } from '../../../src/http/Types.js';
import type { LogContextData } from '../../../src/LogContext.js';
import { LogLevel, type Logger } from '../../../src/Logger.js';

/** Collects the error lines the system logger was told, including via `withSource`. */
class ErrorRecorder implements Logger {
  readonly errors: string[] = [];
  readonly level = LogLevel.Debug;
  constructor(private readonly root: ErrorRecorder | null = null) {}
  debug(): void { /* not asserted */ }
  info(): void { /* not asserted */ }
  warn(): void { /* not asserted */ }
  error(message: string): void { (this.root ?? this).errors.push(message); }
  withSource(): Logger { return new ErrorRecorder(this.root ?? this); }
  withFields(_fields: LogContextData): Logger { return new ErrorRecorder(this.root ?? this); }
}

const backends: ReadonlyArray<readonly [string, () => HttpServerBackend]> = [
  ['fastify', () => new FastifyBackend({ logger: false })],
  ['express', () => new ExpressBackend()],
  ['hono', () => new HonoBackend()],
];

const routes = (): Route => concat(
  // The issue's own reproduction: the target is a request parameter.
  path('literal', get((request) => complete(Status.Found, null, { location: queryParam(request, 'next') ?? '/' }))),
  // 303 has no `Status` constant; the literal is the status under test.
  path('cased', get((request) => complete(303, null, { Location: queryParam(request, 'next') ?? '/' }))),
  path('same-host', get((request) => complete(Status.Found, null, { location: `http://${request.headers['host']}/home` }))),
  path('not-a-redirect', get(() => complete(Status.OK, 'body', { location: 'https://evil.example/' }))),
  path('external', get(() => redirectExternal('https://payments.example/checkout'))),
  path('external-decorated', withMiddleware(securityHeaders(), get(() => redirectExternal('https://payments.example/checkout')))),
  path('thrown', get(() => {
    throw new HttpError(Status.Found, 'moved', undefined, { location: 'https://evil.example/phish' });
  })),
  fallback(() => complete(Status.MovedPermanently, null, { location: 'https://evil.example/fallback' })),
);

const live: Array<{ readonly binding: ServerBinding; readonly system: ActorSystem }> = [];
afterEach(async () => {
  while (live.length > 0) {
    const { binding, system } = live.shift()!;
    await binding.unbind();
    await system.terminate();
  }
});

async function serve(
  makeBackend: () => HttpServerBackend,
  configure: (builder: ServerBuilder) => ServerBuilder = (builder) => builder,
): Promise<{ readonly url: string; readonly log: ErrorRecorder }> {
  const log = new ErrorRecorder();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(log)
    .withLogLevel(LogLevel.Debug);
  const system = ActorSystem.create('off-origin-redirects', systemOptions);
  const builder = system.extension(HttpExtensionId)
    .newServerAt('127.0.0.1', 0)
    .useBackend(makeBackend());
  const binding = await configure(builder).bind(routes());
  live.push({ binding, system });
  return { url: `http://${binding.host}:${binding.port}`, log };
}

const fetchManual = (url: string): Promise<Response> => fetch(url, { redirect: 'manual' });

/** The response a refused redirect must be: the generic 500, no `location`. */
async function expectRefused(response: Response): Promise<void> {
  expect(response.status).toBe(500);
  expect(response.headers.get('location')).toBeNull();
  expect(await response.json()).toEqual({ error: 'Internal Server Error' });
}

describe.each(backends)('%s: an off-origin 3xx is refused (#1056)', (_name, makeBackend) => {
  test.each([
    ['an absolute URL', 'https://evil.example/phish'],
    ['a protocol-relative target', '//evil.example/phish'],
    ['a backslash the browser reads as a slash', '/\\evil.example/phish'],
    ['a javascript: target', 'javascript:alert(1)'],
  ])('a hand-built literal to %s is a 500', async (_label, target) => {
    const { url, log } = await serve(makeBackend);
    await expectRefused(await fetchManual(`${url}/literal?next=${encodeURIComponent(target)}`));
    // The operator learns of it; the target itself never reaches the line.
    expect(log.errors.some((line) => line.includes('off-origin redirect'))).toBe(true);
    expect(log.errors.join('\n')).not.toContain('evil.example');
  });

  test('a same-origin literal still redirects', async () => {
    const { url } = await serve(makeBackend);
    const response = await fetchManual(`${url}/literal?next=${encodeURIComponent('/home')}`);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/home');
  });

  test('an absolute URL naming the request\'s own host still redirects', async () => {
    const { url } = await serve(makeBackend);
    const response = await fetchManual(`${url}/same-host`);
    expect(response.status).toBe(302);
  });

  test('a capitalised Location header is checked too', async () => {
    const { url } = await serve(makeBackend);
    await expectRefused(await fetchManual(`${url}/cased?next=${encodeURIComponent('https://evil.example/')}`));
  });

  test('a location on a non-redirect status is left alone', async () => {
    const { url } = await serve(makeBackend);
    expect((await fetchManual(`${url}/not-a-redirect`)).status).toBe(200);
  });

  test('a thrown HttpError carrying an off-origin location is a 500', async () => {
    const { url } = await serve(makeBackend);
    await expectRefused(await fetchManual(`${url}/thrown`));
  });

  test('a fallback() answer is checked like any route', async () => {
    const { url } = await serve(makeBackend);
    await expectRefused(await fetchManual(`${url}/nowhere`));
  });

  test('redirectExternal() is the per-route opt-in, and survives a decorator', async () => {
    const { url } = await serve(makeBackend);
    for (const route of ['external', 'external-decorated']) {
      const response = await fetchManual(`${url}/${route}`);
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('https://payments.example/checkout');
    }
  });

  test('withAllowedRedirectOrigins admits the origins it names and no others', async () => {
    const { url } = await serve(makeBackend, (builder) => builder.withAllowedRedirectOrigins(['https://payments.example']));
    const allowed = await fetchManual(`${url}/literal?next=${encodeURIComponent('https://payments.example/checkout')}`);
    expect(allowed.status).toBe(302);
    // Same host on another scheme is another origin.
    await expectRefused(await fetchManual(`${url}/literal?next=${encodeURIComponent('http://payments.example/checkout')}`));
    await expectRefused(await fetchManual(`${url}/literal?next=${encodeURIComponent('https://evil.example/')}`));
  });

  test('"*" is the explicit opt-out', async () => {
    const { url } = await serve(makeBackend, (builder) => builder.withAllowedRedirectOrigins(['*']));
    const response = await fetchManual(`${url}/literal?next=${encodeURIComponent('https://evil.example/')}`);
    expect(response.status).toBe(302);
  });
});

describe('withAllowedRedirectOrigins refuses what is not an origin', () => {
  test.each([
    ['a path', 'https://payments.example/checkout'],
    ['no scheme', 'payments.example'],
    ['another scheme', 'ftp://payments.example'],
  ])('%s', (_label, origin) => {
    const systemOptions = ActorSystemOptions.create().withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('off-origin-redirects-validation', systemOptions);
    try {
      expect(() => system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).withAllowedRedirectOrigins([origin]))
        .toThrow(/withAllowedRedirectOrigins/);
    } finally {
      void system.terminate();
    }
  });
});
