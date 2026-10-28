import type { ActorClassOrFactory } from '../../Actor.js';
import type { ActorOptions, ActorOptionsType } from '../../ActorOptions.js';
import { match, P } from 'ts-pattern';
import { Actor } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import { exponentialBackoff, type BackoffPolicy } from '../../pattern/BackoffPolicy.js';
import type { Cancellable } from '../../Scheduler.js';
import { DeadLetter, Terminated } from '../../SystemMessages.js';
import { BidirectionalMap } from '../../util/BidirectionalMap.js';
import { Passivate } from './Passivate.js';
import {
  DEFAULT_ENTITY_RESTART_BACKOFF_MAX_MS,
  DEFAULT_ENTITY_RESTART_BACKOFF_MIN_MS,
  DEFAULT_ENTITY_RESTART_BACKOFF_RANDOM_FACTOR,
  DEFAULT_ENTITY_RESTART_BACKOFF_RESET_AFTER_MS,
  DEFAULT_PASSIVATION_STOP_TIMEOUT_MS,
  DEFAULT_SHARD_REGION_BUFFER_SIZE,
} from './ShardingOptions.js';
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
  /**
   * How long an entity sent its `Passivate` stop-message may take to stop
   * before the shard stops it outright, in ms; `0` waits forever (#848).
   *
   * Optional, and absent means the same as `0`.  This type is exported from
   * `actor-ts/cluster`, so an application may build one — and a field it cannot
   * know about must not change what its shard does.  While it was required the
   * absence was not even inert: `undefined <= 0` is false and `setTimeout`
   * reads `undefined` as zero, so a `ShardConfig` written against the previous
   * release force-stopped every cooperative passivation on the next tick.
   */
  readonly passivationStopTimeoutMs?: number;
  /**
   * The first wait before this shard re-creates an entity that stopped without
   * being passivated, in ms (#1437) — `ShardingOptionsType.entityRestartBackoffMinMs`,
   * which says what the four `entityRestartBackoff*` fields do.
   *
   * Optional for the reason {@link passivationStopTimeoutMs} is, but absent
   * means the opposite kind of default: the `DEFAULT_ENTITY_RESTART_BACKOFF_*`
   * values, not "off".  The stop timeout is an opt-in deadline on a drain the
   * entity chose, and arming it for a caller who never asked would abandon
   * flushes; this backoff is a safety default, like the region's buffer bound,
   * and a shard built from a `ShardConfig` that predates it must not re-create
   * a failing entity per message.  A ceiling below the first wait — one of the
   * pair set, the other defaulted — is raised to the first wait rather than
   * refused, since a shard has nobody to refuse it to.
   */
  readonly entityRestartBackoffMinMs?: number;
  /** The ceiling the wait doubles up to, in ms (#1437); absent means `DEFAULT_ENTITY_RESTART_BACKOFF_MAX_MS`. */
  readonly entityRestartBackoffMaxMs?: number;
  /** The jitter on every wait, in `[0, 1]` (#1437); absent means `DEFAULT_ENTITY_RESTART_BACKOFF_RANDOM_FACTOR`. */
  readonly entityRestartBackoffRandomFactor?: number;
  /** How long an entity has to go without stopping unasked to start again at the first wait, in ms (#1437); absent means `DEFAULT_ENTITY_RESTART_BACKOFF_RESET_AFTER_MS`. */
  readonly entityRestartBackoffResetAfterMs?: number;
  /**
   * How many messages this shard holds, across all of its entities, for the
   * ones waiting out their restart backoff (#1437); past it the newest is
   * dead-lettered with its sender.  Absent means
   * `DEFAULT_SHARD_REGION_BUFFER_SIZE` — a safety default like the four above.
   * The region passes its own `bufferSize`, so one setting bounds both
   * buffers: the region's across every shard, this one per shard.
   */
  readonly bufferSize?: number;
};

/** What a shard accepts from the outside — its region, or a holder of its ref. */
export type ShardMessage<TMessage = unknown> =
  | EntityEnvelope<TMessage>
  | PassivateEntity
  | StartEntities
  | StartEntity
  | GetShardStats;

