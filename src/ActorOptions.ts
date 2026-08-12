/**
 * Per-actor spawn configuration.  What to construct is the actor class or
 * factory you pass positionally; how to run it is here:
 *
 *     const workerOptions = ActorOptions.create<WorkerMessage>()
 *       .withMailboxCapacity(500)
 *       .withSupervisorStrategy(stoppingStrategy);
 *
 *     system.spawn(() => new Worker(database), 'worker-1', workerOptions);
 *
 * Every field is optional, so the whole argument is: the defaults are an
 * unbounded FIFO mailbox, the system dispatcher, and the parent's supervision.
 */
import type { Dispatcher } from './Dispatcher.js';
import type { EntityContext } from './EntityContext.js';
import type { Mailbox } from './internal/Mailbox.js';
import type { BoundedMailboxOverflow } from './mailbox/BoundedMailboxOptions.js';
import type { SupervisorStrategy } from './Supervision.js';
import { OptionsBuilder } from './util/OptionsBuilder.js';
import { OptionsValidator } from './util/OptionsValidator.js';

/**
 * Built-in default for {@link ActorOptionsType.mailboxOverflow}.
 * `drop-head` discards the oldest queued message when a new one arrives on
 * a full mailbox — the right shape for telemetry-style workloads where
 * stale messages are worthless and the freshest snapshot is the only thing
 * that matters.
 *
 * `reject` would be the more cautious-looking default and is the wrong one:
 * it throws `MailboxFullError` into the *sender's* `onReceive`, so the
 * actor that fails and restarts is the one that sent to a slow actor, not
 * the slow actor itself (#919).
 */
export const DEFAULT_MAILBOX_OVERFLOW: BoundedMailboxOverflow = 'drop-head';

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
  /**
   * Bound this actor's mailbox at `mailboxCapacity` queued user messages.
   * Unset means unbounded, which is the default — so setting this is the
   * act that introduces message loss, and {@link mailboxOverflow} decides
   * which message is lost.  Cannot be combined with `mailbox`, which brings
   * its own bound.
   */
  readonly mailboxCapacity?: number;
  /**
   * What a full mailbox does with an arriving message.  Only meaningful
   * together with {@link mailboxCapacity} — an unbounded mailbox is never
   * full — so setting it alone is rejected rather than silently ignored.
   * Defaults to {@link DEFAULT_MAILBOX_OVERFLOW}.
   */
  readonly mailboxOverflow?: BoundedMailboxOverflow;
  /**
   * Custom mailbox — `PriorityMailbox`, or a `BoundedMailbox` configured
   * beyond what `mailboxCapacity` / `mailboxOverflow` express, or a
   * `Mailbox` subclass of your own.  Omit for the default unbounded FIFO
   * queue.
   *
   * Drops still reach `actor_mailbox_dropped_total`: the cell registers its
   * observer on whatever you return, provided the mailbox implements
   * `DropReportingMailbox` (`BoundedMailbox` does).  Any `onDrop` of your own
   * keeps firing alongside it.
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
   * Human-readable name for log lines and the DevTools tree (#891) — the
   * spawn-site counterpart to overriding `Actor.displayName()`, for a
   * framework-constructed actor with no subclass of your own: a `Behaviors`
   * actor, a sharded entity, a singleton.
   *
   * Outranks the method, exactly as `supervisorStrategy` outranks
   * `Actor.supervisorStrategy()`.  Purely cosmetic — the path stays the
   * identity everywhere that routes or correlates.
   */
  readonly displayName?: string;
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
 * Mutates in place and returns `this`, per the shared `OptionsBuilder`
 * contract: two chains off one instance are not two configurations.  Build a
 * second instance instead.  The settings are snapshotted at spawn time, so a
 * builder mutated afterwards never reconfigures a running actor.
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

  /** What a full mailbox does — see {@link ActorOptionsType.mailboxOverflow}. */
  withMailboxOverflow(mailboxOverflow: BoundedMailboxOverflow): this {
    return this.set('mailboxOverflow', mailboxOverflow);
  }

  /** Full control over the queue — any `Mailbox` subclass. */
  withMailbox(mailbox: MailboxFactory<TMessage>): this {
    return this.set('mailbox', mailbox);
  }

  /** Mark this actor as tooling — see {@link ActorOptionsType.internal}. */
  withInternal(internal = true): this {
    return this.set('internal', internal);
  }

  /** Name this actor in logs and the DevTools tree — see {@link ActorOptionsType.displayName}. */
  withDisplayName(displayName: string): this {
    return this.set('displayName', displayName);
  }

  /** Give this actor a sharding identity — see {@link ActorOptionsType.entity}. */
  withEntity(entity: EntityContext): this {
    return this.set('entity', entity);
  }
}

/**
 * The two mailbox fields are the only ones with constraints the type system
 * does not already carry.  `BoundedMailbox` checks them too, but from inside
 * the cell constructor — here they fail at the `spawn` call that got it wrong.
 */
export class ActorOptionsValidator<TMessage = unknown>
  extends OptionsValidator<ActorOptionsType<TMessage>> {
  constructor() {
    super('ActorOptions');
  }

  protected rules(s: Partial<ActorOptionsType<TMessage>>): void {
    this.positiveInt('mailboxCapacity');
    this.oneOf('mailboxOverflow', ['drop-head', 'drop-new', 'reject']);
    // An overflow policy without a bound is a no-op, and a silent no-op in
    // an options object is the shape that makes someone believe they
    // configured something.
    if (s.mailboxOverflow !== undefined && s.mailboxCapacity === undefined) {
      this.fail(
        'mailboxOverflow',
        'needs a mailboxCapacity — an unbounded mailbox never overflows',
        s.mailboxOverflow,
      );
    }
    // Same rule, other direction (#661): a caller-supplied mailbox carries
    // its own bound and policy, so the cell has nowhere to apply these.  They
    // used to be ignored outright, which reads as configuration and is not.
    if (s.mailbox !== undefined && s.mailboxCapacity !== undefined) {
      this.fail(
        'mailboxCapacity',
        'cannot be combined with mailbox — a supplied mailbox brings its own bound '
        + '(configure it there, or drop withMailbox and let the capacity build one)',
        s.mailboxCapacity,
      );
    }
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
