/**
 * The plain-HTTP contract every `HttpServerBackend` must keep, as one suite
 * each backend runs with a one-line call (#990).
 *
 * The WebSocket half already had this shape (`websocket/WebsocketBackendSuite.ts`);
 * plain HTTP had a dozen files that each declared their own `backends` array
 * and their own `start()` helper, and a behaviour was cross-checked only where
 * some file happened to exercise it.  That is how the divergences of #357,
 * #759 and #979 shipped: each was a property all three backends were meant to
 * share, and nothing asserted it uniformly.
 *
 * Adding a backend is one file: `runHttpBackendSuite(fixture)` with the
 * backend's factories.  A behaviour a backend does not share **by design** is
 * declared in {@link HttpBackendDeviations}, with its reason, and the case then
 * asserts the deviating behaviour instead — so a declared deviation is checked
 * as strictly as the contract, and one that stops being true goes red rather
 * than quietly hiding a case.  Nothing here is skipped.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { connect, type Socket } from 'node:net';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { CoordinatedShutdownId, Phases } from '../../../../src/CoordinatedShutdown.js';
import { DEFAULT_HTTP_MAX_BODY_BYTES } from '../../../../src/http/Constants.js';
import { completeHtml, html } from '../../../../src/http/Html.js';
import { HttpExtensionId, type ServerBuilder } from '../../../../src/http/HttpExtension.js';
import { HttpServerOptions } from '../../../../src/http/HttpServerOptions.js';
import { entity } from '../../../../src/http/Marshalling.js';
import {
  PAYLOAD_TOO_LARGE_RESPONSE,
  type HttpServerBackend,
  type ServerBinding,
  type ServerOptionsReport,
} from '../../../../src/http/backend/HttpServerBackend.js';
import { contentSecurityPolicy } from '../../../../src/http/middleware/Csp.js';
import { cors } from '../../../../src/http/middleware/Cors.js';
import { CorsOptions } from '../../../../src/http/middleware/CorsOptions.js';
import { requestId } from '../../../../src/http/middleware/RequestId.js';
import { securityHeaders } from '../../../../src/http/middleware/SecurityHeaders.js';
import { SecurityHeadersOptions } from '../../../../src/http/middleware/SecurityHeadersOptions.js';
import {
  complete,
  completeJson,
  concat,
  fallback,
  get,
  handleErrors,
  options,
  path,
  post,
  withMiddleware,
  type Middleware,
  type Route,
} from '../../../../src/http/Route.js';
import { HttpError, Status, type HttpRequest, type HttpResponse } from '../../../../src/http/Types.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { healthChecksOf, managementRoutes } from '../../../../src/management/index.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

/** One declared deviation: what differs is named by the field that carries it, why by this. */
export type BackendDeviation = { readonly reason: string };

/**
 * Behaviour a backend does not share with the contract by design.  Each field
 * names the deviating behaviour the case asserts in place of the contract's.
 */
export type HttpBackendDeviations = {
  /**
   * A handler-set `content-length` on a streamed body does not reach the wire:
   * the runtime re-frames the body as chunked.  The byte count still has to be
   * exact — a *wrong* length would be a defect, an honest chunked framing is not.
   */
  readonly streamedBodyIsChunked?: BackendDeviation;
  /**
   * The server has no header deadline of its own: a connection that never
   * finishes its header block is not answered `408`, and the binding reports
   * `headerTimeoutMs` as not in effect — which `bind()` then warns about.
   */
  readonly noHeaderDeadline?: BackendDeviation;
  /**
   * `idle-timeout` is checked on a 4 s sweep rather than timed per connection,
   * so an idle connection closes up to one sweep early or late — documented on
   * `HttpServerOptionsType.idleTimeoutMs`.  The case asserts it closes within
   * one sweep of the value, with no lower bound.
   */
  readonly idleTimeoutOnFourSecondSweep?: BackendDeviation;
  /** `request-timeout` has nowhere to be installed, and the binding reports it as not in effect. */
  readonly noRequestTimeout?: BackendDeviation;
  /** `max-connections` has nowhere to be installed, and the binding reports it as not in effect. */
  readonly noConnectionCap?: BackendDeviation;
};

export type HttpBackendSuiteFixture = {
  /** The label the suite's `describe` blocks carry. */
  readonly label: string;
  /** The backend on every default. */
  readonly makeBackend: () => HttpServerBackend;
  /** The backend capped at `bytes` through its own knob, not through the server option. */
  readonly makeBackendWithBodyCap: (bytes: number) => HttpServerBackend;
  /**
   * The backend for a server bound under `serverOptions`, for a backend that
   * takes some of them at construction — Fastify's body and header caps
   * (#1488).  Absent, {@link makeBackend} serves.
   */
  readonly makeBackendFor?: (serverOptions: HttpServerOptions) => HttpServerBackend;
  readonly deviations?: HttpBackendDeviations;
};

type ErrorHandler = (err: unknown, request: HttpRequest) => Promise<HttpResponse> | HttpResponse;

/** What a case asks of the server it binds, beyond the routes. */
type BindSetup = {
  readonly backend?: HttpServerBackend;
  readonly serverOptions?: HttpServerOptions;
  readonly errorHandler?: ErrorHandler;
  readonly configure?: (builder: ServerBuilder) => ServerBuilder;
};

type LiveServer = { readonly binding: ServerBinding; readonly url: string; readonly port: number; readonly system: ActorSystem };

// ─── Body sources ────────────────────────────────────────────────────────────

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/**
 * The same chunks, handed out one `pull` at a time and only after the event
 * loop has turned — a body backed by real I/O rather than one already in
 * memory.  `setImmediate` rather than a timer: what matters is that the first
 * chunk is not available in the tick that sent the response.
 */
function slowStreamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]!);
      index += 1;
    },
  });
}

/** One chunk, then a source that fails — `pull` runs a macrotask late, so the chunk is on the wire first (#979). */
function failingAfterFirstChunk(first: Uint8Array): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (!sent) {
        sent = true;
        controller.enqueue(first);
        return;
      }
      throw new Error('upstream row cursor died');
    },
  });
}

/** A source that fails before it has produced a byte. */
function failingAtOnce(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull() {
      await new Promise<void>((resolve) => setImmediate(resolve));
      throw new Error('upstream row cursor died');
    },
  });
}

/**
 * A source whose first chunk never comes: `pulled` resolves once something
 * asked it for one, and `onCancel` records the release.  `highWaterMark: 0`,
 * so it is asked only by a read and not eagerly when it is built.
 */
function neverFirstChunk(onCancel: () => void): { readonly body: ReadableStream<Uint8Array>; readonly pulled: Promise<void> } {
  let signalPulled!: () => void;
  const pulled = new Promise<void>((resolve) => { signalPulled = resolve; });
  const body = new ReadableStream<Uint8Array>({
    pull() {
      signalPulled();
      return new Promise<void>(() => { /* the first chunk never arrives */ });
    },
    cancel() { onCancel(); },
  }, { highWaterMark: 0 });
  return { body, pulled };
}

/** An endless source that records whether it was cancelled — the release of whatever it reads from. */
function endlessStream(onCancel: () => void): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(1024).fill(7);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5)); // the source's own pace, like real I/O — nothing is asserted on it
      controller.enqueue(chunk.slice());
    },
    cancel() { onCancel(); },
  });
}

// ─── Clients ─────────────────────────────────────────────────────────────────

