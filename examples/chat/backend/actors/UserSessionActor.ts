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
 *   - `RoomsChanged` / `RoomAdded` / `RoomRemoved` from the cluster-
 *     wide `ChatRoomDirectoryActor` — added in #98 so the client can
 *     react to runtime room creation by any user on any node.
 *   - `DmBroadcast` from the user's DM inbox topic
 *     (`chat.dm.user.<self>`) — added in #100.  Translated to
 *     `message` frames with `room = '@<other>'` so the client renders
 *     them as a virtual room without needing a new protocol frame.
 *   - `DmHistoryReply` from a sharded `DmChannelActor`, returned in
 *     response to the user opening a DM "room" for the first time.
 */
import { match } from 'ts-pattern';
import {
  Actor,
  type ActorRef,
} from '../../../../src/index.js';
import type { ServerWebSocketLike } from '../../../../src/io/broker/ServerWebSocketActor.js';
import { DistributedPubSubId } from '../../../../src/cluster/pubsub/index.js';
import { Publish, Subscribe, Unsubscribe } from '../../../../src/cluster/pubsub/Messages.js';
import {
  decodeClient,
  encodeServer,
  type ClientMessage,
  type ServerMessage,
} from '../../shared/protocol.js';
import {
  DEFAULT_ROOMS,
  dmCounterparty,
  dmRoomFor,
  isDmRoomName,
  isRoomName,
  type RoomName,
} from '../../shared/rooms.js';
import { canonicalPairId, dmInboxTopic } from '../../shared/dm.js';
import { validateCredentials } from '../auth/credentials.js';
import type { SessionStore } from '../auth/sessionStore.js';
import {
  chatRoomTopic,
  type ChatRoomCmd,
  type HistoryReply,
  type RoomBroadcast,
  type TypingBroadcast,
} from './ChatRoomActor.js';
import type {
  ChatRoomDirectoryCmd,
  RoomAdded,
  RoomRemoved,
  RoomsChanged,
} from './ChatRoomDirectoryActor.js';
import type {
  DmBroadcast,
  DmChannelCmd,
  DmHistoryReply,
} from './DmChannelActor.js';
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
  | UsersChanged
  | RoomsChanged
  | RoomAdded
  | RoomRemoved
  | DmBroadcast
  | DmHistoryReply
  | TypingBroadcast;

/* --------------------------- public deps ---------------------------- */

export interface UserSessionDeps {
  readonly socket: ServerWebSocketLike;
  readonly chatRoomRegion: ActorRef<ChatRoomCmd>;
  readonly dmChannelRegion: ActorRef<DmChannelCmd>;
  readonly onlineUsers: ActorRef<OnlineUsersCmd>;
  readonly mediator: ActorRef<Subscribe | Unsubscribe>;
  readonly sessions: SessionStore;
  readonly roomDirectory: ActorRef<ChatRoomDirectoryCmd>;
}

/* ------------------------------ actor ------------------------------- */

type Phase = 'Unauthenticated' | 'Authenticated';

