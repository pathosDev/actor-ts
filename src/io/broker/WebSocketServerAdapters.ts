import type { ActorRef } from '../../ActorRef.js';
import type { ActorSystem } from '../../ActorSystem.js';
import { Props } from '../../Props.js';
import {
  ServerWebSocketActor,
  type ServerWebSocketActorOptions,
  type ServerWebSocketLike,
  type WebSocketCmd,
  type WebSocketFrame,
} from './ServerWebSocketActor.js';

/**
 * Backend adapters for {@link ServerWebSocketActor} (#1) — the bits
 * that make a server-side WebSocket from `Bun.serve`, the `ws`
 * package, or `@fastify/websocket` look like the
 * `ServerWebSocketLike` shape the actor expects.
 *
 * The `ws`-package family (used by `@fastify/websocket`,
 * `@hono/node-ws`, plain `new WebSocketServer({ ... })`) already
 * exposes a W3C-compatible `addEventListener` interface, so those
 * sockets can be handed straight to `ServerWebSocketActor` —
 * `serverWebSocketActorOf(system, socket, opts)` is the convenience
 * spawn for that case.
 *
 * Bun's native `ServerWebSocket` uses callback-style handlers
 * configured at server-construction time (`Bun.serve({ websocket:
 * { open, message, close } })`).  `bunWebSocketHandlers` adapts that
 * style to our event-listener shape and returns the four
 * callbacks pre-wired so each new connection spins up its own
 * actor.
 */

/* ------------------- generic / ws-package adapter --------------------- */

/**
 * Spawn a {@link ServerWebSocketActor} bound to an already-upgraded
 * socket.  Use this from a Fastify-websocket handler:
 *
 *   fastify.register(import('@fastify/websocket'));
 *   fastify.get('/ws', { websocket: true }, (conn, _req) => {
 *     const ref = serverWebSocketActorOf(system, conn.socket, {
 *       target: chatRoom,
 *       name: () => `ws-${nextId()}`,
 *     });
 *     chatRoom.tell({ kind: 'join', client: ref });
 *   });
 *
 * `socket` must satisfy {@link ServerWebSocketLike} — Fastify's
 * `conn.socket`, the `ws` package's `WebSocket`, and Hono's
 * Node-WS-bound socket all do.
 */
export function serverWebSocketActorOf(
  system: ActorSystem,
  socket: ServerWebSocketLike,
  opts: ServerWebSocketActorOptions & { readonly name?: string } = {},
): ActorRef<WebSocketCmd> {
  const { name, ...actorOpts } = opts;
  const props = Props.create(() => new ServerWebSocketActor(socket, actorOpts)) as Props<WebSocketCmd>;
  return name !== undefined ? system.spawn(props, name) : system.spawnAnonymous(props);
}

/* --------------------------- Bun adapter ------------------------------ */

/**
 * The minimum surface of a Bun `ServerWebSocket<T>` we depend on.
 * Bun's native type is generic over the per-connection `data` slot;
 * we typedef it loosely so the adapter compiles without a Bun-types
 * dependency.
 */
export interface BunServerWebSocketLike<T = unknown> {
  send(data: string | Uint8Array | ArrayBuffer): number;
  close(code?: number, reason?: string): void;
  data: T;
  readyState?: number;
}

/**
 * Internal shape stored in `ws.data` so each Bun.serve websocket
 * callback can look up the actor + adapter that drives the actor's
 * event listeners.
 */
export interface BunWebSocketSlot<UserData = unknown> {
  /** The bridge that translates Bun callbacks into addEventListener calls. */
  readonly bridge: BunWebSocketBridge;
  /** Per-connection actor reference returned to user code via `onOpen`. */
  readonly ref: ActorRef<WebSocketCmd>;
  /** Whatever per-connection state user code attached during upgrade. */
  readonly user: UserData;
}

/** Wrapper that captures listeners registered by the actor and
 *  exposes setter-callbacks the Bun handlers drive. */
class BunWebSocketBridge implements ServerWebSocketLike {
  private messageCb: ((ev: { data: unknown }) => void) | null = null;
  private closeCb: (() => void) | null = null;
  private errorCb: ((ev: unknown) => void) | null = null;

  constructor(private readonly ws: BunServerWebSocketLike) {}

  send(data: string | Uint8Array | ArrayBuffer): void { this.ws.send(data); }
  close(code?: number, reason?: string): void { this.ws.close(code, reason); }
  get readyState(): number | undefined { return this.ws.readyState; }

  addEventListener(event: 'message' | 'close' | 'error', cb: never): void {
    if (event === 'message') this.messageCb = cb;
    else if (event === 'close') this.closeCb = cb;
    else this.errorCb = cb;
  }

  removeEventListener(event: string): void {
    if (event === 'message') this.messageCb = null;
    else if (event === 'close') this.closeCb = null;
    else if (event === 'error') this.errorCb = null;
  }

