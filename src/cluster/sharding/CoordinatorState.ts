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
export interface CoordinatorStateData {
  /** Replica that wrote this snapshot.  Informational + LWW tiebreak. */
  readonly leader: string;
  /** Wall-clock millis at write time.  LWW tiebreak. */
  readonly takenAt: number;
  /** Region table — keyed by the same `regionKey` the coordinator uses. */
  readonly regions: ReadonlyArray<RegionInfoData>;
  /** Allocation map.  `[shardId, regionKey][]` — Map's wire shape. */
  readonly shardHome: ReadonlyArray<readonly [number, string]>;
}

/** JSON-friendly mirror of the in-memory `RegionInfo`. */
export interface RegionInfoData {
  /** Same key as `regionKey(node, path)`. */
  readonly key: string;
  readonly node: NodeAddressData;
  readonly path: string;
  readonly proxy: boolean;
  readonly shards: ReadonlyArray<number>;
}

/**
 * Pluggable persistence for the coordinator's allocation state.
 * Symmetric to `RememberEntitiesStore` from #49: load / save / clear.
 *
 * The default impl is `DistributedDataCoordinatorStateStore` —
 * gossip-replicated within the cluster, so when leadership flips
 * the new leader sees a recent snapshot from the previous leader.
 * Custom impls could front a SQLite table or any other backend.
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
