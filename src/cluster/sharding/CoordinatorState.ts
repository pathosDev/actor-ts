import type { Journal } from '../../persistence/Journal.js';
import { JournalConcurrencyError } from '../../persistence/JournalTypes.js';
import { LWWRegister } from '../../crdt/LWWRegister.js';
import type { DistributedDataHandle } from '../../crdt/DistributedData.js';
import type { NodeAddressData } from '../NodeAddress.js';

/**
 * Wire shape for `ShardCoordinator` state — what's persisted to
 * `CoordinatorStateStore` so a new leader can skip the full
 * rebuild-from-Register-gossip path on `LeaderChanged`.
 *
 * `pending` and `rebalanceInProgress` are deliberately **not**
 * persisted: they're transient by nature (in-flight queries +
 * mid-flight handoffs).  A fresh leader rebuilds them as new
 * messages arrive.
 *
 * `entitiesPerShard` is persisted separately via
 * `RememberEntitiesStore` (#49) — those two stores have different
 * cadences (state changes here are bursty during rebalance; entity
 * lifecycle is steady).  Keeping them apart lets each tune
 * independently.
 */
export type CoordinatorStateData = {
  /** Replica that wrote this snapshot.  Informational + LWW tiebreak. */
  readonly leader: string;
  /** Wall-clock millis at write time.  LWW tiebreak. */
  readonly takenAt: number;
  /** Region table — keyed by the same `regionKey` the coordinator uses. */
  readonly regions: ReadonlyArray<RegionInfoData>;
  /** Allocation map.  `[shardId, regionKey][]` — Map's wire shape. */
  readonly shardHome: ReadonlyArray<readonly [number, string]>;
  /**
   * The shard count the writing coordinator governed the type with (#633).
   *
   * Both halves of this snapshot are modulus-dependent: a shard id is
   * `hash(entityId) % numShards`, so `shardHome` and every `RegionInfoData.shards`
   * are only meaningful against the count that produced them.  Adopting a
   * snapshot written under another count re-establishes precisely the split
   * routing a `numShards` refusal exists to prevent, and it does so through the
   * load path, where the `Register` handshake — the only place the counts are
   * ever compared — never runs.  A rolling deploy that changes the count is the
   * ordinary way to get there: the outgoing leader's last snapshot is written
   * under the old count and the incoming leader reads it under the new one.
   *
   * Stamped at snapshot level rather than per region, because a snapshot from
   * another modulus has a `shardHome` map that is unusable *in its entirety*,
   * not entry by entry.
   *
   * Optional only for reading: a snapshot already sitting in `DistributedData`
   * from before this field existed still parses.  It is not adopted, though —
   * an unstated modulus cannot be checked, and the fallback is the
   * rebuild-from-`Register` path every default configuration already runs.
   */
  readonly numShards?: number;
};

/** JSON-friendly mirror of the in-memory `RegionInfo`. */
export type RegionInfoData = {
  /** Same key as `regionKey(node, path)`. */
  readonly key: string;
  readonly node: NodeAddressData;
  readonly path: string;
  readonly proxy: boolean;
  readonly shards: ReadonlyArray<number>;
};

/**
 * Pluggable persistence for the coordinator's allocation state.
 * Symmetric to `RememberEntitiesStore` from #49: load / save / clear.
 *
 * **Nothing is wired by default.**  The stock implementation is
 * `DistributedDataCoordinatorStateStore` — gossip-replicated within
 * the cluster, so when leadership flips the new leader sees a recent
 * snapshot from the previous leader — but you opt in by passing it as
 * `coordinatorStateStore`, having started the DistributedData
 * extension yourself.  Without that, `ShardCoordinator` rebuilds from
 * region `Register` claims, which is the behaviour every default
 * configuration has.  "Default impl" used to sit here and read as
 * "wired for you"; it never was (#682).  Custom implementations could
 * front a SQLite table or any other backend.
 *
 * This store is *not* what the `/cluster/shards` management endpoint
 * reads — that answers from `ClusterSharding.shardMap()` and works
 * with no store configured.
 */
export interface CoordinatorStateStore {
  /** Load the most recent snapshot, or `null` if none stored. */
  load(typeName: string): Promise<CoordinatorStateData | null>;

  /** Persist a fresh snapshot.  Overwrites any prior. */
  save(typeName: string, state: CoordinatorStateData): Promise<void>;
}

/* ============== DistributedData-backed default impl =================== */

/**
 * `CoordinatorStateStore` backed by `DistributedData`.  Each
 * coordinator's state lives in a single LWW register keyed by
 * `sharding-coordinator-state|{typeName}`.  Cluster-wide gossip
 * propagates the writes; on leadership flip the new leader's local
 * DD view typically holds the previous leader's last snapshot
 * (modulo the gossip interval — a few hundred ms behind in the
 * worst case).
 *
 * **CRDT shape**: a single `LWWRegister<CoordinatorStateData>`.
 * Tiebreak via `(timestamp, replicaId)` is exactly what we want —
 * the most recent writer (=most recent leader) wins.
 *
 * **Latency**: DD's default gossip is push-to-one-random-peer per
 * tick.  In a 3-node cluster, the previous leader's last write
 * reaches the new leader within ~2 gossip rounds in expectation.
 * For sub-second failover the user can tighten
 * `DistributedDataOptionsType.gossipInterval`.
 */
