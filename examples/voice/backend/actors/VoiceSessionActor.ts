/**
 * One actor per WebSocket connection.  The pivot point of the voice
 * sample: demultiplexes JSON-control-plane frames from raw Opus
 * binary frames, looks up routing targets via the Receptionist
 * (1:1 PTT) or DistributedPubSub (groups + rooms), and serialises
 * inbound `BinaryFrame` events back onto the WS as length-prefixed
 * envelopes the client demuxes per-sender.
 *
 * State machine — `Unauthenticated → Authenticated` — and the auth
 * handshake itself are structurally identical to the chat sample's
 * `UserSessionActor`.  The voice-specific bits start AFTER login:
 *
 *   - On `activate()`: register self with the Receptionist under
 *     `voice-user:<username>`; subscribe to `voice.group.<g>` for
 *     every group the user belongs to; add self to the global
 *     `voice.online-users` ORSet.
 *
 *   - `voice-target` (peer): kick a Receptionist `Find` and cache
 *     the replied `Listing.refs` in `currentTarget` for the duration
 *     of the press.  Each subsequent `binary` frame is a direct
 *     `.tell(BinaryFrame)` to every cached ref.  No registry lookup
 *     per frame.
 *
 *   - `voice-target` (group / room): topic is already subscribed
 *     (groups eagerly at login, rooms lazily on `room-enter`); each
 *     `binary` frame becomes a `mediator.tell(Publish(topic, ...))`.
 *
 *   - `voice-stop`: emit a final `BinaryStreamEnd` along the same
 *     path so receivers can teardown their per-sender `MediaSource`.
 *
 * Self-filter: `voice.group.<g>` and `voice.room.<r>` topics fan out
 * to **every** subscriber including the publisher; receivers drop
 * their own frames in `onBinaryInbound`.
 *
 * On disconnect: deregister from Receptionist, unsubscribe every
 * pubsub topic, remove from every DD-ORSet (online + every joined
 * room).
 */
import { match, P } from 'ts-pattern';
import {
  Actor,
  type ActorRef,
} from '../../../../src/index.js';
import { Publish, Subscribe, Unsubscribe } from '../../../../src/cluster/pubsub/Messages.js';
import {
  Deregister,
  Find,
  Listing,
  Register,
} from '../../../../src/discovery/ReceptionistMessages.js';
import { ServiceKey } from '../../../../src/discovery/ServiceKey.js';
import { TEST_USERS } from '../../shared/users.js';
import {
  GROUP_NAMES,
  GROUPS,
  groupsForUser,
  isGroupName,
  type GroupName,
} from '../../shared/groups.js';
import {
  VOICE_ROOMS,
  isVoiceRoomName,
  type VoiceRoomName,
} from '../../shared/rooms.js';
import {
  decodeClient,
  encodeServer,
  type ClientMessage,
  type IncomingSource,
  type ServerMessage,
} from '../../shared/protocol.js';
import { encodeIncoming } from '../../shared/frameCodec.js';
import { validateCredentials } from '../auth/credentials.js';
import type { SessionStore } from '../auth/sessionStore.js';
import {
  ONLINE_USERS_KEY,
  roomUsersKey,
  type PresenceChanged,
  type VoicePresenceCommand,
} from './VoicePresenceActor.js';

/* ------------------------ pubsub topic helpers ------------------------ */

export function groupTopic(name: GroupName): string {
  return `voice.group.${name}`;
}

export function roomTopic(name: VoiceRoomName): string {
  return `voice.room.${name}`;
}

export function userServiceKey(username: string): ServiceKey<BinaryFrame | BinaryStreamEnd> {
  return ServiceKey.of<BinaryFrame | BinaryStreamEnd>(`voice-user:${username}`);
}

/* ----------------------------- mailbox shape ----------------------------- */

/** Audio chunk routed peer-to-peer or via PubSub topic. */
export interface BinaryFrame {
  readonly kind: 'BinaryFrame';
  readonly senderUsername: string;
  readonly opusChunk: Uint8Array;
}

/** Synthetic "this sender's press is over" marker sent on voice-stop. */
export interface BinaryStreamEnd {
  readonly kind: 'BinaryStreamEnd';
  readonly senderUsername: string;
}

export type InboundFrame =
  | { readonly kind: 'text';   readonly data: string }
  | { readonly kind: 'binary'; readonly data: Uint8Array };

export interface SocketClosed { readonly kind: 'socket-closed' }

