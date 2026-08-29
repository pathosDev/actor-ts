import { match } from 'ts-pattern';
import {
  getHonoRunner,
  type FetchHandler,
  type HonoServerHandle,
  type HonoWebsocketBridge,
  type WSContextLike,
  type WSEventsLike,
} from '../../runtime/http/index.js';
import { HttpError, type HttpMethod, type HttpRequest, type HttpResponse } from '../Types.js';
import { DEFAULT_HTTP_MAX_BODY_BYTES } from '../Constants.js';
import {
  contentLengthExceeds,
  DEFAULT_RESPONSE_SECURITY_HEADERS,
  PAYLOAD_TOO_LARGE_RESPONSE,
  transportFrameCapOf,
} from './HttpServerBackend.js';
import type {
  HttpServerBackend,
  RouteRegistration,
  ServerBinding,
  WebsocketRouteRegistration,
} from './HttpServerBackend.js';
import { bufferWebsocketEvents } from '../websocket/SocketAdapter.js';
import type { WebsocketSocketAdapter } from '../websocket/SocketAdapter.js';
import { HonoBackendOptionsValidator } from './HonoBackendOptions.js';
import type { HonoBackendOptions, HonoBackendOptionsType } from './HonoBackendOptions.js';

/** Hono delivers text as a string and binary as ArrayBuffer/Uint8Array. */
function coerceWebsocketData(data: unknown): string | Uint8Array {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(0);
}

/** Read the `Content-Length` header off a Hono context as a string, if present. */
function contentLengthHeader(c: { req: { header(name?: string): unknown } }): string | undefined {
  const cl = c.req.header('content-length');
  return typeof cl === 'string' ? cl : undefined;
}

/**
 * The Web-Fetch body stream of the runtime request behind a Hono context, or
 * `null` when there is nothing this code can read incrementally.
 *
 * Probed structurally instead of typed.  `c.req.raw` is a `Request` on Bun and
 * Deno and a `Request` shim under `@hono/node-server`, but Hono is an optional
 * peer dependency whose adapter zoo has moved before, and a wrong assumption
 * here would throw on the request path rather than degrade.  `bodyUsed` and
 * `locked` are part of the probe on purpose: a user's own Hono middleware may
 * have read the body first, and then Hono's own cache — not this stream — is
 * the only place the bytes still exist, so the caller has to fall back to
 * `c.req.arrayBuffer()`.
 */
function requestBodyStream(raw: unknown): ReadableStream<Uint8Array> | null {
  if (!raw || typeof raw !== 'object') return null;
  if ((raw as { bodyUsed?: unknown }).bodyUsed === true) return null;
  const body = (raw as { body?: unknown }).body;
  if (!body || typeof body !== 'object') return null;
  if (typeof (body as { getReader?: unknown }).getReader !== 'function') return null;
  if ((body as { locked?: unknown }).locked === true) return null;
  return body as ReadableStream<Uint8Array>;
}

