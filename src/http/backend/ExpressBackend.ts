import type { IncomingMessage, Server } from 'node:http';
import { ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { Readable } from 'node:stream';
import { match } from 'ts-pattern';
import { Lazy } from '../../util/Lazy.js';
import { HttpError, type HttpMethod, type HttpRequest, type HttpResponse } from '../types.js';
import { ExpressBackendOptionsValidator } from './ExpressBackendOptions.js';
import type { ExpressBackendOptions, ExpressBackendOptionsType } from './ExpressBackendOptions.js';
import { DEFAULT_HTTP_MAX_BODY_BYTES, DEFAULT_WEBSOCKET_MAX_FRAME_BYTES } from '../Constants.js';
import {
  contentLengthExceeds,
  DEFAULT_RESPONSE_SECURITY_HEADERS,
  PAYLOAD_TOO_LARGE_RESPONSE,
} from './HttpServerBackend.js';
import type {
  HttpServerBackend,
  RouteRegistration,
  ServerBinding,
  WebsocketRouteRegistration,
} from './HttpServerBackend.js';
import { websocketPackageAdapter, type WebsocketPackageSocket } from '../websocket/SocketAdapter.js';

/** Minimal shape of the `ws` package's WebSocketServer (noServer mode). */
interface WebsocketServerLike {
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (ws: WebsocketPackageSocket) => void,
  ): void;
  emit(event: 'connection', ws: WebsocketPackageSocket, req: IncomingMessage): boolean;
  readonly clients?: Iterable<{ terminate?: () => void; close?: () => void }>;
}

// `ws` is an optional peer dep — lazy-import its WebSocketServer (cached).
const wsServerConstructorLazy: Lazy<Promise<new (opts: { noServer: boolean; maxPayload?: number }) => WebsocketServerLike>> = Lazy.of(async () => {
  try {
    const name = 'ws';
    const mod = (await import(name)) as {
      WebSocketServer?: new (opts: { noServer: boolean; maxPayload?: number }) => WebsocketServerLike;
      default?: { WebSocketServer?: new (opts: { noServer: boolean; maxPayload?: number }) => WebsocketServerLike };
    };
    const Constructor = mod.WebSocketServer ?? mod.default?.WebSocketServer;
    if (!Constructor) throw new Error('ws: WebSocketServer not exported');
    return Constructor;
  } catch (e) {
    throw new Error(
      'websocket() routes on the Express backend require the "ws" package.  '
        + 'Install it with: bun add ws\nOriginal error: '
        + (e instanceof Error ? e.message : String(e)),
    );
  }
});

/*
 * We deliberately keep Express imports narrow + structural — the peer dep
 * is optional, so the type aliases below describe only what we touch.
 * Callers can still hand us a real Express app via `new ExpressBackend(app)`.
 */

/** Minimal shape of the Express Request we rely on. */
type ExpressRequestLike = {
  method: string;
  url: string;
  path?: string;
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string>;
  query: Record<string, unknown>;
  /** Populated by our raw-body middleware. */
  rawBody?: Uint8Array | null;
  body?: unknown;
  /**
   * Express's IP accessor — by default the socket peer; when
   * `app.set('trust proxy', ...)` is configured, the leftmost
   * `X-Forwarded-For` entry.  Forwarded into `HttpRequest.remoteAddress`.
   */
  ip?: string;
  /** Raw socket — fallback when `req.ip` isn't populated. */
  socket?: { remoteAddress?: string };
};

/** Minimal shape of the Express Response we rely on. */
interface ExpressResponseLike {
  status(code: number): ExpressResponseLike;
  setHeader(name: string, value: string): void;
  end(body?: string | Uint8Array): void;
}

type ExpressNext = (err?: unknown) => void;
type ExpressHandler = (req: ExpressRequestLike, res: ExpressResponseLike, next: ExpressNext) => void | Promise<void>;
type ExpressErrorHandler = (err: unknown, req: ExpressRequestLike, res: ExpressResponseLike, next: ExpressNext) => void | Promise<void>;

/** Escape a literal string for safe embedding in a RegExp source. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `ServerResponse.assignSocket`/`detachSocket` are typed for a `net.Socket`,
 * while the `'upgrade'` event hands over the widest shape it can promise, a
 * `Duplex`.  On a real `http.Server` it is always the former — the two are
 * the same object — and this narrowing records that rather than widening the
 * fields that carry it.
 */
