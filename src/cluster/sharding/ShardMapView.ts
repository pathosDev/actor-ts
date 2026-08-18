import type { ShardMapChanged } from '../ClusterEvents.js';

/**
 * The shard map of one type as plain JSON — what
 * `ClusterSharding.shardMap()` hands back and what the `/cluster/shards`
 * management endpoint serialises verbatim.
 *
 * Deliberately separate from `ShardInfo`, which carries a live
 * `ActorRef` and therefore cannot cross a wire: this is the same placement
 * data with the ref left out and nothing that needs materialising on the
 * asking node.
 *
 * It is a *view*, not a query result — the last map the local region was
 * told about, kept by `ClusterSharding` as `ShardMapChanged` arrives.  So it
 * costs nothing to read and it is at most one coordinator publish behind,
 * and it exists on every node rather than only the leader's, because the
 * coordinator broadcasts to every registered region and each region
 * republishes locally.  Before #682 the endpoint read a DistributedData
 * snapshot instead, which meant it answered 404 unless the operator had
 * started the DistributedData extension *and* opted into a
 * `coordinatorStateStore`.
 */
export type ShardMapView = {
  readonly typeName: string;
  /**
   * The cluster leader as this node saw it when the map arrived — which is
   * the coordinator that computed it, since only the leader's coordinator is
   * active.  Empty string while no leader is known.
   */
  readonly leader: string;
  /**
   * The coordinator's publish counter, not an allocation counter: one bump
   * per broadcast, and a broadcast coalesces a burst of assignments.  Useful
   * for "has the map moved since I last looked", useless for counting shards.
   */
  readonly version: number;
  /** Wall-clock millis at which this node recorded the map. */
  readonly takenAt: number;
  readonly regions: ReadonlyArray<ShardMapViewRegion>;
  /** Allocation map, one entry per shard that has a home. */
  readonly shardHome: ReadonlyArray<ShardMapViewAssignment>;
};

/** One region participating in a sharded type, as JSON. */
export type ShardMapViewRegion = {
  /** `<node>|<path>` — the same key the coordinator's allocation map uses. */
  readonly key: string;
  readonly address: string;
  readonly path: string;
  readonly proxy: boolean;
  /** Shard ids currently homed here.  Empty for a region hosting nothing. */
  readonly shards: ReadonlyArray<number>;
};

/** Where one shard currently lives. */
export type ShardMapViewAssignment = {
  readonly shard: number;
  readonly regionKey: string;
};

/**
 * Project a `ShardMapChanged` into the serialisable view.
 *
 * The per-region shard *ids* are regrouped out of the assignment map rather
 * than taken from the event, which only carries each region's `shardCount`:
 * the coordinator keeps the two sides in step on every mutation, so grouping
 * `shards` by region key reconstructs exactly the set it counted — and it
 * keeps the endpoint's response shape byte-identical to the one the
 * DistributedData-backed handler produced, which is documented and may
 * already be parsed by operator tooling.
 *
 * A region that hosts nothing still appears, with an empty `shards`: knowing
 * a node has registered and been given no shards is the interesting half of
 * a rebalance question.
 *
 * @param leader Address of the leader as the caller sees it — passed in so
 *   this stays a pure function over the event and does not reach for a
 *   `Cluster`.
 * @param takenAt Wall-clock millis to stamp the view with.
 */
export function shardMapViewOf(
  event: ShardMapChanged,
  leader: string,
  takenAt: number,
): ShardMapView {
  const shardsByRegion = new Map<string, number[]>();
  for (const region of event.regions) shardsByRegion.set(region.key, []);
  const shardHome: ShardMapViewAssignment[] = [];
  for (const [shard, regionKey] of event.shards) {
    shardHome.push({ shard, regionKey });
    // A shard homed on a region the event does not list would be a
    // coordinator bug; recording it anyway keeps the assignment map honest
    // instead of dropping the evidence.
    const owned = shardsByRegion.get(regionKey);
    if (owned) owned.push(shard);
  }
  shardHome.sort((a, b) => a.shard - b.shard);
  return {
    typeName: event.type,
    leader,
    version: event.version,
    takenAt,
    regions: event.regions.map((region) => ({
      key: region.key,
      address: region.address,
      path: region.path,
      proxy: region.proxy,
      shards: (shardsByRegion.get(region.key) ?? []).sort((a, b) => a - b),
    })),
    shardHome,
  };
}
