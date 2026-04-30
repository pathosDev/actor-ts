/**
 * One actor per WebSocket connection.  Inbound frames are pushed
 * into the actor by a synchronous `socket.on('message', ...)`
 * listener that the route handler attaches immediately on accept —
 * see `plugins/webSocketPlugin.ts`.  Outbound is direct
 * `socket.send(...)` from the actor's `sendServer` helper.
 *
 * **Why not wrap the socket in a ServerWebSocketActor child?**
 * Because actor instantiation in this framework is async (the
 * actor's `preStart` runs on the actor mailbox, not synchronously
 * inside `actorOf`).  In the small window between Fastify accepting
 * the upgrade and the wrapper actor's `preStart` actually adding
 * listeners, the client's first frame (typically `login`) is
 * delivered to the raw socket and dropped because no listener is
 * attached yet.  Attaching the `socket.on('message', ...)` listener
 * in the Fastify handler — synchronously — closes that race.
 *
 * State machine: starts in `Unauthenticated` and stays there until
 * the client sends a `{ type: 'login', ... }` frame.  Anything else
 * before login is a protocol violation and triggers `stopSelf` →
 * `postStop` closes the socket.  A successful login transitions to
 * `Authenticated(username)` and triggers auto-join of every default
 * room (history replay + presence + pubsub subscription).
 *
 * Mailbox is a tagged union of:
 *   - `{ kind: 'text' | 'binary', data }` from the route-attached listener.
 *   - `{ kind: 'socket-closed' }` synthetic close signal.
 *   - `RoomBroadcast` from DistributedPubSub.
 *   - `HistoryReply` from a sharded `ChatRoomActor`.
 *   - `UsersChanged` from the local `OnlineUsersActor`.
 */
import { match } from 'ts-pattern';
import {
  Actor,
  type ActorRef,
} from '../../../../src/index.js';
import type { ServerWebSocketLike } from '../../../../src/io/broker/ServerWebSocketActor.js';
import { Subscribe, Unsubscribe } from '../../../../src/cluster/pubsub/Messages.js';
import {
  decodeClient,
  encodeServer,
  type ClientMessage,
  type ServerMessage,
} from '../../shared/protocol.js';
import { DEFAULT_ROOMS, isRoomName, type RoomName } from '../../shared/rooms.js';
import { validateCredentials } from '../auth/credentials.js';
import {
  chatRoomTopic,
  type ChatRoomCmd,
  type HistoryReply,
  type RoomBroadcast,
} from './ChatRoomActor.js';
import type {
  OnlineUsersCmd,
  UsersChanged,
} from './OnlineUsersActor.js';

/* --------------------------- mailbox shape --------------------------- */

/** Inbound frame from the route-attached listener. */
export type InboundFrame =
  | { readonly kind: 'text';   readonly data: string }
  | { readonly kind: 'binary'; readonly data: Uint8Array };

/** Synthetic close signal sent by the route handler when the socket closes. */
export interface SocketClosed { readonly kind: 'socket-closed' }

type SessionMsg =
  | InboundFrame
  | SocketClosed
  | RoomBroadcast
  | HistoryReply
  | UsersChanged;

/* --------------------------- public deps ---------------------------- */

export interface UserSessionDeps {
  readonly socket: ServerWebSocketLike;
  readonly chatRoomRegion: ActorRef<ChatRoomCmd>;
  readonly onlineUsers: ActorRef<OnlineUsersCmd>;
  readonly mediator: ActorRef<Subscribe | Unsubscribe>;
}

/* ------------------------------ actor ------------------------------- */

type Phase = 'Unauthenticated' | 'Authenticated';

export class UserSessionActor extends Actor<SessionMsg> {
  private phase: Phase = 'Unauthenticated';
  private username: string | null = null;
  private readonly joinedRooms = new Set<RoomName>();
  private currentRoom: RoomName | null = null;

  constructor(private readonly deps: UserSessionDeps) {
    super();
  }

  override postStop(): void {
    // Best-effort: announce departure for every room we'd announced
    // arrival for.  Mediator + OnlineUsersActor may already be
    // shutting down — `tell` is fire-and-forget either way.
    if (this.phase === 'Authenticated' && this.username) {
      for (const room of this.joinedRooms) {
        this.deps.mediator.tell(new Unsubscribe(chatRoomTopic(room), this.self as ActorRef));
        this.deps.onlineUsers.tell({
          kind: 'Unsubscribe',
          room,
          ref: this.self as ActorRef<UsersChanged>,
        });
        this.deps.onlineUsers.tell({
          kind: 'RemoveFromRoom',
          room,
          username: this.username,
        });
      }
    }
    this.joinedRooms.clear();
    // Idempotent close — the route handler may have already done it.
    try { this.deps.socket.close(); } catch { /* already closed */ }
  }

  override onReceive(msg: SessionMsg): void {
    match(msg)
      .with({ kind: 'text' }, (m) => this.onClientText(m.data))
      .with({ kind: 'binary' }, () => { /* binary frames are ignored */ })
      .with({ kind: 'socket-closed' }, () => this.context.stopSelf())
      .with({ kind: 'RoomBroadcast' }, (m) => this.onBroadcast(m))
      .with({ kind: 'HistoryReply' }, (m) => this.onHistory(m))
      .with({ kind: 'UsersChanged' }, (m) => this.onUsersChanged(m))
      .exhaustive();
  }

