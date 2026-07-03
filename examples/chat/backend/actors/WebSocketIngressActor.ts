/**
 * WebSocket ingress hub.  Bound to `/ws` with `websocket('/ws', ref)`.
 *
 * One hub handles every connection on the route; for each accepted
 * connection it spawns a {@link UserSessionActor} that owns that
 * client's protocol state, and forwards raw frames to it.  The session
 * writes back through the connection ref.  This keeps the sample's
 * one-actor-per-connection design while using the typed routing DSL —
 * the framework solves the first-frame race for us, so the manual
 * synchronous-listener dance in the old Fastify plugin is gone.
 *
 * The hub uses `rawCodec()` (see routes.ts) so `TOut`/`TIn` are raw
 * frames: the chat wire protocol is JSON-over-text and the session
 * actor already does its own encode/decode via `shared/protocol.ts`.
 */
import {
  Props,
  type ActorRef,
} from '../../../../src/index.js';
import { WebSocketServerActor } from '../../../../src/http/ws/WebSocketServerActor.js';
import type { WsConnection } from '../../../../src/http/ws/WsConnection.js';
import type { WsFrame } from '../../../../src/http/ws/types.js';
import type { Subscribe, Unsubscribe } from '../../../../src/cluster/pubsub/Messages.js';
import {
  UserSessionActor,
  type InboundFrame,
  type SocketClosed,
} from './UserSessionActor.js';
import type { ChatRoomCmd } from './ChatRoomActor.js';
import type { ChatRoomDirectoryCmd } from './ChatRoomDirectoryActor.js';
import type { DmChannelCmd } from './DmChannelActor.js';
import type { OnlineUsersCmd } from './OnlineUsersActor.js';
import type { ReadReceiptsCmd } from './ReadReceiptsActor.js';
import type { SessionStore } from '../auth/sessionStore.js';

export interface WebSocketIngressDeps {
  readonly chatRoomRegion: ActorRef<ChatRoomCmd>;
  readonly dmChannelRegion: ActorRef<DmChannelCmd>;
  readonly onlineUsers: ActorRef<OnlineUsersCmd>;
  readonly mediator: ActorRef<Subscribe | Unsubscribe>;
  readonly sessions: SessionStore;
  readonly roomDirectory: ActorRef<ChatRoomDirectoryCmd>;
  readonly readReceipts: ActorRef<ReadReceiptsCmd>;
}

type SessionRef = ActorRef<InboundFrame | SocketClosed>;

export class WebSocketIngressActor extends WebSocketServerActor<WsFrame, WsFrame> {
  private readonly sessions = new Map<string, SessionRef>();

  constructor(private readonly deps: WebSocketIngressDeps) {
    super();
  }

  override onMessage(frame: WsFrame): void {
    this.sessions.get(this.connection.id)?.tell(frame);
  }

  protected override onClientConnected(c: WsConnection<WsFrame>): void {
    const connection = {
      sendText: (text: string) => c.sendRaw({ kind: 'text', data: text }),
      close: () => c.close(),
    };
    const session = this.context.spawn(
      Props.create(() => new UserSessionActor({ connection, ...this.deps })),
      `chat-session-${c.id}`,
    ) as unknown as SessionRef;
    this.sessions.set(c.id, session);
  }

  protected override onClientDisconnected(c: WsConnection<WsFrame>): void {
    const session = this.sessions.get(c.id);
    if (session) {
      session.tell({ kind: 'socket-closed' });
      this.sessions.delete(c.id);
    }
  }
}

export function webSocketIngressProps(deps: WebSocketIngressDeps): Props<never> {
  return Props.create(() => new WebSocketIngressActor(deps)) as unknown as Props<never>;
}
