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
import { WebsocketServerActor } from '../../../../src/http/websocket/WebsocketServerActor.js';
import type { WebsocketConnection } from '../../../../src/http/websocket/WebsocketConnection.js';
import type { WebsocketFrame } from '../../../../src/http/websocket/types.js';
import type { Publish, Subscribe, Unsubscribe } from '../../../../src/cluster/pubsub/Messages.js';
import {
  VoiceSessionActor,
  type InboundFrame,
  type SocketClosed,
} from './VoiceSessionActor.js';
import type { VoicePresenceCmd } from './VoicePresenceActor.js';
import type { SessionStore } from '../auth/sessionStore.js';

export interface VoiceWebsocketIngressDeps {
  readonly receptionist: ActorRef<unknown>;
  readonly mediator: ActorRef<Subscribe | Unsubscribe | Publish<unknown>>;
  readonly voicePresence: ActorRef<VoicePresenceCmd>;
  readonly sessions: SessionStore;
}

type SessionRef = ActorRef<InboundFrame | SocketClosed>;

export class WebsocketIngressActor extends WebsocketServerActor<WebsocketFrame, WebsocketFrame> {
  private readonly sessions = new Map<string, SessionRef>();

  constructor(private readonly deps: VoiceWebsocketIngressDeps) {
    super();
  }

  override onMessage(frame: WebsocketFrame): void {
    this.sessions.get(this.connection.id)?.tell(frame);
  }

  protected override onClientConnected(c: WebsocketConnection<WebsocketFrame>): void {
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

  protected override onClientDisconnected(c: WebsocketConnection<WebsocketFrame>): void {
    const session = this.sessions.get(c.id);
    if (session) {
      session.tell({ kind: 'socket-closed' });
      this.sessions.delete(c.id);
    }
  }
}