/**
 * What a client saw of a response: its status (0 when the connection was reset
 * before one arrived), and whether its body completed cleanly.  A response that
 * never settles is the hang #979 reported on Bun, so the deadline rethrows
 * rather than counting as an aborted response.
 */
async function outcomeOf(url: string): Promise<{ status: number; completed: boolean; body: string }> {
  const signal = AbortSignal.timeout(4_000);
  const rethrowTimeout = (e: unknown): void => {
    if (signal.aborted) throw new Error(`no outcome within 4 s for ${url}: the response hung`, { cause: e });
  };
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (e) {
    rethrowTimeout(e);
    return { status: 0, completed: false, body: '' };
  }
  try {
    const body = await response.text();
    return { status: response.status, completed: true, body };
  } catch (e) {
    rethrowTimeout(e);
    return { status: response.status, completed: false, body: '' };
  }
}

/** What the client of an in-flight request saw: the status and body, or that the connection was cut. */
async function settledOutcomeOf(response: Promise<Response>): Promise<{ status: number; body: string } | 'severed'> {
  try {
    const answered = await response;
    return { status: answered.status, body: await answered.text() };
  } catch {
    return 'severed';
  }
}

/** Whether a fresh TCP connection to `port` is refused (or reset before it can be used). */
function connectionRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 1_000);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(false); });
    socket.once('error', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
  });
}

/**
 * A hand-driven HTTP/1.1 connection: what `fetch` cannot express — a header
 * block left unfinished, two requests on one socket, watching the server hang
 * up.  Every path destroys the socket, so a failing case cannot leak a handle
 * into the rest of the file.
 */
class RawConnection {
  private received = '';
  private closedFlag = false;
  private readonly socket: Socket;
  readonly opened: Promise<void>;
  readonly closed: Promise<void>;

  constructor(port: number) {
    this.socket = connect({ host: '127.0.0.1', port });
    this.socket.on('data', (chunk: Buffer) => { this.received += chunk.toString('latin1'); });
    this.socket.on('error', () => { /* a reset is a close, observed below */ });
    this.opened = new Promise((resolve) => this.socket.once('connect', () => resolve()));
    this.closed = new Promise((resolve) => this.socket.once('close', () => { this.closedFlag = true; resolve(); }));
  }

  get text(): string { return this.received; }
  get isClosed(): boolean { return this.closedFlag; }

  write(data: string): void { this.socket.write(data); }

  /** How many complete status lines have arrived. */
  responseCount(): number { return (this.received.match(/HTTP\/1\.1 \d{3}/g) ?? []).length; }

  destroy(): void { this.socket.destroy(); }
}

/** A complete keep-alive GET for `target`. */
function rawGet(target: string, extraHeaders = ''): string {
  return `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\n${extraHeaders}\r\n`;
}

// ─── Fixtures shared by several cases ────────────────────────────────────────

/** What a CSRF or auth rejection does: short-circuit by throwing, never returning. */
const rejecting: Middleware = async () => { throw new HttpError(Status.Forbidden, 'CSRF verification failed'); };

const ALLOWED_ORIGIN = 'https://app.example';

/** What the echo handler saw, as JSON. */
type SeenRequest = {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string | string[] | undefined>;
  readonly params: Record<string, string>;
  readonly headers: Record<string, string>;
  readonly bodyLength: number;
  readonly remoteAddress: string | null;
};

const echo = (request: HttpRequest): HttpResponse => completeJson(Status.OK, {
  method: request.method,
  path: request.path,
  query: request.query,
  params: request.params,
  headers: request.headers,
  bodyLength: request.body?.byteLength ?? 0,
  remoteAddress: request.remoteAddress ?? null,
} satisfies SeenRequest);

/** Route that reports how many bytes of body actually reached the handler. */
function echoLength(seen?: { called: boolean }): Route {
  return path('up', post((request) => {
    if (seen) seen.called = true;
    return completeJson(Status.OK, { length: request.body?.byteLength ?? 0 });
  }));
}

async function postBytes(url: string, byteLength: number): Promise<Response> {
  return fetch(`${url}/up`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(byteLength),
  });
}

/** How long the slow handler works once entered — long enough to start a shutdown inside it. */
const HANDLER_WORK_MS = 600;

/** A route that signals when its handler is entered, then answers after {@link HANDLER_WORK_MS}. */
function slowRoute(): { route: Route; entered: Promise<void> } {
  let signal!: () => void;
  const entered = new Promise<void>((resolve) => { signal = resolve; });
  const route = path('slow', get(async () => {
    signal();
    await new Promise<void>((resolve) => setTimeout(resolve, HANDLER_WORK_MS)); // the handler's own work, inside which the shutdown starts
    return complete(Status.OK, 'done');
  }));
  return { route, entered };
}

