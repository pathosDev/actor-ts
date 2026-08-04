import type { ActorContext } from './ActorContext.js';
import type { ActorRef } from './ActorRef.js';
import type { ActorSystem } from './ActorSystem.js';
import type { Cluster } from './cluster/Cluster.js';
import type { EntityContext } from './EntityContext.js';
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

  /** Called after construction and before the first message is processed. */
  preStart(): void | Promise<void> {}

  /** Called after the actor has been terminated. Children are already stopped. */
  postStop(): void | Promise<void> {}

  /**
   * Called before a restart, on the instance about to be thrown away.
   * The default stops children and then calls postStop().
   */
  preRestart(_reason: Error, _message?: TMessage): void | Promise<void> {
    return this.postStop();
  }

  /** Called on the fresh instance after a restart.  Default: call preStart(). */
  postRestart(_reason: Error): void | Promise<void> {
    return this.preStart();
  }

  /**
   * Supervisor strategy for this actor's children.  Defaults to restart,
   * up to 10 times per minute, then stop.
   */
  supervisorStrategy(): SupervisorStrategy { return defaultStrategy; }
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
    + 'or give it an identity directly with `Props.create(...).withEntity({ ... })`. '
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
