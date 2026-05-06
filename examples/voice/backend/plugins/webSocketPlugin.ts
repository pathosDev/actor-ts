/**
 * Voice variant of the chat sample's `webSocketPlugin.ts`.  Same
 * two-stage shape (top-level `@fastify/websocket` plus a nested
 * route plugin), same race-free synchronous-listener pattern.
 * Only difference: the spawned actor is `VoiceSessionActor`, and
 * its dep struct is voice-shaped.
 *
 * The chat plugin already routed binary frames into the session
 * actor's mailbox as `{ kind: 'binary', data: Uint8Array }` even
 * though the chat actor ignored them — we just keep that wire
 * shape and start handling it in `VoiceSessionActor.onClientBinary`.
 */
import type { FastifyPluginAsync } from 'fastify';
import {
  Props,
  type ActorRef,
  type ActorSystem,
} from '../../../../src/index.js';
import type { ServerWebSocketLike } from '../../../../src/io/broker/ServerWebSocketActor.js';
import type {
  Publish,
  Subscribe,
  Unsubscribe,
} from '../../../../src/cluster/pubsub/Messages.js';
import {
  VoiceSessionActor,
  type InboundFrame,
  type SocketClosed,
} from '../actors/VoiceSessionActor.js';
import type { VoicePresenceCmd } from '../actors/VoicePresenceActor.js';
import type { SessionStore } from '../auth/sessionStore.js';
import type { FastifyBackend } from '../../../../src/http/backend/FastifyBackend.js';

export interface WebSocketPluginOptions {
  readonly system: ActorSystem;
  readonly receptionist: ActorRef<unknown>;
  readonly mediator: ActorRef<Subscribe | Unsubscribe | Publish<unknown>>;
  readonly voicePresence: ActorRef<VoicePresenceCmd>;
  readonly sessions: SessionStore;
  readonly path?: string;
}

export async function registerWebSocketSupport(backend: FastifyBackend): Promise<void> {
  const wsMod = (await import('@fastify/websocket')) as {
    default?: unknown;
    fastifyWebsocket?: unknown;
  };
  const wsPlugin = wsMod.default ?? wsMod.fastifyWebsocket ?? wsMod;
  await backend.withPlugin(wsPlugin);
}

export const webSocketRoutePlugin: FastifyPluginAsync<WebSocketPluginOptions> = async (
  fastify,
  opts,
) => {
  let counter = 0;
  const wsPath = opts.path ?? '/ws';

  fastify.get(wsPath, { websocket: true }, (socket, _req) => {
    const id = ++counter;
    opts.system.log.info(`[ws] connection accepted (session ${id})`);

    const session: ActorRef<InboundFrame | SocketClosed> = opts.system.actorOf(
      Props.create(() =>
        new VoiceSessionActor({
          socket: socket as unknown as ServerWebSocketLike,
          receptionist: opts.receptionist,
          mediator: opts.mediator,
          voicePresence: opts.voicePresence,
          sessions: opts.sessions,
        }),
      ),
      `voice-session-${id}`,
    ) as unknown as ActorRef<InboundFrame | SocketClosed>;

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
