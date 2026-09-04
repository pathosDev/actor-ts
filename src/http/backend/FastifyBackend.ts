import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { HttpError, type HttpRequest, type HttpResponse } from '../Types.js';
import { DEFAULT_HTTP_MAX_BODY_BYTES } from '../Constants.js';
import { applyServerOptions, DEFAULT_RESPONSE_SECURITY_HEADERS, PAYLOAD_TOO_LARGE_RESPONSE, transportFrameCapOf } from './HttpServerBackend.js';
import type {
  HttpServerBackend,
  NodeHttpServerLike,
  RouteRegistration,
  ServerBinding,
  WebsocketRouteRegistration,
} from './HttpServerBackend.js';
import type { HttpServerOptionsType } from '../HttpServerOptions.js';
import { Lazy } from '../../util/Lazy.js';
import { websocketPackageAdapter, type WebsocketPackageSocket } from '../websocket/SocketAdapter.js';

// `@fastify/websocket` is an optional peer dep — lazy-import it (cached),
// so projects that never use websocket() routes don't pull it in.
const fastifyWebsocketLazy: Lazy<Promise<unknown>> = Lazy.of(async () => {
  try {
    const name = '@fastify/websocket';
    const mod = (await import(name)) as { default?: unknown };
    return mod.default ?? mod;
  } catch (e) {
    throw new Error(
      'websocket() routes on the Fastify backend require "@fastify/websocket".  '
        + 'Install it with: bun add @fastify/websocket\nOriginal error: '
        + (e instanceof Error ? e.message : String(e)),
    );
  }
});

// Fastify's generic type parameters have drifted between majors — treat the
// instance as opaque here.  The DSL never leaks this type to users.
type FastifyLike = ReturnType<typeof Fastify>;

/**
 * True for the error Fastify raises when a body outgrows `bodyLimit`.
 *
 * Matched on `code` rather than on the class: `FastifyError` is not exported
 * as a value, and the code is the part of that contract Fastify documents.
 * @internal — exported for testing.
 */
export function isBodyTooLargeError(err: unknown): boolean {
  return typeof err === 'object'
    && err !== null
    && (err as { code?: unknown }).code === 'FST_ERR_CTP_BODY_TOO_LARGE';
}

/**
 * Fastify-based default HTTP backend.  Leans on Fastify for fast routing,
 * body parsing (including raw-body support), and its plugin ecosystem.
 * The directives DSL compiles down to plain Fastify route registrations —
 * user code never interacts with Fastify types unless they explicitly opt
 * in via `backend.withPlugin(...)`.
 */
export class FastifyBackend implements HttpServerBackend {
  readonly name = 'fastify';
  private readonly app: FastifyLike;
  private readonly registered: RouteRegistration[] = [];
  private readonly wsRegistered: WebsocketRouteRegistration[] = [];
  private userErrorHandler:
    | ((err: unknown, request: HttpRequest) => Promise<HttpResponse> | HttpResponse)
    | null = null;
  private defaultResponseHeaders: Readonly<Record<string, string>> = DEFAULT_RESPONSE_SECURITY_HEADERS;

  constructor(options: object = {}) {
    // `bodyLimit` is spelled out rather than left to Fastify's own default so
    // the cap is the framework's decision and matches what the Express and
    // Hono backends enforce (#357).  Defaults go in first, so a caller-supplied
    // `bodyLimit` — or `logger` — still wins.
    this.app = (Fastify as (o?: object) => FastifyLike)({
      logger: false,
      bodyLimit: DEFAULT_HTTP_MAX_BODY_BYTES,
      ...options,
    });
    // Route EVERY content-type through a raw-buffer parser — we want the
    // bytes to reach the DSL unparsed so user code picks the decoder via
    // pickRequestSerializer.  Fastify's built-in JSON parser would steal
    // `application/json` bodies otherwise.
    //
    // None of them names a per-parser `bodyLimit`: that would SHADOW the
    // global one for the content types it covers, which is every one of them,
    // and the cap would then depend on which parser matched.
    const rawParser = (_req: unknown, body: unknown, done: (err: Error | null, value: unknown) => void) => done(null, body);
    this.app.removeContentTypeParser(['application/json', 'text/plain']);
    this.app.addContentTypeParser('*', { parseAs: 'buffer' }, rawParser);
    this.app.addContentTypeParser('application/json', { parseAs: 'buffer' }, rawParser);
    this.app.addContentTypeParser('application/cbor', { parseAs: 'buffer' }, rawParser);
    this.installErrorHandler();
  }

