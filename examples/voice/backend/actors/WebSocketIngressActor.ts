/**
 * WebSocket ingress hub — voice variant.  Bound to `/ws` with
 * `websocket('/ws', ref)`.  One hub per route; it spawns a
 * {@link VoiceSessionActor} per connection and forwards raw frames
 * (text control + binary Opus) to it.  Uses `rawCodec()` so both frame
 * kinds pass through untouched — the session actor owns the wire format.
 */
import {
  Props,
  type ActorRef,
} from '../../../../src/index.js';
import { WebSocketServerActor } from '../../../../src/http/ws/WebSocketServerActor.js';
import type { WsConnection } from '../../../../src/http/ws/WsConnection.js';
import type { WsFrame } from '../../../../src/http/ws/types.js';
import type { Publish, Subscribe, Unsubscribe } from '../../../../src/cluster/pubsub/Messages.js';
import {
  VoiceSessionActor,
  type InboundFrame,
  type SocketClosed,
} from './VoiceSessionActor.js';
import type { VoicePresenceCmd } from './VoicePresenceActor.js';
import type { SessionStore } from '../auth/sessionStore.js';

export interface VoiceWebSocketIngressDeps {
  readonly receptionist: ActorRef<unknown>;
  readonly mediator: ActorRef<Subscribe | Unsubscribe | Publish<unknown>>;
  readonly voicePresence: ActorRef<VoicePresenceCmd>;
  readonly sessions: SessionStore;
}

type SessionRef = ActorRef<InboundFrame | SocketClosed>;

export class WebSocketIngressActor extends WebSocketServerActor<WsFrame, WsFrame> {
  private readonly sessions = new Map<string, SessionRef>();

  constructor(private readonly deps: VoiceWebSocketIngressDeps) {
    super();
  }

  override onMessage(frame: WsFrame): void {
    this.sessions.get(this.connection.id)?.tell(frame);
  }

  protected override onClientConnected(c: WsConnection<WsFrame>): void {
    const connection = {
      sendText: (text: string) => c.sendRaw({ kind: 'text', data: text }),
      sendBinary: (data: Uint8Array) => c.sendRaw({ kind: 'binary', data }),
      close: () => c.close(),
    };
    const session = this.context.spawn(
      Props.create(() => new VoiceSessionActor({ connection, ...this.deps })),
      `voice-session-${c.id}`,
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
