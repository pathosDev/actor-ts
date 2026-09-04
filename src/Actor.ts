import type { ActorContext } from './ActorContext.js';
import type { ActorRef } from './ActorRef.js';
import type { ActorSystem } from './ActorSystem.js';
import type { Cluster } from './cluster/Cluster.js';
import type { EntityContext } from './EntityContext.js';
import { recordUnhandled } from './internal/Unhandled.js';
import type { Logger } from './Logger.js';
import { defaultStrategy, SupervisorStrategy } from './Supervision.js';
import type { Option } from './util/Option.js';

/**
 * Base class for user actors.  Subclasses must override `onReceive`.
 * Lifecycle hooks (preStart, postStop, preRestart, postRestart) have sensible
 * defaults but can be overridden.
 *
 * Actors are single-threaded by construction: the runtime guarantees that
 * onReceive is never invoked concurrently for the same actor.  If onReceive
 * returns a Promise, the runtime awaits it before starting the next message.
 */
export abstract class Actor<TMessage = unknown> {
  /** @internal — injected by ActorCell at construction time. */
  private _context!: ActorContext<TMessage>;

  /** @internal */
  _attach(context: ActorContext<TMessage>): void {
    this._context = context;
  }

  /** Runtime context. Only valid after the actor has been started. */
  protected get context(): ActorContext<TMessage> { return this._context; }

  protected get self(): ActorRef<TMessage> { return this._context.self; }
  protected get sender(): Option<ActorRef> { return this._context.sender; }
  protected get system(): ActorSystem { return this._context.system; }
  protected get log(): Logger { return this._context.log; }

  /**
   * The `Cluster` this actor runs in — membership, `selfAddress`,
   * `leader()`, and through it `sharding` / `singleton` (#833).  Removes
   * the need to thread a `Cluster` through the actor's constructor, which
   * a framework-constructed actor (a sharded entity, a singleton) has no
   * call site for in the first place.
   *
   * A *getter*, for the same reason `entityId` is one: the context is
   * attached after construction, so a `readonly cluster = ...` field
   * initializer would run too early.  Read it from `preStart` onwards.
   *
   * For "is this system clustered at all?" ask `this.context.cluster`,
   * which answers `None` rather than throwing.
   *
   * @throws if the enclosing `ActorSystem` never joined a cluster.
   */
  protected get cluster(): Cluster {
    const cluster = this._context?.cluster.toNullable() ?? null;
    if (cluster === null) {
      throw notClustered(this.constructor.name, this._context?.path.toString() ?? null);
    }
    return cluster;
  }

  /**
   * The id this entity was routed by — exactly what `extractEntityId`
   * returned, not the sanitized form in the actor path.  Stable for the
   * actor's whole life and across restarts.
   *
   * Readable from `preStart` onwards, which is what lets a sharded
   * `PersistentActor` build its journal stream out of it:
   *
   *     override get persistenceId(): string { return `cart-${this.entityId}`; }
   *
   * A *getter*, not a field initializer — the context is attached after
   * construction, so `readonly persistenceId = ...` would run too early.
   *
   * @throws if this actor is not a sharded entity — see {@link entity}.
   */
  protected get entityId(): string { return this.entity.entityId; }

  /**
   * Full sharding identity: {@link entityId} plus the type and shard it was
   * routed into.  For "am I an entity at all?" ask `this.context.entity`,
   * which answers `None` rather than throwing.
   *
   * @throws if `ClusterSharding` did not start this actor as an entity.
   *   That includes an entity's own children, which are not entities.
   */
  protected get entity(): EntityContext {
    const entity = this._context?.entity.toNullable() ?? null;
    if (entity === null) {
      throw notAShardedEntity(this.constructor.name, this._context?.path.toString() ?? null);
    }
    return entity;
  }

  /**
   * Main message handler.  Receives each envelope dequeued from the mailbox.
   * A thrown error (sync or async) is caught by the supervisor.
   */
  abstract onReceive(message: TMessage): void | Promise<void>;