/**
 * The outbound surface this actor needs — text (JSON control frames)
 * and binary (length-prefixed Opus envelopes), plus close.  The voice
 * WebSocket ingress hub supplies one backed by the connection ref.
 */
export interface VoiceConnection {
  sendText(text: string): void;
  sendBinary(data: Uint8Array): void;
  close(): void;
}

type SessionMessage =
  | InboundFrame
  | SocketClosed
  | BinaryFrame
  | BinaryStreamEnd
  | PresenceChanged
  | Listing<BinaryFrame | BinaryStreamEnd>;

/* ------------------------------ deps + helpers ----------------------------- */

export interface VoiceSessionDeps {
  readonly connection: VoiceConnection;
  readonly receptionist: ActorRef<unknown>;
  readonly mediator: ActorRef<Subscribe | Unsubscribe | Publish<unknown>>;
  readonly voicePresence: ActorRef<VoicePresenceCommand>;
  readonly sessions: SessionStore;
}

type Phase = 'Unauthenticated' | 'Authenticated';

type CurrentTarget =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'peer';
      readonly targetUsername: string;
      cachedRefs: ReadonlyArray<ActorRef<BinaryFrame | BinaryStreamEnd>>;
      /** True while we're awaiting a Listing for the press. */
      pendingFind: boolean;
    }
  | {
      readonly kind: 'group';
      readonly groupName: GroupName;
      readonly topic: string;
    }
  | {
      readonly kind: 'room';
      readonly roomName: VoiceRoomName;
      readonly topic: string;
    };

/* ------------------------------- actor ---------------------------------- */

export class VoiceSessionActor extends Actor<SessionMessage> {
  private phase: Phase = 'Unauthenticated';
  private username: string | null = null;
  private token: string | null = null;

  private currentTarget: CurrentTarget = { kind: 'idle' };

  /** Pubsub topics this session is subscribed to (groups + entered rooms). */
  private readonly subscribedTopics = new Set<string>();
  /** Rooms this session has entered (subset of subscribedTopics). */
  private readonly joinedRooms = new Set<VoiceRoomName>();
  /** Active inbound streams (sender → metadata) — drives voice-incoming-start/-end framing. */
  private readonly activeIncoming = new Map<string, IncomingSource>();
  /** Service key under which we registered ourselves (set after activate). */
  private myServiceKey: ServiceKey<BinaryFrame | BinaryStreamEnd> | null = null;

  constructor(private readonly deps: VoiceSessionDeps) {
    super();
  }

  /* ------------------------------- lifecycle ------------------------------ */

  override postStop(): void {
    if (this.phase === 'Authenticated' && this.username) {
      // Deregister from receptionist.
      if (this.myServiceKey) {
        this.deps.receptionist.tell(
          new Deregister(this.myServiceKey, this.self as ActorRef<BinaryFrame | BinaryStreamEnd>) as never,
        );
      }
      // Unsubscribe every pubsub topic we were on.
      for (const topic of this.subscribedTopics) {
        this.deps.mediator.tell(new Unsubscribe(topic, this.self as ActorRef));
      }
      // Remove from global online + every room ORSet.
      this.deps.voicePresence.tell({
        kind: 'Remove', key: ONLINE_USERS_KEY, username: this.username,
      });
      this.deps.voicePresence.tell({
        kind: 'Unsubscribe', key: ONLINE_USERS_KEY,
        ref: this.self as ActorRef<PresenceChanged>,
      });
      for (const room of this.joinedRooms) {
        this.deps.voicePresence.tell({
          kind: 'Remove', key: roomUsersKey(room), username: this.username,
        });
        this.deps.voicePresence.tell({
          kind: 'Unsubscribe', key: roomUsersKey(room),
          ref: this.self as ActorRef<PresenceChanged>,
        });
      }
    }
    this.subscribedTopics.clear();
    this.joinedRooms.clear();
    this.activeIncoming.clear();
    try { this.deps.connection.close(); } catch { /* already closed */ }
  }

  /* ------------------------------- mailbox -------------------------------- */

  override onReceive(msg: SessionMessage): void {
    if (msg instanceof Listing) {
      this.onReceptionistListing(msg);
      return;
    }
    match(msg)
      .with({ kind: 'text' },             (m) => this.onClientText(m.data))
      .with({ kind: 'binary' },           (m) => this.onClientBinary(m.data))
      .with({ kind: 'socket-closed' },    () => this.context.stopSelf())
      .with({ kind: 'BinaryFrame' },      (m) => this.onBinaryInbound(m))
      .with({ kind: 'BinaryStreamEnd' },  (m) => this.onStreamEndInbound(m))
      .with({ kind: 'PresenceChanged' },  (m) => this.onPresenceChanged(m))
      .with(P.instanceOf(Listing),        () => { /* handled above */ })
      .exhaustive();
  }

