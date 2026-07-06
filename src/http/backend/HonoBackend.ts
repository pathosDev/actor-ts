import { match } from 'ts-pattern';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import {
  getHonoRunner,
  type HonoServerHandle,
  type HonoWebSocketBridge,
  type WSContextLike,
  type WSEventsLike,
} from '../../runtime/http/index.js';
import { HttpError, type HttpMethod, type HttpRequest, type HttpResponse } from '../types.js';
import type {
  HttpServerBackend,
  RouteRegistration,
  ServerBinding,
  WebSocketRouteRegistration,
} from './HttpServerBackend.js';
import type { WebSocketListeners, WebSocketSocketAdapter } from '../ws/SocketAdapter.js';

/** Hono delivers text as a string and binary as ArrayBuffer/Uint8Array. */
function coerceWsData(data: unknown): string | Uint8Array {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(0);
}

/*
 * Hono is an optional peer dependency — the structural types below describe
 * only the narrow slice of its API we touch, so projects that never touch
 * this backend don't have to pull it in just for TypeScript to resolve.
 * Users that *do* install Hono get full, typed access via `getApp()`.
 */

interface HonoContextLike {
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
}

type HonoHandler = (c: HonoContextLike) => Promise<Response> | Response;
type HonoErrorHandler = (err: unknown, c: HonoContextLike) => Promise<Response> | Response;
type HonoNotFoundHandler = (c: HonoContextLike) => Promise<Response> | Response;

/** Structural subset of the Hono app we consume. */
interface HonoAppLike {
  get(path: string, ...handlers: unknown[]): unknown;
  post(path: string, handler: HonoHandler): unknown;
  put(path: string, handler: HonoHandler): unknown;
  delete(path: string, handler: HonoHandler): unknown;
  patch(path: string, handler: HonoHandler): unknown;
  options(path: string, handler: HonoHandler): unknown;
  on(method: string, path: string, handler: HonoHandler): unknown;
  onError(handler: HonoErrorHandler): unknown;
  notFound(handler: HonoNotFoundHandler): unknown;
  fetch(request: Request): Promise<Response> | Response;
}

export interface HonoBackendSettings {
  /**
   * Bring-your-own Hono app — useful if you already registered middleware
   * (CORS, JWT, logger) before handing it off.  When omitted, we import
   * `hono` dynamically and build a fresh app on `listen()`.
   */
  readonly app?: HonoAppLike;
  /** Maximum allowed body size in bytes (default: 10 MiB).  Exceeding it returns 413. */
  readonly maxBodyBytes?: number;
}

/**
 * Fluent builder for {@link HonoBackendSettings}:
 *
 *     new HonoBackend(HonoBackendOptions.create().withMaxBodyBytes(1 << 20))
 */
export class HonoBackendOptions extends OptionsBuilder<HonoBackendSettings> {
  /** Start a fresh builder.  Equivalent to `new HonoBackendOptions()`. */
  static create(): HonoBackendOptions {
    return new HonoBackendOptions();
  }

  /** Bring-your-own Hono app (skips the internal `hono` import). */
  withApp(app: HonoAppLike): this {
    return this.set('app', app);
  }

  /** Maximum request body size in bytes.  Default 10 MiB; exceeding it returns 413. */
  withMaxBodyBytes(bytes: number): this {
    return this.set('maxBodyBytes', bytes);
  }
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
  private readonly wsRegistered: WebSocketRouteRegistration[] = [];
  private notFoundHandler: ((req: HttpRequest) => Promise<HttpResponse> | HttpResponse) | null = null;
  private errorHandler: ((err: unknown, req: HttpRequest) => Promise<HttpResponse> | HttpResponse) | null = null;

  // Runtime-neutral server handle; the per-runtime adapter supplies a
  // concrete implementation (Bun.serve / @hono/node-server / Deno.serve).
  private server: HonoServerHandle | null = null;

  constructor(options: HonoBackendOptions = HonoBackendOptions.create()) {
    const settings = options.build();
    this.app = settings.app ?? null;
    this.ownsApp = settings.app == null;
    this.maxBodyBytes = settings.maxBodyBytes ?? 10 * 1024 * 1024;
  }

  /** Inject / access the underlying Hono app — useful for native middleware. */
  getApp(): HonoAppLike {
    if (!this.app) throw new Error('HonoBackend: app not constructed yet — call listen() first or pass `{ app }` to the constructor.');
    return this.app;
  }

  registerRoute(route: RouteRegistration): void {
    this.registered.push(route);
  }

