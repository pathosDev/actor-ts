import type { ActorClassOrFactory } from '../../Actor.js';
import type { ActorOptions, ActorOptionsType } from '../../ActorOptions.js';
import { match, P } from 'ts-pattern';
import { Actor } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import { Terminated } from '../../SystemMessages.js';
import { BidirectionalMap } from '../../util/BidirectionalMap.js';
import { Passivate } from './Passivate.js';
import type {
  EntityEnvelope,
  EntityStarted,
  EntityStopped,
  GetShardStats,
  PassivateEntity,
  StartEntities,
  StartEntity,
} from './ShardingProtocol.js';

export type ShardConfig = {
  readonly typeName: string;
  readonly shardId: number;
  readonly entityActor: ActorClassOrFactory<unknown>;
  readonly entityOptions?: ActorOptions<unknown>;
};

/** What a shard accepts from the outside — its region, or a holder of its ref. */
export type ShardMessage<TMessage = unknown> =
  | EntityEnvelope<TMessage>
  | PassivateEntity
  | StartEntities
  | StartEntity
  | GetShardStats;

/** Everything a shard can find in its mailbox, including system traffic. */
export type ShardInbox = ShardMessage | Terminated | Passivate;

type EntityState = {
  readonly ref: ActorRef<unknown>;
  /** Non-null while the entity is passivating: messages buffered to flush on the next create. */
  passivating: unknown[] | null;
};

/**
 * One shard of a sharded type — child of its `ShardRegion`, parent of the
 * entities whose id hashes into it.  Its entire job is the **entity
 * lifecycle**: spawn, watch, stop, and buffer traffic for an entity that is
 * on its way out.
 *
 * Routing, buffering and coordinator bookkeeping stay in the region; the
 * *policy* decisions about when to passivate stay there too (the region sees
 * every message on this node, a single shard only sees its own slice).  The
 * shard just executes {@link PassivateEntity}.  Keeping it that thin is what
 * lets `maxEntities` go on meaning "per node" rather than silently becoming
 * "per shard".
 *
 * Being a real actor is the point: a shard now has a path
 * (`/system/cluster/sharding/region-<type>/shard-<n>`), so it is addressable
 * from anywhere in
 * the cluster, it shows up in the actor tree, and handoff is simply "stop the
 * shard" — the runtime terminates the entities underneath and only then
 * reports back.
 */
export class Shard extends Actor<ShardInbox> {
  private readonly entities = new Map<string, EntityState>();
  /**
   * Entity id ↔ the entity's actor path.
   *
   * `Passivate` and `Terminated` arrive carrying a ref and nothing else, so
   * both used to find their entity by scanning every entry in `entities` —
   * O(n) per stop, and therefore O(n²) to drain a shard during handoff, on
   * the one path that runs once per entity rather than once per system.
   *
   * The path *string* is indexed rather than the ref, because that is what
   * `ActorRef.equals` compares: two refs to the same entity are equal without
   * being the same object, so a ref-keyed map would miss.
   */
  private readonly entityPaths = new BidirectionalMap<string, string>();

  constructor(public readonly config: ShardConfig) { super(); }

  /**
   * Arm order is deliberate: every message to an entity lands here, and the
   * two `instanceOf` checks are the expensive ones — putting the envelope
   * first keeps the hot path a single string comparison.
   */
  override onReceive(message: ShardInbox): void {
    match(message)
      .with({ kind: 'sharding.EntityEnvelope' }, (m) => this.onEntityEnvelope(m))
      .with({ kind: 'sharding.PassivateEntity' }, (m) => this.onPassivateEntity(m))
      .with({ kind: 'sharding.StartEntities' }, (m) => this.onStartEntities(m))
      .with({ kind: 'sharding.StartEntity' }, (m) => this.onStartEntity(m))
      .with({ kind: 'sharding.GetShardStats' }, (m) => this.onGetShardStats(m))
      .with(P.instanceOf(Terminated), (m) => this.onEntityTerminated(m))
      .with(P.instanceOf(Passivate), (m) => this.onPassivate(m))
      .otherwise(() => this.onUnhandled());
  }

  /** Number of live entities — the region mirrors this for its stats replies. */
  get entityCount(): number { return this.entities.size; }

  /* ------------------------------ Handlers ------------------------------- */

  private onEntityEnvelope(message: EntityEnvelope): void {
    this.deliver(message.entityId, message.message, this.sender.toNullable());
  }

  private onPassivateEntity(message: PassivateEntity): void {
    const state = this.entities.get(message.entityId);
    if (!state || state.passivating) return;
    // Buffer from here on; the entity drains its mailbox and stops, and
    // `onEntityTerminated` replays whatever arrived in the meantime.
    state.passivating = [];
    state.ref.stop();
  }

  private onStartEntities(message: StartEntities): void {
    for (const entityId of message.entityIds) {
      if (this.entities.has(entityId)) continue;
      this.createEntity(entityId);
    }
  }

  private onStartEntity(message: StartEntity): void {
    if (this.entities.has(message.entityId)) return;
    this.createEntity(message.entityId);
  }

  private onGetShardStats(message: GetShardStats): void {
    message.replyTo.tell({
      kind: 'sharding.ShardStats',
      shardId: this.config.shardId,
      entityCount: this.entities.size,
      entityIds: Array.from(this.entities.keys()),
    });
  }