export class UserSessionActor extends Actor<SessionMsg> {
  private phase: Phase = 'Unauthenticated';
  private username: string | null = null;
  /** Token issued for this session — set on login or accepted resume. */
  private token: string | null = null;
  private readonly joinedRooms = new Set<RoomName>();
  private readonly historyAskedRooms = new Set<RoomName>();
  /** DM "rooms" the client has opened (asked history for) at least
   *  once during this session.  Tracked separately because DMs share
   *  a single inbox subscription rather than per-channel pubsub —
   *  the set serves only to deduplicate history requests. */
  private readonly dmHistoryAskedRooms = new Set<RoomName>();
  private currentRoom: RoomName | null = null;
  /** Cache of the current cluster-wide room list; populated on activation. */
  private knownRooms: ReadonlyArray<RoomName> = [];

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
      // Also detach from the directory's per-session subscription.
      this.deps.roomDirectory.tell({
        kind: 'Unsubscribe',
        ref: this.self as ActorRef<RoomsChanged | RoomAdded | RoomRemoved>,
      });
      // And leave our DM inbox topic.  PubSub gossip eventually drops
      // the subscription when the actor dies, but doing it explicitly
      // shortens the window where DMs are queued for a dead inbox.
      this.deps.mediator.tell(
        new Unsubscribe(dmInboxTopic(this.username), this.self as ActorRef),
      );
    }
    this.joinedRooms.clear();
    this.dmHistoryAskedRooms.clear();
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
      .with({ kind: 'RoomsChanged' }, (m) => this.onRoomsChanged(m))
      .with({ kind: 'RoomAdded' },    (m) => this.onRoomAdded(m))
      .with({ kind: 'RoomRemoved' },  (m) => this.onRoomRemoved(m))
      .with({ kind: 'DmBroadcast' },     (m) => this.onDmBroadcast(m))
      .with({ kind: 'DmHistoryReply' },  (m) => this.onDmHistoryReply(m))
      .with({ kind: 'TypingBroadcast' }, (m) => this.onTypingBroadcast(m))
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
    if (cmd.type === 'login') {
      const user = validateCredentials(cmd.username, cmd.password);
      if (!user) {
        this.sendServer({ type: 'login-failed', reason: 'Invalid username or password' });
        this.context.stopSelf();
        return;
      }
      const token = this.deps.sessions.mintToken(user.username);
      this.activate(user.username, token);
      return;
    }

    if (cmd.type === 'resume') {
      const username = this.deps.sessions.lookupToken(cmd.token);
      if (!username) {
        // Unknown / expired / revoked token — tell the client so it
        // can clear its stored token and fall back to the credentials
        // form.  Don't stop the connection: the client may re-attempt
        // with `login` on the same socket.
        this.sendServer({ type: 'login-failed', reason: 'Session expired' });
        return;
      }
      // Reuse the same token — keep the client's storage stable.
      this.activate(username, cmd.token);
      return;
    }

    this.sendServer({
      type: 'login-failed',
      reason: 'Login required as first frame',
    });
    this.context.stopSelf();
  }

  /**
   * Move from `Unauthenticated` to `Authenticated`.  Sends
   * `logged-in` (with the session token the client should persist),
   * the room list, and the auto-join burst — same flow whether we
   * arrived here via fresh `login` or via `resume`.
   */
  private activate(username: string, token: string): void {
    this.phase = 'Authenticated';
    this.username = username;
    this.token = token;
    this.sendServer({ type: 'logged-in', username, token });
    // Subscribe to the cluster-wide room directory.  The directory
    // immediately replays its current set as a `RoomsChanged`
    // message — `onRoomsChanged` forwards that to the client as a
    // `rooms` ServerMessage.  We additionally send a synchronous
    // `rooms` frame with `DEFAULT_ROOMS` so clients that expect
    // ordering `logged-in` → `rooms` see something stable; the
    // directory's replay then refines that view if user-created
    // rooms exist.
    this.deps.roomDirectory.tell({
      kind: 'Subscribe',
      ref: this.self as ActorRef<RoomsChanged | RoomAdded | RoomRemoved>,
    });
    // Subscribe to our DM inbox topic.  Every DM addressed to this
    // user — incoming OR outgoing — arrives on this topic, so a
    // single subscription covers every DM conversation we ever take
    // part in.  No per-channel subscription bookkeeping needed.
    this.deps.mediator.tell(
      new Subscribe(dmInboxTopic(username), this.self as ActorRef),
    );
    this.sendServer({ type: 'rooms', rooms: [...DEFAULT_ROOMS] });
    // Auto-join every default room for presence + live messages, but
    // only fetch history for the room we're switching into first
    // (`general`).  Avoids a rapid burst of cross-shard ask-style
    // round trips at login time that races with the cluster's
    // initial shard-allocation phase.  History for the other rooms
    // loads on first room-switch instead.  User-created rooms are
    // not auto-joined — they're opt-in via an explicit `join` frame.
    for (const room of DEFAULT_ROOMS) {
      this.joinRoom(room, room === DEFAULT_ROOMS[0]);
    }
    this.currentRoom = DEFAULT_ROOMS[0]!;
  }

  private handleAuthenticated(cmd: ClientMessage): void {
    match(cmd)
      .with({ type: 'login' }, () => {
        // Re-login on an already-authenticated socket — silently ignore.
      })
      .with({ type: 'resume' }, () => {
        // Resume on an already-authenticated socket — silently ignore.
      })
      .with({ type: 'logout' }, () => {
        // Explicit log-out: revoke the session token so the cluster
        // forgets it (gossip propagates), then drop the connection.
        // The client's storage cleanup happens locally on its side.
        if (this.token) this.deps.sessions.revokeToken(this.token);
        this.token = null;
        this.context.stopSelf();
      })
      .with({ type: 'send' }, (m) => {
        if (!isRoomName(m.room)) return;
        const text = m.text.slice(0, 4096);
        if (text.length === 0) return;
        // DMs ride on the same `send` frame but get routed to the
        // DM region instead of the chat-room region.  No `join`
        // gate — DMs have no presence concept, the inbox topic is
        // always subscribed.
        if (isDmRoomName(m.room)) {
          this.sendDm(m.room, text);
          return;
        }
        if (!this.joinedRooms.has(m.room)) return;
        this.deps.chatRoomRegion.tell({
          kind: 'SendMsg',
          room: m.room,
          from: this.username!,
          text,
        });
      })
      .with({ type: 'join' }, (m) => {
        if (!isRoomName(m.room)) return;
        if (isDmRoomName(m.room)) {
          // "Joining" a DM means: fetch its history so the client
          // can render past messages.  No subscription, no presence.
          this.fetchDmHistory(m.room);
          return;
        }
        this.joinRoom(m.room, true);
      })
      .with({ type: 'leave' }, (m) => {
        // No-op for DM rooms — there's nothing to leave, the inbox
        // stays subscribed cluster-wide for this session.
        if (isRoomName(m.room) && !isDmRoomName(m.room)) this.leaveRoom(m.room);
      })
      .with({ type: 'switch-active-room' }, (m) => {
        if (!isRoomName(m.room)) return;
        if (isDmRoomName(m.room)) {
          this.currentRoom = m.room;
          // Lazy history fetch the first time the user switches into
          // this DM.  Idempotent — subsequent switches don't re-ask.
          if (!this.dmHistoryAskedRooms.has(m.room)) {
            this.dmHistoryAskedRooms.add(m.room);
            this.fetchDmHistory(m.room);
          }
          return;
        }
        if (this.joinedRooms.has(m.room)) {
          this.currentRoom = m.room;
          // Lazy history fetch: if we never asked for this room's
          // history at login (because it wasn't the default room),
          // ask now.  Tracking this with `historyAskedRooms` keeps
          // the request idempotent — a follow-up switch back to the
          // same room doesn't re-ask.
          if (!this.historyAskedRooms.has(m.room)) {
            this.historyAskedRooms.add(m.room);
            this.deps.chatRoomRegion.tell({
              kind: 'GetHistory',
              room: m.room,
              limit: 50,
              replyTo: this.self as ActorRef<HistoryReply>,
            });
          }
        }
      })
      .with({ type: 'create-room' }, (m) => {
        // Fire-and-forget: the directory broadcasts `RoomAdded` (or
        // a refreshed `RoomsChanged`) to every subscriber once the
        // ORSet update is gossiped, so this client sees the new
        // room via the same channel that notifies everyone else.
        // We don't surface accept/reject in this minimal demo —
        // invalid names are a typo (no progress visible client-side
        // = clear feedback) and the duplicate case still results in
        // the name appearing in the list.
        this.deps.roomDirectory.tell({ kind: 'Create', name: m.name });
      })
      .with({ type: 'typing' }, (m) => {
        if (!isRoomName(m.room)) return;
        this.broadcastTyping(m.room);
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

  /* ----------------------------- typing ------------------------------ */

  /**
   * Relay a `typing` frame as a `TypingBroadcast` to the appropriate
   * topic.  For real rooms this rides on the same `chatRoomTopic` as
   * regular messages (#103 design note in `ChatRoomActor`).  For DM
   * "rooms" (`@<other>`), publish only to the OTHER party's inbox
   * topic — typing is direction-aware, the recipient sees "alice is
   * typing in @alice" while alice doesn't echo herself.
   *
   * **Trust model**: we don't validate that the user is *actually*
   * a participant in the room/DM at the protocol-frame level — the
   * worst a misbehaving client can do is generate a noise indicator
   * for a room it's not subscribed to.  No persistence, no security
   * implication.
   */
  private broadcastTyping(room: RoomName): void {
    const me = this.username;
    if (!me) return;
    const mediator = this.system.extension(DistributedPubSubId).mediator;
    if (isDmRoomName(room)) {
      const other = dmCounterparty(room);
      if (!other || other === me) return;
      const broadcast: TypingBroadcast = {
        kind: 'TypingBroadcast',
        // From the recipient's perspective the room is `@<me>`.  The
        // server pre-resolves this so the recipient renders the
        // indicator under the right virtual room without further
        // mapping.
        room: dmRoomFor(me),
        from: me,
      };
      mediator.tell(new Publish(dmInboxTopic(other), broadcast));
      return;
    }
    if (!this.joinedRooms.has(room)) return;
    const broadcast: TypingBroadcast = {
      kind: 'TypingBroadcast',
      room,
      from: me,
    };
    mediator.tell(new Publish(chatRoomTopic(room), broadcast));
  }

  private onTypingBroadcast(msg: TypingBroadcast): void {
    // Filter self-echoes — for real rooms, this actor subscribes to
    // the same topic it publishes on, so it sees its own typing
    // broadcasts.  Drop them so the client doesn't render "you are
    // typing".
    if (msg.from === this.username) return;
    this.sendServer({
      type: 'user-typing',
      room: msg.room,
      username: msg.from,
    });
  }

  /* ------------------------------- DM -------------------------------- */

  /** Route an outbound DM to the right `DmChannelActor` shard.  The
   *  pair-id is canonical so both sides hit the same entity. */
  private sendDm(dmRoom: RoomName, text: string): void {
    const other = dmCounterparty(dmRoom);
    if (!other || other === this.username) return;
    try {
      const pairId = canonicalPairId(this.username!, other);
      this.deps.dmChannelRegion.tell({
        kind: 'SendDm',
        pairId,
        from: this.username!,
        text,
      });
    } catch (e) {
      this.log.warn(`DM: rejected for ${other}: ${(e as Error).message}`);
    }
  }

  /** Ask the DM channel for its recent history.  The reply arrives
   *  as `DmHistoryReply` which we forward to the client. */
  private fetchDmHistory(dmRoom: RoomName): void {
    const other = dmCounterparty(dmRoom);
    if (!other || other === this.username) return;
    try {
      const pairId = canonicalPairId(this.username!, other);
      this.deps.dmChannelRegion.tell({
        kind: 'GetDmHistory',
        pairId,
        limit: 50,
        replyTo: this.self as ActorRef<DmHistoryReply>,
      });
    } catch (e) {
      this.log.warn(`DM: history rejected for ${other}: ${(e as Error).message}`);
    }
  }

  private onDmBroadcast(msg: DmBroadcast): void {
    // The "room" from this client's perspective is the OTHER party.
    // Both sides receive the same broadcast — each maps to its own
    // virtual `@<other>` room.
    const me = this.username;
    if (!me) return;
    const other = msg.from === me ? msg.to : msg.from;
    this.sendServer({
      type: 'message',
      room: dmRoomFor(other),
      from: msg.from,
      text: msg.text,
      ts: msg.ts,
    });
  }

  private onDmHistoryReply(msg: DmHistoryReply): void {
    // Map the pair-id back to "the other party" so the client can
    // file the history under the right `@<other>` room.
    const me = this.username;
    if (!me) return;
    // Pair-id is `min|max` of two usernames; remove ours to find the
    // other.  No regex parse needed — string split on `|`.
    const idx = msg.pairId.indexOf('|');
    if (idx <= 0) return;
    const a = msg.pairId.slice(0, idx);
    const b = msg.pairId.slice(idx + 1);
    const other = me === a ? b : me === b ? a : null;
    if (!other) return;
    this.sendServer({
      type: 'history',
      room: dmRoomFor(other),
      messages: msg.messages,
    });
  }

  /* ---------------------------- directory ---------------------------- */

  private onRoomsChanged(msg: RoomsChanged): void {
    this.knownRooms = msg.rooms;
    // Always forward the full set so the client can deterministically
    // replace its local list — handles both the initial replay on
    // subscribe and concurrent updates from other clients.
    this.sendServer({ type: 'rooms', rooms: msg.rooms });
  }

  private onRoomAdded(msg: RoomAdded): void {
    // RoomsChanged carries the full set; RoomAdded is the per-name
    // notification frontends use to render toast-style "new room"
    // notices without diffing two lists themselves.
    this.sendServer({ type: 'room-added', name: msg.name });
  }

  private onRoomRemoved(msg: RoomRemoved): void {
    this.sendServer({ type: 'room-removed', name: msg.name });
    // If we were subscribed to this room, leave it — otherwise we'd
    // keep broadcasting `send` frames into a room the client can no
    // longer see in its UI.  Best-effort: the directory's `Create`
    // is the only mutator today, so this path only fires once we
    // ship deletion (currently out of scope, but wired).
    if (this.joinedRooms.has(msg.name)) {
      this.leaveRoom(msg.name);
    }
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

  /**
   * Join a room.
   *
   * @param fetchHistory  If true, ask the sharded entity for the
   *                      last 50 messages and forward them to the
   *                      client as a `history` frame.  Defaulted to
   *                      true for explicit `join` commands, but
   *                      defaulted to false for the auto-join burst
   *                      at login time except for the room the user
   *                      starts in — see the rationale in
   *                      `handleUnauthenticated`.
   */
  private joinRoom(room: RoomName, fetchHistory: boolean): void {
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

    if (fetchHistory) {
      this.historyAskedRooms.add(room);
      this.deps.chatRoomRegion.tell({
        kind: 'GetHistory',
        room,
        limit: 50,
        replyTo: this.self as ActorRef<HistoryReply>,
      });
    }
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
