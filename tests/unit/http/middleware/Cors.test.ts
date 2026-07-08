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
import { Status } from '../../../../src/http/types.js';
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
    const opts = compiled.filter((c) => c.kind === 'http' && c.method === 'OPTIONS');
    expect(opts).toHaveLength(1);
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

describe.each(backends)('cors — %s backend', (_name, mk) => {
  const withCors = (): Route => cors(
    CorsOptions.create().withOrigins(ALLOWED),
    path('api', get(() => complete(Status.OK, 'data'))),
  );

  test('answers a preflight for an allowed origin', async () => {
    const url = await start(mk, withCors());
    const res = await fetch(`${url}/api`, {
      method: 'OPTIONS',
      headers: { origin: ALLOWED, 'access-control-request-method': 'GET' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
    expect(res.headers.get('vary') ?? '').toContain('Origin');
  });

  test('without cors, a preflight carries no CORS headers (pins the routing constraint)', async () => {
    const url = await start(mk, path('api', get(() => complete(Status.OK, 'data'))));
    const res = await fetch(`${url}/api`, {
      method: 'OPTIONS',
      headers: { origin: ALLOWED, 'access-control-request-method': 'GET' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('decorates the actual response for an allowed origin', async () => {
    const url = await start(mk, withCors());
    const res = await fetch(`${url}/api`, { headers: { origin: ALLOWED } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(res.headers.get('vary') ?? '').toContain('Origin');
  });

  test('omits CORS headers for a disallowed origin', async () => {
    const url = await start(mk, withCors());
    const res = await fetch(`${url}/api`, { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('withAnyOrigin echoes a literal * (no credentials)', async () => {
    const url = await start(mk, cors(CorsOptions.create().withAnyOrigin(), path('api', get(() => complete(Status.OK, 'd')))));
    const res = await fetch(`${url}/api`, { headers: { origin: ALLOWED } });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  test('credentials echoes the origin and sets allow-credentials', async () => {
    const url = await start(mk, cors(
      CorsOptions.create().withOrigins(ALLOWED).withCredentials(),
      path('api', get(() => complete(Status.OK, 'd'))),
    ));
    const res = await fetch(`${url}/api`, { headers: { origin: ALLOWED } });
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });
});