  /* Driven by Bun.serve handlers. */
  deliverMessage(data: unknown): void { this.messageCb?.({ data }); }
  deliverClose(): void { this.closeCb?.(); }
  deliverError(ev: unknown): void { this.errorCb?.(ev); }
}

export interface BunWebSocketHandlerOptions<UserData = unknown> {
  /**
   * Per-connection setup.  Receives the freshly-spawned actor ref so
   * caller code can register it with chatrooms, persistence layers,
   * routers, etc.  The optional return value is forwarded as
   * `target` for the actor — handy if you build the target lazily
   * from the upgrade context (e.g. one room actor per URL path).
   */
  readonly onOpen?: (ws: BunServerWebSocketLike<BunWebSocketSlot<UserData>>, ref: ActorRef<WebSocketCmd>) => void;
  /** Per-connection cleanup.  Called after the actor has stopped. */
  readonly onClose?: (ws: BunServerWebSocketLike<BunWebSocketSlot<UserData>>, ref: ActorRef<WebSocketCmd>, code: number, reason: string) => void;
  /**
   * Static target for every actor spawned by this handler set.  If
   * omitted, callers register the per-connection target inside
   * `onOpen` via `ref.tell(...)` to a router that knows where to
   * forward.
   */
  readonly target?: ActorRef<WebSocketFrame>;
  /** Stop the actor when the bun socket closes.  Default true. */
  readonly stopOnSocketClose?: boolean;
  /** Custom actor name per connection.  Defaults to a counter. */
  readonly actorName?: (ws: BunServerWebSocketLike<BunWebSocketSlot<UserData>>) => string;
}

/**
 * Build the four `Bun.serve({ websocket: ... })` callbacks pre-wired
 * to spawn a `ServerWebSocketActor` per connection.  Pair with
 * `bunUpgrade(req, server, { initialUserData })` from your `fetch`
 * handler:
 *
 *   const wsHandlers = bunWebSocketHandlers(system, {
 *     target: chatRoom,
 *     onOpen:  (_ws, ref) => chatRoom.tell({ kind: 'join', client: ref }),
 *     onClose: (_ws, ref) => chatRoom.tell({ kind: 'leave', client: ref }),
 *   });
 *
 *   Bun.serve({
 *     port: 3000,
 *     fetch(req, server) {
 *       if (new URL(req.url).pathname === '/ws') {
 *         if (server.upgrade(req, { data: { user: 'alice' } })) return undefined;
 *         return new Response('upgrade failed', { status: 400 });
 *       }
 *       return new Response('not found', { status: 404 });
 *     },
 *     websocket: wsHandlers,
 *   });
 */
export function bunWebSocketHandlers<UserData = unknown>(
  system: ActorSystem,
  opts: BunWebSocketHandlerOptions<UserData> = {},
): {
  open(ws: BunServerWebSocketLike<UserData>): void;
  message(ws: BunServerWebSocketLike<BunWebSocketSlot<UserData>>, message: string | Buffer): void;
  close(ws: BunServerWebSocketLike<BunWebSocketSlot<UserData>>, code: number, reason: string): void;
  drain(ws: BunServerWebSocketLike<BunWebSocketSlot<UserData>>): void;
} {
  let counter = 0;
  return {
    open(ws): void {
      const bridge = new BunWebSocketBridge(ws);
      const slotName = opts.actorName?.(ws as BunServerWebSocketLike<BunWebSocketSlot<UserData>>)
        ?? `ws-${++counter}`;
      const ref = system.spawn(
        Props.create(() => new ServerWebSocketActor(bridge, {
          target: opts.target,
          stopOnSocketClose: opts.stopOnSocketClose,
        })) as Props<WebSocketCmd>,
        slotName,
      );
      // Stash the bridge + ref on the bun socket so subsequent
      // callbacks can find it.  The original user data is preserved
      // under `.user` for downstream code.
      const userData = ws.data as UserData;
      ws.data = { bridge, ref, user: userData } as unknown as UserData;
      try {
        opts.onOpen?.(ws as BunServerWebSocketLike<BunWebSocketSlot<UserData>>, ref);
      } catch (err) {
        system.log.warn('bunWebSocketHandlers.onOpen threw', err);
      }
    },

    message(ws, message): void {
      const slot = ws.data;
      if (!slot) return;
      // Bun delivers strings as-is and binary as Buffer (Uint8Array
      // subclass) — both pass through to the actor's frame
      // dispatcher unchanged.
      slot.bridge.deliverMessage(message);
    },

    close(ws, code, reason): void {
      const slot = ws.data;
      if (!slot) return;
      slot.bridge.deliverClose();
      try {
        opts.onClose?.(ws, slot.ref, code, reason);
      } catch (err) {
        system.log.warn('bunWebSocketHandlers.onClose threw', err);
      }
    },

    drain(_ws): void {
      // Backpressure hook — Bun calls this when the socket's send
      // buffer drains.  We don't queue at the actor layer, so this
      // is a no-op for v1.  Document so users know it's available.
    },
  };
}