  /**
   * Say that this actor was handed `message` and declined it — the blessed
   * body of an `.otherwise((m) => this.onUnhandled(m))` arm.
   *
   * The message becomes a `DeadLetter` naming **this actor** as recipient, so
   * it is published on the event stream, reaches the dead-letter queue when
   * one is turned on, and is logged by the throttled record #1000 added.  It
   * also ticks `actor_unhandled_total{class}`, which is the part routing to
   * dead letters does *not* supply: `actor_dead_letters_total` only moves
   * while `actor-ts.dead-letters.store` is on, and it is `off` by default.
   *
   * **Nothing detects this for you, by design.** The runtime cannot tell an
   * intentionally ignored message from a dropped one, so an `onReceive` that
   * simply returns still produces nothing at all.  Declining is a statement
   * the actor makes.
   *
   * ```ts
   * override onReceive(message: Command): void {
   *   match(message)
   *     .with({ kind: 'deposit' }, (m) => this.onDeposit(m))
   *     .otherwise((m) => this.onUnhandled(m));
   * }
   *
   * private onUnhandled(message: Command): void { this.unhandled(message); }
   * ```
   *
   * `unknown` rather than `TMessage`, because the arm that reaches here is
   * the un-narrowed remainder — and a framework actor at a resolvable path
   * receives whatever a remote peer addressed to it, which is not `TMessage`
   * at all.
   *
   * Not to be confused with the exported `unhandled` of the typed API
   * (`Behaviors.unhandled`, re-exported from the package root): that one is a
   * *sentinel a behavior returns*, and it lands on this same path from the
   * other side.  Two things named `unhandled`, one method and one factory.
   */
  protected unhandled(message: unknown): void {
    recordUnhandled(
      this.system, this.self, this.constructor.name, this.sender.toNullable(), message,
    );
  }

  /** Called after construction and before the first message is processed. */
  preStart(): void | Promise<void> {}

  /** Called after the actor has been terminated. Children are already stopped. */
  postStop(): void | Promise<void> {}

  /**
   * Called before a restart, on the instance about to be thrown away.
   * The default calls `postStop()` and nothing else.
   *
   * Override to release what the instance holds outside itself — a file
   * handle, an open socket, a broker connection — or to do something other
   * than drop the message that failed.
   *
   * Stopping this actor's children is **not** done here: the framework tears
   * them down after this hook returns and waits for them before building the
   * replacement, because `postRestart` re-runs `preStart` and a named child
   * needs its name back.  To keep the children instead, see
   * {@link Actor.stopChildrenOnRestart}.
   */
  preRestart(_reason: Error, _message?: TMessage): void | Promise<void> {
    return this.postStop();
  }

  /**
   * Whether a restart tears this actor's children down before rebuilding it.
   * Default: `true`.
   *
   * A restart replaces the `Actor` instance while the cell — and therefore
   * the child map — survives.  Keeping the children was the old behaviour and
   * it made an ordinary pattern impossible: `postRestart` re-runs `preStart`,
   * so an actor that spawns a *named* child there hit `Child name … is not
   * unique` on its first restart and never recovered (#634).
   *
   * Override to `false` when the children are expensive to rebuild, hold
   * state the parent cannot restore, or are supervised independently — a
   * connection pool, say.  They then outlive the restart exactly as before,
   * and it is on you to make `preStart` idempotent — by adopting the survivor
   * from the cell, `this.child = this.context.child('name').toNullable() ??
   * this.context.spawn(Child, 'name')`, or with `context.spawnAnonymous`.
   * An instance field cannot do it: `preStart` runs on a *fresh* instance
   * after every restart, so `this.child ??= …` is always unset and re-spawns
   * into the name the surviving child still holds, which fails the spawn and
   * restarts the actor again.
   *
   * This is a separate hook rather than a `preRestart` override because the
   * teardown has to be *awaited*: the new instance cannot be built until the
   * old children are actually gone, and `preRestart` has no way to tell the
   * cell that it started something worth waiting for.
   */
  stopChildrenOnRestart(): boolean { return true; }

  /** Called on the fresh instance after a restart.  Default: call preStart(). */
  postRestart(_reason: Error): void | Promise<void> {
    return this.preStart();
  }