export class DistributedDataCoordinatorStateStore implements CoordinatorStateStore {
  constructor(
    private readonly dd: DistributedDataHandle,
    /** This replica's id — used as the LWWRegister writer. */
    private readonly replicaId: string,
  ) {}

  private keyFor(typeName: string): string {
    return `sharding-coordinator-state|${typeName}`;
  }

  async load(typeName: string): Promise<CoordinatorStateData | null> {
    const reg = this.dd.get<LWWRegister<CoordinatorStateData>>(this.keyFor(typeName));
    return reg?.value() ?? null;
  }

  async save(typeName: string, state: CoordinatorStateData): Promise<void> {
    this.dd.update<LWWRegister<CoordinatorStateData>>(
      this.keyFor(typeName),
      () => LWWRegister.empty<CoordinatorStateData>(),
      (reg) => reg.assign(this.replicaId, state, state.takenAt),
    );
    // The update is fire-and-forget (DD serialises through its
    // mailbox) — we don't await write-to-disk.  That's fine: load
    // reads the local view, which always reflects our own writes
    // synchronously.
  }
}

/* ===================== Journal-backed implementation ===================== */

/** What {@link JournalCoordinatorStateStore} writes to the journal: one snapshot per event. */
type CoordinatorStateEvent = { readonly kind: 'coordinator-state'; readonly state: CoordinatorStateData };

/**
 * `CoordinatorStateStore` backed by any `Journal` (#1188).
 *
 * The DistributedData store reads only the *local* replica, so a coordinator
 * that comes up on a node that has just restarted — exactly the node a leader
 * change most often lands on, since the leader is the lowest address — finds
 * nothing to load.  A journal shared by the cluster does not have that gap:
 * the new leader reads what the previous one last wrote, wherever it ran.
 *
 * **Shape: the latest snapshot, not an event log.**  Each save appends one
 * event carrying the whole `CoordinatorStateData` under
 * `persistenceId = "sharding-coordinator-state-{typeName}"` (tag
 * `sharding-coordinator-state`) and then deletes everything before it, so the
 * stream never holds more than the one snapshot `load` reads.  The
 * persistence id is not the remember-entities registry's
 * (`sharding-coordinator-{typeName}`): the two must never share a stream.
 *
 * **A fence against a second writer.**  A save appends with the sequence
 * number this store last loaded or wrote as `expectedSeq`, so a coordinator
 * whose view of the stream is stale — another coordinator wrote in between,
 * which only a split brain allows — fails with `JournalConcurrencyError`
 * instead of silently overwriting.  The store then adopts the stream's head,
 * so the next save of a coordinator that still holds authority goes through;
 * the failure itself is logged by the coordinator's save path.  This narrows
 * a split brain's damage to the persisted map; it does not replace the lease,
 * which is what keeps two coordinators from allocating at all.
 */
export class JournalCoordinatorStateStore implements CoordinatorStateStore {
  /** The sequence number this store last saw for each type — the `expectedSeq` of its next save. */
  private readonly heads = new Map<string, number>();

  constructor(private readonly journal: Journal) {}

  private persistenceIdFor(typeName: string): string {
    return `sharding-coordinator-state-${typeName}`;
  }

  async load(typeName: string): Promise<CoordinatorStateData | null> {
    const persistenceId = this.persistenceIdFor(typeName);
    const head = await this.journal.highestSeq(persistenceId);
    this.heads.set(typeName, head);
    if (head === 0) return null;
    const [latest] = await this.journal.read<CoordinatorStateEvent>(persistenceId, head, head);
    return latest?.event.kind === 'coordinator-state' ? latest.event.state : null;
  }

  async save(typeName: string, state: CoordinatorStateData): Promise<void> {
    const persistenceId = this.persistenceIdFor(typeName);
    const expected = this.heads.get(typeName) ?? await this.journal.highestSeq(persistenceId);
    let written: number;
    try {
      const [event] = await this.journal.append<CoordinatorStateEvent>(
        persistenceId,
        [{ event: { kind: 'coordinator-state', state }, tags: ['sharding-coordinator-state'] }],
        expected,
      );
      written = event!.sequenceNr;
    } catch (error) {
      if (error instanceof JournalConcurrencyError) this.heads.set(typeName, error.actualSeq);
      throw error;
    }
    this.heads.set(typeName, written);
    // Only the latest snapshot is ever read, so everything before it is dead
    // weight — and a stream that grew by one event per allocation change is
    // the unbounded growth #649 records for the remember-entities registry.
    if (written > 1) await this.journal.delete(persistenceId, written - 1);
  }
}
