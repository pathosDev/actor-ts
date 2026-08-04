/**
 * Sharding identity of an actor that `ClusterSharding` started as an entity:
 * the id it was routed by, and where that routing put it.
 *
 * It lives in core rather than under `cluster/sharding/` because `ActorOptions`
 * carries it in and `ActorContext` hands it out — the runtime has to be able
 * to give an actor its own identity without core depending on the cluster
 * layer.
 *
 * The id cannot be recovered from the actor's path: `Shard` folds every
 * character outside `[A-Za-z0-9_-]` to `_` to make a legal child name, so
 * `user:42` and `user/42` share a path but are two different entities.  This
 * is the only place the routed value survives verbatim.
 */
export type EntityContext = {
  /** The id `extractEntityId` produced, unmodified. */
  readonly entityId: string;

  /** Sharded type this entity belongs to — `StartShardingOptions.typeName`. */
  readonly typeName: string;

  /** Shard hosting it — `hash(entityId) % numShards`. */
  readonly shardId: number;
};
