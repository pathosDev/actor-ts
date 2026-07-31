import { match, P } from 'ts-pattern';
import { Actor } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import type { Props } from '../../Props.js';
import { Terminated } from '../../SystemMessages.js';
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
  readonly entityProps: Props<unknown>;
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
 * (`/user/sharding-<type>/shard-<n>`), so it is addressable from anywhere in
 * the cluster, it shows up in the actor tree, and handoff is simply "stop the
 * shard" — the runtime terminates the entities underneath and only then
 * reports back.
 */
export class Shard extends Actor<ShardInbox> {
  private readonly entities = new Map<string, EntityState>();

  constructor(public readonly config: ShardConfig) { super(); }

  /**
   * Arm order is deliberate: every message to an entity lands here, and the
   * two `instanceOf` checks are the expensive ones — putting the envelope
   * first keeps the hot path a single string comparison.
   */
  override onReceive(message: ShardInbox): void {
    match(message)
      .with({ $t: 'sharding.EntityEnvelope' }, (m) => this.onEntityEnvelope(m))
      .with({ $t: 'sharding.PassivateEntity' }, (m) => this.onPassivateEntity(m))
      .with({ $t: 'sharding.StartEntities' }, (m) => this.onStartEntities(m))
      .with({ $t: 'sharding.StartEntity' }, (m) => this.onStartEntity(m))
      .with({ $t: 'sharding.GetShardStats' }, (m) => this.onGetShardStats(m))
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
      $t: 'sharding.ShardStats',
      shardId: this.config.shardId,
      entityCount: this.entities.size,
      entityIds: Array.from(this.entities.keys()),
    });
  }

  /** An entity asking to be stopped — `this.context.parent.tell(new Passivate(...))`. */
  private onPassivate(message: Passivate): void {
    const candidate = message.entity ?? this.sender.toNullable();
    if (!candidate) return;
    for (const state of this.entities.values()) {
      if (!state.ref.equals(candidate)) continue;
      state.passivating = [];
      candidate.tell(message.stopMessage as never);
      return;
    }
  }

  private onEntityTerminated(message: Terminated): void {
    for (const [entityId, state] of this.entities) {
      if (!state.ref.equals(message.actor)) continue;
      const buffered = state.passivating ?? [];
      this.entities.delete(entityId);
      this.notifyRegion({ $t: 'sharding.EntityStopped', shardId: this.config.shardId, entityId });
      // Recreates the entity and hands it everything that arrived while it
      // was shutting down — same contract the region used to provide.
      for (const pending of buffered) this.deliver(entityId, pending, null);
      return;
    }
  }

  private onUnhandled(): void {
    /* region-side ShardingMessage variants; not ours */
  }

  /* ------------------------------ Internals ------------------------------ */

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
    const ref = this.context.spawn(this.config.entityProps, entityName(entityId));
    this.context.watch(ref);
    const state: EntityState = { ref: ref as ActorRef<unknown>, passivating: null };
    this.entities.set(entityId, state);
    this.notifyRegion({ $t: 'sharding.EntityStarted', shardId: this.config.shardId, entityId });
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
 * Child name of the entity actor for `entityId` under its shard.  Entity ids
 * are user-supplied and actor names are not allowed to be, so anything outside
 * `[A-Za-z0-9_-]` is folded to `_`.
 */
export function entityName(entityId: string): string {
  return `entity-${entityId.replace(/[^A-Za-z0-9_\-]/g, '_')}`;
}
