/**
 * #1868 — the `streamedBody()` route DSL: how it compiles, how its limit
 * resolves (route options > `actor-ts.http.streamed-body` > built-in), how the
 * stream rides through middleware, and that `bind()` refuses a backend that
 * cannot stream.  What the backends do with a streamed route on the wire is
 * `StreamedBodyParity.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { HttpServerBackend, RouteRegistration, ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { Config } from '../../../src/config/Config.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { entity } from '../../../src/http/Marshalling.js';
import { idempotent } from '../../../src/http/cache/IdempotencyKey.js';
import { compile, complete, get, handleErrors, path, post, put, withMiddleware, type CompiledRoute, type Route } from '../../../src/http/Route.js';
import { readStreamedBodyOptionsFromConfig, resolveStreamedBody, streamedBody } from '../../../src/http/StreamedBody.js';
import { DEFAULT_STREAMED_BODY_MAX_BYTES, StreamedBodyOptions } from '../../../src/http/StreamedBodyOptions.js';
import { streamedBodyOf, withStreamedBody } from '../../../src/http/StreamedRequestBody.js';
import { Status, type HttpRequest, type StreamedHttpRequest } from '../../../src/http/Types.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { expectExactOptions } from '../../util/ExactOptions.js';

const accepted = (): ReturnType<typeof complete> => complete(Status.Created);

function onlyRoute(route: Route, config?: Config): CompiledRoute {
  const endpoints = compile(route, [], config);
  expect(endpoints).toHaveLength(1);
  const endpoint = endpoints[0]!;
  if (endpoint.kind !== 'http') throw new Error(`expected an http endpoint, got ${endpoint.kind}`);
  return endpoint;
}

function bareRequest(): HttpRequest {
  return { method: 'PUT', path: '/files/1', headers: { 'x-token': 't' }, query: { a: '1' }, params: { id: '1' }, body: null };
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
}

describe('streamedBody() — compile', () => {
  test('a buffered route carries no streamed body', () => {
    expect(onlyRoute(put(accepted)).streamedBody).toBeUndefined();
  });

  test('a streamed route without options takes the built-in limit', () => {
    expect(onlyRoute(put(streamedBody(accepted))).streamedBody).toEqual({ maxBytes: DEFAULT_STREAMED_BODY_MAX_BYTES });
  });

  test('the route\'s own limit wins over HOCON, which wins over the built-in', () => {
    const config = Config.parseString('actor-ts.http.streamed-body.max-bytes = 2MiB');
    expect(onlyRoute(put(streamedBody(accepted)), config).streamedBody).toEqual({ maxBytes: 2 * 1024 * 1024 });
    const uploadLimit = StreamedBodyOptions.create().withMaxBytes(1234);
    expect(onlyRoute(put(streamedBody(uploadLimit, accepted)), config).streamedBody).toEqual({ maxBytes: 1234 });
    expect(onlyRoute(put(streamedBody({ maxBytes: 99 }, accepted)), config).streamedBody).toEqual({ maxBytes: 99 });
  });

  test('every body method takes one; the limit survives path, middleware and handleErrors', () => {
    const passThrough = withMiddleware((request, next) => next(request), handleErrors(() => null, path('x', post(streamedBody({ maxBytes: 7 }, accepted)))));
    expect(onlyRoute(passThrough).streamedBody).toEqual({ maxBytes: 7 });
    expect(onlyRoute(post(streamedBody(accepted))).method).toBe('POST');
  });

  test('the options are snapshotted when the route is built', () => {
    const uploadLimit = StreamedBodyOptions.create().withMaxBytes(10);
    const route = put(streamedBody(uploadLimit, accepted));
    uploadLimit.withMaxBytes(20);
    expect(onlyRoute(route).streamedBody).toEqual({ maxBytes: 10 });
  });

  test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2])('an invalid limit (%p) fails the compile with OptionsError', (maxBytes) => {
    expect(() => compile(put(streamedBody({ maxBytes }, accepted)))).toThrow(OptionsError);
  });

  test('an invalid HOCON limit fails the compile too', () => {
    const config = Config.parseString('actor-ts.http.streamed-body.max-bytes = 0');
    expect(() => compile(put(streamedBody(accepted)), [], config)).toThrow(OptionsError);
  });

  test('streamedBody(options) without a handler is refused', () => {
    const call = streamedBody as unknown as (options: object) => unknown;
    expect(() => call({ maxBytes: 1 })).toThrow(TypeError);
  });
});

describe('streamedBody() — the request the handler gets', () => {
  test('the stream rides through middleware that spreads the request; middleware sees body null', async () => {
    let middlewareSawBody: unknown = 'unset';
    let handlerRequest: StreamedHttpRequest | undefined;
    const route = withMiddleware(
      (request, next) => {
        middlewareSawBody = request.body;
        return next({ ...request, headers: { ...request.headers, 'x-added': 'yes' } });
      },
      put(streamedBody((request) => { handlerRequest = request; return accepted(); })),
    );
    const body = emptyStream();
    const response = await onlyRoute(route).handler(withStreamedBody(bareRequest(), { body, contentLength: 0 }));
    expect(response.status).toBe(Status.Created);
    expect(middlewareSawBody).toBeNull();
    expect(handlerRequest?.body).toBe(body);
    expect(handlerRequest?.contentLength).toBe(0);
    expect(handlerRequest?.headers['x-added']).toBe('yes');
    expect(handlerRequest?.query).toEqual({ a: '1' });
    expect(handlerRequest?.params).toEqual({ id: '1' });
  });

  test('without a declared length the request carries no contentLength', async () => {
    let handlerRequest: StreamedHttpRequest | undefined;
    const route = put(streamedBody((request) => { handlerRequest = request; return accepted(); }));
    await onlyRoute(route).handler(withStreamedBody(bareRequest(), { body: emptyStream() }));
    expect(handlerRequest !== undefined && 'contentLength' in handlerRequest).toBe(false);
  });

  test('a middleware that rebuilds the request from scratch loses the stream, and says so', async () => {
    const route = withMiddleware(
      (request, next) => next({ method: request.method, path: request.path, headers: {}, query: {}, params: {}, body: null }),
      put(streamedBody(accepted)),
    );
    await expect(Promise.resolve(onlyRoute(route).handler(withStreamedBody(bareRequest(), { body: emptyStream() }))))
      .rejects.toThrow('build it as { ...request, … }');
  });

  test('the carrier is invisible to keys and JSON', () => {
    const carrying = withStreamedBody(bareRequest(), { body: emptyStream() });
    expect(Object.keys(carrying)).not.toContain('stream');
    expect(JSON.stringify(carrying)).toBe(JSON.stringify(bareRequest()));
    expect(streamedBodyOf({ ...carrying })).toBeDefined();
    expect(streamedBodyOf(bareRequest())).toBeUndefined();
  });
});

describe('streamedBody() — types', () => {
  test('a buffered handler is never handed a stream, and the other way round', () => {
    // Compile-time assertions, checked by `bun run typecheck:dev`; the
    // runtime half only proves the lines run.
    const buffered = (request: HttpRequest): ReturnType<typeof complete> => complete(request.body === null ? 204 : 200);
    // @ts-expect-error — a buffered handler is not a streamed one
    streamedBody(buffered);
    // @ts-expect-error — entity() reads bytes, and a streamed request has none
    put(streamedBody(async (request) => complete(200, await entity<unknown>(request))));
    // @ts-expect-error — idempotent() fingerprints the body, so it wraps buffered handlers only
    put(idempotent({ cache: undefined as never })(streamedBody(accepted)));
    // @ts-expect-error — GET has no body to stream
    get(streamedBody(accepted));
    expect(true).toBe(true);
  });
});

describe('readStreamedBodyOptionsFromConfig', () => {
  test('reads max-bytes as a size under the field it fills', () => {
    expectExactOptions(readStreamedBodyOptionsFromConfig(Config.parseString('actor-ts.http.streamed-body.max-bytes = 25MiB')), {
      maxBytes: 25 * 1024 * 1024,
    });
  });

  test('an absent block yields nothing at all, not a bag of undefined', () => {
    expectExactOptions(readStreamedBodyOptionsFromConfig(Config.parseString('actor-ts.system.name = x')), {});
  });

  test('the shipped reference.conf resolves to the documented default', () => {
    expectExactOptions(readStreamedBodyOptionsFromConfig(Config.parseString(REFERENCE_CONF)), {
      maxBytes: DEFAULT_STREAMED_BODY_MAX_BYTES,
    });
  });

  test('resolveStreamedBody without a config skips the HOCON layer', () => {
    expectExactOptions(resolveStreamedBody({}, undefined), { maxBytes: DEFAULT_STREAMED_BODY_MAX_BYTES });
  });
});

/** Binds no port; records the registrations, and streams only when told to. */
class RecordingBackend implements HttpServerBackend {
  readonly name = 'recording';
  readonly routes: RouteRegistration[] = [];
  constructor(readonly streamsRequestBodies?: boolean) {}
  registerRoute(route: RouteRegistration): void { this.routes.push(route); }
  async listen(host: string, port: number): Promise<ServerBinding> {
    return { host, port, unbind: async () => {} };
  }
}