  /** An entity asking to be stopped — `this.context.parent.tell(new Passivate(...))`. */
  private onPassivate(message: Passivate): void {
    const candidate = message.entity ?? this.sender.toNullable();
    if (!candidate) return;
    const state = this.entityFor(candidate);
    if (!state) return;
    state.passivating = [];
    candidate.tell(message.stopMessage as never);
  }

  private onEntityTerminated(message: Terminated): void {
    const entityId = this.entityPaths.getKey(message.actor.path.toString());
    if (entityId === undefined) return;
    const buffered = this.entities.get(entityId)?.passivating ?? [];
    this.entities.delete(entityId);
    this.entityPaths.delete(entityId);
    this.notifyRegion({ kind: 'sharding.EntityStopped', shardId: this.config.shardId, entityId });
    // Recreates the entity and hands it everything that arrived while it
    // was shutting down — same contract the region used to provide.
    for (const pending of buffered) this.deliver(entityId, pending, null);
  }

  private onUnhandled(): void {
    /* region-side ShardingMessage variants; not ours */
  }

  /* ------------------------------ Internals ------------------------------ */

  /** The entity a ref belongs to, or null — `Passivate` and `Terminated` only carry a ref. */
  private entityFor(ref: ActorRef): EntityState | null {
    const entityId = this.entityPaths.getKey(ref.path.toString());
    return entityId === undefined ? null : this.entities.get(entityId) ?? null;
  }

  private deliver(entityId: string, message: unknown, sender: ActorRef | null): void {
    const existing = this.entities.get(entityId);
    if (existing?.passivating) { existing.passivating.push(message); return; }
    const state = existing ?? this.createEntity(entityId);
    // Forward the original sender so ask-pattern replies bypass shard and
    // region and reach the caller directly.
    state.ref.tell(message as never, sender);
  }

  private createEntity(entityId: string): EntityState {
    this.log.debug(
      `[sharding] spawning entity '${entityId}' in shard ${this.config.shardId} of '${this.config.typeName}'`,
    );
    // The child name is a lossy rendering of the id (see `entityName`), so
    // the identity travels in the spawn options instead — that is the only
    // copy the entity can read back verbatim.  A fresh object per entity, and
    // `entity` last so a caller's own options can never shadow it.
    const ref = this.context.spawn(this.config.entityActor, entityName(entityId), {
      ...(this.config.entityOptions as Partial<ActorOptionsType<unknown>> | undefined),
      entity: { entityId, typeName: this.config.typeName, shardId: this.config.shardId },
    });
    this.context.watch(ref);
    const state: EntityState = { ref: ref as ActorRef<unknown>, passivating: null };
    this.entities.set(entityId, state);
    this.entityPaths.set(entityId, ref.path.toString());
    this.notifyRegion({ kind: 'sharding.EntityStarted', shardId: this.config.shardId, entityId });
    return state;
  }

  /**
   * The region keeps the authoritative per-shard entity index — it needs it
   * for the passivation policies, for handoff logging and for stats replies —
   * so every create/terminate is reported one level up.
   */
  private notifyRegion(message: EntityStarted | EntityStopped): void {
    this.context.parent.toNullable()?.tell(message as never);
  }
}

/**
 * Characters an entity id may carry into a child name unchanged.  Everything
 * an actor name forbids is excluded (`/`, `\`, control characters), as is `~`,
 * which introduces an escape below.  The set is otherwise deliberately wide:
 * ordinary ids — `user-42`, `a.b@x.com`, `tenant:eu` — should read as
 * themselves in the DevTools tree and in log lines.
 */
const NAME_LITERAL = /[A-Za-z0-9_\-.@:+]/;

/**
 * Child name of the entity actor for `entityId` under its shard.  Entity ids
 * are user-supplied; actor names are not allowed to be, so the id is escaped.
 *
 * The escape is **injective**, and that is the whole point.  This used to fold
 * everything outside `[A-Za-z0-9_-]` to `_`, which is many-to-one: `user!31`
 * and `user#31` produced the same name, and — when they also hashed to the
 * same shard — the second one missed the shard's id-keyed `entities` map,
 * called `createEntity`, and `_createChild` threw `Child name … is not
 * unique`.  That throw takes down the Shard actor and every unrelated entity
 * living under it.  No attacker required: `a.b@x.com` and `a-b@x.com` collided
 * the same way (#568).
 *
 * A code unit outside {@link NAME_LITERAL} becomes `~` followed by four hex
 * digits.  Escaping per UTF-16 code unit rather than percent-encoding UTF-8
 * keeps the function **total**: `encodeURIComponent` throws `URIError` on a
 * lone surrogate, and a throw here lands inside `createEntity` — the very
 * failure this fix exists to remove.
 *
 * Nothing decodes this.  The path is a label; `entityId` on the entity context
 * is the value (see `EntityContext`).  That matters for more than style:
 * `parsePathSegments` deliberately does not percent-decode, and every remote
 * path consumer goes through it, so the name survives a round trip over the
 * wire byte-for-byte.  A future "improvement" that decodes a path segment
 * would reintroduce the collision.
 */
export function entityName(entityId: string): string {
  let escaped = '';
  for (let i = 0; i < entityId.length; i++) {
    const char = entityId[i]!;
    escaped += NAME_LITERAL.test(char)
      ? char
      : `~${entityId.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return `entity-${escaped}`;
}
