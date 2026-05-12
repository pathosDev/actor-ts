/**
 * Fastify plugin that:
 *
 *   1. Registers `@fastify/websocket` so Fastify can upgrade
 *      `Connection: Upgrade` requests.
 *   2. Adds a single `GET /ws` route.  Every accepted upgrade spawns
 *      a `UserSessionActor` that owns the connection from there on.
 *
 * Wiring this as a *plugin* (rather than calling `fastify.register`
 * + `fastify.get` from `main.ts`) keeps `main.ts` framework-agnostic
 * — it only sees the actor-ts `HttpExtension` + `FastifyBackend.withPlugin`
 * surface.  All Fastify-specific code lives here.
 *
 * Plugin options (passed through `backend.withPlugin(plugin, opts)`):
 *
 *   - `system`         the ActorSystem that hosts session actors
 *   - `chatRoomRegion` ref to the sharded ChatRoomActor region
 *   - `onlineUsers`    ref to the local OnlineUsersActor
 *   - `mediator`       ref to the local DistributedPubSub mediator
 *   - `path`           override for `/ws` (rarely useful)
 */
import type { FastifyPluginAsync } from 'fastify';
import {
  Props,
  type ActorRef,
  type ActorSystem,
} from '../../../../src/index.js';
import type { ServerWebSocketLike } from '../../../../src/io/broker/ServerWebSocketActor.js';
import type {
  Subscribe,
  Unsubscribe,
} from '../../../../src/cluster/pubsub/Messages.js';
import {
  UserSessionActor,
  type InboundFrame,
  type SocketClosed,
} from '../actors/UserSessionActor.js';
import type { ChatRoomCmd } from '../actors/ChatRoomActor.js';
import type { ChatRoomDirectoryCmd } from '../actors/ChatRoomDirectoryActor.js';
import type { DmChannelCmd } from '../actors/DmChannelActor.js';
import type { OnlineUsersCmd } from '../actors/OnlineUsersActor.js';
import type { ReadReceiptsCmd } from '../actors/ReadReceiptsActor.js';
import type { SessionStore } from '../auth/sessionStore.js';

export interface WebSocketPluginOptions {
  readonly system: ActorSystem;
  readonly chatRoomRegion: ActorRef<ChatRoomCmd>;
  readonly dmChannelRegion: ActorRef<DmChannelCmd>;
  readonly onlineUsers: ActorRef<OnlineUsersCmd>;
  readonly mediator: ActorRef<Subscribe | Unsubscribe>;
  readonly sessions: SessionStore;
  readonly roomDirectory: ActorRef<ChatRoomDirectoryCmd>;
  readonly readReceipts: ActorRef<ReadReceiptsCmd>;
  readonly path?: string;
}

/**
 * Two-stage registration to avoid Fastify's plugin encapsulation:
 *
 *   1. `registerWebSocketSupport(backend)` adds `@fastify/websocket`
 *      at the top level of the Fastify instance.  Must run before
 *      step 2.  Done from `main.ts` via `backend.withPlugin(...)`.
 *
 *   2. `webSocketRoutePlugin(opts)` adds the actual `GET /ws` route
 *      that uses `{ websocket: true }`.  Because `@fastify/websocket`
 *      was registered at the parent scope in step 1, this nested
 *      plugin can attach the route without re-registering.
 *
 * If we tried to combine both into a single inner plugin, Fastify's
 * encapsulation would drop the websocket route option once the
 * registration completes — the route would behave like a normal HTTP
 * GET and never trigger the upgrade.
 *
 * **Why attach `socket.on('message', ...)` here, not inside the
 * actor?**  The actor system's `actorOf` returns an `ActorRef`
 * synchronously but defers `preStart` to a later mailbox tick.  In
 * that small window between Fastify accepting the upgrade and the
 * actor's preStart running, the client's first frame (the `login`)
 * is delivered to the raw socket and dropped because no listener is
 * attached yet.  Attaching the listener here, **synchronously inside
 * the route handler**, eliminates the race: messages received before
 * the actor is ready are buffered and replayed on spawn-completion.
 */
import type { FastifyBackend } from '../../../../src/http/backend/FastifyBackend.js';

export async function registerWebSocketSupport(backend: FastifyBackend): Promise<void> {
  const wsMod = (await import('@fastify/websocket')) as {
    default?: unknown;
    fastifyWebsocket?: unknown;
  };
  const wsPlugin = wsMod.default ?? wsMod.fastifyWebsocket ?? wsMod;
  await backend.withPlugin(wsPlugin);
}

/**
 * Plugin that adds the `/ws` route.  Pre-condition: caller has
 * already called {@link registerWebSocketSupport} on the same
 * backend so `{ websocket: true }` is wired up.
 */
export const webSocketRoutePlugin: FastifyPluginAsync<WebSocketPluginOptions> = async (
  fastify,
  opts,
) => {
  let counter = 0;
  const wsPath = opts.path ?? '/ws';

  fastify.get(wsPath, { websocket: true }, (socket, _req) => {
    const id = ++counter;
    opts.system.log.info(`[ws] connection accepted (session ${id})`);

    // -- 1. Spawn the session actor.  `actorOf` returns synchronously;
    //       the actor's mailbox queues messages we tell it before
    //       its `preStart` runs, so we can safely forward right away.
    const session: ActorRef<InboundFrame | SocketClosed> = opts.system.actorOf(
      Props.create(() =>
        new UserSessionActor({
          socket: socket as unknown as ServerWebSocketLike,
          chatRoomRegion: opts.chatRoomRegion,
          dmChannelRegion: opts.dmChannelRegion,
          onlineUsers: opts.onlineUsers,
          mediator: opts.mediator,
          sessions: opts.sessions,
          roomDirectory: opts.roomDirectory,
          readReceipts: opts.readReceipts,
        }),
      ),
      `chat-session-${id}`,
    ) as unknown as ActorRef<InboundFrame | SocketClosed>;

    // -- 2. Attach the inbound listener synchronously.  Anything
    //       received from now on goes into the actor's mailbox and is
    //       processed in order after preStart.
    socket.on('message', (raw: Buffer | string, isBinary?: boolean) => {
      if (isBinary) {
        const data = raw instanceof Buffer
          ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
          : new Uint8Array();
        session.tell({ kind: 'binary', data });
      } else {
        const data = typeof raw === 'string' ? raw : raw.toString('utf-8');
        session.tell({ kind: 'text', data });
      }
    });

    socket.on('close', () => {
      session.tell({ kind: 'socket-closed' });
    });

    socket.on('error', (e: Error) => {
      opts.system.log.warn(`[ws] socket ${id} error: ${e.message}`);
    });
  });
};

export default webSocketRoutePlugin;