async function withSystem<T>(name: string, body: (system: ActorSystem) => Promise<T>): Promise<T> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, systemOptions);
  try {
    return await body(system);
  } finally {
    await system.terminate();
  }
}

describe('HttpExtension.bind — streamed routes', () => {
  test('a backend that does not stream request bodies is refused, naming the routes', async () => {
    await withSystem('streamed-body-refused', async (system) => {
      const binding = system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0)
        .useBackend(new RecordingBackend())
        .bind(path('files', put(streamedBody(accepted))));
      await expect(binding).rejects.toThrow('does not support streamedBody() routes (PUT /files)');
    });
  });

  test('a backend that streams gets the resolved limit on the registration; buffered routes get none', async () => {
    await withSystem('streamed-body-registered', async (system) => {
      const backend = new RecordingBackend(true);
      const binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0)
        .useBackend(backend)
        .bind(path('files', put(streamedBody({ maxBytes: 4096 }, accepted))));
      await binding.unbind();
      expect(backend.routes.map((r) => [r.method, r.pattern, r.streamedBody])).toEqual([['PUT', '/files', { maxBytes: 4096 }]]);
    });
  });

  test('a backend without the capability still binds a tree with no streamed route', async () => {
    await withSystem('streamed-body-none', async (system) => {
      const backend = new RecordingBackend();
      const binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0)
        .useBackend(backend)
        .bind(path('files', put(accepted)));
      await binding.unbind();
      expect(backend.routes[0]?.streamedBody).toBeUndefined();
      expect('streamedBody' in backend.routes[0]!).toBe(false);
    });
  });
});