  /* ----------------------------- text inbound ----------------------------- */

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
        this.sendServer({ type: 'login-failed', reason: 'Session expired' });
        return;
      }
      this.activate(username, cmd.token);
      return;
    }
    this.sendServer({ type: 'login-failed', reason: 'Login required as first frame' });
    this.context.stopSelf();
  }

  /**
   * Promote to Authenticated.  Sends `logged-in` + the directory
   * snapshot, then wires up presence + group subscriptions.  Note
   * that group subscriptions are *eager* (per the design) so a
   * later `voice-target { mode: 'group' }` doesn't have to wait
   * for gossip — the session is already on the topic.
   */
  private activate(username: string, token: string): void {
    this.phase = 'Authenticated';
    this.username = username;
    this.token = token;

    this.sendServer({ type: 'logged-in', username, token });

    // Directory snapshot.
    const groups = GROUP_NAMES.map((name) => ({
      name, members: [...GROUPS[name]],
    }));
    this.sendServer({
      type: 'directory',
      users: TEST_USERS.map((u) => u.username),
      groups,
      rooms: [...VOICE_ROOMS],
    });

    // Receptionist registration — this is what 1:1 PTT lookups
    // against `voice-user:<target>` will find.
    this.myServiceKey = userServiceKey(username);
    this.deps.receptionist.tell(
      new Register(this.myServiceKey, this.self as ActorRef<BinaryFrame | BinaryStreamEnd>, null) as never,
    );

    // Subscribe to every group the user belongs to (eager).
    for (const group of groupsForUser(username)) {
      const topic = groupTopic(group);
      if (!this.subscribedTopics.has(topic)) {
        this.subscribedTopics.add(topic);
        this.deps.mediator.tell(new Subscribe(topic, this.self as ActorRef));
      }
    }

    // Global online-users presence + subscription.
    this.deps.voicePresence.tell({
      kind: 'Add', key: ONLINE_USERS_KEY, username,
    });
    this.deps.voicePresence.tell({
      kind: 'Subscribe', key: ONLINE_USERS_KEY,
      ref: this.self as ActorRef<PresenceChanged>,
    });
  }

  private handleAuthenticated(cmd: ClientMessage): void {
    match(cmd)
      .with({ type: 'login' },  () => { /* already authed */ })
      .with({ type: 'resume' }, () => { /* already authed */ })
      .with({ type: 'logout' }, () => {
        if (this.token) this.deps.sessions.revokeToken(this.token);
        this.token = null;
        this.context.stopSelf();
      })
      .with({ type: 'ping' }, () => { /* keepalive */ })
      .with({ type: 'voice-target', mode: 'peer'  }, (m) => this.targetPeer(m.target))
      .with({ type: 'voice-target', mode: 'group' }, (m) => this.targetGroup(m.group))
      .with({ type: 'voice-target', mode: 'room'  }, (m) => this.targetRoom(m.room))
      .with({ type: 'voice-stop' },                  ()  => this.stopCurrentTarget())
      .with({ type: 'room-enter' }, (m) => this.enterRoom(m.room))
      .with({ type: 'room-leave' }, (m) => this.leaveRoom(m.room))
      .exhaustive();
  }

  /* --------------------------- voice-target paths ------------------------ */

  private targetPeer(target: string): void {
    // Reset any previous press.
    if (this.currentTarget.kind !== 'idle') this.stopCurrentTarget();
    if (target === this.username) {
      this.sendServer({
        type: 'voice-target-failed', mode: 'peer', key: target,
        reason: 'cannot voice-target self',
      });
      return;
    }
    // Set up peer state with empty refs; populate via Listing reply.
    this.currentTarget = {
      kind: 'peer', targetUsername: target, cachedRefs: [], pendingFind: true,
    };
    this.deps.receptionist.tell(
      new Find(userServiceKey(target), this.self as ActorRef<Listing<BinaryFrame | BinaryStreamEnd>>) as never,
    );
  }

  private targetGroup(group: GroupName): void {
    if (this.currentTarget.kind !== 'idle') this.stopCurrentTarget();
    if (!isGroupName(group)) {
      this.sendServer({
        type: 'voice-target-failed', mode: 'group', key: group,
        reason: 'unknown group',
      });
      return;
    }
    this.currentTarget = { kind: 'group', groupName: group, topic: groupTopic(group) };
    this.sendServer({ type: 'voice-target-ok', mode: 'group', key: group });
  }

  private targetRoom(room: VoiceRoomName): void {
    if (this.currentTarget.kind !== 'idle') this.stopCurrentTarget();
    if (!isVoiceRoomName(room) || !this.joinedRooms.has(room)) {
      this.sendServer({
        type: 'voice-target-failed', mode: 'room', key: room,
        reason: 'enter the room first',
      });
      return;
    }
    this.currentTarget = { kind: 'room', roomName: room, topic: roomTopic(room) };
    this.sendServer({ type: 'voice-target-ok', mode: 'room', key: room });
  }

  /**
   * Tear down the current press.  Emit a final `BinaryStreamEnd` so
   * subscribers' playback pipelines can flush + close.  The marker
   * is routed along the same path the frames travelled (peer
   * direct-tells / topic publish), so the cleanup hits exactly the
   * receivers who heard the press.
   */
  private stopCurrentTarget(): void {
    if (this.currentTarget.kind === 'idle') return;
    const marker: BinaryStreamEnd = { kind: 'BinaryStreamEnd', senderUsername: this.username! };
    match(this.currentTarget)
      .with({ kind: 'peer' }, (t) => {
        for (const ref of t.cachedRefs) ref.tell(marker);
      })
      .with({ kind: 'group' }, (t) => {
        this.deps.mediator.tell(new Publish(t.topic, marker));
      })
      .with({ kind: 'room' }, (t) => {
        this.deps.mediator.tell(new Publish(t.topic, marker));
      })
      .with({ kind: 'idle' }, () => { /* unreachable */ })
      .exhaustive();
    this.currentTarget = { kind: 'idle' };
  }

  /* ------------------------- binary inbound (own audio) ------------------ */

  private onClientBinary(opusChunk: Uint8Array): void {
    if (this.currentTarget.kind === 'idle' || !this.username) return;
    const frame: BinaryFrame = {
      kind: 'BinaryFrame', senderUsername: this.username, opusChunk,
    };
    match(this.currentTarget)
      .with({ kind: 'peer' }, (t) => {
        // Drop frames during the brief Find round-trip; press is short
        // anyway and the next chunk arrives in ~100 ms.
        if (t.pendingFind) return;
        for (const ref of t.cachedRefs) ref.tell(frame);
      })
      .with({ kind: 'group' }, (t) => {
        this.deps.mediator.tell(new Publish(t.topic, frame));
      })
      .with({ kind: 'room' }, (t) => {
        this.deps.mediator.tell(new Publish(t.topic, frame));
      })
      .with({ kind: 'idle' }, () => { /* unreachable */ })
      .exhaustive();
  }

  /* ------------------- binary inbound (someone speaking to us) ----------- */

  private onBinaryInbound(frame: BinaryFrame): void {
    // Self-filter for group + room topics (we're a subscriber too).
    if (frame.senderUsername === this.username) return;

    // Determine source kind for the start frame: peer (no topic), or
    // group/room based on the topic the message arrived on.  We don't
    // get the topic from the framework's mediator dispatch directly,
    // so use the senderUsername context: if they're in any group with
    // us → group source; else if the only common context is a joined
    // room → room; else peer.  This is a small heuristic that's good
    // enough for the demo's UI labelling — receivers don't act on it
    // beyond rendering "[Group: ops] Charlie:" prefixes.
    const source = this.classifyIncomingSource(frame.senderUsername);

    if (!this.activeIncoming.has(frame.senderUsername)) {
      this.activeIncoming.set(frame.senderUsername, source);
      this.sendServer({
        type: 'voice-incoming-start',
        from: frame.senderUsername,
        source,
      });
    }
    const wire = encodeIncoming(frame.senderUsername, frame.opusChunk);
    try { this.deps.connection.sendBinary(wire); } catch (e) {
      this.log.warn(`VoiceSession: send failed: ${(e as Error).message}`);
    }
  }

  private onStreamEndInbound(end: BinaryStreamEnd): void {
    if (end.senderUsername === this.username) return;
    if (!this.activeIncoming.has(end.senderUsername)) return;
    this.activeIncoming.delete(end.senderUsername);
    this.sendServer({ type: 'voice-incoming-end', from: end.senderUsername });
  }

  /** Best-effort heuristic — see comment in onBinaryInbound. */
  private classifyIncomingSource(senderUsername: string): IncomingSource {
    // Room match wins when the speaker is in a room we've also joined
    // — they're transmitting via the room's topic.
    for (const room of this.joinedRooms) {
      // We can't introspect DD ORSet from here without a presence
      // request; assume any room we've joined is the active room.
      // A speaker's frames in a room they're in match this branch
      // first; if there's no room context fall through to group.
      void room;
    }
    if (this.joinedRooms.size > 0) {
      // pick the first joined room — usually correct for the demo
      const room = this.joinedRooms.values().next().value as VoiceRoomName;
      return { kind: 'room', room };
    }
    // Group inference: any group both we and the sender are in.
    for (const group of groupsForUser(this.username!)) {
      if ((GROUPS[group] as ReadonlyArray<string>).includes(senderUsername)) {
        return { kind: 'group', group };
      }
    }
    return { kind: 'peer' };
  }

  /* --------------------------- room subscription ------------------------- */

  private enterRoom(room: VoiceRoomName): void {
    if (!isVoiceRoomName(room)) return;
    if (this.joinedRooms.has(room)) return;
    this.joinedRooms.add(room);

    const topic = roomTopic(room);
    if (!this.subscribedTopics.has(topic)) {
      this.subscribedTopics.add(topic);
      this.deps.mediator.tell(new Subscribe(topic, this.self as ActorRef));
    }
    this.deps.voicePresence.tell({
      kind: 'Add', key: roomUsersKey(room), username: this.username!,
    });
    this.deps.voicePresence.tell({
      kind: 'Subscribe', key: roomUsersKey(room),
      ref: this.self as ActorRef<PresenceChanged>,
    });
  }

  private leaveRoom(room: VoiceRoomName): void {
    if (!this.joinedRooms.delete(room)) return;
    // If we were targeting this room, drop the press.
    if (this.currentTarget.kind === 'room' && this.currentTarget.roomName === room) {
      this.stopCurrentTarget();
    }
    const topic = roomTopic(room);
    if (this.subscribedTopics.delete(topic)) {
      this.deps.mediator.tell(new Unsubscribe(topic, this.self as ActorRef));
    }
    this.deps.voicePresence.tell({
      kind: 'Remove', key: roomUsersKey(room), username: this.username!,
    });
    this.deps.voicePresence.tell({
      kind: 'Unsubscribe', key: roomUsersKey(room),
      ref: this.self as ActorRef<PresenceChanged>,
    });
  }

  /* --------------------------- listing reply ---------------------------- */

  private onReceptionistListing(listing: Listing<BinaryFrame | BinaryStreamEnd>): void {
    // We only Find under voice-user:<target> for peer presses, so
    // only act on listings whose key belongs to our current peer
    // press.  Anything else is a stale subscriber-style notification
    // we don't subscribe to right now.
    if (this.currentTarget.kind !== 'peer') return;
    const expected = userServiceKey(this.currentTarget.targetUsername).id;
    if (listing.key.id !== expected) return;
    if (listing.refs.length === 0) {
      this.sendServer({
        type: 'voice-target-failed', mode: 'peer',
        key: this.currentTarget.targetUsername,
        reason: 'target not online',
      });
      // Reset; client will retry on next press.
      this.currentTarget = { kind: 'idle' };
      return;
    }
    this.currentTarget = {
      ...this.currentTarget,
      cachedRefs: [...listing.refs],
      pendingFind: false,
    };
    this.sendServer({
      type: 'voice-target-ok', mode: 'peer',
      key: this.currentTarget.targetUsername,
    });
  }

  /* ------------------------- presence inbound --------------------------- */

  private onPresenceChanged(evt: PresenceChanged): void {
    if (evt.key === ONLINE_USERS_KEY) {
      this.sendServer({ type: 'online-users', users: evt.users });
      return;
    }
    // Otherwise it's a per-room set.  Reverse lookup the room name.
    const prefix = 'voice.room-users.';
    if (evt.key.startsWith(prefix)) {
      const room = evt.key.slice(prefix.length);
      if (isVoiceRoomName(room)) {
        this.sendServer({ type: 'room-participants', room, users: evt.users });
      }
    }
  }

  /* ------------------------------ outgoing ----------------------------- */

  private sendServer(msg: ServerMessage): void {
    try {
      this.deps.connection.sendText(encodeServer(msg));
    } catch (e) {
      this.log.warn(`VoiceSession: send failed: ${(e as Error).message}`);
    }
  }
}
