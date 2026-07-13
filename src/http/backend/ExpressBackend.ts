import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { Readable } from 'node:stream';
import { match } from 'ts-pattern';
import { Lazy } from '../../util/Lazy.js';
import { HttpError, type HttpMethod, type HttpRequest, type HttpResponse } from '../types.js';
import { ExpressBackendOptionsValidator } from './ExpressBackendOptions.js';
import type { ExpressBackendOptions, ExpressBackendOptionsType } from './ExpressBackendOptions.js';
import type {
  HttpServerBackend,
  RouteRegistration,
  ServerBinding,
  WebsocketRouteRegistration,
} from './HttpServerBackend.js';
import { websocketPackageAdapter, type WebsocketPackageSocket } from '../websocket/SocketAdapter.js';
import { matchWebsocketPattern } from '../websocket/matchPattern.js';
import { writeRawHttpResponse } from '../websocket/rawResponse.js';

/** Minimal shape of the `ws` package's WebSocketServer (noServer mode). */
interface WebsocketServerLike {
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    cb: (ws: WebsocketPackageSocket) => void,
  ): void;
  emit(event: 'connection', ws: WebsocketPackageSocket, req: IncomingMessage): boolean;
  readonly clients?: Iterable<{ terminate?: () => void; close?: () => void }>;
}

// `ws` is an optional peer dep — lazy-import its WebSocketServer (cached).
const wsServerConstructorLazy: Lazy<Promise<new (opts: { noServer: boolean }) => WebsocketServerLike>> = Lazy.of(async () => {
  try {
    const name = 'ws';
    const mod = (await import(name)) as {
      WebSocketServer?: new (opts: { noServer: boolean }) => WebsocketServerLike;
      default?: { WebSocketServer?: new (opts: { noServer: boolean }) => WebsocketServerLike };
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
interface ExpressRequestLike {
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
}

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
 * Subset of the Express app API we touch.  Covers v4 and v5.  Paths accept
 * a RegExp as well as a string: a trailing-`*` wildcard route registers as
 * a RegExp so it works identically on Express 4 and 5 (v5's path-to-regexp
 * rejects a bare string `*`).
 */
export interface ExpressAppLike {
  get(path: string | RegExp, handler: ExpressHandler): void;
  post(path: string | RegExp, handler: ExpressHandler): void;
  put(path: string | RegExp, handler: ExpressHandler): void;
  delete(path: string | RegExp, handler: ExpressHandler): void;
  patch(path: string | RegExp, handler: ExpressHandler): void;
  head(path: string | RegExp, handler: ExpressHandler): void;
  options(path: string | RegExp, handler: ExpressHandler): void;
  use(mw: ExpressHandler | ExpressErrorHandler): void;
  listen(port: number, hostname: string, cb: (err?: Error) => void): Server;
}

/**
 * Express-backed HTTP backend — drop-in alternative to the Fastify
 * default.  Intended for teams that already have an Express-based plugin
 * ecosystem (session stores, auth, observability) they want to reuse.
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
  private readonly maxBodyBytes: number;
  private readonly registered: RouteRegistration[] = [];
  private readonly wsRegistered: WebsocketRouteRegistration[] = [];
  private wss: WebsocketServerLike | null = null;
  private notFoundHandler: ((req: HttpRequest) => Promise<HttpResponse> | HttpResponse) | null = null;
  private errorHandler: ((err: unknown, req: HttpRequest) => Promise<HttpResponse> | HttpResponse) | null = null;

  constructor(options: ExpressBackendOptions = {}) {
    const resolvedOptions = (options as ExpressBackendOptionsType);
    new ExpressBackendOptionsValidator().validate(resolvedOptions);
    this.app = resolvedOptions.app ?? null;
    this.ownsApp = resolvedOptions.app == null;
    this.maxBodyBytes = resolvedOptions.maxBodyBytes ?? 10 * 1024 * 1024;
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

  setNotFound(handler: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse): void {
    this.notFoundHandler = handler;
  }

  setErrorHandler(handler: (err: unknown, req: HttpRequest) => Promise<HttpResponse> | HttpResponse): void {
    this.errorHandler = handler;
  }

  async listen(host: string, port: number): Promise<ServerBinding> {
    if (!this.app) this.app = await this.createExpressApp();
    // Register our raw-body middleware first so routes see req.rawBody.
    this.app.use(this.rawBodyMiddleware());
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
      await this.attachUpgradeHandling(this.server);
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

  private async attachUpgradeHandling(server: Server): Promise<void> {
    const WebsocketServerConstructor = await wsServerConstructorLazy.get();
    const wss = new WebsocketServerConstructor({ noServer: true });
    this.wss = wss;
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        let hit: { reg: WebsocketRouteRegistration; params: Record<string, string> } | null = null;
        for (const reg of this.wsRegistered) {
          const params = matchWebsocketPattern(reg.pattern, url.pathname);
          if (params) { hit = { reg, params }; break; }
        }
        if (!hit) {
          writeRawHttpResponse(socket, { status: 404, body: 'Not Found' });
          return;
        }
        const adapted = this.adaptUpgradeRequest(req, url, hit.params);
        // Guard against the peer vanishing mid-authorize (unhandled
        // 'error' on the raw socket would otherwise crash the process).
        socket.on('error', () => { /* ignore */ });
        let reject: HttpResponse | null;
        try {
          reject = await hit.reg.authorize(adapted);
        } catch {
          reject = { status: 500, body: 'Internal Server Error' };
        }
        if (reject) {
          writeRawHttpResponse(socket, reject);
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          // Keep wss.clients populated so the unbind terminate-walk works.
          wss.emit('connection', ws, req);
          hit!.reg.onConnection(adapted, websocketPackageAdapter(ws, { remoteAddress: adapted.remoteAddress }));
        });
      })();
    });
  }

  private adaptUpgradeRequest(req: IncomingMessage, url: URL, params: Record<string, string>): HttpRequest {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value.join(',');
    }
    const query: Record<string, string | string[] | undefined> = {};
    for (const key of new Set(url.searchParams.keys())) {
      const all = url.searchParams.getAll(key);
      query[key] = all.length > 1 ? all : all[0];
    }
    const remoteAddress = req.socket?.remoteAddress;
    return {
      method: 'GET',
      path: url.pathname,
      headers,
      query,
      params,
      body: null,
      ...(remoteAddress ? { remoteAddress } : {}),
    };
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
        const finalReq = wildcard
          ? { ...adapted, params: { ...adapted.params, '*': (req.params as Record<string, string>)['0'] ?? '' } }
          : adapted;
        const out = await route.handler(finalReq);
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
      try {
        const chunks: Buffer[] = [];
        let total = 0;
        const readable = req as unknown as NodeJS.ReadableStream;
        for await (const chunk of readable) {
          const buf = chunk as Buffer;
          total += buf.length;
          if (total > cap) {
            res.status(413).setHeader('content-type', 'text/plain; charset=utf-8');
            res.end('Payload Too Large');
            return;
          }
          chunks.push(buf);
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
      res.end(JSON.stringify({ error: 'Internal Server Error', message: (err as Error)?.message ?? String(err) }));
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

  private writeResponse(res: ExpressResponseLike, response: HttpResponse): void {
    res.status(response.status);
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
      // Express v4 ships `module.exports = fn`; v5 exports `{ default: fn }`.
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
