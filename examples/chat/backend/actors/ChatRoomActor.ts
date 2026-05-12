/**
 * One sharded entity per chat room.  PersistentActor — every
 * `SendMsg` is appended to the SQLite journal as a `MsgPosted`
 * event; recovery replays the room's history into in-memory state.
 *
 * Routing: ClusterSharding picks a node based on `entityId = roomName`
 * via the message extractor in `main.ts`.  At any moment a given
 * room lives on exactly one node — kein Doppelschreiben aufs
 * Journal, kein Split-Brain auf der History.
 *
 * Broadcast: after a successful `persist(...)`, the new event is
 * published on the cluster-wide `chat.room.<roomName>` pubsub topic.
 * Every node's `UserSessionActor`s that have subscribed to that
 * topic receive the broadcast and forward it to their client over
 * the WebSocket.
 *
 * History replay: `GetHistory` returns the most-recent `limit`
 * messages from in-memory state.  In-memory history is capped at
 * {@link HISTORY_LIMIT} so RAM stays bounded; older events remain
 * in the journal.  A future Phase-2 improvement could expose a
 * journal-backed query for unbounded scroll-back.
 */
import { match } from 'ts-pattern';
import {
  PersistentActor,
  everyNEvents,
  type ActorRef,
  type SnapshotPolicy,
} from '../../../../src/index.js';
import { DistributedPubSubId } from '../../../../src/cluster/pubsub/index.js';
import { Publish } from '../../../../src/cluster/pubsub/Messages.js';
import type { ChatMessage } from '../../shared/protocol.js';
import type { RoomName } from '../../shared/rooms.js';

/** In-memory history cap.  Older events stay in the journal. */
export const HISTORY_LIMIT = 200;

/**
 * Snapshot cadence — one persisted snapshot per N events posted.
 * Bounded by `HISTORY_LIMIT` so each snapshot is at most that many
 * messages (~ a few dozen KB JSON).  100 is a balance between
 * snapshot churn and recovery time: at 1 message/sec a room takes
 * 100s to accumulate enough events for a snapshot to be worth it,
 * and recovery scans at most 100 events even after a long uptime.
 */
export const SNAPSHOT_EVERY_N_EVENTS = 100;

/* --------------------------- public messages --------------------------- */

export interface HistoryReply {
  readonly kind: 'HistoryReply';
  readonly room: RoomName;
  readonly messages: ReadonlyArray<ChatMessage>;
}

export type ChatRoomCmd =
  | {
      readonly kind: 'SendMsg';
      readonly room: RoomName;
      readonly from: string;
      readonly text: string;
    }
  | {
      readonly kind: 'GetHistory';
      readonly room: RoomName;
      readonly limit: number;
      readonly replyTo: ActorRef<HistoryReply>;
    };

/**
 * Body published on `chatRoomTopic(room)` after every persisted
 * message.  Subscribers (UserSessionActors) translate this into a
 * `ServerMessage` of `type: 'message'` and forward over their socket.
 */
export interface RoomBroadcast {
  readonly kind: 'RoomBroadcast';
  readonly room: RoomName;
  readonly from: string;
  readonly text: string;
  readonly ts: number;
}

/**
 * Ephemeral "user is typing" broadcast — published on the same
 * `chatRoomTopic(room)` topic as `RoomBroadcast`, but never persisted.
 *
 * **Why ride the chat-room topic instead of a separate topic?**  Every
 * `UserSessionActor` already subscribes to a room's topic on `join`;
 * carrying typing notifications on the same topic adds zero
 * subscription bookkeeping.  Subscribers discriminate by `kind` in
 * their mailbox handler.  Trade-off: a typing burst is gossiped to
 * every room subscriber even if they're not actively viewing the
 * room — fine for sample-scale traffic (~10 users); a production
 * design might split into a separate topic if typing fan-out
 * dominates message fan-out.  Added in #103.
 */
