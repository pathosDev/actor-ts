import type { Actor } from '../../Actor.js';

/**
 * Named, type-tagged identity for a sharded entity type — the sharding
 * counterpart to {@link SingletonKey}.  Ties the `typeName` string and the
 * message type together so `start()`, `entityRefFor()` and `startProxy()` hand
 * back a correctly-typed `ActorRef` without the caller repeating either.
 *
 * ```ts
 * class UserActor extends PersistentActor<UserCommand, UserEvent, UserState> {
 *   static readonly shard = ShardKey.of<UserCommand>('user', (command) => command.userId);
 * }
 *
 * const users = cluster.sharding.start(UserActor);
 * const user = cluster.sharding.entityRefFor(UserActor, 'user-42');
 * ```
 *
 * The explicit type argument is load-bearing: without it the key infers
 * `ShardKey<unknown>` and every ref taken from it degrades to
 * `ActorRef<unknown>`.
 */
export class ShardKey<TCommand = unknown> {
  /** Phantom field — retains TCommand so inference round-trips through the key. */
  readonly _command!: TCommand;

  constructor(
    public readonly typeName: string,
    /**
     * How a command names its entity.
     *
     * It rides along on the key so the declaring class is the single source of
     * truth for both halves of "what this entity type is" — but it is NOT part
     * of the identity, and {@link equals} ignores it.  A node that only looks
     * entities up (`entityRefFor`, `startProxy`) never routes by extraction, so
     * it can name the same type with a key that omits the extractor entirely.
     * An `extractEntityId` passed in options wins over this one.
     */
    public readonly extractEntityId?: (command: TCommand) => string,
  ) {}

  static of<TCommand>(
    typeName: string,
    extractEntityId?: (command: TCommand) => string,
  ): ShardKey<TCommand> {
    return new ShardKey<TCommand>(typeName, extractEntityId);
  }

  // Typed on TCommand rather than `ShardKey<unknown>`: the extractor puts
  // TCommand in a parameter position, so the type is invariant and a
  // `ShardKey<Command>` would not be assignable to a `ShardKey<unknown>`
  // parameter.  Comparing keys of different entity types is meaningless anyway.
  equals(other: ShardKey<TCommand>): boolean { return this.typeName === other.typeName; }
  toString(): string { return `ShardKey(${this.typeName})`; }
}

/**
 * A class that declares its own sharded-entity identity as a static.
 *
 * The static is the carrier because TypeScript's `implements` constrains only
 * the instance side of a class — see {@link SingletonKeyedClass} for the full
 * reasoning.  It also composes with any base class, which matters because a
 * sharded entity is usually a `PersistentActor`.
 */
export type ShardKeyedClass<TCommand> = {
  readonly shard: ShardKey<TCommand>;
};

/**
 * …and constructs with no arguments, so passing the class alone is enough.
 * An entity with a dependency-injecting constructor satisfies
 * {@link ShardKeyedClass} but not this, which routes it to the
 * `start(TheClass, factory)` overload.
 */
export interface ShardEntityClass<TCommand> extends ShardKeyedClass<TCommand> {
  new (): Actor<TCommand>;
}

/** Anything that names a sharded entity type: its key, or the class declaring it. */
export type ShardReference<TCommand = unknown> =
  | ShardKey<TCommand>
  | ShardKeyedClass<TCommand>
  | string;

/** Narrow any {@link ShardReference} to the key it names. */
export function shardKeyOf<TCommand>(reference: ShardReference<TCommand>): ShardKey<TCommand> {
  if (typeof reference === 'string') return ShardKey.of<TCommand>(reference);
  if (reference instanceof ShardKey) return reference;
  return reference.shard;
}