  /** Escape hatch: register a native Fastify plugin (e.g. @fastify/cors). */
  async withPlugin(plugin: unknown, options?: object): Promise<void> {
    await (this.app as { register: (p: unknown, o?: object) => Promise<void> }).register(plugin, options);
  }

  /**
   * **Every async Fastify handler here must `return reply`.**  Fastify's
   * `wrap-thenable` inspects what an async handler resolves to: on `undefined`
   * it re-sends when `reply.sent === false`, and `reply.sent` is still false
   * right after `reply.send(stream)` because a stream is written
   * asynchronously.  So an async handler that sends a stream and returns
   * nothing gets an immediate `reply.send(undefined)` on top of it — the client
   * receives `200`, `content-length: 0` and an empty body, with no error
   * anywhere.  Returning the reply is Fastify's documented signal that the
   * response is already handed over.
   *
   * Measured, not inferred: identical on Bun 1.3 and Node 26 with Fastify
   * 5.10, and only for a body whose first chunk is not ready synchronously —
   * which is why the pre-existing `StreamBody` cases never caught it (they
   * enqueue everything up front) and why it surfaced as soon as a static file
   * became the source (#465).
   */
  registerRoute(route: RouteRegistration): void {
    // Ahead of `app.route`, which would also reject this — but with
    // `FST_ERR_DUPLICATED_ROUTE`, wording that changes with Fastify and that
    // the other two backends cannot produce.  Rejecting here makes the refusal
    // the backend's own and identical across all three (#759).
    if (this.registered.some((r) => r.method === route.method && r.pattern === route.pattern)) {
      throw new Error(`FastifyBackend: duplicate ${route.method} route for pattern "${route.pattern}".`);
    }
    this.registered.push(route);
    this.app.route({
      method: route.method,
      url: route.pattern,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const adapted = this.adaptRequest(req);
        try {
          const out = await route.handler(adapted);
          this.writeResponse(reply, out);
        } catch (err) {
          await this.emitError(reply, adapted, err);
        }
        return reply;
      },
    });
  }

  registerWebSocket(reg: WebsocketRouteRegistration): void {
    if (this.wsRegistered.some((r) => r.pattern === reg.pattern)) {
      throw new Error(`FastifyBackend: duplicate websocket route for pattern "${reg.pattern}".`);
    }
    this.wsRegistered.push(reg);
  }

  /** `return reply` for the reason spelled out on {@link registerRoute} — a
   *  not-found handler serving an SPA fallback is a streaming body too. */
  setNotFound(handler: (request: HttpRequest) => Promise<HttpResponse> | HttpResponse): void {
    this.app.setNotFoundHandler(async (req: FastifyRequest, reply: FastifyReply) => {
      const adapted = this.adaptRequest(req);
      const response = await handler(adapted);
      this.writeResponse(reply, response);
      return reply;
    });
  }

  setDefaultResponseHeaders(headers: Readonly<Record<string, string>>): void {
    this.defaultResponseHeaders = headers;
  }

  setErrorHandler(handler: (err: unknown, request: HttpRequest) => Promise<HttpResponse> | HttpResponse): void {
    // Only recorded, never re-registered: the app-level hook installed in the
    // constructor reads this field on every error, so it picks the handler up
    // the moment it is set.  Recording it is what makes errors thrown by our
    // route handlers — caught in registerRoute's try/catch, which never
    // reaches Fastify core — route through it too.
    this.userErrorHandler = handler;
  }

  async listen(host: string, port: number, serverOptions?: Partial<HttpServerOptionsType>): Promise<ServerBinding> {
    if (this.wsRegistered.length > 0) {
      const plugin = await fastifyWebsocketLazy.get();
      // Await the register so the plugin's onRoute hook is installed
      // before we add the ws routes below.  (Awaiting does NOT lock the
      // route tree — routes can still be added after.)
      // `options` is forwarded to the underlying `ws` server; `maxPayload`
      // caps the transport frame size so an oversized frame is rejected at the
      // protocol level rather than buffered up to the `ws` 100 MiB default
      // first (security audit WS-3).  It is the widest frame any registered
      // route admits rather than the framework default, so the cap an
      // application configured — per route or in HOCON — is the one the
      // transport enforces (#373); the plugin is registered once for the whole
      // instance, so every route shares that single limit.
      await (this.app as { register: (p: unknown, o?: object) => Promise<unknown> })
        .register(plugin, { options: { maxPayload: transportFrameCapOf(this.wsRegistered) } });
      for (const reg of this.wsRegistered) this.attachWebsocketRoute(reg);
    }
    const address = await this.app.listen({ host, port });
    // Fastify overrides two of the four on its own — `keepAliveTimeout` to
    // 72 s and `requestTimeout` to 0 (no bound) — so this is the write that
    // makes a configured policy the one that governs rather than Fastify's
    // opinion.  It runs after `listen` because these are re-read per
    // connection; the factory-only knobs are not reachable from here at all.
    applyServerOptions(this.app.server as NodeHttpServerLike | undefined, serverOptions);
    // Fastify returns "http://<host>:<port>".
    const match = /:(\d+)$/.exec(address);
    const actualPort = match ? parseInt(match[1]!, 10) : port;
    return {
      host,
      port: actualPort,
      unbind: async (gracePeriodMs?: number) => {
        // `app.close()` waits for every in-flight request — and every
        // long-lived WebSocket connection — to drain.  Long-lived
        // sockets never drain on their own, so a server with even one
        // active WS client would hang `close()` forever (process
        // refuses to exit on Ctrl+C).  We give in-flight work a
        // bounded grace window, then force-close anything still
        // hanging on:
        //
        //   1. `server.closeAllConnections()` kills regular HTTP
        //      sockets (Node 18.2+ / Bun).  It does NOT touch
        //      sockets already upgraded to WebSocket — Node
        //      releases ownership of those at upgrade time.
        //   2. For Websockets we walk `fastify.websocketServer.clients`
        //      (populated by `@fastify/websocket`) and `terminate()`
        //      each one.  `terminate()` destroys the underlying TCP
        //      socket without sending a close frame — appropriate
        //      for shutdown where we're going down anyway.
        //
        // Both probes are best-effort: if no WS plugin is registered
        // `websocketServer` is undefined, and on Bun
        // `closeAllConnections` may also be unavailable.  After
        // forcing, `app.close()` resolves quickly and we return.
        const grace = gracePeriodMs && gracePeriodMs > 0 ? gracePeriodMs : 0;
        const server = (this.app as { server?: { closeAllConnections?: () => void } }).server;
        const wss = (this.app as { websocketServer?: { clients?: Iterable<{ terminate?: () => void }> } }).websocketServer;
        const closing = this.app.close();
        if (grace > 0) {
          let timer: ReturnType<typeof setTimeout> | null = null;
          await Promise.race([
            closing,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, grace);
              (timer as { unref?: () => void }).unref?.();
            }),
          ]);
          if (timer) clearTimeout(timer);
        }
        try { server?.closeAllConnections?.(); } catch { /* best-effort */ }
        if (wss?.clients) {
          for (const client of wss.clients) {
            try { client.terminate?.(); } catch { /* best-effort */ }
          }
        }
        // The listening socket is already closed (close() stops accepting
        // immediately); we've force-terminated remaining connections.  Wait
        // for `close()` to settle, but bound it — on Bun `close()` can hang
        // after WebSocket upgrades even once every socket is gone, which
        // would otherwise make `unbind()` (and shutdown) never resolve.
        await Promise.race([
          closing,
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 1000);
            (timer as { unref?: () => void }).unref?.();
          }),
        ]);
      },
    };
  }

  /** @internal — used by tests that inspect Fastify state. */
  get fastify(): FastifyLike { return this.app; }

  private attachWebsocketRoute(reg: WebsocketRouteRegistration): void {
    // Use the `.get(url, { websocket: true }, handler)` shorthand: it is
    // the form @fastify/websocket wires reliably across runtimes (the
    // route-object `wsHandler` variant is not picked up on Bun).  The
    // handler receives the ws socket + request; preValidation replying
    // cancels the upgrade (auth-at-upgrade).
    (this.app as {
      get: (url: string, opts: unknown, handler: (socket: WebsocketPackageSocket, req: FastifyRequest) => void) => unknown;
    }).get(
      reg.pattern,
      {
        websocket: true,
        preValidation: async (req: FastifyRequest, reply: FastifyReply) => {
          const response = await reg.authorize(this.adaptRequest(req));
          if (response) this.writeResponse(reply, response);
        },
      },
      (socket: WebsocketPackageSocket, req: FastifyRequest) => {
        const adapted = this.adaptRequest(req);
        reg.onConnection(adapted, websocketPackageAdapter(socket, {
          remoteAddress: adapted.remoteAddress,
          preAttachBuffer: reg.preAttachBuffer,
        }));
      },
    );
  }

  /* -------------------------------- Helpers ------------------------------- */

  /**
   * Install the app-level error hook once, at construction.
   *
   * Unconditional — not only when the application calls `withErrorHandler` —
   * because a body over `bodyLimit` never reaches a route and so is only
   * answerable here, and Fastify's own answer for it is a JSON envelope no
   * other backend emits (#357).  Normalising it needs the hook to be in place
   * even for an application that installed no error handler at all.
   *
   * Everything else without a user handler is handed straight back to Fastify:
   * re-sending the error object is the documented way to reach the default
   * serialiser, so a framework error that carries its own status keeps it
   * instead of being flattened into our generic 500 — which is what a server
   * that never asked for an error handler already got, since before this the
   * hook was only installed when one was set.
   */
  private installErrorHandler(): void {
    this.app.setErrorHandler(async (err: unknown, req: FastifyRequest, reply: FastifyReply) => {
      if (isBodyTooLargeError(err)) {
        this.writeResponse(reply, PAYLOAD_TOO_LARGE_RESPONSE);
        return reply;
      }
      if (!this.userErrorHandler) {
        reply.send(err as Error);
        return reply;
      }
      // A user error handler may return any body shape, streams included, so
      // this path needs the same `return reply` as registerRoute.
      await this.emitError(reply, this.adaptRequest(req), err);
      return reply;
    });
  }

  private adaptRequest(req: FastifyRequest): HttpRequest {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value.join(',');
    }
    const body = this.asBytes(req.body);
    // Fastify exposes the connecting peer as `req.ip` — that's the
    // canonical accessor that also respects the `trustProxy` config
    // when operators have wired it up.  Fall back to the raw socket
    // peer if `req.ip` isn't populated (e.g. inside a unit-test mock).
    // The cast is necessary because `FastifyRequest.ip` is typed as
    // `string` but can be missing in non-standard test doubles.
    const remoteAddress = (req as unknown as { ip?: string; socket?: { remoteAddress?: string } }).ip
      ?? (req as unknown as { socket?: { remoteAddress?: string } }).socket?.remoteAddress;
    // `req.url` is Fastify's RAW request target — query string included.
    // `HttpRequest.path` is contractually the bare pathname (see
    // `src/http/Types.ts`), which is what Express and Hono already report,
    // so split at the first `?`.  A pathname can never contain a literal
    // one (it is percent-encoded as `%3F`), and the parameters are in
    // `query` anyway.  Leaving the query in `path` made every consumer that
    // appends to it — the static-file directory redirect, the DevTools shell
    // redirect, the directory-listing heading — build a target with the
    // suffix landing inside the query instead of on the path.
    const queryStart = req.url.indexOf('?');
    const pathname = queryStart === -1 ? req.url : req.url.slice(0, queryStart);
    return {
      method: (req.method as HttpRequest['method']),
      path: pathname,
      headers,
      query: (req.query as Record<string, string | string[] | undefined>) ?? {},
      params: (req.params as Record<string, string>) ?? {},
      body,
      ...(remoteAddress ? { remoteAddress } : {}),
    };
  }

  private asBytes(raw: unknown): Uint8Array | null {
    if (raw === null || raw === undefined) return null;
    if (raw instanceof Uint8Array) return raw;
    if (typeof raw === 'string') return new TextEncoder().encode(raw);
    if (typeof Buffer !== 'undefined' && raw instanceof Buffer) {
      return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    }
    return null;
  }

  /**
   * Write the server-wide defaults first — `reply.header` replaces, so
   * anything the response carries itself overwrites them.  Fastify lower-cases
   * header names, so the precedence holds regardless of the caller's spelling.
   */
  private applyDefaultResponseHeaders(reply: FastifyReply): void {
    for (const [key, value] of Object.entries(this.defaultResponseHeaders)) reply.header(key, value);
  }

  private writeResponse(reply: FastifyReply, response: HttpResponse): void {
    reply.status(response.status);
    this.applyDefaultResponseHeaders(reply);
    if (response.headers) for (const [key, value] of Object.entries(response.headers)) reply.header(key, value);
    if (response.contentType) reply.header('content-type', response.contentType);
    if (response.body === undefined || response.body === null) {
      reply.send();
      return;
    }
    if (typeof response.body === 'string') {
      if (!response.contentType && !response.headers?.['content-type']) reply.header('content-type', 'text/plain; charset=utf-8');
      reply.send(response.body);
      return;
    }
    if (response.body instanceof Uint8Array) {
      if (!response.contentType) reply.header('content-type', 'application/octet-stream');
      reply.send(Buffer.from(response.body));
      return;
    }
    if (typeof ReadableStream !== 'undefined' && response.body instanceof ReadableStream) {
      if (!response.contentType && !response.headers?.['content-type']) reply.header('content-type', 'application/octet-stream');
      reply.send(response.body);
      return;
    }
    // Plain object → JSON.
    if (!response.contentType) reply.header('content-type', 'application/json; charset=utf-8');
    reply.send(JSON.stringify(response.body));
  }

  /**
   * Route a thrown error through the user's error handler when one is set
   * (falling back to the default mapping if that handler itself throws),
   * otherwise the default mapping.  Unifies the per-route catch with
   * Fastify's framework-level hook so both honour `withErrorHandler` —
   * matching how the Express and Hono backends already behave.
   */
  private async emitError(reply: FastifyReply, request: HttpRequest, err: unknown): Promise<void> {
    if (this.userErrorHandler) {
      try {
        this.writeResponse(reply, await this.userErrorHandler(err, request));
        return;
      } catch (inner) {
        this.writeError(reply, inner);
        return;
      }
    }
    this.writeError(reply, err);
  }

  private writeError(reply: FastifyReply, err: unknown): void {
    this.applyDefaultResponseHeaders(reply);
    if (err instanceof HttpError) {
      reply.status(err.status);
      if (err.headers) for (const [k, v] of Object.entries(err.headers)) reply.header(k, v);
      reply.send({ error: err.message, ...err.extra });
      return;
    }
    // No `message` field: an unhandled throw is not a client's business, and
    // its text routinely carries file paths, SQL fragments or driver internals.
    // Matches `defaultErrorResponse` in Route.ts, which the WebSocket-reject
    // and `fallback()` paths already use.  To surface or log the detail,
    // install `withErrorHandler` on the server builder.
    reply.status(500).send({ error: 'Internal Server Error' });
  }
}