function asNetSocket(socket: Duplex): Socket {
  return socket as Socket;
}

/**
 * Subset of the Express app API we touch.  Covers v4 and v5.  Paths accept
 * a RegExp as well as a string: a trailing-`*` wildcard route registers as
 * a RegExp so it works identically on Express 4 and 5 (v5's path-to-regexp
 * rejects a bare string `*`).
 *
 * The call signature is the app itself — `express()` returns
 * `function (request, response, next) { app.handle(...) }`, which is what
 * `app.listen()` hands to `http.createServer`.  Calling it is how a
 * WebSocket upgrade is pushed through the middleware chain (see
 * {@link ExpressBackend.attachUpgradeDispatch}).  It is declared instead of
 * `app.handle` deliberately: `@types/express` types the app as callable but
 * does not declare `handle`, so requiring the method would reject a genuine
 * Express app at `ExpressBackendOptionsBuilder.withApp`.
 */
export interface ExpressAppLike {
  (request: IncomingMessage, response: ServerResponse, next: ExpressNext): void;
  get(path: string | RegExp, handler: ExpressHandler): void;
  post(path: string | RegExp, handler: ExpressHandler): void;
  put(path: string | RegExp, handler: ExpressHandler): void;
  delete(path: string | RegExp, handler: ExpressHandler): void;
  patch(path: string | RegExp, handler: ExpressHandler): void;
  head(path: string | RegExp, handler: ExpressHandler): void;
  options(path: string | RegExp, handler: ExpressHandler): void;
  use(mw: ExpressHandler | ExpressErrorHandler): void;
  listen(port: number, hostname: string, callback: (err?: Error) => void): Server;
}

/**
 * One in-flight WebSocket upgrade, parked while the Express stack runs.
 *
 * Node hands the raw socket to the `'upgrade'` listener and never to the
 * request handler, so the socket cannot travel through Express with the
 * request.  This record is how the WebSocket route handler — invoked deep
 * inside the middleware chain — finds the socket belonging to the request it
 * was called with.
 */
type PendingUpgrade = {
  /** The raw request; `ws` needs it verbatim to compute the handshake. */
  readonly request: IncomingMessage;
  readonly socket: Duplex;
  /** Bytes the client already sent after the request head. */
  readonly head: Buffer;
  /** Synthesised response the Express stack writes to; owns `socket`. */
  readonly response: ServerResponse;
  /** Set once the socket's fate is decided, so it is torn down exactly once. */
  settled: boolean;
};

/**
 * Express-backed HTTP backend — drop-in alternative to the Fastify
 * default.  Intended for teams that already have an Express-based plugin
 * ecosystem (session stores, auth, observability) they want to reuse.
 *
 * That reuse covers **WebSocket handshakes too**: an upgrade is dispatched
 * through the app itself, so everything installed with `app.use(...)` —
 * sessions, authentication, rate limiting — runs before a socket is upgraded,
 * and a middleware that answers the request cancels the handshake (#623).
 * See {@link ExpressBackend.attachUpgradeDispatch} for the mechanics.
 *
 * `express` is an optional peer dependency: install it only if you use
 * this backend.  When no app is injected, the backend imports `express`
 * dynamically and builds a fresh one.
 */
export class ExpressBackend implements HttpServerBackend {
  readonly name = 'express';

  private app: ExpressAppLike | null;
  private server: Server | null = null;
  private readonly ownsApp: boolean;
  /** Upgrades waiting for the Express stack to reach their route. */
  private readonly pendingUpgrades = new WeakMap<object, PendingUpgrade>();
  private readonly maxBodyBytes: number;
  private readonly registered: RouteRegistration[] = [];
  private readonly wsRegistered: WebsocketRouteRegistration[] = [];
  private wss: WebsocketServerLike | null = null;
  private notFoundHandler: ((request: HttpRequest) => Promise<HttpResponse> | HttpResponse) | null = null;
  private errorHandler: ((err: unknown, request: HttpRequest) => Promise<HttpResponse> | HttpResponse) | null = null;
  private defaultResponseHeaders: Readonly<Record<string, string>> = DEFAULT_RESPONSE_SECURITY_HEADERS;