export function runHttpBackendSuite(fixture: HttpBackendSuiteFixture): void {
  const { label, makeBackend, makeBackendWithBodyCap } = fixture;
  const deviations = fixture.deviations ?? {};
  const makeBackendFor = fixture.makeBackendFor ?? ((): HttpServerBackend => makeBackend());

  describe(`HTTP backend contract — ${label}`, () => {
    const live: LiveServer[] = [];

    afterEach(async () => {
      while (live.length) {
        const { binding, system } = live.shift()!;
        try { await binding.unbind(); } catch { /* already unbound by the case */ }
        await system.terminate();
      }
    });

    async function start(routes: Route, setup: BindSetup = {}): Promise<LiveServer> {
      const systemOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
      const system = ActorSystem.create(`http-contract-${label}`, systemOptions);
      try {
        const backend = setup.backend
          ?? (setup.serverOptions === undefined ? makeBackend() : makeBackendFor(setup.serverOptions));
        let builder = system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).useBackend(backend);
        if (setup.serverOptions !== undefined) builder = builder.withServerOptions(setup.serverOptions);
        if (setup.errorHandler !== undefined) builder = builder.withErrorHandler(setup.errorHandler);
        if (setup.configure !== undefined) builder = setup.configure(builder);
        const binding = await builder.bind(routes);
        const server = { binding, system, port: binding.port, url: `http://${binding.host}:${binding.port}` };
        live.push(server);
        return server;
      } catch (e) {
        await system.terminate();
        throw e;
      }
    }

    async function urlOf(routes: Route, setup?: BindSetup): Promise<string> {
      return (await start(routes, setup)).url;
    }

    // ── registerRoute ────────────────────────────────────────────────────────
    //
    // Contract: "A repeat of a `method` + `pattern` pair already registered
    // **must throw**, rather than be dropped or appended." (#759)
    describe('registerRoute', () => {
      test(`${label} throws on a repeated method+pattern`, () => {
        const backend = makeBackend();
        backend.registerRoute({ method: 'GET', pattern: '/admin', handler: () => complete(Status.OK, 'first') });
        expect(() => backend.registerRoute({ method: 'GET', pattern: '/admin', handler: () => complete(Status.OK, 'second') }))
          .toThrow(`${backend.constructor.name}: duplicate GET route for pattern "/admin".`);
      });

      test(`${label} still accepts the same pattern under another method`, () => {
        const backend = makeBackend();
        backend.registerRoute({ method: 'GET', pattern: '/orders', handler: () => complete(Status.OK, 'list') });
        expect(() => backend.registerRoute({ method: 'POST', pattern: '/orders', handler: () => complete(Status.Created, 'created') }))
          .not.toThrow();
      });
    });

    // ── The request as the handler sees it, the response as the client does ──
    describe('request normalisation and response round trip', () => {
      const routes = (): Route => concat(
        path('orders', get(echo)),
        path('orders', path(':id', concat(get(echo), post(echo)))),
        path('created', post(() => completeJson(Status.Created, { ok: true }, { 'x-custom': 'yes', location: '/created/1' }))),
        path('bytes', get(() => ({ status: Status.OK, body: new Uint8Array([0, 1, 2, 255]) }))),
        path('empty', get(() => complete(Status.NoContent))),
        path('teapot', get(() => complete(418, 'short and stout'))),
        path('cookie', get(() => complete(Status.OK, 'set', { 'set-cookie': 'session=abc; Path=/; HttpOnly' }))),
        fallback(echo),
      );

      test('status, JSON body, content type and handler headers reach the client', async () => {
        const url = await urlOf(routes());
        const response = await fetch(`${url}/created`, { method: 'POST' });
        expect(response.status).toBe(201);
        expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
        expect(response.headers.get('x-custom')).toBe('yes');
        expect(response.headers.get('location')).toBe('/created/1');
        expect(await response.json()).toEqual({ ok: true });
      });

      test('a status outside the named set is passed through as is', async () => {
        const url = await urlOf(routes());
        const response = await fetch(`${url}/teapot`);
        expect(response.status).toBe(418);
        expect(await response.text()).toBe('short and stout');
      });

      test('a Uint8Array body is sent byte for byte as application/octet-stream', async () => {
        const url = await urlOf(routes());
        const response = await fetch(`${url}/bytes`);
        expect(response.headers.get('content-type')).toContain('application/octet-stream');
        expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 1, 2, 255]);
      });

      test('a 204 carries no body', async () => {
        const url = await urlOf(routes());
        const response = await fetch(`${url}/empty`);
        expect(response.status).toBe(204);
        expect(await response.text()).toBe('');
      });

      test('a handler-set Set-Cookie reaches the client unchanged', async () => {
        const url = await urlOf(routes());
        const response = await fetch(`${url}/cookie`);
        expect(response.headers.get('set-cookie')).toBe('session=abc; Path=/; HttpOnly');
      });

      test('method, params, lower-cased headers, body bytes and the socket peer reach the handler', async () => {
        const url = await urlOf(routes());
        const response = await fetch(`${url}/orders/42`, {
          method: 'POST',
          headers: { 'X-Mixed-Case': 'Value', cookie: 'a=1; b=2', 'content-type': 'application/octet-stream' },
          body: new Uint8Array(7),
        });
        const seen = await response.json() as SeenRequest;
        expect(seen.method).toBe('POST');
        expect(seen.params).toEqual({ id: '42' });
        expect(seen.headers['x-mixed-case']).toBe('Value');
        expect(Object.keys(seen.headers).every((name) => name === name.toLowerCase())).toBe(true);
        expect(seen.headers['cookie']).toBe('a=1; b=2');
        expect(seen.bodyLength).toBe(7);
        // From the socket, never from a header — and spelled the same on every backend.
        expect(seen.remoteAddress).toBe('127.0.0.1');
      });

      test('a repeated query parameter arrives as an array, a single one as a string', async () => {
        const url = await urlOf(routes());
        const seen = await (await fetch(`${url}/orders?tag=a&tag=b&page=2`)).json() as SeenRequest;
        expect(seen.query).toEqual({ tag: ['a', 'b'], page: '2' });
      });

      // Contract (`HttpRequest.path`): "The **pathname only** — `/orders/42`,
      // never `/orders/42?page=2`."  Fastify used to hand over the raw target,
      // so every consumer appending to `path` built a broken target on the
      // default backend only (#601).
      test('a query string never reaches path — it is parsed into query', async () => {
        const url = await urlOf(routes());
        const seen = await (await fetch(`${url}/orders?page=2&sort=asc`)).json() as SeenRequest;
        expect(seen.path).toBe('/orders');
        expect(seen.query).toEqual({ page: '2', sort: 'asc' });
      });

      test('a query-free request is unchanged', async () => {
        const url = await urlOf(routes());
        const seen = await (await fetch(`${url}/orders`)).json() as SeenRequest;
        expect(seen.path).toBe('/orders');
        expect(seen.query).toEqual({});
      });

      test('a nested path keeps every segment and drops only the query', async () => {
        const url = await urlOf(routes());
        const seen = await (await fetch(`${url}/orders/42?expand=lines`)).json() as SeenRequest;
        expect(seen.path).toBe('/orders/42');
        expect(seen.query).toEqual({ expand: 'lines' });
      });

      test('an unmatched path reaches the fallback without its query', async () => {
        const url = await urlOf(routes());
        const seen = await (await fetch(`${url}/no/such/route?a=1`)).json() as SeenRequest;
        expect(seen.path).toBe('/no/such/route');
        expect(seen.query).toEqual({ a: '1' });
      });

      test('a value containing an encoded question mark stays in query, not in path', async () => {
        const url = await urlOf(routes());
        const seen = await (await fetch(`${url}/orders?q=a%3Fb`)).json() as SeenRequest;
        expect(seen.path).toBe('/orders');
        expect(seen.query).toEqual({ q: 'a?b' });
      });

      test('a bare trailing question mark leaves an empty query and a clean path', async () => {
        const url = await urlOf(routes());
        const seen = await (await fetch(`${url}/orders?`)).json() as SeenRequest;
        expect(seen.path).toBe('/orders');
        expect(seen.query).toEqual({});
      });
    });

    describe('wildcard params[*]', () => {
      // Only the wildcard route, so no sibling route competes for the match.
      const routes = (): Route =>
        path('assets', path('*', get((request) => complete(Status.OK, request.params['*'] ?? '<none>'))));

      test('captures a multi-segment remainder', async () => {
        const url = await urlOf(routes());
        expect(await (await fetch(`${url}/assets/a/b/c.txt`)).text()).toBe('a/b/c.txt');
      });

      test('captures an empty remainder for the trailing slash', async () => {
        const url = await urlOf(routes());
        expect(await (await fetch(`${url}/assets/`)).text()).toBe('');
      });

      test('HEAD on a GET route answers 200 with an empty body', async () => {
        const url = await urlOf(routes());
        const response = await fetch(`${url}/assets/x`, { method: 'HEAD' });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('');
      });
    });

    // ── entity() over the body the backend handed in ─────────────────────────
    describe('entity() decoding', () => {
      const routes = (): Route => path('decode', post((request) => completeJson(Status.OK, { decoded: entity(request) })));

      test('a JSON body decodes to the value that was sent', async () => {
        const url = await urlOf(routes());
        const response = await fetch(`${url}/decode`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Grüße', items: [1, 2, 3] }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ decoded: { name: 'Grüße', items: [1, 2, 3] } });
      });

      test('a malformed JSON body is a 400', async () => {
        const url = await urlOf(routes());
        const response = await fetch(`${url}/decode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"broken' });
        expect(response.status).toBe(400);
        await response.text();
      });

      test('an empty body is a 400 whatever type it claims', async () => {
        const url = await urlOf(routes());
        const response = await fetch(`${url}/decode`, { method: 'POST', headers: { 'content-type': 'application/json' } });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Missing request body' });
      });

      test('a content type no serializer decodes is a 415', async () => {
        const url = await urlOf(routes());
        const response = await fetch(`${url}/decode`, { method: 'POST', headers: { 'content-type': 'application/x-unknown' }, body: 'x' });
        expect(response.status).toBe(415);
        await response.text();
      });
    });

    // ── Streaming bodies ─────────────────────────────────────────────────────
    describe('ReadableStream response body', () => {
      test('streams multiple chunks with an explicit content-type', async () => {
        const encoder = new TextEncoder();
        const url = await urlOf(get(() => ({
          status: Status.OK,
          body: streamOf([encoder.encode('hello '), encoder.encode('streamed '), encoder.encode('world')]),
          contentType: 'text/plain; charset=utf-8',
        })));
        const response = await fetch(`${url}/`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/plain');
        expect(await response.text()).toBe('hello streamed world');
      });

      test('defaults to application/octet-stream and round-trips a large body byte-for-byte', async () => {
        const big = new Uint8Array(256 * 1024);
        for (let i = 0; i < big.length; i++) big[i] = i % 256;
        // Independent 16 KiB slices, so the stream can transfer each without detaching the others.
        const chunks: Uint8Array[] = [];
        for (let offset = 0; offset < big.length; offset += 16 * 1024) chunks.push(big.slice(offset, offset + 16 * 1024));

        const url = await urlOf(get(() => ({ status: Status.OK, body: streamOf(chunks) })));
        const response = await fetch(`${url}/`);
        expect(response.headers.get('content-type')).toContain('application/octet-stream');
        const received = new Uint8Array(await response.arrayBuffer());
        expect(received.length).toBe(big.length);
        expect(received[0]).toBe(0);
        expect(received[257]).toBe(1);
        expect(received[big.length - 1]).toBe((big.length - 1) % 256);
      });

      test('a body whose first chunk is not ready in the same tick is not truncated', async () => {
        const encoder = new TextEncoder();
        const url = await urlOf(get(() => ({
          status: Status.OK,
          body: slowStreamOf([encoder.encode('slow '), encoder.encode('but '), encoder.encode('complete')]),
          contentType: 'text/plain; charset=utf-8',
        })));
        const response = await fetch(`${url}/`);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('slow but complete');
      });

      test('a handler-set content-length survives a stream body', async () => {
        // What the streaming static route depends on: a backend has nothing to
        // measure on a stream, so the length only reaches the client if the
        // header the handler set is left alone.
        const body = new Uint8Array(96 * 1024).fill(3);
        const chunks: Uint8Array[] = [];
        for (let offset = 0; offset < body.length; offset += 32 * 1024) chunks.push(body.slice(offset, offset + 32 * 1024));

        const url = await urlOf(get(() => ({
          status: Status.OK,
          headers: { 'content-length': String(body.length) },
          body: slowStreamOf(chunks),
        })));
        const response = await fetch(`${url}/`);
        expect(response.status).toBe(200);
        if (deviations.streamedBodyIsChunked === undefined) {
          expect(response.headers.get('content-length')).toBe(String(body.length));
        } else {
          expect(response.headers.get('content-length')).toBeNull();
        }
        expect((await response.arrayBuffer()).byteLength).toBe(body.length);
      });
    });

    describe('ReadableStream response body that fails (#979)', () => {
      test('a source that fails mid-body ends in a truncated response, and the server keeps serving', async () => {
        const encoder = new TextEncoder();
        let served = 0;
        const url = await urlOf(get(() => {
          served += 1;
          return served === 1
            ? { status: Status.OK, body: failingAfterFirstChunk(encoder.encode('first chunk;')), contentType: 'text/plain' }
            : { status: Status.OK, body: 'still serving', contentType: 'text/plain' };
        }));
        const failed = await outcomeOf(`${url}/`);
        // A clean 200 carrying only the first chunk would be a response that lies.
        expect(failed.completed).toBe(false);
        expect(await outcomeOf(`${url}/`)).toEqual({ status: 200, completed: true, body: 'still serving' });
      });

      test('a source that fails before its first byte is not answered as a success', async () => {
        const url = await urlOf(get(() => ({ status: Status.OK, body: failingAtOnce() })));
        const outcome = await outcomeOf(`${url}/`);
        expect(outcome.completed && outcome.status < 500).toBe(false);
      });

      // Contract (`setStreamFailureHandler`): "A failure before the first byte
      // is not reported here: it goes to setErrorHandler like any other."
      test('a failure before the first byte reaches the registered error handler, and not the stream-failure handler', async () => {
        const backend = makeBackend();
        const seen: unknown[] = [];
        const streamFailures: unknown[] = [];
        const url = await urlOf(get(() => ({ status: Status.OK, body: failingAtOnce() })), {
          backend,
          errorHandler: (err) => {
            seen.push(err);
            return { status: 502, body: 'upstream failed', contentType: 'text/plain' };
          },
        });
        backend.setStreamFailureHandler!((err) => { streamFailures.push(err); });
        const outcome = await outcomeOf(`${url}/`);
        expect(outcome).toEqual({ status: 502, completed: true, body: 'upstream failed' });
        expect(seen.length).toBe(1);
        expect((seen[0] as Error).message).toBe('upstream row cursor died');
        // Answered by the error handler, so nothing was truncated to report.
        expect(streamFailures).toEqual([]);
      });

      // What the client sees differs — Express and Hono fall back to the
      // default 500, Fastify keeps the handler's 502 — but every backend answers
      // with a status line, where a reset (status 0) is how #1830 showed.
      test('an error handler whose own stream body fails before its first byte still answers with a server error', async () => {
        const url = await urlOf(get(() => { throw new Error('handler failed'); }), {
          errorHandler: () => ({ status: 502, body: failingAtOnce() }),
        });
        const outcome = await outcomeOf(`${url}/`);
        expect(outcome.status).toBeGreaterThanOrEqual(500);
      });

      // Contract: "register the listener for a ReadableStream body whose source
      // failed after the response was committed … this is the only place the
      // failure can still be seen."
      test('a failure after the response was committed reaches the stream-failure handler once, with the request', async () => {
        const backend = makeBackend();
        const failures: Array<{ err: unknown; request: HttpRequest | undefined }> = [];
        expect(backend.setStreamFailureHandler).toBeDefined();
        const encoder = new TextEncoder();
        // Installed after bind: `HttpExtension` wires the system log in first,
        // and a later registration replaces it.
        const url = await urlOf(get(() => ({ status: Status.OK, body: failingAfterFirstChunk(encoder.encode('first chunk;')) })), { backend });
        backend.setStreamFailureHandler!((err, request) => { failures.push({ err, request }); });
        const outcome = await outcomeOf(`${url}/`);
        expect(outcome.completed).toBe(false);
        await awaitCondition(() => failures.length > 0, { timeoutMs: 2_000, label: 'the stream failure was reported' });
        expect(failures.length).toBe(1);
        expect((failures[0]!.err as Error).message).toBe('upstream row cursor died');
        expect(failures[0]!.request?.path).toBe('/');
      });

      test('a client that disconnects mid-body cancels the source', async () => {
        let cancelled = false;
        const url = await urlOf(get(() => ({ status: Status.OK, body: endlessStream(() => { cancelled = true; }) })));
        const controller = new AbortController();
        const response = await fetch(`${url}/`, { signal: controller.signal });
        const reader = response.body!.getReader();
        await reader.read();
        controller.abort();
        await reader.cancel().catch(() => {});
        await awaitCondition(() => cancelled, { timeoutMs: 3_000, label: 'the source was cancelled' });
        expect(cancelled).toBe(true);
      });

      test('a client that disconnects before the first chunk cancels the source', async () => {
        let cancelled = false;
        const source = neverFirstChunk(() => { cancelled = true; });
        const url = await urlOf(get(() => ({ status: Status.OK, body: source.body })));
        const controller = new AbortController();
        const response = fetch(`${url}/`, { signal: controller.signal }).catch(() => undefined);
        await source.pulled;
        controller.abort();
        await response;
        await awaitCondition(() => cancelled, { timeoutMs: 3_000, label: 'the source was cancelled' });
        expect(cancelled).toBe(true);
      });

      test('a stream that closes without a chunk is a complete, empty 200', async () => {
        const url = await urlOf(get(() => ({ status: Status.OK, body: streamOf([]) })));
        const response = await fetch(`${url}/`, { signal: AbortSignal.timeout(3_000) });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('');
      });    });

    // ── Body-size caps (#357, #1488) ─────────────────────────────────────────
    describe('request body-size cap', () => {
      test('refuses a body one byte over the shared default', async () => {
        const seen = { called: false };
        const url = await urlOf(echoLength(seen));
        const response = await postBytes(url, DEFAULT_HTTP_MAX_BODY_BYTES + 1);
        expect(response.status).toBe(413);
        // A 413 written after the handler ran would protect nothing.
        expect(seen.called).toBe(false);
      });

      test('accepts a body exactly at the shared default', async () => {
        const url = await urlOf(echoLength());
        const response = await postBytes(url, DEFAULT_HTTP_MAX_BODY_BYTES);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ length: DEFAULT_HTTP_MAX_BODY_BYTES });
      });

      test('the refusal is identical across backends — status, body, content type and default headers', async () => {
        const url = await urlOf(echoLength(), { backend: makeBackendWithBodyCap(16) });
        const response = await postBytes(url, 64);
        expect(response.status).toBe(PAYLOAD_TOO_LARGE_RESPONSE.status);
        expect(await response.text()).toBe(PAYLOAD_TOO_LARGE_RESPONSE.body as string);
        expect(response.headers.get('content-type')).toBe(PAYLOAD_TOO_LARGE_RESPONSE.contentType as string);
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      });

      test('an installed error handler does not see — or reshape — the refusal', async () => {
        // On Fastify the body-too-large error used to reach the app-level hook,
        // which turned the 413 into a 500.  A body cap is a transport decision.
        const backend = makeBackendWithBodyCap(16);
        let handlerCalls = 0;
        expect(backend.setErrorHandler).toBeDefined();
        backend.setErrorHandler!(() => {
          handlerCalls += 1;
          return completeJson(Status.InternalServerError, { custom: true });
        });
        const url = await urlOf(echoLength(), { backend });
        const response = await postBytes(url, 64);
        expect(response.status).toBe(413);
        expect(await response.text()).toBe('Payload Too Large');
        expect(handlerCalls).toBe(0);
      });

      test('a per-backend cap still overrides the shared default', async () => {
        const url = await urlOf(echoLength(), { backend: makeBackendWithBodyCap(DEFAULT_HTTP_MAX_BODY_BYTES * 2) });
        const response = await postBytes(url, DEFAULT_HTTP_MAX_BODY_BYTES + 1);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ length: DEFAULT_HTTP_MAX_BODY_BYTES + 1 });
      });

      test('the server option max-content-length caps every backend the same way, and is reported held', async () => {
        const seen = { called: false };
        const serverOptions = HttpServerOptions.create().withMaxContentLength(16);
        const server = await start(echoLength(seen), { serverOptions });
        const response = await postBytes(server.url, 64);
        expect(response.status).toBe(413);
        expect(await response.text()).toBe('Payload Too Large');
        expect(seen.called).toBe(false);
        expect(server.binding.serverOptionsReport?.maxContentLength).toBe(true);
      });
    });

    // ── Error handling ───────────────────────────────────────────────────────
    //
    // Contract (`setErrorHandler`): "It MUST see both errors thrown by route
    // handlers AND backend-internal errors …; if it throws, the backend falls
    // back to its default error mapping."
    describe('error handler', () => {
      test('replaces the default mapping for a generic handler throw', async () => {
        const url = await urlOf(get(() => { throw new Error('kaboom'); }), {
          errorHandler: (err) => completeJson(Status.BadGateway, { handled: true, msg: (err as Error).message }),
        });
        const response = await fetch(`${url}/`);
        expect(response.status).toBe(Status.BadGateway);
        expect(await response.json()).toEqual({ handled: true, msg: 'kaboom' });
      });

      test('receives the original HttpError instance', async () => {
        let seenStatus = 0;
        const url = await urlOf(get(() => { throw new HttpError(Status.Conflict, 'conflict'); }), {
          errorHandler: (err) => { seenStatus = (err as HttpError).status; return complete(Status.OK, 'ok'); },
        });
        await (await fetch(`${url}/`)).text();
        expect(seenStatus).toBe(Status.Conflict);
      });

      test('an error handler that itself throws falls back to the default mapping', async () => {
        const url = await urlOf(get(() => { throw new HttpError(Status.Conflict, 'conflict'); }), {
          errorHandler: () => { throw new Error('handler broke'); },
        });
        const response = await fetch(`${url}/`);
        expect(response.status).toBe(Status.InternalServerError);
        expect(await response.json()).toEqual({ error: 'Internal Server Error' });
      });

      test('a scoped handleErrors takes precedence over withErrorHandler', async () => {
        const url = await urlOf(
          handleErrors(() => complete(Status.Accepted, 'scoped'), get(() => { throw new HttpError(Status.InternalServerError, 'x'); })),
          { errorHandler: () => complete(Status.BadGateway, 'server') },
        );
        const response = await fetch(`${url}/`);
        expect(response.status).toBe(Status.Accepted);
        expect(await response.text()).toBe('scoped');
      });

      test('an unhandled throw yields a generic body with no message field', async () => {
        const secret = '/srv/app/src/db/credentials.ts: ECONNREFUSED postgres://user:hunter2@10.0.0.5:5432';
        const url = await urlOf(get(() => { throw new Error(secret); }));
        const response = await fetch(`${url}/`);
        expect(response.status).toBe(Status.InternalServerError);
        const body = await response.text();
        expect(JSON.parse(body)).toEqual({ error: 'Internal Server Error' });
        expect(body).not.toContain('hunter2');
        expect(body).not.toContain('/srv/app');
        expect(body).not.toContain('ECONNREFUSED');
      });

      test('an HttpError still reports its own message, which is deliberate', async () => {
        const url = await urlOf(get(() => { throw new HttpError(Status.Conflict, 'version conflict'); }));
        const response = await fetch(`${url}/`);
        expect(response.status).toBe(Status.Conflict);
        expect(await response.json()).toEqual({ error: 'version conflict' });
      });

      test('withErrorHandler remains the way to surface the detail', async () => {
        const url = await urlOf(get(() => { throw new Error('boom-detail'); }), {
          errorHandler: (err) => completeJson(Status.InternalServerError, { detail: (err as Error).message }),
        });
        expect(await (await fetch(`${url}/`)).json()).toEqual({ detail: 'boom-detail' });
      });
    });

    // ── Not-found handler ────────────────────────────────────────────────────
    //
    // Contract (`setNotFound`): "invoked for any request that matched no route
    // (including unmatched OPTIONS/HEAD) … If the handler throws, the backend
    // applies its default error mapping."
    describe('fallback()', () => {
      test('answers an unmatched path', async () => {
        const url = await urlOf(concat(
          path('known', get(() => complete(Status.OK, 'yes'))),
          fallback((request) => completeJson(Status.NotFound, { error: 'no route', path: request.path })),
        ));
        const response = await fetch(`${url}/nope`);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'no route', path: '/nope' });
      });

      test('matched routes still win — a fallback declared first does not shadow them', async () => {
        const url = await urlOf(concat(
          fallback(() => complete(Status.NotFound, 'fb')),
          path('known', get(() => complete(Status.OK, 'real'))),
        ));
        expect(await (await fetch(`${url}/known`)).text()).toBe('real');
        expect((await fetch(`${url}/other`)).status).toBe(404);
      });

      test('a method mismatch on an existing path hits the fallback (404, not 405)', async () => {
        const url = await urlOf(concat(
          path('thing', get(() => complete(Status.OK, 'g'))),
          fallback(() => complete(Status.NotFound, 'fb')),
        ));
        const response = await fetch(`${url}/thing`, { method: 'POST' });
        expect(response.status).toBe(404);
        expect(await response.text()).toBe('fb');
      });

      test('an unmatched OPTIONS request hits the fallback', async () => {
        const url = await urlOf(concat(
          path('thing', get(() => complete(Status.OK, 'g'))),
          fallback(() => complete(Status.NoContent)),
        ));
        // A path with no route at all — avoids automatic OPTIONS handling for paths that do have routes.
        const response = await fetch(`${url}/totally-unknown`, { method: 'OPTIONS' });
        expect(response.status).toBe(Status.NoContent);
      });

      test('an unmatched HEAD request hits the fallback', async () => {
        const url = await urlOf(concat(
          path('thing', get(() => complete(Status.OK, 'g'))),
          fallback(() => complete(410,'gone')),
        ));
        const response = await fetch(`${url}/totally-unknown`, { method: 'HEAD' });
        expect(response.status).toBe(410);
        expect(await response.text()).toBe('');
      });

      test('a fallback throwing HttpError maps to that status', async () => {
        const url = await urlOf(fallback(() => { throw new HttpError(Status.Forbidden, 'blocked'); }));
        expect((await fetch(`${url}/whatever`)).status).toBe(Status.Forbidden);
      });

      test('a fallback throwing a plain Error is the generic 500', async () => {
        const url = await urlOf(fallback(() => { throw new Error('leaky detail'); }));
        const response = await fetch(`${url}/whatever`);
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: 'Internal Server Error' });
      });

      test('middleware wraps the fallback handler', async () => {
        const stamp: Middleware = async (_request, next) => {
          const response = await next();
          return { ...response, headers: { ...(response.headers ?? {}), 'x-fb': '1' } };
        };
        const url = await urlOf(withMiddleware(stamp, fallback(() => complete(Status.NotFound, 'fb'))));
        const response = await fetch(`${url}/x`);
        expect(response.status).toBe(404);
        expect(response.headers.get('x-fb')).toBe('1');
      });
    });

    // ── Response security headers (#127, #606) ───────────────────────────────
    describe('response security headers', () => {
      const guardedSecurityHeaders = SecurityHeadersOptions.create().withHsts();
      const routes = (): Route => concat(
        path('plain', get(() => complete(Status.OK, 'hello'))),
        path('own-header', get(() => ({ status: Status.OK, headers: { 'X-Content-Type-Options': 'off' }, body: 'hello' }))),
        path('already-nosniff', get(() => completeHtml(Status.OK, html`<p>hi</p>`))),
        path('http-error', get(() => { throw new HttpError(Status.Forbidden, 'nope'); })),
        path('cased-error-nosniff', get(() => {
          throw new HttpError(Status.Forbidden, 'nope', undefined, { 'X-Content-Type-Options': 'off' });
        })),
        path('cased-error-frame', get(() => {
          throw new HttpError(Status.Forbidden, 'nope', undefined, { 'X-Frame-Options': 'SAMEORIGIN' });
        })),
        path('boom', get(() => { throw new Error('kaboom'); })),
        path('guarded',
          withMiddleware(requestId(),
          withMiddleware(securityHeaders(guardedSecurityHeaders),
          withMiddleware(contentSecurityPolicy(),
          withMiddleware(rejecting,
            get(() => complete(Status.OK, 'unreachable'))))))),
        fallback(() => complete(Status.NotFound, 'nothing here')),
      );

      test('a plain response carries nosniff without any configuration', async () => {
        const url = await urlOf(routes());
        const response = await fetch(`${url}/plain`);
        expect(response.status).toBe(200);
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      });

      test('only nosniff — the embedding-relevant headers stay opt-in', async () => {
        const url = await urlOf(routes());
        const response = await fetch(`${url}/plain`);
        expect(response.headers.get('x-frame-options')).toBeNull();
        expect(response.headers.get('cross-origin-resource-policy')).toBeNull();
        expect(response.headers.get('referrer-policy')).toBeNull();
      });

      test("the response's own header wins, matched case-insensitively", async () => {
        const url = await urlOf(routes());
        expect((await fetch(`${url}/own-header`)).headers.get('x-content-type-options')).toBe('off');
      });

      // #1058: the error path used to build its headers by object spread, so a
      // differently-cased key sat beside the default and `Headers` appended it.
      test("a thrown HttpError's own header replaces the default, matched case-insensitively", async () => {
        const url = await urlOf(routes());
        const response = await fetch(`${url}/cased-error-nosniff`);
        expect(response.status).toBe(403);
        expect(response.headers.get('x-content-type-options')).toBe('off');
      });

      test("a thrown HttpError's own header replaces an opted-in bundle header", async () => {
        const url = await urlOf(routes(), { configure: (b) => b.withSecurityHeaders({}) });
        const response = await fetch(`${url}/cased-error-frame`);
        expect(response.status).toBe(403);
        expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
      });

      test('a handler that already sends nosniff does not get it twice', async () => {
        const url = await urlOf(routes());
        // A duplicate would surface as the comma-joined "nosniff, nosniff".
        expect((await fetch(`${url}/already-nosniff`)).headers.get('x-content-type-options')).toBe('nosniff');
      });

      const carriesNosniff = (target: string, status: number) => async (): Promise<void> => {
        const url = await urlOf(routes());
        const response = await fetch(`${url}${target}`);
        expect(response.status).toBe(status);
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      };

      test('the thrown-HttpError response carries it', carriesNosniff('/http-error', 403));

      test('the generic 500 carries it', carriesNosniff('/boom', 500));

      test('the fallback 404 carries it', carriesNosniff('/nowhere', 404));

      // #1059: without a fallback() the backend used to answer an unrouted path
      // itself, outside the default headers, and Fastify echoed the path back.
      describe('the framework 404 of a tree without fallback()', () => {
        const unfallbacked = (): Route => path('plain', get(() => complete(Status.OK, 'hello')));

        test('carries nosniff and a fixed JSON body that does not echo the path', async () => {
          const url = await urlOf(unfallbacked());
          const response = await fetch(`${url}/nowhere-${'q'.repeat(8)}`);
          expect(response.status).toBe(404);
          expect(response.headers.get('x-content-type-options')).toBe('nosniff');
          expect(response.headers.get('content-type')).toContain('application/json');
          const text = await response.text();
          expect(JSON.parse(text)).toEqual({ error: 'Not Found' });
          expect(text).not.toContain('nowhere');
        });

        test('carries an opted-in bundle too', async () => {
          const url = await urlOf(unfallbacked(), { configure: (b) => b.withSecurityHeaders({}) });
          const response = await fetch(`${url}/nowhere`);
          await response.arrayBuffer();
          expect(response.status).toBe(404);
          expect(response.headers.get('x-frame-options')).toBe('DENY');
        });

        test('withSecurityHeaders(false) still opts it out', async () => {
          const url = await urlOf(unfallbacked(), { configure: (b) => b.withSecurityHeaders(false) });
          const response = await fetch(`${url}/nowhere`);
          await response.arrayBuffer();
          expect(response.status).toBe(404);
          expect(response.headers.get('x-frame-options')).toBeNull();
        });
      });

      test('withSecurityHeaders(false) opts out entirely', async () => {
        const url = await urlOf(routes(), { configure: (b) => b.withSecurityHeaders(false) });
        expect((await fetch(`${url}/plain`)).headers.get('x-content-type-options')).toBeNull();
      });

      test('withSecurityHeaders(false) also opts the error paths out', async () => {
        const url = await urlOf(routes(), { configure: (b) => b.withSecurityHeaders(false) });
        expect((await fetch(`${url}/boom`)).headers.get('x-content-type-options')).toBeNull();
        expect((await fetch(`${url}/nowhere`)).headers.get('x-content-type-options')).toBeNull();
      });

      test('passing options opts into the whole bundle, server-wide', async () => {
        const bundle = SecurityHeadersOptions.create()
          .withFrameOptions('SAMEORIGIN')
          .withReferrerPolicy('strict-origin-when-cross-origin');
        const url = await urlOf(routes(), { configure: (b) => b.withSecurityHeaders(bundle) });
        const response = await fetch(`${url}/plain`);
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
        expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
        expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      });

      test('the opted-in bundle reaches the error paths a middleware would miss', async () => {
        const url = await urlOf(routes(), { configure: (b) => b.withSecurityHeaders({}) });
        const response = await fetch(`${url}/boom`);
        expect(response.status).toBe(500);
        expect(response.headers.get('x-frame-options')).toBe('DENY');
      });

      test('a throwing short-circuit still carries the decorators above it (#606)', async () => {
        const url = await urlOf(routes());
        const response = await fetch(`${url}/guarded`);
        expect(response.status).toBe(403);
        expect(response.headers.get('x-frame-options')).toBe('DENY');
        expect(response.headers.get('referrer-policy')).toBe('no-referrer');
        expect(response.headers.get('strict-transport-security')).toBe('max-age=15552000; includeSubDomains');
        expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
        expect(response.headers.get('x-request-id')).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
      });
    });

    // ── CORS ─────────────────────────────────────────────────────────────────
    describe('cors', () => {
      const withCors = (): Route => cors(
        CorsOptions.create().withOrigins(ALLOWED_ORIGIN),
        path('api', get(() => complete(Status.OK, 'data'))),
      );
      const preflightHeaders = { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'GET' };

      test('answers a preflight for an allowed origin', async () => {
        const url = await urlOf(withCors());
        const response = await fetch(`${url}/api`, { method: 'OPTIONS', headers: preflightHeaders });
        expect(response.status).toBe(204);
        expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
        expect(response.headers.get('access-control-allow-methods')).toContain('GET');
        expect(response.headers.get('vary') ?? '').toContain('Origin');
      });

      test('without cors, a preflight carries no CORS headers (pins the routing constraint)', async () => {
        const url = await urlOf(path('api', get(() => complete(Status.OK, 'data'))));
        const response = await fetch(`${url}/api`, { method: 'OPTIONS', headers: preflightHeaders });
        expect(response.headers.get('access-control-allow-origin')).toBeNull();
      });

      test('decorates the actual response for an allowed origin', async () => {
        const url = await urlOf(withCors());
        const response = await fetch(`${url}/api`, { headers: { origin: ALLOWED_ORIGIN } });
        expect(response.status).toBe(200);
        expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
        expect(response.headers.get('vary') ?? '').toContain('Origin');
      });

      test("keeps a handler's own Vary on the wire and merges Origin into it (#603)", async () => {
        const url = await urlOf(cors(
          CorsOptions.create().withOrigins(ALLOWED_ORIGIN),
          path('api', get(() => complete(Status.OK, 'data', { Vary: 'Cookie' }))),
        ));
        const vary = ((await fetch(`${url}/api`, { headers: { origin: ALLOWED_ORIGIN } })).headers.get('vary') ?? '').toLowerCase();
        expect(vary).toContain('cookie');
        expect(vary).toContain('origin');
      });

      test('omits CORS headers for a disallowed origin', async () => {
        const url = await urlOf(withCors());
        const response = await fetch(`${url}/api`, { headers: { origin: 'https://evil.example' } });
        expect(response.status).toBe(200);
        expect(response.headers.get('access-control-allow-origin')).toBeNull();
      });

      test('withAnyOrigin echoes a literal * (no credentials)', async () => {
        const url = await urlOf(cors(CorsOptions.create().withAnyOrigin(), path('api', get(() => complete(Status.OK, 'd')))));
        expect((await fetch(`${url}/api`, { headers: { origin: ALLOWED_ORIGIN } })).headers.get('access-control-allow-origin')).toBe('*');
      });

      test('credentials echoes the origin and sets allow-credentials', async () => {
        const corsOptions = CorsOptions.create()
          .withOrigins(ALLOWED_ORIGIN)
          .withCredentials();
        const url = await urlOf(cors(corsOptions, path('api', get(() => complete(Status.OK, 'd')))));
        const response = await fetch(`${url}/api`, { headers: { origin: ALLOWED_ORIGIN } });
        expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
        expect(response.headers.get('access-control-allow-credentials')).toBe('true');
      });

      test('echoes the requested headers on a preflight when none are configured', async () => {
        const url = await urlOf(withCors());
        const response = await fetch(`${url}/api`, {
          method: 'OPTIONS',
          headers: { ...preflightHeaders, 'access-control-request-headers': 'x-custom, content-type' },
        });
        expect(response.status).toBe(204);
        expect(response.headers.get('access-control-allow-headers') ?? '').toContain('x-custom');
      });

      test('uses the configured allowed headers + max-age on a preflight', async () => {
        const corsOptions = CorsOptions.create()
          .withOrigins(ALLOWED_ORIGIN)
          .withAllowedHeaders('x-a', 'x-b')
          .withMaxAge(120);
        const url = await urlOf(cors(corsOptions, path('api', get(() => complete(Status.OK, 'd')))));
        const response = await fetch(`${url}/api`, { method: 'OPTIONS', headers: preflightHeaders });
        expect(response.headers.get('access-control-allow-headers')).toBe('x-a, x-b');
        expect(response.headers.get('access-control-max-age')).toBe('120');
      });

      test('a user OPTIONS route still handles a non-preflight OPTIONS', async () => {
        const url = await urlOf(cors(
          CorsOptions.create().withOrigins(ALLOWED_ORIGIN),
          path('api', concat(get(() => complete(Status.OK, 'g')), options(() => complete(Status.OK, 'custom-options')))),
        ));
        // No Origin / Access-Control-Request-Method → not a preflight → user handler runs.
        expect(await (await fetch(`${url}/api`, { method: 'OPTIONS' })).text()).toBe('custom-options');
      });
    });

    // ── Connection behaviour ─────────────────────────────────────────────────
    describe('keep-alive', () => {
      test('two requests on one connection are both answered, in order', async () => {
        const server = await start(concat(
          path('one', get(() => complete(Status.OK, 'first'))),
          path('two', get(() => complete(Status.OK, 'second'))),
        ));
        const connection = new RawConnection(server.port);
        try {
          await connection.opened;
          connection.write(rawGet('/one'));
          await awaitCondition(() => connection.text.includes('first'), { timeoutMs: 2_000, label: 'the first response arrived' });
          connection.write(rawGet('/two'));
          await awaitCondition(() => connection.text.includes('second'), { timeoutMs: 2_000, label: 'the second response arrived on the same socket' });
          expect(connection.responseCount()).toBe(2);
          expect(connection.isClosed).toBe(false);
          expect(connection.text.indexOf('first')).toBeLessThan(connection.text.indexOf('second'));
        } finally {
          connection.destroy();
        }
      });

      test('a request asking for Connection: close is answered and the connection closed', async () => {
        const server = await start(path('one', get(() => complete(Status.OK, 'only'))));
        const connection = new RawConnection(server.port);
        try {
          await connection.opened;
          connection.write(rawGet('/one', 'Connection: close\r\n'));
          await awaitCondition(() => connection.isClosed, { timeoutMs: 2_000, label: 'the server closed the connection' });
          expect(connection.text).toContain('HTTP/1.1 200');
          expect(connection.text).toContain('only');
        } finally {
          connection.destroy();
        }
      });
    });

    // ── Timeouts and what the binding reports about them ─────────────────────
    describe('server timeouts', () => {
      test('the binding reports which timeout bounds it put into effect', async () => {
        const serverOptions = HttpServerOptions.create()
          .withIdleTimeoutMs(5_000)
          .withHeaderTimeoutMs(5_000)
          .withRequestTimeoutMs(10_000)
          .withMaxConnections(100);
        const server = await start(get(() => complete(Status.OK, 'x')), { serverOptions });
        const report: ServerOptionsReport | undefined = server.binding.serverOptionsReport;
        expect(report).toBeDefined();
        expect(report!.idleTimeoutMs).toBe(true);
        expect(report!.requestTimeoutMs).toBe(deviations.noRequestTimeout === undefined);
        expect(report!.headerTimeoutMs).toBe(deviations.noHeaderDeadline === undefined);
        expect(report!.maxConnections).toBe(deviations.noConnectionCap === undefined);
      });

      test('a header block never finished within header-timeout is answered 408 and the connection closed', async () => {
        const serverOptions = HttpServerOptions.create().withHeaderTimeoutMs(300);
        const server = await start(get(() => complete(Status.OK, 'x')), { serverOptions });
        const connection = new RawConnection(server.port);
        try {
          await connection.opened;
          connection.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n'); // and never the blank line
          if (deviations.noHeaderDeadline === undefined) {
            await awaitCondition(() => connection.isClosed, { timeoutMs: 3_000, label: 'the slow header block was cut' });
            expect(connection.text.startsWith('HTTP/1.1 408')).toBe(true);
          } else {
            // Nothing of ours answers: the connection is still open past the deadline.
            await new Promise<void>((resolve) => setTimeout(resolve, 900)); // three times the deadline the case set, with no guard to fire
            expect(connection.text).toBe('');
          }
        } finally {
          connection.destroy();
        }
      });

      test('an idle keep-alive connection is closed once idle-timeout elapses', async () => {
        const serverOptions = HttpServerOptions.create().withIdleTimeoutMs(1_000);
        const server = await start(get(() => complete(Status.OK, 'x')), { serverOptions });
        const connection = new RawConnection(server.port);
        try {
          await connection.opened;
          connection.write(rawGet('/'));
          await awaitCondition(() => connection.responseCount() === 1, { timeoutMs: 2_000, label: 'the response arrived' });
          const answeredAt = performance.now();
          if (deviations.idleTimeoutOnFourSecondSweep === undefined) {
            await awaitCondition(() => connection.isClosed, { timeoutMs: 3_500, label: 'the idle connection was closed' });
            expect(performance.now() - answeredAt).toBeGreaterThanOrEqual(500);
          } else {
            // Up to one sweep early or late, but closed: measured on bun 1.4.2,
            // 1 s closes 126 ms to 4.0 s after the response.
            await awaitCondition(() => connection.isClosed, { timeoutMs: 5_500, label: 'the idle connection was closed within one sweep' });
          }
        } finally {
          connection.destroy();
        }
      }, 7_000);
    });

    // ── Shutdown (#997) ──────────────────────────────────────────────────────
    //
    // Contract (`ServerBinding.unbind`): "stop accepting at once, wait up to
    // `gracePeriodMs` for the requests in flight to finish, then force whatever
    // is still open.  `0`, or no value, forces at once."
    describe('shutdown drain', () => {
      test('a grace period lets a request in flight finish and receive its response', async () => {
        const { route, entered } = slowRoute();
        const server = await start(route);
        const response = fetch(`${server.url}/slow`);
        await entered;
        await server.binding.unbind(5_000);
        expect(await settledOutcomeOf(response)).toEqual({ status: 200, body: 'done' });
      });

      test('0 forces at once: the request in flight is cut and unbind does not wait for it', async () => {
        const { route, entered } = slowRoute();
        const server = await start(route);
        const response = fetch(`${server.url}/slow`);
        await entered;
        const startedAt = performance.now();
        await server.binding.unbind(0);
        const unbindMs = performance.now() - startedAt;
        expect(await settledOutcomeOf(response)).toBe('severed');
        expect(unbindMs).toBeLessThan(HANDLER_WORK_MS / 2);
      });

      test('the shutdown pipeline drains on the shipped default: readiness goes 503, new connections are refused, the request in flight completes', async () => {
        const { route, entered } = slowRoute();
        const systemOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
        const system = ActorSystem.create(`http-contract-drain-${label}`, systemOptions);
        const binding = await system.extension(HttpExtensionId)
          .newServerAt('127.0.0.1', 0)
          .useBackend(makeBackend())
          .bind(concat(route, managementRoutes(system, null)));
        live.push({ binding, system, port: binding.port, url: `http://127.0.0.1:${binding.port}` });
        const ready = await fetch(`http://127.0.0.1:${binding.port}/ready`);
        expect(ready.status).toBe(200);
        await ready.text();

        const events: string[] = [];
        const shutdown = system.extension(CoordinatedShutdownId);
        shutdown.addTask(Phases.ServiceUnbind, 'test-readiness-probe', async () => {
          const readiness = await healthChecksOf(system).checkReadiness();
          if (readiness.some((r) => !r.status)) events.push('readiness-503');
        });

        const response = fetch(`http://127.0.0.1:${binding.port}/slow`);
        await entered;
        const run = shutdown.run();

        const deadline = performance.now() + HANDLER_WORK_MS;
        while (performance.now() < deadline) {
          if (await connectionRefused(binding.port)) { events.push('new-connections-refused'); break; }
        }
        const outcome = await settledOutcomeOf(response);
        events.push('in-flight-completed');
        await run;
        events.push('listener-closed');

        expect(outcome).toEqual({ status: 200, body: 'done' });
        expect(events).toEqual(['readiness-503', 'new-connections-refused', 'in-flight-completed', 'listener-closed']);
      });
    });
  });
}