/**
 * "The graceful stop window for one entity ran out" — the shard telling itself,
 * on a timer (#848).
 *
 * A class rather than a `sharding.`-kinded object, for the two reasons
 * `EntityRecoveryTick` in `ShardRegion` already spells out: a remote frame
 * arrives as decoded plain data, so nothing off the wire can be `instanceof`
 * this and no peer can force another node's entity to stop; and the timer's
 * callback only ever *sends* it, so the state it mutates is touched on the
 * shard's own turn rather than inside the scheduler (#952).
 */
export class EntityStopTimeout {
  constructor(readonly entityId: string) {}
}

/**
 * "A backing-off entity's wait is over" — the shard telling itself, on a timer
 * (#1437).
 *
 * The shape of {@link EntityStopTimeout}, for its two reasons: nothing off the
 * wire can be `instanceof` it, so no peer can make another node re-create an
 * entity early; and the timer only sends it, so the re-creation runs on the
 * shard's turn, behind whatever was queued first (#952).
 */
export class EntityRestartTick {
  constructor(readonly entityId: string) {}
}

/**
 * "Stop, unless you still have work" — the region's empty-shard sweep asking
 * a shard to go away (#1441).
 *
 * The region judges a shard empty by its own index, and that index lags the
 * shard: an entity that a routed message or a recovery start has just created
 * is reported only once the shard has run, behind the sweep's tick, and what a
 * shard holds for an entity backing off is not reported at all.  A stop sent
 * on that view alone went in behind the very work the region had just handed
 * over, and took it down with the shard.  So the shard has the last word: it
 * reads the request behind everything it was sent first and stops only if it
 * has nothing to lose; otherwise it answers {@link ShardPassivationDeclined}
 * and goes on.
 *
 * A class rather than a `sharding.`-kinded object, for the reason
 * {@link EntityStopTimeout} is one: nothing off the wire can be `instanceof`
 * it, so no peer can stop another node's shard.  It names the shard it was
 * meant for, which is what a dead letter shows when the shard was already gone.
 */
export class ShardPassivationRequest {
  constructor(readonly shardId: number) {}
}

/**
 * A shard's answer to a {@link ShardPassivationRequest} it did not honour: it
 * still had work, so it keeps running and its region routes to it again
 * (#1441).  A class for the request's reason.
 */
export class ShardPassivationDeclined {
  constructor(readonly shardId: number) {}
}

/** Everything a shard can find in its mailbox, including system traffic. */
export type ShardInbox =
  | ShardMessage
  | Terminated
  | Passivate
  | EntityStopTimeout
  | EntityRestartTick
  | ShardPassivationRequest;

/**
 * One message held for a passivating entity, with the sender it arrived with.
 *
 * The sender is half of the message, not metadata about it: an entity that
 * answers `this.sender` answers whoever is recorded here, and the replay is
 * the only delivery the message ever gets.  Holding the message alone made
 * every `ask` that landed in a passivation window time out, while one
 * answered through a `replyTo` inside the message went through.
 */
type BufferedMessage = {
  readonly message: unknown;
  readonly sender: ActorRef | null;
};

type EntityState = {
  readonly ref: ActorRef<unknown>;
  /** Non-null while the entity is passivating: messages buffered to flush on the next create. */
  passivating: BufferedMessage[] | null;
  /**
   * Armed while a *cooperative* stop is outstanding — the `Passivate` path,
   * where the entity was asked rather than told.  `null` on every other path,
   * including `PassivateEntity`, which stops the entity outright and has
   * nothing to wait for.
   */
  stopTimer: Cancellable | null;
};

/**
 * An entity's run of stops nobody asked for, and the wait it is in (#1437).
 *
 * The shard cannot see why an entity stopped: `Terminated` carries no cause,
 * and the supervision decision is taken in the shard's own cell.  So the
 * signal is the stop itself — every one but a passivation, which is the one
 * stop this shard asks for.  That covers a failure past the restart budget, a
 * start or recovery that keeps failing, a recovery failure the entity
 * swallowed, a lost lease and a plain `stopSelf` alike, and it is the one place
 * all of them meet.
 *
 * Measured from when the entity came back — the end of its last wait — and not
 * from when its current incarnation was created, for the reason the region's
 * shard backoff gives: an entity re-created by a message long after its wait
 * stops a few milliseconds into that incarnation however long it had gone
 * without stopping.  That also makes a record whose wait ended `reset-after`
 * ago, with nothing held, worth exactly as much as no record at all, which is
 * what lets {@link Shard.pruneRestartRecords} drop it without changing a
 * decision.
 */
