/**
 * Per-room read-receipts tracker — added in #103 slice 2.
 *
 * **What this stores**: for each chat room or DM pair, a map
 * `{ [username]: read-up-to-timestamp }`.  Each entry is the highest
 * message timestamp the user has acknowledged seeing in that room.
 * `read-up-to.<room>` is a `LWWMap<username, number>` in
 * DistributedData — last-writer-wins per user with the wall-clock
 * `Date.now()` resolving concurrent writes, and the **monotonic
 * guard** below prevents a stale write from rolling a user's
 * pointer backwards even if their clock skews.
 *
 * **Why LWWMap, not ORSet?**  Each value carries semantic ordering
 * (you can't "un-read" a message), so LWW with monotonic comparison
 * is the right fit.  ORSet would give us add-wins semantics on
 * key-presence but no way to compare values across writes.
 *
 * **Why an actor wrapper, not raw DD?**  Same three reasons as
 * `OnlineUsersActor`:
 *   1. Single place that owns the per-room key naming.
 *   2. Subscriber fan-out: each interested `UserSessionActor` calls
 *      `Subscribe` once per room; a single DD-level subscription per
 *      room broadcasts to all of them.  Bounds DD subscribers by
 *      number of distinct rooms with at least one local watcher.
 *   3. **Monotonic guard**: `Update` only writes when `ts >
 *      currentForUser(username)`.  Without this, a late-arriving
 *      `read-up-to` (e.g. duplicate from a reconnect) could undo a
 *      newer one.  LWWMap itself can't enforce this — its register's
 *      wall-clock timestamp is independent of the *value* being
 *      written.
 */
import { match } from 'ts-pattern';
import { Actor, type ActorRef } from '../../../../src/index.js';
import { DistributedDataId } from '../../../../src/crdt/index.js';
import type { DistributedDataHandle } from '../../../../src/crdt/DistributedData.js';
import { LWWMap } from '../../../../src/crdt/LWWMap.js';

/* --------------------------- public messages --------------------------- */

export interface UpdateCommand      { readonly kind: 'Update';      readonly room: string; readonly username: string; readonly ts: number }
export interface SubscribeCommand   { readonly kind: 'Subscribe';   readonly room: string; readonly ref: ActorRef<ReceiptsChanged> }
export interface UnsubscribeCommand { readonly kind: 'Unsubscribe'; readonly room: string; readonly ref: ActorRef<ReceiptsChanged> }

export type ReadReceiptsCommand =
  | UpdateCommand
  | SubscribeCommand
  | UnsubscribeCommand;

export interface ReceiptsChanged {
  readonly kind: 'ReceiptsChanged';
  readonly room: string;
  /** Username → read-up-to timestamp (ms since epoch). */
  readonly receipts: Readonly<Record<string, number>>;
}

/** DD key for a room's read-receipts.  Same `room` value used for
 *  chat rooms (`general`) and DM "rooms" (`@bob`) — the leading `@`
 *  makes the namespaces disjoint by construction. */
function ddKey(room: string): string {
  return `read-up-to.${room}`;
}

/* ------------------------------- internals ----------------------------- */

interface RoomState {
  readonly subscribers: Set<ActorRef<ReceiptsChanged>>;
  ddUnsubscribe: (() => void) | null;
  /** Last broadcast snapshot — reused on `Subscribe` to give late
   *  joiners the current view without waiting for the next change. */
  lastReceipts: Readonly<Record<string, number>>;
}

/* ------------------------------- actor --------------------------------- */

export class ReadReceiptsActor extends Actor<ReadReceiptsCommand> {
  private dd!: DistributedDataHandle;
  private replicaId!: string;
  private readonly rooms = new Map<string, RoomState>();

  override preStart(): void {
    this.dd = this.system.extension(DistributedDataId).get();
    this.replicaId = this.dd.selfReplicaId();
  }

  override postStop(): void {
    for (const state of this.rooms.values()) state.ddUnsubscribe?.();
    this.rooms.clear();
  }

  override onReceive(cmd: ReadReceiptsCommand): void {
    match(cmd)
      .with({ kind: 'Update' },      (m) => this.onUpdate(m))
      .with({ kind: 'Subscribe' },   (m) => this.onSubscribe(m))
      .with({ kind: 'Unsubscribe' }, (m) => this.onUnsubscribe(m))
      .exhaustive();
  }

  /* ----------------------------- mutations ----------------------------- */

  private onUpdate(m: UpdateCommand): void {
    const { room, username, ts } = m;
    // Monotonic guard: drop the write if it would roll the user's
    // pointer backwards.  LWWMap.put resolves concurrent writes via
    // wall-clock, which is good for cross-node tiebreaks but doesn't
    // know the value's semantic ordering.  Reading `current` here
    // bounds the per-user pointer to monotonically non-decreasing.
    const current = this.dd.get<LWWMap<string, number>>(ddKey(room));
    const previous = current?.get(username);
    if (previous !== undefined && ts <= previous) return;
    this.dd.update<LWWMap<string, number>>(
      ddKey(room),
      () => LWWMap.empty<string, number>(),
      (map) => map.put(this.replicaId, username, ts),
    );
  }

  /* ----------------------------- subscription -------------------------- */

  private onSubscribe(m: SubscribeCommand): void {
    const { room, ref } = m;
    const state = this.ensureRoomState(room);
    state.subscribers.add(ref);
    // Replay the last-known snapshot so the new subscriber doesn't
    // wait for the next change to render existing receipts.
    ref.tell({ kind: 'ReceiptsChanged', room, receipts: state.lastReceipts });
  }

  private onUnsubscribe(m: UnsubscribeCommand): void {
    const { room, ref } = m;
    const state = this.rooms.get(room);
    if (!state) return;
    state.subscribers.delete(ref);
    if (state.subscribers.size === 0) {
      state.ddUnsubscribe?.();
      this.rooms.delete(room);
    }
  }

  private ensureRoomState(room: string): RoomState {
    const existing = this.rooms.get(room);
    if (existing) return existing;
    const initial = this.dd.get<LWWMap<string, number>>(ddKey(room));
    const state: RoomState = {
      subscribers: new Set(),
      ddUnsubscribe: null,
      lastReceipts: initial ? snapshotReceipts(initial) : {},
    };
    this.rooms.set(room, state);
    state.ddUnsubscribe = this.dd.subscribe<LWWMap<string, number>>(ddKey(room), (next) => {
      const receipts = snapshotReceipts(next);
      state.lastReceipts = receipts;
      const evt: ReceiptsChanged = { kind: 'ReceiptsChanged', room, receipts };
      for (const sub of state.subscribers) {
        try { sub.tell(evt); }
        catch (e) { this.log.warn(`ReadReceipts: subscriber for ${room} threw`, e); }
      }
    });
    return state;
  }
}

/** Materialize a `Record<username, ts>` from the LWWMap.  Skips
 *  tombstoned entries (`get` returns undefined for those). */
function snapshotReceipts(receipts: LWWMap<string, number>): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const key of receipts.keys()) {
    const value = receipts.get(key);
    if (typeof value === 'number') out[key] = value;
  }
  return out;
}