  constructor(options: ExpressBackendOptions = {}) {
    const resolvedOptions = (options as ExpressBackendOptionsType);
    new ExpressBackendOptionsValidator().validate(resolvedOptions);
    this.app = resolvedOptions.app ?? null;
    this.ownsApp = resolvedOptions.app == null;
    this.maxBodyBytes = resolvedOptions.maxBodyBytes ?? DEFAULT_HTTP_MAX_BODY_BYTES;
  }

  /** Inject / access the underlying Express app — useful for native middleware. */
  getApp(): ExpressAppLike {
    if (!this.app) throw new Error('ExpressBackend: app not constructed yet — call listen() first or pass `{ app }` to the constructor.');
    return this.app;
  }

  registerRoute(route: RouteRegistration): void {
    this.registered.push(route);
  }

  registerWebSocket(reg: WebsocketRouteRegistration): void {
    if (this.wsRegistered.some((r) => r.pattern === reg.pattern)) {
      throw new Error(`ExpressBackend: duplicate websocket route for pattern "${reg.pattern}".`);
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
    if (!this.app) this.app = await this.createExpressApp();
    // Register our raw-body middleware first so routes see req.rawBody.
    this.app.use(this.rawBodyMiddleware());
    // WebSocket routes go in ahead of the HTTP ones.  A wildcard GET route
    // registered first would match the upgrade request and answer it as an
    // ordinary GET, and the handshake would never reach its own route.
    if (this.wsRegistered.length > 0) await this.attachWebsocketRoutes(this.app);
    // Apply routes.  Express treats patterns like "/users/:id" natively.
    for (const route of this.registered) this.attachRoute(route);
    // 404 + error middlewares MUST come last.
    if (this.notFoundHandler) {
      const handler = this.notFoundHandler;
      const notFound: ExpressHandler = async (req, res, next) => {
        try {
          const adapted = this.adaptRequest(req);
          const out = await handler(adapted);
          this.writeResponse(res, out);
        } catch (err) { next(err); }
      };
      this.app.use(notFound);
    }
    this.app.use(this.makeErrorMiddleware());

    const actualPort = await new Promise<number>((resolve, reject) => {
      const server = this.app!.listen(port, host, (err?: Error) => {
        if (err) { reject(err); return; }
        const addr = server.address();
        if (addr && typeof addr === 'object') resolve(addr.port);
        else resolve(port);
      });
      server.once('error', reject);
      this.server = server;
    });

    if (this.wsRegistered.length > 0 && this.server) {
      this.attachUpgradeDispatch(this.server, this.app);
    }

    return {
      host,
      port: actualPort,
      unbind: async (gracePeriodMs?: number) => {
        const srv = this.server;
        if (!srv) return;
        this.server = null;
        // Force-terminate live WebSocket connections first — otherwise
        // server.close() waits on them forever (a long-lived socket never
        // drains) and shutdown hangs.
        if (this.wss?.clients) {
          for (const client of this.wss.clients) {
            try { client.terminate?.(); } catch { /* already gone */ }
          }
        }
        await new Promise<void>((resolve) => {
          let done = false;
          const finish = (): void => { if (!done) { done = true; resolve(); } };
          const grace = gracePeriodMs && gracePeriodMs > 0 ? gracePeriodMs : 1000;
          // Bound the wait — on some runtimes (Bun) close() can hang after
          // WS upgrades even once sockets are terminated.  This one-shot
          // timer is intentionally NOT unref'd: it must fire to guarantee
          // unbind resolves; it clears itself once close() or the deadline
          // wins, so it never keeps the process alive afterwards.
          const hard = setTimeout(() => { try { srv.closeAllConnections?.(); } catch { /* best-effort */ } finish(); }, grace);
          srv.close(() => { clearTimeout(hard); finish(); });
        });
      },
    };
  }

  /**
   * Register every WebSocket route as an ordinary Express GET.
   *
   * Reaching one of these handlers *is* the guarantee #623 asked for: the
   * request only gets there after the whole middleware chain ran and let it
   * through, exactly like any other route on this app.
   */
  private async attachWebsocketRoutes(app: ExpressAppLike): Promise<void> {
    const WebsocketServerConstructor = await wsServerConstructorLazy.get();
    // Cap the transport payload at the default WS frame size so an oversized
    // frame is rejected at the protocol level instead of being buffered up to
    // the `ws` default of 100 MiB first (security audit WS-3).
    const wss = new WebsocketServerConstructor({ noServer: true, maxPayload: DEFAULT_WEBSOCKET_MAX_FRAME_BYTES });
    this.wss = wss;
    for (const registration of this.wsRegistered) {
      app.get(registration.pattern, (req, res, next) => {
        const pending = this.pendingUpgrades.get(req);
        // A plain GET to a WebSocket path is not a handshake — fall through,
        // so it lands wherever it landed before this route existed (a
        // wildcard route, or the not-found handler).
        if (!pending) { next(); return; }
        this.completeUpgrade(pending, registration, wss, req, res).catch(() => {
          // Last-resort guard: this handler must never reject into an
          // unhandled rejection (process-fatal under Node's default, and
          // Express 4 does not await a handler's promise).  Any unexpected
          // throw closes the socket instead (security audit WS-1).
          this.releaseUpgrade(pending);
        });
      });
    }
  }

  /**
   * Push every upgrade through the Express app, the way `@fastify/websocket`
   * pushes one through `fastify.routing`.
   *
   * Node emits `'upgrade'` on the server and never routes it into the request
   * handler, so an adapter that answers the event itself — as this backend
   * used to — silently skips every `app.use(...)` the application installed:
   * sessions, authentication, rate limiting (#623).  Binding a synthesised
   * `ServerResponse` to the raw socket and calling the app restores the
   * ordinary request path.  The socket is upgraded only if the chain reached
   * the WebSocket route without answering; a middleware that writes a
   * response instead cancels the handshake and gets that response delivered.
   *
   * The `ServerResponse` also replaces the hand-rolled socket write this path
   * used before, which measurably delivered *zero bytes* under Bun 1.3.1 — a
   * rejected client saw a bare connection close instead of the guard's 401.
   * Written through a `ServerResponse` the status line arrives on both Bun
   * and Node.  Deno delivers neither, before or after this change: its
   * `'upgrade'` socket is write-only in the direction of a completed
   * handshake, so a rejected client there still just sees the connection go.
   */
  private attachUpgradeDispatch(server: Server, app: ExpressAppLike): void {
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      // Attach the raw-socket error guard BEFORE any other work: a peer that
      // vanishes mid-handshake (or a malformed upgrade) must never surface as
      // an unhandled 'error' event, which would crash the process (WS-1).
      socket.on('error', () => { /* ignore */ });
      const response = new ServerResponse(request);
      const pending: PendingUpgrade = { request, socket, head, response, settled: false };
      this.pendingUpgrades.set(request, pending);
      // Which event marks "the app answered" differs per runtime — Node emits
      // only 'finish', Bun 'finish' then 'close', Deno 'close' with the socket
      // already destroyed — so both are wired and the teardown is idempotent.
      const release = (): void => this.releaseUpgrade(pending);
      response.on('finish', release);
      response.on('close', release);
      try {
        response.assignSocket(asNetSocket(socket));
        // Only a GET can become a WebSocket (RFC 6455 §4.1), and anything
        // else must not enter the app at all: the raw-body middleware would
        // try to drain a body from a socket the HTTP parser already let go of.
        if ((request.method ?? '').toUpperCase() !== 'GET') {
          this.answerUpgrade(pending, 405, 'Method Not Allowed');
          return;
        }
        app(request, response, () => this.answerUpgrade(pending, 404, 'Not Found'));
      } catch {
        release();
      }
    });
  }

  /**
   * Run the DSL's own upgrade guard and, if it passes, hand the socket to
   * `ws`.  Everything before this point was the application's middleware; the
   * `authorize` fold here is what `withMiddleware()` / `allowedOrigins`
   * compile down to, and it stays the last word.
   */
  private async completeUpgrade(
    pending: PendingUpgrade,
    registration: WebsocketRouteRegistration,
    wss: WebsocketServerLike,
    req: ExpressRequestLike,
    res: ExpressResponseLike,
  ): Promise<void> {
    // Express already matched the pattern and populated `req.params`, so the
    // upgrade reuses the very same adapter the HTTP path uses — including
    // `req.ip`, which honours `app.set('trust proxy', …)`.
    const adapted = this.adaptRequest(req);
    let reject: HttpResponse | null;
    try {
      reject = await registration.authorize(adapted);
    } catch {
      reject = { status: 500, body: 'Internal Server Error' };
    }
    // The peer may have gone away while `authorize` awaited.
    if (pending.settled) return;
    if (reject) {
      this.writeResponse(res, reject);
      return;
    }
    // Hand the socket over.  The response has to let go of it first, or Node
    // keeps treating it as the body of an HTTP response.
    pending.settled = true;
    this.pendingUpgrades.delete(pending.request);
    pending.response.detachSocket(asNetSocket(pending.socket));
    wss.handleUpgrade(pending.request, pending.socket, pending.head, (ws) => {
      // Keep wss.clients populated so the unbind terminate-walk works.
      wss.emit('connection', ws, pending.request);
      registration.onConnection(adapted, websocketPackageAdapter(ws, { remoteAddress: adapted.remoteAddress }));
    });
  }

  /**
   * Answer an upgrade the app itself never answered, using the bare
   * `ServerResponse` API.  Both callers can be reached before Express's own
   * `expressInit` middleware swapped the response prototype, so `res.status(…)`
   * — what {@link writeResponse} uses — is not guaranteed to exist yet.
   */
  private answerUpgrade(pending: PendingUpgrade, status: number, body: string): void {
    const { response } = pending;
    if (pending.settled || response.headersSent) { this.releaseUpgrade(pending); return; }
    response.statusCode = status;
    for (const [key, value] of Object.entries(this.defaultResponseHeaders)) response.setHeader(key, value);
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.end(body);
  }

  /** Give up an upgrade that will not happen and close its socket, once. */
  private releaseUpgrade(pending: PendingUpgrade): void {
    if (pending.settled) return;
    pending.settled = true;
    this.pendingUpgrades.delete(pending.request);
    try { pending.response.detachSocket(asNetSocket(pending.socket)); } catch { /* runtime already did */ }
    try { pending.socket.destroy(); } catch { /* already gone */ }
  }

  /* ============================ internals ============================ */

  private attachRoute(route: RouteRegistration): void {
    const method = route.method.toLowerCase() as Lowercase<HttpMethod>;
    // A trailing-`*` pattern registers as a RegExp (v4/v5-safe) and the
    // captured remainder is exposed as params['*'] — the wildcard contract.
    const wildcard = route.pattern.endsWith('/*');
    const registerPath: string | RegExp = wildcard
      ? new RegExp('^' + escapeRegExp(route.pattern.slice(0, -2)) + '/(.*)$')
      : route.pattern;
    const handler: ExpressHandler = async (req, res, next) => {
      try {
        const adapted = this.adaptRequest(req);
        const finalRequest = wildcard
          ? { ...adapted, params: { ...adapted.params, '*': (req.params as Record<string, string>)['0'] ?? '' } }
          : adapted;
        const out = await route.handler(finalRequest);
        this.writeResponse(res, out);
      } catch (err) { next(err); }
    };
    const app = this.app!;
    match(method)
      .with('get',     () => app.get(registerPath, handler))
      .with('post',    () => app.post(registerPath, handler))
      .with('put',     () => app.put(registerPath, handler))
      .with('delete',  () => app.delete(registerPath, handler))
      .with('patch',   () => app.patch(registerPath, handler))
      .with('head',    () => app.head(registerPath, handler))
      .with('options', () => app.options(registerPath, handler))
      .exhaustive();
  }

  /**
   * Read the whole request body into a single Uint8Array on `req.rawBody`.
   * We intentionally avoid express.json/urlencoded so the DSL's own
   * content-negotiation (JSON vs. CBOR vs. text) stays in charge.
   */
  private rawBodyMiddleware(): ExpressHandler {
    const cap = this.maxBodyBytes;
    return async (req, res, next) => {
      const method = req.method.toUpperCase();
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
        req.rawBody = null; next(); return;
      }
      // A declared length over the cap is refused before a byte is read, the
      // way Hono and Fastify already refuse it — otherwise a client
      // announcing a gigabyte still gets `cap` bytes read and buffered first.
      const declaredLength = req.headers['content-length'];
      if (contentLengthExceeds(typeof declaredLength === 'string' ? declaredLength : undefined, cap)) {
        this.writeResponse(res, PAYLOAD_TOO_LARGE_RESPONSE);
        return;
      }
      try {
        const chunks: Buffer[] = [];
        let total = 0;
        const readable = req as unknown as NodeJS.ReadableStream;
        for await (const chunk of readable) {
          const buffer = chunk as Buffer;
          total += buffer.length;
          // The backstop for a chunked body, which declares no length.
          if (total > cap) {
            this.writeResponse(res, PAYLOAD_TOO_LARGE_RESPONSE);
            return;
          }
          chunks.push(buffer);
        }
        const merged = Buffer.concat(chunks, total);
        req.rawBody = new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength);
        next();
      } catch (e) {
        next(e);
      }
    };
  }

  private makeErrorMiddleware(): ExpressErrorHandler {
    return async (err, req, res, _next) => {
      this.applyDefaultResponseHeaders(res);
      const adapted = this.adaptRequest(req);
      if (this.errorHandler) {
        try {
          const out = await this.errorHandler(err, adapted);
          this.writeResponse(res, out);
          return;
        } catch (inner) {
          err = inner;
        }
      }
      if (err instanceof HttpError) {
        res.status(err.status).setHeader('content-type', 'application/json; charset=utf-8');
        if (err.headers) for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
        res.end(JSON.stringify({ error: err.message, ...err.extra }));
        return;
      }
      res.status(500).setHeader('content-type', 'application/json; charset=utf-8');
      // No `message` field — see the note on FastifyBackend.writeError.
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    };
  }

  private adaptRequest(req: ExpressRequestLike): HttpRequest {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value.join(',');
    }
    const body = req.rawBody ?? null;
    // Express's `req.ip` is the standard accessor — also honours
    // `app.set('trust proxy', ...)` when the operator has configured
    // it.  Fall back to the raw socket peer if `req.ip` isn't set
    // (test-double / barebones Express setup).
    const remoteAddress = req.ip ?? req.socket?.remoteAddress;
    return {
      method: req.method.toUpperCase() as HttpRequest['method'],
      path: req.path ?? req.url,
      headers,
      query: this.normaliseQuery(req.query),
      params: { ...req.params },
      body,
      ...(remoteAddress ? { remoteAddress } : {}),
    };
  }

  private normaliseQuery(raw: Record<string, unknown>): Record<string, string | string[] | undefined> {
    const out: Record<string, string | string[] | undefined> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'string') out[key] = value;
      else if (Array.isArray(value)) out[key] = value.map((x) => String(x));
      else out[key] = String(value);
    }
    return out;
  }

  /**
   * Write the server-wide defaults first — `setHeader` replaces (and matches
   * case-insensitively), so anything set afterwards overrides them.
   */
  private applyDefaultResponseHeaders(res: ExpressResponseLike): void {
    for (const [key, value] of Object.entries(this.defaultResponseHeaders)) res.setHeader(key, value);
  }

  private writeResponse(res: ExpressResponseLike, response: HttpResponse): void {
    res.status(response.status);
    this.applyDefaultResponseHeaders(res);
    if (response.headers) for (const [key, value] of Object.entries(response.headers)) res.setHeader(key, value);
    if (response.contentType) res.setHeader('content-type', response.contentType);

    const body = response.body;
    if (body === undefined || body === null) { res.end(); return; }
    if (typeof body === 'string') {
      if (!response.contentType && !response.headers?.['content-type']) {
        res.setHeader('content-type', 'text/plain; charset=utf-8');
      }
      res.end(body);
      return;
    }
    if (body instanceof Uint8Array) {
      if (!response.contentType) res.setHeader('content-type', 'application/octet-stream');
      res.end(body);
      return;
    }
    if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
      if (!response.contentType && !response.headers?.['content-type']) res.setHeader('content-type', 'application/octet-stream');
      Readable.fromWeb(body as unknown as Parameters<typeof Readable.fromWeb>[0]).pipe(res as unknown as NodeJS.WritableStream);
      return;
    }
    // Plain object → JSON.
    if (!response.contentType) res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  }

  private async createExpressApp(): Promise<ExpressAppLike> {
    if (!this.ownsApp) throw new Error('ExpressBackend: app was not injected but ownsApp=false');
    try {
      const moduleName = 'express';
      const mod = (await import(moduleName)) as { default?: () => ExpressAppLike } | (() => ExpressAppLike);
      // Express v4 ships `module.exports = factory`; v5 exports `{ default: factory }`.
      const factory: () => ExpressAppLike =
        typeof mod === 'function' ? mod as () => ExpressAppLike
        : (mod as { default: () => ExpressAppLike }).default;
      return factory();
    } catch (e) {
      throw new Error(
        'ExpressBackend requires the "express" package.  Install it with: '
        + 'bun add express\nOriginal error: ' + (e instanceof Error ? e.message : String(e)),
      );
    }
  }
}
