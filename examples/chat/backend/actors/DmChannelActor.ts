/**
 * One sharded entity per direct-message conversation — added in #100.
 *
 * Structurally a copy of `ChatRoomActor`:
 *
 *   - PersistentActor with `persistenceId = "dm-channel-<pair-id>"`.
 *   - Sharded by `entityId = canonicalPairId(from, to)` — see
 *     `shared/dm.ts` for the ordering rationale.
 *   - Snapshot every `SNAPSHOT_EVERY_N_EVENTS` events to bound
 *     recovery time, same value as ChatRoom.
 *
 * **Difference from `ChatRoomActor`**: broadcast goes to
 * `chat.dm.user.<participant>` topics (one publish per party, two
 * publishes total) rather than a single room-wide topic.  Each
 * `UserSessionActor` subscribes to its own inbox topic once at
 * login — so the routing is "DM lands directly in your inbox" rather
 * than "subscribe to channels you're a part of".  Simpler client-
 * side state model: no per-DM subscription bookkeeping.
 *
 * **Why two publishes?**  Could also publish to one
 * `chat.dm.pair.<pair-id>` topic and have both sides subscribe.  But
 * that requires every UserSessionActor to subscribe to N pair-topics
 * (one per DM partner) at login or on first message — adds dynamic
 * subscription bookkeeping for a marginal saving.  Two publishes per
 * send is cheap.
 *
 * **History replay** mirrors ChatRoom: in-memory `HISTORY_LIMIT`
 * cap, older events live in the journal.  Re-using the same limit
 * keeps the snapshot policy consistent across the two actor types.
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
import { dmInboxTopic, splitPairId } from '../../shared/dm.js';
import { HISTORY_LIMIT, SNAPSHOT_EVERY_N_EVENTS } from './ChatRoomActor.js';

/* --------------------------- public messages --------------------------- */

export interface DmHistoryReply {
  readonly kind: 'DmHistoryReply';
  readonly pairId: string;
  readonly messages: ReadonlyArray<ChatMessage>;
}

export type DmChannelCommand =
  | {
      readonly kind: 'SendDm';
      readonly pairId: string;
      readonly from: string;
      readonly text: string;
    }
  | {
      readonly kind: 'GetDmHistory';
      readonly pairId: string;
      readonly limit: number;
      readonly replyTo: ActorRef<DmHistoryReply>;
    };

/**
 * Body published on each participant's inbox topic.  Both sides of a
 * DM see the same payload — they distinguish "incoming" vs "outgoing"
 * client-side by comparing `from` to their own username.
 */
export interface DmBroadcast {
  readonly kind: 'DmBroadcast';
  readonly pairId: string;
  readonly from: string;
  readonly to: string;
  readonly text: string;
  readonly ts: number;
}

/* ----------------------------- internals ------------------------------ */

interface DmPosted {
  readonly kind: 'DmPosted';
  readonly from: string;
  readonly text: string;
  readonly ts: number;
}
type DmEvent = DmPosted;

interface DmState {
  readonly history: ReadonlyArray<ChatMessage>;
}

/* ------------------------------- actor -------------------------------- */

export class DmChannelActor extends PersistentActor<DmChannelCommand, DmEvent, DmState> {
  /**
   * `persistenceId` is bound to the actor path's name (the
   * sharded-entity slot, which sharding spawns as `entity-<id>`).
   * The actor system sanitizes the entity-id when building the
   * path — characters outside `[A-Za-z0-9_-]` (e.g. `|`) are
   * rewritten — so this string is the **sanitized** form, not
   * necessarily the original `canonicalPairId(a, b)` value.  That's
   * fine for journal-stream uniqueness because the sharding system
   * already guarantees one entity per sanitized name; the path is
   * the only stable id we can derive synchronously during recovery
   * (before any command arrives).  For semantic operations that
   * need the original `|`-separated pair-id (e.g. routing broadcasts
   * back to participant inboxes), use `cmd.pairId` from the
   * incoming command instead.
   */
  override get persistenceId(): string {
    const name = this.self.path.name;
    const stripped = name.startsWith('entity-') ? name.slice('entity-'.length) : name;
    return `dm-channel-${stripped}`;
  }

  initialState(): DmState {
    return { history: [] };
  }

  override snapshotPolicy(): SnapshotPolicy<DmState, DmEvent> {
    return everyNEvents(SNAPSHOT_EVERY_N_EVENTS);
  }

  onEvent(state: DmState, e: DmEvent): DmState {
    return match(e)
      .with({ kind: 'DmPosted' }, (m) => this.onDmPosted(state, m))
      .exhaustive();
  }

  private onDmPosted(state: DmState, m: DmPosted): DmState {
    const next = [...state.history, { from: m.from, text: m.text, ts: m.ts }];
    const trimmed =
      next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
    return { history: trimmed };
  }

  async onCommand(state: DmState, cmd: DmChannelCommand): Promise<void> {
    if (cmd.kind === 'SendDm') {
      const event: DmPosted = {
        kind: 'DmPosted',
        from: cmd.from,
        text: cmd.text,
        ts: Date.now(),
      };
      await this.persist(event, () => {
        // Both participants need a copy of the broadcast — one in
        // each inbox topic.  Use `cmd.pairId` (the canonical form,
        // carrying the original `|` separator) rather than the
        // path-derived id which may have been sanitized by the
        // actor system.  Defensive split: if the pair-id is
        // malformed we drop the publish entirely (persist already
        // succeeded, so the event is durable — just the live
        // notification is lost).
        const parts = splitPairId(cmd.pairId);
        if (!parts) {
          this.log.warn(`DmChannel: malformed pair-id '${cmd.pairId}'`);
          return;
        }
        const [a, b] = parts;
        const to = cmd.from === a ? b : a;
        const broadcast: DmBroadcast = {
          kind: 'DmBroadcast',
          pairId: cmd.pairId,
          from: cmd.from,
          to,
          text: event.text,
          ts: event.ts,
        };
        const mediator = this.system.extension(DistributedPubSubId).mediator;
        mediator.tell(new Publish(dmInboxTopic(a), broadcast));
        mediator.tell(new Publish(dmInboxTopic(b), broadcast));
      });
      return;
    }

    if (cmd.kind === 'GetDmHistory') {
      const messages = state.history.slice(-Math.max(1, cmd.limit));
      cmd.replyTo.tell({ kind: 'DmHistoryReply', pairId: cmd.pairId, messages });
      return;
    }
  }
}
