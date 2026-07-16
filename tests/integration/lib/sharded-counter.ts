/**
 * Sharded entity used by scenario 06 (Cluster Sharding rebalance).
 *
 * Each shard region on each cluster node hosts a subset of the
 * sharded entities; the coordinator (running on the leader) assigns
 * shards to regions.  When a region's host node leaves, the
 * coordinator re-allocates that node's shards to remaining regions
 * via `HandOff` directives.  The integration test sends `Who`
 * queries with various entity IDs, verifies they're distributed
 * across multiple regions, then leaves one node and verifies the
 * entities that were on that node end up answering from elsewhere.
 */

import { Actor } from '../../../src/Actor.js';
import type { ActorRef } from '../../../src/ActorRef.js';

export interface ShardedMessage {
  /** The entity ID — required by the shard region's `extractEntityId`. */
  readonly entityId: string;
}

/** Increment the counter for `entityId`. */
export interface ShardedIncrement extends ShardedMessage { readonly op: 'increment' }

/** Query "who hosts you?" — reply via `replyTo`. */
export interface ShardedWho extends ShardedMessage {
  readonly op: 'who';
  readonly replyTo: ActorRef<ShardedWhoReply>;
}

export type ShardedCommand = ShardedIncrement | ShardedWho;

export class ShardedWhoReply {
  constructor(
    public readonly entityId: string,
    public readonly nodeName: string,
    public readonly value: number,
  ) {}
}

/**
 * The sharded counter entity — one instance per `entityId`, hosted
 * by the shard region that owns the entity's shard.
 */
export class ShardedCounter extends Actor<ShardedCommand> {
  private value = 0;
  constructor(private readonly nodeName: string) { super(); }
  override onReceive(message: ShardedCommand): void {
    if (message.op === 'increment') {
      this.value++;
    } else {
      // 'who'
      message.replyTo.tell(new ShardedWhoReply(message.entityId, this.nodeName, this.value));
    }
  }
}

/** Shared by node-runner (region.start) and control-routes (region.tell). */
export const SHARDING_TYPE_NAME = 'counter';
