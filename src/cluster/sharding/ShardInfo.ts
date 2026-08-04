import type { ActorRef } from '../../ActorRef.js';
import type { NodeAddress } from '../NodeAddress.js';
import type { ShardMessage } from './Shard.js';

/**
 * One shard of a sharded type, as reported by `ClusterSharding.shards()`.
 *
 * Carries both halves of what "list the shards" is usually asked for: the
 * placement data (which node, which region, how many entities) *and* a live
 * `ref` you can send to.  The ref is materialised on the asking node — the
 * wire payload behind it is plain data — so the shape is deliberately **not**
 * JSON-serialisable.  Surfaces that need a serialisable view (the
 * `/cluster/shards` management endpoint, the DevTools frames) keep their own
 * DTOs rather than dragging a ref through JSON.
 *
 * It is a snapshot: `entityCount` was true when the hosting region answered,
 * and `node` only holds until the next rebalance.  Hold the `ref`, not the
 * placement, if you intend to keep talking to the shard.
 */
export type ShardInfo<TMessage = unknown> = {
  readonly shardId: number;
  /** Node currently hosting the shard. */
  readonly node: NodeAddress;
  /** Path of the region on that node — the shard sits directly beneath it. */
  readonly regionPath: string;
  /** Live entities in the shard when its region answered. */
  readonly entityCount: number;
  /**
   * Whether the shard actor was materialised when its region answered.
   *
   * A shard that passivated while empty stays allocated, addressable and
   * reachable through `ref` — it is re-created on the next message — but it
   * is not running right now.  `entityCount: 0` cannot tell you that on its
   * own, since a running-but-empty shard reports the same count, so this is
   * what to read when tuning `shardPassivationIdleMs` or counting the actors
   * a node actually holds.
   */
  readonly resident: boolean;
  /** True when the shard is hosted by the node that asked. */
  readonly local: boolean;
  readonly ref: ActorRef<ShardMessage<TMessage>>;
};