  /**
   * Supervisor strategy for this actor's children.  Defaults to restart,
   * up to 10 times per minute, then stop.
   */
  supervisorStrategy(): SupervisorStrategy { return defaultStrategy; }

  /**
   * Human-readable name for this actor in log lines and in the DevTools
   * actor tree (#891).  Defaults to the full path — which is already the
   * log source, so an actor that doesn't override this logs exactly as it
   * did before.
   *
   *     override displayName(): string { return `User(${this.entityId})`; }
   *
   * Purely cosmetic.  The path stays the identity everywhere that routes,
   * correlates or aggregates — metric labels, tracing attributes, dead
   * letters, `ActorRef.toString()`, every wire identifier — so a display
   * name is free to be ambiguous, unstable, or shared between actors.
   *
   * **Resolved on every record**, not captured once.  Two consequences:
   * keep it cheap and side-effect free, and expect it to be called before
   * `preStart` (hence the optional chain — the context is attached after
   * construction).  In exchange a name may be derived from state, and it
   * updates when that state does.  Throwing, or returning anything but a
   * non-empty string, falls back to the path and warns once: a naming
   * hook must not be able to take a log line down with it.
   *
   * `ActorOptions.withDisplayName(...)` outranks this, for the same reason
   * `withSupervisorStrategy(...)` outranks {@link supervisorStrategy}
   * — the spawn site is the more specific statement.  It has to: every
   * `Behaviors` actor is a `TypedActor` that inherits this default, so a
   * method that won would silently swallow the spawn-site value for exactly
   * the actors that have no subclass to override.  For a name that only
   * becomes known at runtime, `this.context.setDisplayName(...)` outranks
   * both.
   */
  displayName(): string { return this._context?.path.toString() ?? this.constructor.name; }
}

/**
 * Builds a fresh actor instance.  A *factory*, not an instance, because the
 * runtime rebuilds the actor on every restart — handing over one instance
 * would resurrect the broken state the crash was supposed to discard.
 */
export type ActorFactory<TMessage> = () => Actor<TMessage>;

/**
 * What every spawning API accepts: the actor class itself, or a factory that
 * builds one.
 *
 * The class form covers the common case — a constructor that takes no
 * arguments needs no closure around it.  The factory form is how dependencies
 * get in (`() => new Worker(database)`), and it is also the escape hatch for
 * anything the class form cannot express.
 */
export type ActorClassOrFactory<TMessage> =
  | (new () => Actor<TMessage>)
  | ActorFactory<TMessage>;

/**
 * Module-level so the getters stay one-liners.  Names both plausible causes
 * — wrong actor, or right actor asked too early — because the two look
 * identical from the call site.
 */
function notAShardedEntity(className: string, path: string | null): Error {
  const where = path === null ? ' (before it was started)' : ` at ${path}`;
  return new Error(
    `${className}${where} is not a sharded entity — `
    + '`entityId` / `entity` are only set on actors ClusterSharding started, '
    + 'and not on an entity\'s own children.  Start it with `sharding.start(...)`, '
    + 'or give it an identity directly with '
    + '`system.spawn(TheEntity, name, { entity: { entityId, typeName, shardId } })`. '
    + 'Note the context is attached after construction: derive from `entityId` in a '
    + 'getter or in `preStart`, never in a field initializer.',
  );
}

/**
 * Same shape as {@link notAShardedEntity}, for the same reason: no cluster
 * on this system and asked-before-the-context-was-attached are
 * indistinguishable at the call site, so the message names both — and the
 * way out of each.
 */
function notClustered(className: string, path: string | null): Error {
  const where = path === null ? ' (before it was started)' : ` at ${path}`;
  return new Error(
    `${className}${where} has no Cluster — `
    + '`this.cluster` needs the enclosing ActorSystem to have joined one. '
    + 'Join it with `await Cluster.join(system, clusterOptions)` (or '
    + '`Cluster.bootstrap(...)`) before spawning, or ask '
    + '`this.context.cluster`, which answers `None` instead of throwing. '
    + 'Note the context is attached after construction: read it in '
    + '`preStart` or later, never in a field initializer.',
  );
}