  registerWebSocket(reg: WebSocketRouteRegistration): void {
    if (this.wsRegistered.some((r) => r.pattern === reg.pattern)) {
      throw new Error(`HonoBackend: duplicate websocket route for pattern "${reg.pattern}".`);
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
    if (!this.app) this.app = await this.createHonoApp();
    const app = this.app;

    for (const r of this.registered) this.attachRoute(r);

    if (this.notFoundHandler) {
      const handler = this.notFoundHandler;
      app.notFound(async (c) => {
        const req = await this.adaptRequest(c);
        const res = await handler(req);
        return this.writeResponse(res);
      });
    }

    app.onError(async (err, c) => {
      const req = await this.adaptRequest(c);
      if (this.errorHandler) {
        try {
          const res = await this.errorHandler(err, req);
          return this.writeResponse(res);
        } catch (inner) { err = inner; }
      }
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: err.message, ...err.extra }), {
          status: err.status,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      return new Response(
        JSON.stringify({ error: 'Internal Server Error', message: (err as Error)?.message ?? String(err) }),
        { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } },
      );
    });

    const runner = await getHonoRunner();

    // WebSocket routes: obtain the per-runtime bridge, register each route
    // as a GET carrying the authorize guard + Hono's upgrade middleware,
    // and fold the bridge's serve options in (Bun needs `{ websocket }`).
    let bridge: HonoWebSocketBridge | null = null;
    if (this.wsRegistered.length > 0) {
      if (!runner.webSocket) {
        throw new Error('HonoBackend: this runtime\'s Hono runner does not support websocket() routes.');
      }
      bridge = await runner.webSocket(app);
      for (const reg of this.wsRegistered) this.attachWebSocketRoute(app, bridge, reg);
    }

