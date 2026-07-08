import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { HttpError, type HttpRequest, type HttpResponse } from '../types.js';
import type {
  HttpServerBackend,
  RouteRegistration,
  ServerBinding,
  WebsocketRouteRegistration,
} from './HttpServerBackend.js';
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

  constructor(opts: object = { logger: false }) {
    this.app = (Fastify as (o?: object) => FastifyLike)(opts);
    // Route EVERY content-type through a raw-buffer parser — we want the
    // bytes to reach the DSL unparsed so user code picks the decoder via
    // pickRequestSerializer.  Fastify's built-in JSON parser would steal
    // `application/json` bodies otherwise.
    const rawParser = (_req: unknown, body: unknown, done: (err: Error | null, v: unknown) => void) => done(null, body);
    this.app.removeContentTypeParser(['application/json', 'text/plain']);
    this.app.addContentTypeParser('*', { parseAs: 'buffer' }, rawParser);
    this.app.addContentTypeParser('application/json', { parseAs: 'buffer' }, rawParser);
    this.app.addContentTypeParser('application/cbor', { parseAs: 'buffer' }, rawParser);
  }

  /** Escape hatch: register a native Fastify plugin (e.g. @fastify/cors). */
  async withPlugin(plugin: unknown, options?: object): Promise<void> {
    await (this.app as { register: (p: unknown, o?: object) => Promise<void> }).register(plugin, options);
  }

  registerRoute(route: RouteRegistration): void {
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
          this.writeError(reply, err);
        }
      },
    });
  }

  registerWebSocket(reg: WebsocketRouteRegistration): void {
    if (this.wsRegistered.some((r) => r.pattern === reg.pattern)) {
      throw new Error(`FastifyBackend: duplicate websocket route for pattern "${reg.pattern}".`);
    }
    this.wsRegistered.push(reg);
  }

  setNotFound(handler: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse): void {
    this.app.setNotFoundHandler(async (req: FastifyRequest, reply: FastifyReply) => {
      const adapted = this.adaptRequest(req);
      const res = await handler(adapted);
      this.writeResponse(reply, res);
    });
  }

  setErrorHandler(handler: (err: unknown, req: HttpRequest) => Promise<HttpResponse> | HttpResponse): void {
    this.app.setErrorHandler(async (err: unknown, req: FastifyRequest, reply: FastifyReply) => {
      const adapted = this.adaptRequest(req);
      const res = await handler(err, adapted);
      this.writeResponse(reply, res);
    });
  }

  async listen(host: string, port: number): Promise<ServerBinding> {
    if (this.wsRegistered.length > 0) {
      const plugin = await fastifyWebsocketLazy.get();
      // Await the register so the plugin's onRoute hook is installed
      // before we add the ws routes below.  (Awaiting does NOT lock the
      // route tree — routes can still be added after.)
      await (this.app as { register: (p: unknown, o?: object) => Promise<unknown> }).register(plugin);
      for (const reg of this.wsRegistered) this.attachWebsocketRoute(reg);
    }
    const address = await this.app.listen({ host, port });
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
            const t = setTimeout(resolve, 1000);
            (t as { unref?: () => void }).unref?.();
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
          const res = await reg.authorize(this.adaptRequest(req));
          if (res) this.writeResponse(reply, res);
        },
      },
      (socket: WebsocketPackageSocket, req: FastifyRequest) => {
        const adapted = this.adaptRequest(req);
        reg.onConnection(adapted, websocketPackageAdapter(socket, { remoteAddress: adapted.remoteAddress }));
      },
    );
  }

  /* -------------------------------- Helpers ------------------------------- */

  private adaptRequest(req: FastifyRequest): HttpRequest {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k] = v;
      else if (Array.isArray(v)) headers[k] = v.join(',');
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
    return {
      method: (req.method as HttpRequest['method']),
      path: req.url,
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

  private writeResponse(reply: FastifyReply, res: HttpResponse): void {
    reply.status(res.status);
    if (res.headers) for (const [k, v] of Object.entries(res.headers)) reply.header(k, v);
    if (res.contentType) reply.header('content-type', res.contentType);
    if (res.body === undefined || res.body === null) {
      reply.send();
      return;
    }
    if (typeof res.body === 'string') {
      if (!res.contentType && !res.headers?.['content-type']) reply.header('content-type', 'text/plain; charset=utf-8');
      reply.send(res.body);
      return;
    }
    if (res.body instanceof Uint8Array) {
      if (!res.contentType) reply.header('content-type', 'application/octet-stream');
      reply.send(Buffer.from(res.body));
      return;
    }
    // Plain object → JSON.
    if (!res.contentType) reply.header('content-type', 'application/json; charset=utf-8');
    reply.send(JSON.stringify(res.body));
  }

  private writeError(reply: FastifyReply, err: unknown): void {
    if (err instanceof HttpError) {
      reply.status(err.status).send({ error: err.message, ...err.extra });
      return;
    }
    reply.status(500).send({ error: 'Internal Server Error', message: (err as Error)?.message });
  }
}
