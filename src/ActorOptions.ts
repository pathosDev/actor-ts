/**
 * Per-actor spawn configuration — the second half of what `Props` used to
 * bundle.  What to construct is the actor class or factory you pass
 * positionally; how to run it is here:
 *
 *     const workerOptions = ActorOptions.create<WorkerMessage>()
 *       .withMailboxCapacity(500)
 *       .withSupervisorStrategy(stoppingStrategy);
 *
 *     system.spawn(() => new Worker(database), 'worker-1', workerOptions);
 *
 * Every field is optional, so the whole argument is: the defaults are a
 * bounded FIFO mailbox, the system dispatcher, and the parent's supervision.
 */
import type { Dispatcher } from './Dispatcher.js';
import type { EntityContext } from './EntityContext.js';
import type { Mailbox } from './internal/Mailbox.js';
import type { SupervisorStrategy } from './Supervision.js';
import { OptionsBuilder } from './util/OptionsBuilder.js';
import { OptionsValidator } from './util/OptionsValidator.js';

/**
 * Builds the actor's mailbox.  Called once, when the cell is constructed —
 * the mailbox outlives every restart, so messages queued before a crash are
 * still there afterwards.
 */
export type MailboxFactory<TMessage> = () => Mailbox<TMessage>;

/** Plain options-object shape accepted wherever an actor is spawned. */
export type ActorOptionsType<TMessage = unknown> = {
  /**
   * How the **parent** handles this actor's failures.  Distinct from the
   * `supervisorStrategy()` override inside the actor class, which governs its
   * *children*.  Set here, a single child opts out of its parent's policy
   * without affecting its siblings.
   */
  readonly supervisorStrategy?: SupervisorStrategy;
  /** Run this actor on a different dispatcher than the system's. */
  readonly dispatcher?: Dispatcher;
  /** Ceiling for the default bounded mailbox.  Ignored when `mailbox` is set. */
  readonly mailboxCapacity?: number;
  /**
   * Custom mailbox — `BoundedMailbox` or `PriorityMailbox` for non-default
   * queueing.  Omit for the default bounded FIFO queue.
   */
  readonly mailbox?: MailboxFactory<TMessage>;
  /**
   * This actor belongs to the tooling, not to the application.
   *
   * Whole-system instrumentation skips it, which is what keeps a debugger
   * from observing itself: DevTools' own hub publishes the spans it just
   * recorded, so tracing it feeds its own output back in.  Children inherit
   * the mark — a tooling actor's children are tooling.
   */
  readonly internal?: boolean;
  /**
   * Spawn this actor as a sharded entity with the given identity, readable
   * back off `this.entityId` / `this.context.entity`.
   *
   * `ClusterSharding` sets this itself for every entity a shard creates.  It
   * is public for the test bench: an entity that derives its `persistenceId`
   * from `this.entityId` is otherwise unspawnable without a cluster standing
   * behind it.
   */
  readonly entity?: EntityContext;
};

/**
 * Fluent builder for {@link ActorOptionsType}.
 *
 * Unlike the `Props` it replaces, this mutates in place and returns `this` —
 * the shared `OptionsBuilder` contract.  Two chains off one instance are not
 * two configurations; build a second instance instead.
 */
export class ActorOptionsBuilder<TMessage = unknown>
  extends OptionsBuilder<ActorOptionsType<TMessage>> {
  /** Start a fresh builder.  Equivalent to `new ActorOptionsBuilder()`. */
  static create<TMessage = unknown>(): ActorOptionsBuilder<TMessage> {
    return new ActorOptionsBuilder<TMessage>();
  }

  /** How the parent supervises *this* actor — see {@link ActorOptionsType.supervisorStrategy}. */
  withSupervisorStrategy(supervisorStrategy: SupervisorStrategy): this {
    return this.set('supervisorStrategy', supervisorStrategy);
  }

  /** Override the system-wide dispatcher for this actor. */
  withDispatcher(dispatcher: Dispatcher): this {
    return this.set('dispatcher', dispatcher);
  }

  /** Lower (or raise) the default bounded mailbox's ceiling. */
  withMailboxCapacity(mailboxCapacity: number): this {
    return this.set('mailboxCapacity', mailboxCapacity);
  }

  /** Full control over the queue — any `Mailbox` subclass. */
  withMailbox(mailbox: MailboxFactory<TMessage>): this {
    return this.set('mailbox', mailbox);
  }

  /** Mark this actor as tooling — see {@link ActorOptionsType.internal}. */
  withInternal(internal = true): this {
    return this.set('internal', internal);
  }

  /** Give this actor a sharding identity — see {@link ActorOptionsType.entity}. */
  withEntity(entity: EntityContext): this {
    return this.set('entity', entity);
  }
}

/**
 * `mailboxCapacity` is the only field with a constraint the type system does
 * not already carry.  `BoundedMailbox` checks it too, but from inside the
 * cell constructor — here it fails at the `spawn` call that got it wrong.
 */
export class ActorOptionsValidator<TMessage = unknown>
  extends OptionsValidator<ActorOptionsType<TMessage>> {
  constructor() {
    super('ActorOptions');
  }

  protected rules(_s: Partial<ActorOptionsType<TMessage>>): void {
    this.positiveInt('mailboxCapacity');
  }
}

/**
 * Accepted input wherever an actor is spawned: the fluent
 * {@link ActorOptionsBuilder} OR a plain {@link ActorOptionsType} object.
 */
export type ActorOptions<TMessage = unknown> =
  | ActorOptionsBuilder<TMessage>
  | ActorOptionsType<TMessage>;
/** Value alias so `ActorOptions.create()` / `new ActorOptions()` resolve to the builder. */
export const ActorOptions = ActorOptionsBuilder;