export interface TypingBroadcast {
  readonly kind: 'TypingBroadcast';
  readonly room: RoomName;
  readonly from: string;
}

/** Topic name a room broadcasts on. */
export function chatRoomTopic(room: RoomName): string {
  return `chat.room.${room}`;
}

/* ----------------------------- internals ------------------------------ */

interface MsgPosted {
  readonly kind: 'MsgPosted';
  readonly from: string;
  readonly text: string;
  readonly ts: number;
}
type ChatEvent = MsgPosted;

interface ChatState {
  readonly history: ReadonlyArray<ChatMessage>;
}

/* ------------------------------- actor -------------------------------- */

export class ChatRoomActor extends PersistentActor<ChatRoomCmd, ChatEvent, ChatState> {
  private _roomName: RoomName | null = null;

  /**
   * `persistenceId` is bound to the entity's roomName.
   *
   * ClusterSharding spawns the actor with name `entity-<roomName>` —
   * we strip the prefix to recover the room.  The actor field is
   * overridden as a getter (the abstract field in the base class
   * accepts either shape) so `this.self` is available at the time it
   * runs (preStart, after `_attach()`).
   */
  override get persistenceId(): string {
    return `chat-room-${this.roomName}`;
  }

  private get roomName(): RoomName {
    if (this._roomName !== null) return this._roomName;
    const name = this.self.path.name;
    const stripped = name.startsWith('entity-') ? name.slice('entity-'.length) : name;
    this._roomName = stripped as RoomName;
    return this._roomName;
  }

  initialState(): ChatState {
    return { history: [] };
  }

  /**
   * Take a snapshot every {@link SNAPSHOT_EVERY_N_EVENTS} events.
   * Without this, recovery rescans the whole journal slice for the
   * room's `persistenceId` on every cold start — fine for a few
   * dozen messages, painful for an active room with thousands.
   *
   * The state is small (`HISTORY_LIMIT` capped to 200 messages) so
   * each snapshot is well under a kilobyte; storing one every 100
   * events bounds replay work to ≤ 100 events + 1 snapshot read
   * regardless of total room age.
   */
  override snapshotPolicy(): SnapshotPolicy<ChatState, ChatEvent> {
    return everyNEvents(SNAPSHOT_EVERY_N_EVENTS);
  }

  onEvent(state: ChatState, e: ChatEvent): ChatState {
    return match(e)
      .with({ kind: 'MsgPosted' }, (m) => {
        const next = [...state.history, { from: m.from, text: m.text, ts: m.ts }];
        // Trim AFTER append so the most-recent N messages stay live —
        // older events live on in the journal but aren't kept resident.
        const trimmed =
          next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
        return { history: trimmed };
      })
      .exhaustive();
  }

  async onCommand(state: ChatState, cmd: ChatRoomCmd): Promise<void> {
    if (cmd.kind === 'SendMsg') {
      const event: MsgPosted = {
        kind: 'MsgPosted',
        from: cmd.from,
        text: cmd.text,
        ts: Date.now(),
      };
      await this.persist(event, () => {
        // After persistence: broadcast cluster-wide via PubSub.  Sender
        // (originating UserSessionActor) doesn't get an explicit ack —
        // it sees its own message arrive via the same pubsub fan-out
        // that reaches every other connected client.  No special
        // round-tripping, no echo handling on the client.
        const broadcast: RoomBroadcast = {
          kind: 'RoomBroadcast',
          room: this.roomName,
          from: event.from,
          text: event.text,
          ts: event.ts,
        };
        const topic = chatRoomTopic(this.roomName);
        const mediator = this.system.extension(DistributedPubSubId).mediator;
        mediator.tell(new Publish(topic, broadcast));
      });
      return;
    }

    if (cmd.kind === 'GetHistory') {
      const messages = state.history.slice(-Math.max(1, cmd.limit));
      cmd.replyTo.tell({ kind: 'HistoryReply', room: this.roomName, messages });
      return;
    }
  }
}