type EntityRestartRecord = {
  /** Stops that counted toward the current run; the next one waits `delayFor(attempts)`. */
  attempts: number;
  /** When the current wait ends, on `system.clock` — and so when the entity counts as back. */
  blockedUntil: number;
  /** What arrived for the entity inside its wait, oldest first, each with its sender. */
  readonly held: BufferedMessage[];
  /** The one-shot that ends the wait, armed by the first hold or a start; `null` otherwise. */
  timer: Cancellable | null;
  /**
   * Whether a message for the entity has reached this shard since the entity
   * was last reported stopped and not created since — held, or past the cap
   * and dead-lettered.  The region counts an entity resident from the moment
   * it routes it a message, so this is when it counts the entity resident with
   * no incarnation behind it, and when a `PassivateEntity` is owed an
   * `EntityStopped` to release the slot (#1437).
   */
  messageSinceStop: boolean;
};

/**
 * One shard of a sharded type — child of its `ShardRegion`, parent of the
 * entities whose id hashes into it.  Its entire job is the **entity
 * lifecycle**: spawn, watch, stop, and buffer traffic for an entity that is
 * on its way out, or backing off after a stop nobody asked for.
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
  /**
   * One record per entity that stopped without being passivated, in the order
   * of their last stops — the order {@link pruneRestartRecords} relies on.
   */
  private readonly restarts = new Map<string, EntityRestartRecord>();
  /** Messages held across every record, against {@link holdLimit}. */
  private heldCount = 0;
  /** Latched by the first message dropped over the limit, released once nothing is held. */
  private warnedHoldFull = false;
  private readonly restartBackoff: BackoffPolicy;

  constructor(public readonly config: ShardConfig) {
    super();
    // Built once, from the resolved config.  A `ShardConfig` an application
    // builds never passed the options validator, and with one of the pair set
    // and the other defaulted the two can cross: the ceiling gives way rather
    // than the shard failing to start.
    const minMs = config.entityRestartBackoffMinMs ?? DEFAULT_ENTITY_RESTART_BACKOFF_MIN_MS;
    this.restartBackoff = exponentialBackoff({
      minMs,
      maxMs: Math.max(minMs, config.entityRestartBackoffMaxMs ?? DEFAULT_ENTITY_RESTART_BACKOFF_MAX_MS),
      randomFactor: config.entityRestartBackoffRandomFactor ?? DEFAULT_ENTITY_RESTART_BACKOFF_RANDOM_FACTOR,
    });
  }

  /**
   * The cooperative-stop bound this shard runs under.  Resolved once here
   * rather than at each read so an absent field and an explicit `0` cannot
   * drift apart — they are the same instruction.
   */
  private get stopTimeoutMs(): number {
    return this.config.passivationStopTimeoutMs ?? DEFAULT_PASSIVATION_STOP_TIMEOUT_MS;
  }

  private get restartResetAfterMs(): number {
    return this.config.entityRestartBackoffResetAfterMs ?? DEFAULT_ENTITY_RESTART_BACKOFF_RESET_AFTER_MS;
  }

  private get holdLimit(): number {
    return this.config.bufferSize ?? DEFAULT_SHARD_REGION_BUFFER_SIZE;
  }

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
      // Ahead of the two timer messages, whose classes have the same shape:
      // the matcher's types tell classes apart by shape alone, so the arm
      // after `EntityStopTimeout` is typed with whatever shape is left.
      .with(P.instanceOf(ShardPassivationRequest), () => this.onShardPassivationRequest())
      .with(P.instanceOf(EntityStopTimeout), (m) => this.onEntityStopTimeout(m))
      .with(P.instanceOf(EntityRestartTick), (m) => this.onEntityRestartTick(m))
      .otherwise((m) => this.onUnhandled(m));
  }

  /**
   * Nothing outlives the shard.  Without this a shard stopped mid-passivation —
   * a handoff, an empty-shard sweep, a node shutting down — leaves a scheduler
   * entry holding a ref to an entity that is already gone.
   *
   * What a backing-off entity was holding has nowhere to go once its shard is
   * gone, so it goes to dead letters, each message with its sender, instead of
   * vanishing with the shard.
   */
  override postStop(): void {
    for (const state of this.entities.values()) {
      state.stopTimer?.cancel();
      state.stopTimer = null;
    }
    for (const record of this.restarts.values()) {
      record.timer?.cancel();
      record.timer = null;
      for (const { message, sender } of record.held.splice(0)) {
        this.system.deadLetters.tell(new DeadLetter(message, sender, this.self));
      }
    }
    this.restarts.clear();
    this.heldCount = 0;
  }

  /** Number of live entities — the region mirrors this for its stats replies. */
  get entityCount(): number { return this.entities.size; }

  /**
   * @internal How many entities this shard keeps a restart record for —
   * what the bound on that bookkeeping is pinned by.  Nothing in the
   * framework reads it.
   */
  get _restartRecordCount(): number { return this.restarts.size; }

  /* ------------------------------ Handlers ------------------------------- */

  private onEntityEnvelope(message: EntityEnvelope): void {
    this.deliver(message.entityId, message.message, this.sender.toNullable());
  }

  /**
   * The region's passivation of one entity — idle, or evicted for a newcomer.
   *
   * An entity backing off has no incarnation to stop, but the region may still
   * count it resident: it was routed a message since its stop was reported,
   * which is what admits an entity there.  Only an `EntityStopped` releases
   * that slot, so then the request is answered with one.  What the entity holds
   * keeps waiting, and its wait keeps running: the passivation is the region's
   * bookkeeping, not a reason to drop what callers sent (#1437).
   *
   * Otherwise it is answered with nothing.  A request can be on its way while
   * the entity stops by itself, and arrive once that stop has been reported;
   * answering it reported the one stop twice, and under `rememberEntities` the
   * coordinator persisted a second `stopped`.  So is a second request for the
   * residency one answer has already released.
   */
  private onPassivateEntity(message: PassivateEntity): void {
    const state = this.entities.get(message.entityId);
    if (!state) {
      const record = this.restarts.get(message.entityId);
      if (record?.messageSinceStop === true) {
        record.messageSinceStop = false;
        this.notifyRegion({ kind: 'sharding.EntityStopped', shardId: this.config.shardId, entityId: message.entityId });
      }
      return;
    }
    if (state.passivating) return;
    // Buffer from here on; the entity drains its mailbox and stops, and
    // `onEntityTerminated` replays whatever arrived in the meantime.
    state.passivating = [];
    state.ref.stop();
  }

  private onStartEntities(message: StartEntities): void {
    for (const entityId of message.entityIds) this.startEntity(entityId);
  }

  private onStartEntity(message: StartEntity): void {
    this.startEntity(message.entityId);
  }

  /**
   * A backing-off entity's wait is over: re-create it and hand it, in order,
   * what waited for it, each message from the sender it arrived with (#1437).
   *
   * A tick whose record has no timer armed any more is stale and does nothing:
   * the timer fired, and before the tick was read the wait was disarmed — by a
   * message that found the wait over and created the entity itself, or by the
   * record going.  Nothing can re-arm in between, since every hold and start
   * that could is queued behind the tick.
   */
  private onEntityRestartTick(tick: EntityRestartTick): void {
    const record = this.restarts.get(tick.entityId);
    if (record === undefined || record.timer === null) return;
    record.timer = null;
    // The tick is what ends the wait.  A timer may fire a millisecond before
    // the clock reads its end, and a wait still open by that millisecond would
    // send the replay below straight back into the hold.
    record.blockedUntil = Math.min(record.blockedUntil, this.system.clock.now());
    const held = record.held.splice(0);
    this.releaseHeld(held.length);
    const state = this.entities.get(tick.entityId) ?? this.createEntity(tick.entityId);
    for (const { message, sender } of held) state.ref.tell(message as never, sender);
  }

  /**
   * The region's empty-shard sweep asking this shard to go away (#1441) — see
   * {@link ShardPassivationRequest} for why the shard is the one to decide.
   *
   * Read behind everything the region sent before it, so whatever it handed
   * over has been applied by now: a routed message has created its entity, a
   * recovery start its remembered one.  An idle shard stops through the system
   * lane, as the `PoisonPill` it replaces did, so nothing queued behind the
   * request runs first — the region buffers what it routes from the moment it
   * asked, so none of its own traffic is there.  A busy one says so and goes
   * on, and the region routes to it again.
   */
  private onShardPassivationRequest(): void {
    if (this.isIdle()) {
      this.context.stopSelf();
      return;
    }
    const declined = new ShardPassivationDeclined(this.config.shardId);
    this.context.parent.toNullable()?.tell(declined as never);
  }

  /**
   * Whether stopping this shard would lose nothing: no entity, running or
   * passivating — the one created by the routed message or the recovery start
   * just ahead of the request included — and no entity backing off: none
   * holding messages, none whose return a start has armed, none still inside
   * its wait (#1437).
   *
   * Those last three are why the region cannot judge this alone: an entity
   * backing off has reported its stop, so the region's index already counts
   * the shard empty, while the shard holds the messages that arrived for it
   * and the record that makes the wait a wait.  Stopped then, the shard took
   * both along — the messages to dead letters, the record so that the next
   * message created the entity at once, its backoff started over at `min`.
   * The wait counts with nothing held for that reason.  A record whose wait is
   * over decides nothing a missing one would not, apart from how long the next
   * wait is, so it does not keep the shard.
   */
  private isIdle(): boolean {
    if (this.entities.size > 0) return false;
    for (const record of this.restarts.values()) {
      if (record.timer !== null || this.isHeldDown(record)) return false;
    }
    return true;
  }

  /**
   * Answer a stats query — or decline one that names nowhere to answer.
   *
   * `replyTo` is typed as a ref, and an `ask` always supplies one, but the
   * type is a promise the sender keeps rather than one the shard can rely on:
   * a plain `tell` can leave it out, or put something there that is no ref at
   * all.  Calling `tell` on that threw inside the shard, the region's
   * supervisor restarted it, and the restart took every entity of the shard
   * down with it while the region went on counting them.  A query with no ref
   * to answer is declined like any other message the shard cannot act on.
   *
   * What counts as a ref is asked by shape — see {@link isReplyRef} — so a ref
   * minted by another copy of this module is answered (#1441).
   */
  private onGetShardStats(message: GetShardStats): void {
    if (!isReplyRef(message.replyTo)) {
      this.unhandled(message);
      return;
    }
    message.replyTo.tell({
      kind: 'sharding.ShardStats',
      shardId: this.config.shardId,
      entityCount: this.entities.size,
      entityIds: Array.from(this.entities.keys()),
    });
  }

  /**
   * An entity asking to be stopped — `this.context.parent.tell(new Passivate(...))`.
   *
   * The stop-message contract is cooperative: the entity is *told what to send
   * itself*, and it decides when to act on it — finish in-flight work, flush
   * state, then terminate.  Until #848 that was cooperative with no backstop.
   * An entity that never acted on the message never terminated, so `Terminated`
   * never fired, `EntityStopped` never reached the region, and the entity held
   * its slot against `maxEntities` for the lifetime of the node while the shard
   * buffered every message addressed to it.  The timer is that backstop.
   */
  private onPassivate(message: Passivate): void {
    const candidate = message.entity ?? this.sender.toNullable();
    if (!candidate) return;
    const entityId = this.entityPaths.getKey(candidate.path.toString());
    if (entityId === undefined) return;
    const state = this.entities.get(entityId);
    if (!state) return;
    state.passivating = [];
    candidate.tell(message.stopMessage as never);
    this.armStopTimeout(entityId, state);
  }

  /**
   * The cooperative window expired.  `stop()` is the unignorable path
   * {@link onPassivateEntity} already uses, so a forced passivation and a
   * region-driven one end identically — the entity's `postStop` still runs and
   * a persistent one still finishes its shutdown.
   *
   * Re-read from the map rather than closed over: between arming the timer and
   * this arriving the entity may have stopped on its own, or the shard may have
   * re-created it after a `Terminated`, and either way the state object that
   * was armed is not the one to act on.
   */
  private onEntityStopTimeout(message: EntityStopTimeout): void {
    const state = this.entities.get(message.entityId);
    if (!state || state.stopTimer === null) return;
    state.stopTimer = null;
    this.log.warn(
      `[sharding] entity '${message.entityId}' in shard ${this.config.shardId} of `
      + `'${this.config.typeName}' did not stop within ${this.stopTimeoutMs}ms `
      + 'of its passivation stop-message; stopping it',
    );
    state.ref.stop();
  }

  /**
   * An entity stopped.  The region hears of it either way, as before the
   * backoff existed (#954 owns what that report means).
   *
   * A stop this shard asked for — a passivation — replays what arrived during
   * it, which re-creates the entity at once.  Any other stop backs the entity
   * off before anything re-creates it ({@link backOffEntity}): without that,
   * an entity past its restart budget was re-created by the very next message
   * for it, and one failing on every message was re-created per message.
   */
  private onEntityTerminated(message: Terminated): void {
    const entityId = this.entityPaths.getKey(message.actor.path.toString());
    if (entityId === undefined) return;
    const existing = this.entities.get(entityId);
    existing?.stopTimer?.cancel();
    const buffered = existing?.passivating ?? null;
    this.entities.delete(entityId);
    this.entityPaths.delete(entityId);
    this.notifyRegion({ kind: 'sharding.EntityStopped', shardId: this.config.shardId, entityId });
    if (buffered === null) {
      this.backOffEntity(entityId);
      return;
    }
    // Recreates the entity and hands it everything that arrived while it
    // was shutting down — same contract the region used to provide, each
    // message from the sender it arrived with.
    for (const pending of buffered) this.deliver(entityId, pending.message, pending.sender);
  }

  /**
   * Whatever no arm above claims.  A shard ref is a public, remotely
   * addressable handle, so this is what a caller tells it that is not a shard
   * message at all — directly, or through a `RemoteShardRef` whose payload the
   * owning region forwards as it is — and a sharding kind that belongs to the
   * region or the coordinator rather than to a shard.
   *
   * Declined through `unhandled`, so it is a dead letter naming this shard and
   * a tick of `actor_unhandled_total{class="Shard"}`.  Healthy traffic never
   * reaches this arm — `tests/multi-node/ShardingUnhandledArms.test.ts` drives
   * a cluster through every kind of it and holds the counter at zero — so a
   * routine message pays nothing for the visibility.
   */
  private onUnhandled(message: unknown): void { this.unhandled(message); }

  /* ------------------------------ Internals ------------------------------ */

  /**
   * Arm the cooperative-stop backstop for one entity (#848).
   *
   * `0` — the default, and what an absent field resolves to — opts out and
   * waits forever, which is what every release before #848 did.  An entity
   * whose graceful shutdown genuinely has no bound (draining a long-running
   * job) is a real shape, and there a forced stop is the bug rather than the
   * fix; the operator who knows the drain is the one who sets a bound.
   *
   * The callback only ever sends: the state it has to clear lives on the
   * shard's turn, and mutating it from the scheduler is the shape #952 was
   * about.
   */
  private armStopTimeout(entityId: string, state: EntityState): void {
    const timeoutMs = this.stopTimeoutMs;
    if (timeoutMs <= 0 || state.stopTimer !== null) return;
    state.stopTimer = this.system.scheduler.scheduleOnceFunction(
      timeoutMs,
      () => { this.self.tell(new EntityStopTimeout(entityId)); },
    );
  }

  private deliver(entityId: string, message: unknown, sender: ActorRef | null): void {
    const existing = this.entities.get(entityId);
    if (existing?.passivating) { existing.passivating.push({ message, sender }); return; }
    if (existing === undefined) {
      const record = this.restarts.get(entityId);
      if (record !== undefined && this.isHeldDown(record)) {
        // Held or over the cap, the region counted the entity resident to route it.
        record.messageSinceStop = true;
        this.hold(entityId, record, message, sender);
        return;
      }
      this.pruneRestartRecords();
    }
    const state = existing ?? this.createEntity(entityId);
    // Forward the original sender so ask-pattern replies bypass shard and
    // region and reach the caller directly.
    state.ref.tell(message as never, sender);
  }

  /** A `StartEntity` for one entity: create it now, or at the end of the wait it is in. */
  private startEntity(entityId: string): void {
    if (this.entities.has(entityId)) return;
    const record = this.restarts.get(entityId);
    if (record !== undefined && this.isHeldDown(record)) {
      // A start is a reason to come back as soon as the wait allows — under
      // `rememberEntities` it is how a remembered entity returns — not a
      // reason to come back now.
      this.armRestart(entityId, record);
      return;
    }
    this.createEntity(entityId);
  }

  /**
   * Whether an entity is still kept down: inside its wait, or with messages
   * held that the tick has yet to hand over.  Once the wait is over with
   * nothing held, the next message creates the entity at once.
   */
  private isHeldDown(record: EntityRestartRecord): boolean {
    return record.held.length > 0 || record.blockedUntil > this.system.clock.now();
  }

  /**
   * Keep a message for an entity in its wait, up to `bufferSize` across the
   * shard — the region's cap, applied here per shard (#1437).  Past it the
   * newest is dead-lettered with its sender, for the reason the region's own
   * buffer drops the newest: what is already held keeps the order it was sent
   * in.  The first message held arms the wait's end.
   */
  private hold(entityId: string, record: EntityRestartRecord, message: unknown, sender: ActorRef | null): void {
    if (this.heldCount >= this.holdLimit) {
      this.warnHoldFull();
      this.system.deadLetters.tell(new DeadLetter(message, sender, this.self));
      return;
    }
    record.held.push({ message, sender });
    this.heldCount++;
    this.armRestart(entityId, record);
  }

  /**
   * Arm the one-shot that ends an entity's wait, unless one is armed already.
   * Only ever *sends*: the entity is re-created on the shard's turn — see
   * {@link EntityRestartTick}.
   */
  private armRestart(entityId: string, record: EntityRestartRecord): void {
    if (record.timer !== null) return;
    record.timer = this.system.scheduler.scheduleOnceFunction(
      Math.max(0, record.blockedUntil - this.system.clock.now()),
      () => { this.self.tell(new EntityRestartTick(entityId)); },
    );
  }

  /**
   * Keep an entity that stopped without being passivated down for a while
   * before anything re-creates it (#1437).
   *
   * Each stop in a row doubles the wait, from `min` up to `max`, and an entity
   * that went `reset-after` without stopping since it came back starts the
   * count over — see {@link EntityRestartRecord} for why that is measured from
   * its return.  Supervision is not touched: the restarts inside the budget
   * stay immediate, and this is the wait after them.
   *
   * The record is moved to the back of {@link restarts}, which keeps the map
   * in the order of last stops for the prune.
   */
  private backOffEntity(entityId: string): void {
    const now = this.system.clock.now();
    let record = this.restarts.get(entityId);
    if (record === undefined) {
      record = { attempts: 0, blockedUntil: now, held: [], timer: null, messageSinceStop: false };
    } else {
      this.restarts.delete(entityId);
      if (now - record.blockedUntil >= this.restartResetAfterMs) record.attempts = 0;
    }
    const delayMs = this.restartBackoff.delayFor(record.attempts);
    record.attempts++;
    record.blockedUntil = now + delayMs;
    this.restarts.set(entityId, record);
    this.pruneRestartRecords();
    this.log.debug(
      `[sharding] entity '${entityId}' in shard ${this.config.shardId} of '${this.config.typeName}' stopped `
      + `without being passivated (stop ${record.attempts} in a row); re-creating it no sooner than `
      + `${Math.round(delayMs)} ms from now`,
    );
  }

  /**
   * Drop the records that can no longer change a decision: a wait over for
   * `reset-after`, with nothing held and nothing armed, decides exactly what no
   * record would — the entity is created at once, and its next stop waits the
   * first wait.
   *
   * Without this an entity that stopped once and was never addressed again
   * would keep its record for the life of the shard, one per id: unbounded,
   * over ids anybody can route to.  The map is in the order of last stops, so
   * the walk stops at the first record still in force; whatever is behind it
   * stopped later, and goes on a later call.  Run on every stop and every
   * creation from a message, so a record goes within one `max` plus
   * `reset-after` of its last stop, once the shard sees any traffic at all —
   * and a shard that sees none is passivated by its region with its records.
   */
  private pruneRestartRecords(): void {
    if (this.restarts.size === 0) return;
    const now = this.system.clock.now();
    for (const [entityId, record] of this.restarts) {
      if (record.held.length > 0 || record.timer !== null) return;
      if (now - record.blockedUntil < this.restartResetAfterMs) return;
      this.restarts.delete(entityId);
    }
  }

  /** `count` held messages left the hold; the warning is released once nothing is held. */
  private releaseHeld(count: number): void {
    this.heldCount -= count;
    if (this.heldCount === 0) this.warnedHoldFull = false;
  }

  /**
   * One line per overflow episode, naming the cap and both ways out of it.
   * Raising the cap only holds more of what an entity that keeps stopping
   * will not take, so the line points at the stops first.
   */
  private warnHoldFull(): void {
    if (this.warnedHoldFull) return;
    this.warnedHoldFull = true;
    const situation = this.holdLimit === 0
      ? 'holding is off (`buffer-size = 0`)'
      : `it already holds ${this.holdLimit} messages (\`buffer-size\`, counted per shard here)`;
    this.log.warn(
      `[sharding] shard ${this.config.shardId} of '${this.config.typeName}' cannot hold more messages for `
      + `entities backing off after a stop nobody asked for: ${situation} — dropping the newest to dead `
      + 'letters until one of them is back.  Look for the entity that keeps stopping, or raise the cap with '
      + '`StartShardingOptions.withBufferSize(n)` or `actor-ts.sharding.buffer-size`.',
    );
  }

  private createEntity(entityId: string): EntityState {
    // A start can have armed this entity's wait; created now by a message that
    // found the wait over, nothing is left for the tick to do.
    const record = this.restarts.get(entityId);
    if (record?.timer) {
      record.timer.cancel();
      record.timer = null;
    }
    // From here the incarnation's own stop is what reports the entity stopped.
    if (record !== undefined) record.messageSinceStop = false;
    this.log.debug(
      `[sharding] spawning entity '${entityId}' in shard ${this.config.shardId} of '${this.config.typeName}'`,
    );
    // The child name is a lossy rendering of the id (see `entityName`), so
    // the identity travels in the spawn options instead — that is the only
    // copy the entity can read back verbatim.  A fresh object per entity, and
    // the two framework-set fields last so a caller's own options can never
    // shadow them.
    //
    // `applicationOwned` because this shard is the framework's actor and the
    // class it is spawning is not (#862): the entity sits on a `/system` path
    // only because a region does, and system-wide application policy — the
    // global mailbox bound — has to reach it.
    const ref = this.context.spawn(this.config.entityActor, entityName(entityId), {
      ...(this.config.entityOptions as Partial<ActorOptionsType<unknown>> | undefined),
      entity: { entityId, typeName: this.config.typeName, shardId: this.config.shardId },
      applicationOwned: true,
    });
    this.context.watch(ref);
    const state: EntityState = { ref: ref as ActorRef<unknown>, passivating: null, stopTimer: null };
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
 * Whether a stats query's `replyTo` is something the shard can answer: a
 * callable `tell` and `equals` and a `path`, the members a ref offers.
 *
 * Asked by shape rather than by class, as `EventStream` asks of a subscriber
 * (#1433): a ref minted by another copy of this module — a second install of
 * the package, or one file loaded under two specifiers — fails `instanceof`
 * and works everywhere else (#1441).  Anything without those members, absent
 * or not an object at all, is declined.
 */
function isReplyRef(value: unknown): value is ActorRef {
  if (value === null || value === undefined) return false;
  if (typeof value !== 'object' && typeof value !== 'function') return false;
  const candidate = value as { tell?: unknown; equals?: unknown; path?: unknown };
  return typeof candidate.tell === 'function'
    && typeof candidate.equals === 'function'
    && candidate.path !== null
    && candidate.path !== undefined;
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