  /* ----------------------------- inbound ----------------------------- */

  private onClientText(raw: string): void {
    const cmd = decodeClient(raw);
    if (!cmd) {
      this.sendServer({ type: 'system', text: 'Invalid frame — JSON expected.' });
      return;
    }
    if (this.phase === 'Unauthenticated') {
      this.handleUnauthenticated(cmd);
      return;
    }
    this.handleAuthenticated(cmd);
  }

  private handleUnauthenticated(cmd: ClientMessage): void {
    if (cmd.type !== 'login') {
      this.sendServer({
        type: 'login-failed',
        reason: 'Login required as first frame',
      });
      this.context.stopSelf();
      return;
    }
    const user = validateCredentials(cmd.username, cmd.password);
    if (!user) {
      this.sendServer({ type: 'login-failed', reason: 'Invalid username or password' });
      this.context.stopSelf();
      return;
    }
    this.phase = 'Authenticated';
    this.username = user.username;
    this.sendServer({ type: 'logged-in', username: user.username });
    this.sendServer({ type: 'rooms', rooms: [...DEFAULT_ROOMS] });
    // Auto-join everything; clients can `leave` later if they want.
    for (const room of DEFAULT_ROOMS) {
      this.joinRoom(room);
    }
    this.currentRoom = DEFAULT_ROOMS[0]!;
  }

  private handleAuthenticated(cmd: ClientMessage): void {
    match(cmd)
      .with({ type: 'login' }, () => {
        // Re-login on an already-authenticated socket — silently ignore.
      })
      .with({ type: 'send' }, (m) => {
        if (!isRoomName(m.room)) return;
        if (!this.joinedRooms.has(m.room)) return;
        const text = m.text.slice(0, 4096);
        if (text.length === 0) return;
        this.deps.chatRoomRegion.tell({
          kind: 'SendMsg',
          room: m.room,
          from: this.username!,
          text,
        });
      })
      .with({ type: 'join' }, (m) => {
        if (isRoomName(m.room)) this.joinRoom(m.room);
      })
      .with({ type: 'leave' }, (m) => {
        if (isRoomName(m.room)) this.leaveRoom(m.room);
      })
      .with({ type: 'switch-active-room' }, (m) => {
        if (isRoomName(m.room) && this.joinedRooms.has(m.room)) {
          this.currentRoom = m.room;
        }
      })
      .with({ type: 'ping' }, () => { /* keepalive — no-op server-side */ })
      .exhaustive();
  }

  private onBroadcast(msg: RoomBroadcast): void {
    // Forward as ServerMessage to the client.  Subscribers of
    // multiple rooms need the room field to demux on their side.
    this.sendServer({
      type: 'message',
      room: msg.room,
      from: msg.from,
      text: msg.text,
      ts: msg.ts,
    });
  }

  private onHistory(msg: HistoryReply): void {
    this.sendServer({
      type: 'history',
      room: msg.room,
      messages: msg.messages,
    });
  }

  private onUsersChanged(msg: UsersChanged): void {
    this.sendServer({
      type: 'users',
      room: msg.room,
      users: msg.users,
    });
  }

  /* ---------------------------- outgoing ----------------------------- */

  private sendServer(msg: ServerMessage): void {
    try {
      this.deps.socket.send(encodeServer(msg));
    } catch (e) {
      this.log.warn(`UserSession: send failed: ${(e as Error).message}`);
    }
  }

  /* ---------------------------- room mgmt ---------------------------- */

  private joinRoom(room: RoomName): void {
    if (this.joinedRooms.has(room)) return;
    this.joinedRooms.add(room);

    // Subscribe ourselves to the room's pubsub topic.
    this.deps.mediator.tell(
      new Subscribe(chatRoomTopic(room), this.self as ActorRef),
    );

    // Track presence in DistributedData + listen for changes.
    this.deps.onlineUsers.tell({
      kind: 'AddToRoom',
      room,
      username: this.username!,
    });
    this.deps.onlineUsers.tell({
      kind: 'Subscribe',
      room,
      ref: this.self as ActorRef<UsersChanged>,
    });

    // Pull the recent history from the sharded entity.
    this.deps.chatRoomRegion.tell({
      kind: 'GetHistory',
      room,
      limit: 50,
      replyTo: this.self as ActorRef<HistoryReply>,
    });
  }

  private leaveRoom(room: RoomName): void {
    if (!this.joinedRooms.delete(room)) return;
    this.deps.mediator.tell(
      new Unsubscribe(chatRoomTopic(room), this.self as ActorRef),
    );
    this.deps.onlineUsers.tell({
      kind: 'Unsubscribe',
      room,
      ref: this.self as ActorRef<UsersChanged>,
    });
    this.deps.onlineUsers.tell({
      kind: 'RemoveFromRoom',
      room,
      username: this.username!,
    });
    if (this.currentRoom === room) {
      this.currentRoom = this.joinedRooms.values().next().value ?? null;
    }
  }
}

/** Type alias for the mediator ref the plugin wires up.  Convenience. */
export type MediatorRef = ActorRef<Subscribe | Unsubscribe>;
