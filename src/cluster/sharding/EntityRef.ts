import { ActorPath } from '../../ActorPath.js';
import { ActorRef } from '../../ActorRef.js';
import { entityName } from './Shard.js';
import { hashShardId } from './ShardAllocator.js';
import { shardName } from './ShardRegion.js';
import type { EntityEnvelope } from './ShardingProtocol.js';

/**
 * Location-transparent handle to a single sharded entity — the counterpart to
 * the region ref, addressed by id rather than by whatever routing key your
 * message type happens to carry.
 *
 * Without it the region ref is the only handle sharding hands out, so every
 * message has to embed its own entity id for `extractEntityId` to dig back
 * out.  An `EntityRef` wraps each message in a {@link EntityEnvelope} instead,
 * which the region routes by the id in the envelope — the message type itself
 * no longer has to know how it is routed.
 *
 * Like {@link ClusterSingletonProxy} it extends `ActorRef` without being
 * backed by an actor of its own: it is a thin forwarder onto the local region,
 * which owns all the routing, buffering and cross-node machinery already.
 * `ask` therefore works unchanged — the region forwards the caller's sender to
 * the entity, so a reply goes straight back without a detour.
 *
 * The `path` is the entity's path **as it would be under this node's region**
 * (`/user/sharding-<type>/shard-<n>/entity-<id>`).  It identifies the entity —
 * two refs for the same `(typeName, entityId)` are `equals()` — but it does
 * not say which node currently hosts it; that can change on every rebalance,
 * which is the entire point of holding the handle instead of a path.
 */
export class EntityRef<TMessage = unknown> extends ActorRef<TMessage> {
  readonly path: ActorPath;

  constructor(
    private readonly region: ActorRef<unknown>,
    readonly typeName: string,
    readonly entityId: string,
    numShards: number,
    systemName: string,
  ) {
    super();
    this.path = new ActorPath('', null, systemName)
      .child('user')
      .child(`sharding-${typeName}`)
      .child(shardName(hashShardId(entityId, numShards)))
      .child(entityName(entityId));
  }

  override tell(message: TMessage, sender: ActorRef | null = null): void {
    const envelope: EntityEnvelope = {
      $t: 'sharding.EntityEnvelope',
      entityId: this.entityId,
      message,
    };
    this.region.tell(envelope as never, sender);
  }
}