    // Forward ALL args to app.fetch — Bun invokes fetch(request, server)
    // and Hono's WebSocket upgrade needs that second `server` argument to
    // call server.upgrade().  A single-arg wrapper would silently break
    // upgrades (HTTP still works, WS never opens).
    const appFetch = app.fetch as (...args: unknown[]) => Promise<Response> | Response;
    const server = await runner.serve({
      host,
      port,
      fetch: ((...args: unknown[]) => appFetch(...args)) as (request: Request) => Promise<Response> | Response,
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
              const t = setTimeout(() => resolve(), gracePeriodMs);
              (t as { unref?: () => void }).unref?.();
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

  private attachRoute(route: RouteRegistration): void {
    const app = this.app!;
    const handler: HonoHandler = async (c) => {
      const req = await this.adaptRequest(c);
      if (req.body && req.body.byteLength > this.maxBodyBytes) {
        return new Response('Payload Too Large', {
          status: 413,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
      const out = await route.handler(req);
      return this.writeResponse(out);
    };
    const method = route.method.toLowerCase() as Lowercase<HttpMethod>;
    match(method)
      .with('get',     () => app.get(route.pattern, handler))
      .with('post',    () => app.post(route.pattern, handler))
      .with('put',     () => app.put(route.pattern, handler))
      .with('delete',  () => app.delete(route.pattern, handler))
      .with('patch',   () => app.patch(route.pattern, handler))
      .with('head',    () => app.on('HEAD', route.pattern, handler))
      .with('options', () => app.options(route.pattern, handler))
      .exhaustive();
  }

  private attachWebSocketRoute(app: HonoAppLike, bridge: HonoWebSocketBridge, reg: WebSocketRouteRegistration): void {
    // Guard middleware runs the authorize check against the upgrade
    // request; returning a Response short-circuits (no upgrade).
    const guard = async (c: HonoContextLike, next: () => Promise<void>): Promise<Response | void> => {
      const res = await reg.authorize(this.adaptUpgradeContext(c));
      if (res) return this.writeResponse(res);
      await next();
    };

    const createEvents = (raw: unknown): WSEventsLike => {
      const c = raw as HonoContextLike;
      const adapted = this.adaptUpgradeContext(c);
      let ws: WSContextLike | null = null;
      let listeners: WebSocketListeners | null = null;
      // Frames that arrive before setListeners runs (defensive — Hono
      // dispatches onOpen before onMessage, but the buffer makes it
      // unconditional).
      const pending: Array<string | Uint8Array> = [];
      const adapter: WebSocketSocketAdapter = {
        send: (data) => ws?.send(data),
        close: (code, reason) => ws?.close(code, reason),
        setListeners: (l) => {
          listeners = l;
          const buffered = pending.splice(0);
          for (const d of buffered) l.onMessage(d);
        },
        get readyState() {
          return (ws?.readyState ?? 1) as 0 | 1 | 2 | 3;
        },
        remoteAddress: adapted.remoteAddress,
        get protocol() {
          return ws?.protocol;
        },
      };
      return {
        onOpen: (_evt, wsCtx) => {
          ws = wsCtx;
          reg.onConnection(adapted, adapter);
        },
        onMessage: (evt, wsCtx) => {
          ws = wsCtx;
          const d = coerceWsData(evt.data);
          if (listeners) listeners.onMessage(d);
          else pending.push(d);
        },
        onClose: (evt) => listeners?.onClose(evt.code ?? 1005, evt.reason ?? ''),
        onError: () => listeners?.onError(new Error('websocket error')),
      };
    };

    app.get(reg.pattern, guard, bridge.upgradeWebSocket(createEvents));
  }

  /** Synchronous upgrade-request snapshot (no body read — always GET). */
  private adaptUpgradeContext(c: HonoContextLike): HttpRequest {
    const headers = (c.req.header() as Record<string, string>) ?? {};
    let params: Record<string, string> = {};
    try {
      params = (c.req.param() as Record<string, string>) ?? {};
    } catch { /* no match — leave empty */ }
    const rawQueries = (c.req.queries() as Record<string, string[]>) ?? {};
    const query: Record<string, string | string[] | undefined> = {};
    for (const [k, v] of Object.entries(rawQueries)) {
      if (v) query[k] = v.length === 1 ? v[0] : v;
    }
    const remoteAddress = extractHonoRemoteAddress(c);
    return {
      method: 'GET',
      path: c.req.path ?? new URL(c.req.url).pathname,
      headers,
      query,
      params,
      body: null,
      ...(remoteAddress ? { remoteAddress } : {}),
    };
  }

  private async adaptRequest(c: HonoContextLike): Promise<HttpRequest> {
    const method = c.req.method.toUpperCase() as HttpRequest['method'];
    const headers = (c.req.header() as Record<string, string>) ?? {};

    // `c.req.param()` throws inside notFound / onError handlers because no
    // route matched — swallow that, an empty params object is the right
    // fallback there.
    let params: Record<string, string> = {};
    try {
      params = (c.req.param() as Record<string, string>) ?? {};
    } catch { /* no match — leave empty */ }

    // Hono returns queries as Record<string, string[]>; flatten single values.
    const rawQueries = (c.req.queries() as Record<string, string[]>) ?? {};
    const query: Record<string, string | string[] | undefined> = {};
    for (const [k, v] of Object.entries(rawQueries)) {
      if (!v) continue;
      query[k] = v.length === 1 ? v[0] : v;
    }

    let body: Uint8Array | null = null;
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const buf = await c.req.arrayBuffer();
      if (buf.byteLength > 0) body = new Uint8Array(buf);
    }

    const remoteAddress = extractHonoRemoteAddress(c);

    return {
      method,
      path: c.req.path ?? new URL(c.req.url).pathname,
      headers,
      query,
      params,
      body,
      ...(remoteAddress ? { remoteAddress } : {}),
    };
  }

  private writeResponse(res: HttpResponse): Response {
    const headers = new Headers();
    if (res.headers) for (const [k, v] of Object.entries(res.headers)) headers.set(k, v);
    if (res.contentType) headers.set('content-type', res.contentType);

    const body = res.body;
    if (body === undefined || body === null) return new Response(null, { status: res.status, headers });

    if (typeof body === 'string') {
      if (!headers.has('content-type')) headers.set('content-type', 'text/plain; charset=utf-8');
      return new Response(body, { status: res.status, headers });
    }
    if (body instanceof Uint8Array) {
      if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream');
      // Cast through BodyInit — the standard `Uint8Array<ArrayBufferLike>`
      // IS a valid Fetch body, but TypeScript 5.7+'s DOM types are not
      // (yet) parameterised that way, so the direct assignment errors.
      return new Response(body as unknown as BodyInit, { status: res.status, headers });
    }
    if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(body), { status: res.status, headers });
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

/**
 * Best-effort peer-IP extraction across Hono's adapter zoo.  Tries
 * the well-known shapes (Node-server `c.req.raw.socket.remoteAddress`,
 * Bun `c.env.requestIP({ ... }).address`, Cloudflare `c.req.raw.cf.ip`),
 * returns `undefined` if none of them yield a string.  Consumers
 * that need a guaranteed IP must override `getClientIp` on
 * IpAllowlist or similar middlewares.
 */
function extractHonoRemoteAddress(c: HonoContextLike): string | undefined {
  // 1. @hono/node-server: c.req.raw is the Node IncomingMessage.
  const raw = c.req.raw as { socket?: { remoteAddress?: string } } | undefined;
  if (raw?.socket?.remoteAddress) return raw.socket.remoteAddress;

  // 2. Bun.serve via Hono: connection info lives on `c.env`.
  //    Bun's adapter exposes a `requestIP` callable.
  const env = c.env as
    | { requestIP?: (req: unknown) => { address?: string } | null; incoming?: { socket?: { remoteAddress?: string } } }
    | undefined;
  if (env?.requestIP && c.req.raw) {
    try {
      const info = env.requestIP(c.req.raw);
      if (info?.address) return info.address;
    } catch { /* runtime didn't accept the raw shape — fall through */ }
  }

  // 3. Some adapters (e.g. Vercel) put the connection info on env.incoming.
  if (env?.incoming?.socket?.remoteAddress) return env.incoming.socket.remoteAddress;

  return undefined;
}