/** Join the chunks a capped stream read collected into one contiguous body. */
function concatenateChunks(chunks: ReadonlyArray<Uint8Array>, totalBytes: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** A body that arrived — or was absent — without ever crossing the cap. */
type WithinCapRead = { readonly kind: 'within-cap'; readonly body: Uint8Array | null };
/** A body abandoned mid-flight because it crossed the cap. */
type OverCapRead = { readonly kind: 'over-cap' };
/** Outcome of one capped request-body read. */
type CappedBodyRead = WithinCapRead | OverCapRead;

/**
 * Read the outbound send-buffer depth (bytes) from a Hono `WSContext`'s
 * native socket, so the connection actor's backpressure guard actually fires
 * on Hono (security audit WS-4).  Bun's `ServerWebSocket` exposes
 * `getBufferedAmount()`; the Node (`@hono/node-ws`) and Deno sockets expose a
 * numeric `.bufferedAmount`.  Unknown shape → 0 (guard stays off, as before).
 * @internal — exported for testing.
 */
export function readBufferedAmount(raw: unknown): number {
  if (!raw || typeof raw !== 'object') return 0;
  const sock = raw as { bufferedAmount?: unknown; getBufferedAmount?: unknown };
  if (typeof sock.getBufferedAmount === 'function') {
    const buffered = (sock.getBufferedAmount as () => unknown)();
    return typeof buffered === 'number' && Number.isFinite(buffered) ? buffered : 0;
  }
  return typeof sock.bufferedAmount === 'number' && Number.isFinite(sock.bufferedAmount) ? sock.bufferedAmount : 0;
}

/*
 * Hono is an optional peer dependency — the structural types below describe
 * only the narrow slice of its API we touch, so projects that never touch
 * this backend don't have to pull it in just for TypeScript to resolve.
 * Users that *do* install Hono get full, typed access via `getApp()`.
 */

type HonoContextLike = {
  readonly req: {
    method: string;
    path: string;
    url: string;
    param(name?: string): Record<string, string> | string | undefined;
    queries(name?: string): Record<string, string[]> | string[] | undefined;
    header(name?: string): Record<string, string> | string | undefined;
    arrayBuffer(): Promise<ArrayBuffer>;
    /**
     * Underlying runtime request — typed as `unknown` here because
     * the concrete shape varies: a Node `IncomingMessage` under
     * `@hono/node-server`, a Web-Fetch `Request` under Bun.serve.
     * We probe optional properties for peer-IP extraction in
     * `adaptRequest`.
     */
    readonly raw?: unknown;
  };
  /** Runtime-specific environment bag — varies per Hono adapter. */
  readonly env?: unknown;
};

type HonoHandler = (context: HonoContextLike) => Promise<Response> | Response;
type HonoErrorHandler = (err: unknown, context: HonoContextLike) => Promise<Response> | Response;
type HonoNotFoundHandler = (context: HonoContextLike) => Promise<Response> | Response;

/** Structural subset of the Hono app we consume. */
export interface HonoAppLike {
  get(path: string, ...handlers: unknown[]): unknown;
  post(path: string, handler: HonoHandler): unknown;
  put(path: string, handler: HonoHandler): unknown;
  delete(path: string, handler: HonoHandler): unknown;
  patch(path: string, handler: HonoHandler): unknown;
  options(path: string, handler: HonoHandler): unknown;
  on(method: string, path: string, handler: HonoHandler): unknown;
  onError(handler: HonoErrorHandler): unknown;
  notFound(handler: HonoNotFoundHandler): unknown;
  /**
   * Hono's real signature is `(request, ...rest)` and the tail is meaningful —
   * `rest[0]` becomes the app's `Env` (Bun's `server`, which the WebSocket
   * upgrade calls `server.upgrade()` on) and `rest[1]` its `ExecutionContext`.
   * Declaring only `request` here made every forwarder cast its way past the
   * type; an app that takes just the request stays assignable, so widening it
   * costs nothing.
   */
  fetch(request: Request, ...runtimeExtras: unknown[]): Promise<Response> | Response;
}

/**
 * The fetch handler a Hono app is served through.  Two properties are
 * load-bearing, and both are the kind a tidy-up silently drops:
 *
 * 1. **Every argument is forwarded.**  Bun invokes `fetch(request, server)`,
 *    and Hono's WebSocket upgrade needs that second `server` to call
 *    `server.upgrade()`.  A single-argument wrapper leaves plain HTTP working
 *    while WebSocket upgrades never open.
 * 2. **`request` is declared, not swept into the rest tail.**  A rest
 *    parameter contributes 0 to `Function.prototype.length`, and since Deno
 *    2.9 `Deno.serve` reads that number: an arity-0 handler is taken to not
 *    want the request and is invoked with *no arguments at all*, so
 *    `app.fetch` threw on `undefined.method` and every request answered 500
 *    (#1197).  See `DenoHonoRunner`'s `denoArityHandler` for the mechanism and
 *    the version evidence.
 *
 * Calling `app.fetch(...)` as a method rather than lifting it to a local also
 * keeps `this` intact for a user-injected app whose `fetch` lives on a
 * prototype — Hono's own is a bound class field, but nothing here requires it.
 *
 * @internal — exported for testing.
 */
export function honoFetchHandler(app: HonoAppLike): FetchHandler {
  return (request: Request, ...runtimeExtras: unknown[]) => app.fetch(request, ...runtimeExtras);
}

/**
 * Hono-backed HTTP backend — a thin adapter that compiles the actor-ts
 * routing DSL onto a Hono app and serves it with `Bun.serve`.  Hono is a
 * lightweight router that runs well on Bun and covers the middleware cases
 * we usually reach for (CORS, auth, logger) without pulling in Express.
 *
 * `hono` is an optional peer dependency: install it only if you use this
 * backend.  Without a user-supplied app, the backend imports `hono`
 * dynamically on `listen()`.
 */
export class HonoBackend implements HttpServerBackend {
  readonly name = 'hono';

  private app: HonoAppLike | null;
  private readonly ownsApp: boolean;
  private readonly maxBodyBytes: number;
  private readonly registered: RouteRegistration[] = [];
  private readonly wsRegistered: WebsocketRouteRegistration[] = [];
  private notFoundHandler: ((request: HttpRequest) => Promise<HttpResponse> | HttpResponse) | null = null;
  private errorHandler: ((err: unknown, request: HttpRequest) => Promise<HttpResponse> | HttpResponse) | null = null;
  private defaultResponseHeaders: Readonly<Record<string, string>> = DEFAULT_RESPONSE_SECURITY_HEADERS;
  /**
   * Bodies already read off a context, so a request that reaches the error
   * path is adapted twice without being read twice.  Reading the raw stream
   * bypasses Hono's own `bodyCache`, which is what used to make the second
   * `arrayBuffer()` in `onError` cheap; this restores that property without
   * giving up the streaming check.  Weak, so a context is collectable the
   * moment its response is written.
   */
  private readonly readBodies = new WeakMap<object, Uint8Array | null>();

  // Runtime-neutral server handle; the per-runtime adapter supplies a
  // concrete implementation (Bun.serve / @hono/node-server / Deno.serve).
  private server: HonoServerHandle | null = null;

  constructor(options: HonoBackendOptions = {}) {
    const resolvedOptions = (options as HonoBackendOptionsType);
    new HonoBackendOptionsValidator().validate(resolvedOptions);
    this.app = resolvedOptions.app ?? null;
    this.ownsApp = resolvedOptions.app == null;
    this.maxBodyBytes = resolvedOptions.maxBodyBytes ?? DEFAULT_HTTP_MAX_BODY_BYTES;
  }

  /** Inject / access the underlying Hono app — useful for native middleware. */
  getApp(): HonoAppLike {
    if (!this.app) throw new Error('HonoBackend: app not constructed yet — call listen() first or pass `{ app }` to the constructor.');
    return this.app;
  }

  registerRoute(route: RouteRegistration): void {
    if (this.registered.some((r) => r.method === route.method && r.pattern === route.pattern)) {
      throw new Error(`HonoBackend: duplicate ${route.method} route for pattern "${route.pattern}".`);
    }
    this.registered.push(route);
  }

  registerWebSocket(reg: WebsocketRouteRegistration): void {
    if (this.wsRegistered.some((r) => r.pattern === reg.pattern)) {
      throw new Error(`HonoBackend: duplicate websocket route for pattern "${reg.pattern}".`);
    }
    this.wsRegistered.push(reg);
  }

  setNotFound(handler: (request: HttpRequest) => Promise<HttpResponse> | HttpResponse): void {
    this.notFoundHandler = handler;
  }

  setErrorHandler(handler: (err: unknown, request: HttpRequest) => Promise<HttpResponse> | HttpResponse): void {
    this.errorHandler = handler;
  }

  setDefaultResponseHeaders(headers: Readonly<Record<string, string>>): void {
    this.defaultResponseHeaders = headers;
  }

  async listen(host: string, port: number): Promise<ServerBinding> {
    if (!this.app) this.app = await this.createHonoApp();
    const app = this.app;

    const explicitHead = new Set(this.registered.filter((r) => r.method === 'HEAD').map((r) => r.pattern));
    for (const r of this.registered) {
      this.attachRoute(r, r.method === 'GET' && !explicitHead.has(r.pattern));
    }

    if (this.notFoundHandler) {
      const handler = this.notFoundHandler;
      app.notFound(async (context) => {
        if (contentLengthExceeds(contentLengthHeader(context), this.maxBodyBytes)) return this.writeResponse(PAYLOAD_TOO_LARGE_RESPONSE);
        const read = await this.readBodyWithinCap(context);
        if (read.kind === 'over-cap') return this.writeResponse(PAYLOAD_TOO_LARGE_RESPONSE);
        const request = this.buildRequest(context, read.body);
        const response = await handler(request);
        return this.writeResponse(response);
      });
    }

    app.onError(async (err, context) => {
      const request = await this.adaptRequest(context);
      if (this.errorHandler) {
        try {
          const response = await this.errorHandler(err, request);
          return this.writeResponse(response);
        } catch (inner) { err = inner; }
      }
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: err.message, ...err.extra }), {
          status: err.status,
          headers: { ...this.defaultResponseHeaders, 'content-type': 'application/json; charset=utf-8', ...(err.headers ?? {}) },
        });
      }
      // No `message` field — see the note on FastifyBackend.writeError.
      return new Response(
        JSON.stringify({ error: 'Internal Server Error' }),
        { status: 500, headers: { ...this.defaultResponseHeaders, 'content-type': 'application/json; charset=utf-8' } },
      );
    });

    const runner = await getHonoRunner();

    // WebSocket routes: obtain the per-runtime bridge, register each route
    // as a GET carrying the authorize guard + Hono's upgrade middleware,
    // and fold the bridge's serve options in (Bun needs `{ websocket }`).
    //
    // The runner also gets the frame cap so the *runtime* refuses an oversize
    // frame while it arrives, matching what Express and Fastify hand `ws`.
    // It is the widest frame any registered route admits — the policy is
    // resolved at bind time now, so a route or a HOCON setting that moves
    // `maxFrameBytes` moves the transport window with it (#373).  One bridge
    // serves every route, so the routes have to agree on one number.
    let bridge: HonoWebsocketBridge | null = null;
    if (this.wsRegistered.length > 0) {
      if (!runner.webSocket) {
        throw new Error('HonoBackend: this runtime\'s Hono runner does not support websocket() routes.');
      }
      bridge = await runner.webSocket(app, transportFrameCapOf(this.wsRegistered));
      for (const reg of this.wsRegistered) this.attachWebsocketRoute(app, bridge, reg);
    }

    const server = await runner.serve({
      host,
      port,
      fetch: honoFetchHandler(app),
      serveOptions: bridge?.serveOptions,
    });
    this.server = server;
    bridge?.attach?.(server);

    return {
      host: server.host,
      port: server.port,
      unbind: async (gracePeriodMs?: number) => {
        const srv = this.server;
        if (!srv) return;
        this.server = null;
        if (gracePeriodMs && gracePeriodMs > 0) {
          // Race a graceful stop against the grace window — whichever wins
          // first resolves.  After the window we force-close regardless.
          await Promise.race([
            srv.stop(true),
            new Promise<void>((resolve) => {
              const timer = setTimeout(() => resolve(), gracePeriodMs);
              (timer as { unref?: () => void }).unref?.();
            }),
          ]);
          await srv.stop(false); // force any still-active connections
          return;
        }
        await srv.stop(false);
      },
    };
  }

  /* ============================ internals ============================ */

  private attachRoute(route: RouteRegistration, addHeadTwin = false): void {
    const app = this.app!;
    const wildcard = route.pattern.endsWith('/*');
    const prefix = wildcard ? route.pattern.slice(0, -2) : '';
    const handler: HonoHandler = async (c) => {
      // Reject an oversized Content-Length BEFORE reading the body; a chunked
      // body declares none, so `readBodyWithinCap` counts that one as it
      // arrives and abandons the read at the cap (security audit HTTP-1,
      // #357).  Both halves matter: the fast path costs no read at all, and
      // the counter is what stops a body that never announced its size from
      // being materialised in full first.
      if (contentLengthExceeds(contentLengthHeader(c), this.maxBodyBytes)) return this.writeResponse(PAYLOAD_TOO_LARGE_RESPONSE);
      const read = await this.readBodyWithinCap(c);
      if (read.kind === 'over-cap') return this.writeResponse(PAYLOAD_TOO_LARGE_RESPONSE);
      const request = this.buildRequest(c, read.body);
      // Wildcard contract: expose the matched remainder as params['*'].
      const finalRequest = wildcard
        ? { ...request, params: { ...request.params, '*': honoWildcardRest(c.req.path ?? new URL(c.req.url).pathname, prefix) } }
        : request;
      const out = await route.handler(finalRequest);
      return this.writeResponse(out);
    };
    const method = route.method.toLowerCase() as Lowercase<HttpMethod>;
    match(method)
      .with('get', () => {
        app.get(route.pattern, handler);
        // Hono doesn't auto-dispatch HEAD to a GET route (Fastify/Express
        // do), so mirror GET as HEAD (body stripped) unless an explicit
        // HEAD route already covers this pattern.
        if (addHeadTwin) {
          app.on('HEAD', route.pattern, async (c) => {
            const full = await handler(c);
            return new Response(null, { status: full.status, headers: full.headers });
          });
        }
      })
      .with('post',    () => app.post(route.pattern, handler))
      .with('put',     () => app.put(route.pattern, handler))
      .with('delete',  () => app.delete(route.pattern, handler))
      .with('patch',   () => app.patch(route.pattern, handler))
      .with('head',    () => app.on('HEAD', route.pattern, handler))
      .with('options', () => app.options(route.pattern, handler))
      .exhaustive();
  }

  private attachWebsocketRoute(app: HonoAppLike, bridge: HonoWebsocketBridge, reg: WebsocketRouteRegistration): void {
    // Guard middleware runs the authorize check against the upgrade
    // request; returning a Response short-circuits (no upgrade).
    const guard = async (context: HonoContextLike, next: () => Promise<void>): Promise<Response | void> => {
      const response = await reg.authorize(this.adaptUpgradeContext(context));
      if (response) return this.writeResponse(response);
      await next();
    };

    const createEvents = (raw: unknown): WSEventsLike => {
      const context = raw as HonoContextLike;
      const adapted = this.adaptUpgradeContext(context);
      let ws: WSContextLike | null = null;
      // Events that arrive before setListeners runs.  The connection actor
      // attaches its listeners from preStart, two mailbox hops after the
      // upgrade returns, and a client is free to close inside that window —
      // so close and error have to be held exactly like messages, or the
      // connection actor never stops and its maxConnections slot never
      // comes back (#570).
      // Bounded on the route's own numbers (#717): nothing drains this until
      // the connection actor attaches, and on this backend the socket handle
      // itself only exists from `onOpen` onwards — so the overflow close goes
      // through `ws`, which is set by then or the frames could not have come.
      const events = bufferWebsocketEvents(reg.preAttachBuffer, () => {
        try {
          ws?.close(1013, 'connection setup buffer overflow');
        } catch {
          /* already closing / closed */
        }
      });
      const adapter: WebsocketSocketAdapter = {
        send: (data) => ws?.send(data),
        close: (code, reason) => ws?.close(code, reason),
        setListeners: (incoming) => events.attach(incoming),
        get readyState() {
          return (ws?.readyState ?? 1) as 0 | 1 | 2 | 3;
        },
        // Enables the backpressure guard in WebsocketConnectionActor on Hono
        // (was a no-op before — the adapter had no bufferedAmount).  WS-4.
        bufferedAmount: () => readBufferedAmount(ws?.raw),
        remoteAddress: adapted.remoteAddress,
        get protocol() {
          return ws?.protocol;
        },
      };
      return {
        onOpen: (_evt, wsContext) => {
          ws = wsContext;
          reg.onConnection(adapted, adapter);
        },
        onMessage: (evt, wsContext) => {
          ws = wsContext;
          events.onMessage(coerceWebsocketData(evt.data));
        },
        onClose: (evt) => events.onClose(evt.code ?? 1005, evt.reason ?? ''),
        onError: () => events.onError(new Error('websocket error')),
      };
    };

    app.get(reg.pattern, guard, bridge.upgradeWebSocket(createEvents));
  }

  /** Synchronous upgrade-request snapshot (no body read — always GET). */
  private adaptUpgradeContext(context: HonoContextLike): HttpRequest {
    const headers = (context.req.header() as Record<string, string>) ?? {};
    let params: Record<string, string> = {};
    try {
      params = (context.req.param() as Record<string, string>) ?? {};
    } catch { /* no match — leave empty */ }
    const rawQueries = (context.req.queries() as Record<string, string[]>) ?? {};
    const query: Record<string, string | string[] | undefined> = {};
    for (const [key, value] of Object.entries(rawQueries)) {
      if (value) query[key] = value.length === 1 ? value[0] : value;
    }
    const remoteAddress = extractHonoRemoteAddress(context);
    return {
      method: 'GET',
      path: context.req.path ?? new URL(context.req.url).pathname,
      headers,
      query,
      params,
      body: null,
      ...(remoteAddress ? { remoteAddress } : {}),
    };
  }

  /**
   * Read the request body, giving up the moment it crosses `maxBodyBytes`.
   *
   * Chunk by chunk rather than through `c.req.arrayBuffer()`, which is a
   * single await that only returns once the *whole* body is resident — so a
   * chunked request declaring no `Content-Length` was bounded by whatever the
   * runtime happened to allow (16 MiB on Bun, unbounded elsewhere) and not by
   * the cap the application configured (#357).  Express has counted per chunk
   * since the same fix and Fastify counts inside its own parser; this is what
   * makes the third backend agree.
   *
   * Runtime-neutral by construction: it reads the standard Web-Fetch body
   * stream that every Hono adapter exposes, so it needs nothing from
   * `Bun.serve`, `Deno.serve` or `@hono/node-server` — none of which offers a
   * request-body-size option to pass down anyway.  Where no readable stream is
   * reachable it falls back to the buffered read plus a size check, which is
   * exactly the guarantee this backend gave before.
   */
  private async readBodyWithinCap(context: HonoContextLike): Promise<CappedBodyRead> {
    if (this.readBodies.has(context)) return { kind: 'within-cap', body: this.readBodies.get(context) ?? null };

    const method = context.req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return { kind: 'within-cap', body: null };

    const stream = requestBodyStream(context.req.raw);
    if (!stream) {
      const buffer = await context.req.arrayBuffer();
      if (buffer.byteLength > this.maxBodyBytes) return { kind: 'over-cap' };
      return this.rememberBody(context, buffer.byteLength > 0 ? new Uint8Array(buffer) : null);
    }

    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        totalBytes += value.byteLength;
        if (totalBytes > this.maxBodyBytes) {
          // Hang up on the rest of the upload — the whole point is that the
          // bytes past the cap are never received, let alone allocated.
          await reader.cancel().catch(() => undefined);
          return { kind: 'over-cap' };
        }
        chunks.push(value);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* already released by cancel() */ }
    }
    return this.rememberBody(context, totalBytes > 0 ? concatenateChunks(chunks, totalBytes) : null);
  }

  /** Record a body against its context and hand it back as a within-cap read. */
  private rememberBody(context: HonoContextLike, body: Uint8Array | null): CappedBodyRead {
    this.readBodies.set(context, body);
    return { kind: 'within-cap', body };
  }

  /**
   * Adapt a context whose body has not been read yet — the error path, which
   * runs after a handler already read (and cached) it, or instead of one that
   * never got that far.  An over-cap read is reported as no body at all: the
   * request that produced it was already answered with a 413.
   */
  private async adaptRequest(context: HonoContextLike): Promise<HttpRequest> {
    const read = await this.readBodyWithinCap(context);
    return this.buildRequest(context, read.kind === 'within-cap' ? read.body : null);
  }

  private buildRequest(context: HonoContextLike, body: Uint8Array | null): HttpRequest {
    const method = context.req.method.toUpperCase() as HttpRequest['method'];
    const headers = (context.req.header() as Record<string, string>) ?? {};

    // `c.req.param()` throws inside notFound / onError handlers because no
    // route matched — swallow that, an empty params object is the right
    // fallback there.
    let params: Record<string, string> = {};
    try {
      params = (context.req.param() as Record<string, string>) ?? {};
    } catch { /* no match — leave empty */ }

    // Hono returns queries as Record<string, string[]>; flatten single values.
    const rawQueries = (context.req.queries() as Record<string, string[]>) ?? {};
    const query: Record<string, string | string[] | undefined> = {};
    for (const [key, value] of Object.entries(rawQueries)) {
      if (!value) continue;
      query[key] = value.length === 1 ? value[0] : value;
    }

    const remoteAddress = extractHonoRemoteAddress(context);

    return {
      method,
      path: context.req.path ?? new URL(context.req.url).pathname,
      headers,
      query,
      params,
      body,
      ...(remoteAddress ? { remoteAddress } : {}),
    };
  }

  private writeResponse(response: HttpResponse): Response {
    const headers = new Headers();
    // Server-wide defaults go in first; `Headers.set` is case-insensitive, so
    // whatever the response carries itself replaces them.
    for (const [key, value] of Object.entries(this.defaultResponseHeaders)) headers.set(key, value);
    if (response.headers) for (const [key, value] of Object.entries(response.headers)) headers.set(key, value);
    if (response.contentType) headers.set('content-type', response.contentType);

    const body = response.body;
    if (body === undefined || body === null) return new Response(null, { status: response.status, headers });

    if (typeof body === 'string') {
      if (!headers.has('content-type')) headers.set('content-type', 'text/plain; charset=utf-8');
      return new Response(body, { status: response.status, headers });
    }
    if (body instanceof Uint8Array) {
      if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream');
      // Cast through BodyInit — the standard `Uint8Array<ArrayBufferLike>`
      // IS a valid Fetch body, but TypeScript 5.7+'s DOM types are not
      // (yet) parameterised that way, so the direct assignment errors.
      return new Response(body as unknown as BodyInit, { status: response.status, headers });
    }
    if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
      if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream');
      return new Response(body as unknown as BodyInit, { status: response.status, headers });
    }
    if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(body), { status: response.status, headers });
  }

  private async createHonoApp(): Promise<HonoAppLike> {
    if (!this.ownsApp) throw new Error('HonoBackend: app was not injected but ownsApp=false');
    try {
      const moduleName = 'hono';
      const mod = (await import(moduleName)) as { Hono?: new () => HonoAppLike };
      if (!mod.Hono) throw new Error('"hono" export "Hono" not found');
      return new mod.Hono();
    } catch (e) {
      throw new Error(
        'HonoBackend requires the "hono" package.  Install it with: '
        + 'bun add hono\nOriginal error: ' + (e instanceof Error ? e.message : String(e)),
      );
    }
  }
}

/** The path remainder a `/prefix/*` route matched (still URL-encoded — the caller decodes). */
function honoWildcardRest(path: string, prefix: string): string {
  const withSlash = `${prefix}/`;
  if (path.startsWith(withSlash)) return path.slice(withSlash.length);
  if (path === prefix) return '';
  return path.replace(/^\/+/, '');
}

/**
 * Best-effort peer-IP extraction across Hono's adapter zoo.  Tries
 * the well-known shapes (Node-server `c.req.raw.socket.remoteAddress`,
 * Bun `c.env.requestIP({ ... }).address`, Cloudflare `c.req.raw.cf.ip`),
 * returns `undefined` if none of them yield a string.
 *
 * This is the **socket peer** only — no forwarding header is consulted,
 * and Hono has no `trust proxy` setting to change that.  Behind a reverse
 * proxy the client's own address therefore has to be resolved one layer
 * up, by naming the proxies in `IpAllowlist`'s `trustedProxies` (#715);
 * that path needs nothing from the backend beyond this value, which is
 * why it works here as well as on Fastify and Express.
 */
function extractHonoRemoteAddress(context: HonoContextLike): string | undefined {
  // 1. @hono/node-server: c.req.raw is the Node IncomingMessage.
  const raw = context.req.raw as { socket?: { remoteAddress?: string } } | undefined;
  if (raw?.socket?.remoteAddress) return raw.socket.remoteAddress;

  // 2. Bun.serve via Hono: connection info lives on `c.env`.
  //    Bun's adapter exposes a `requestIP` callable.
  const env = context.env as
    | { requestIP?: (req: unknown) => { address?: string } | null; incoming?: { socket?: { remoteAddress?: string } } }
    | undefined;
  if (env?.requestIP && context.req.raw) {
    try {
      const info = env.requestIP(context.req.raw);
      if (info?.address) return info.address;
    } catch { /* runtime didn't accept the raw shape — fall through */ }
  }

  // 3. Some adapters (e.g. Vercel) put the connection info on env.incoming.
  if (env?.incoming?.socket?.remoteAddress) return env.incoming.socket.remoteAddress;

  return undefined;
}
