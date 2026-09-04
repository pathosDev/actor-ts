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
import type { Config } from './config/Config.js';
import { ConfigKeys } from './config/ConfigKeys.js';
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
   * User messages this actor handles per dispatcher turn before it yields
   * (#409).  Unset falls through to `actor-ts.actor.throughput`, then to the
   * built-in default — so this is the highest-precedence layer, not a
   * replacement for the system-wide setting.
   *
   * Raise it for an actor that is a throughput bottleneck and whose handler is
   * short; the scheduling round trip it amortises costs more than such a
   * handler does. Lower it toward `1` for an actor whose handler is slow
   * enough that a full batch would keep timers and I/O waiting — the batch
   * runs to its budget without yielding, so the budget *is* the latency other
   * work can see.
   *
   * A batch always ends early on anything that changes the actor's situation:
   * an empty mailbox, a suspend or stop, and a throttle bucket that runs out
   * mid-batch.
   */
  readonly throughput?: number;
  /**
   * Bound this actor's mailbox at `mailboxCapacity` queued user messages.
   * Unset falls through to `actor-ts.mailbox.default.capacity` — which is
   * `0`, meaning no global bound — and then to unbounded, which is the
   * shipped answer.  So setting this, here or there, is the act that
   * introduces message loss, and {@link mailboxOverflow} decides which
   * message is lost.  Cannot be combined with `mailbox`, which brings its
   * own bound.
   *
   * What it never loses is anything the framework posts through
   * `ActorCell.postSignalEnvelope`.  That door — not the message that goes
   * through it — is the rule: since #729 it stamps {@link Envelope.undroppable}
   * and routes to `Mailbox.enqueueSignal`, a lane no overflow policy can shed.
   * Three senders use it: a death-watch `Terminated`; the `websocket-accept`
   * command that hands an upgraded socket to its hub (#717); and the `close`
   * a `WebsocketConnection` sends its own actor (#985).  So bounding a watcher
   * costs it backlog and not the deaths it is watching for, bounding a hub
   * cannot orphan a socket it has already accepted, and bounding a connection
   * cannot turn a `closeAll` into a socket that stays open.
   */
  readonly mailboxCapacity?: number;
  /**
   * What a full mailbox does with an arriving message.  Only meaningful
   * together with {@link mailboxCapacity} — an unbounded mailbox is never
   * full — so setting it alone is rejected rather than silently ignored.
   * Falls through to `actor-ts.mailbox.default.overflow`, then to
   * {@link DEFAULT_MAILBOX_OVERFLOW}.
   *
   * The rejection stands even where a global bound exists (#862): the
   * validator has no `Config` and must not grow one, so it cannot tell an
   * intended override of a global bound from the no-op the rule was written
   * for.  Restate the capacity alongside the policy to reshape a global
   * bound for one actor, or set the policy globally in the same block.
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

  /** Messages per dispatcher turn — see {@link ActorOptionsType.throughput}. */
  withThroughput(throughput: number): this {
    return this.set('throughput', throughput);
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
 * The mailbox fields and `throughput` are the only ones with constraints the
 * type system does not already carry.  `BoundedMailbox` checks the first two
 * too, but from inside the cell constructor — here they fail at the `spawn`
 * call that got it wrong.
 */
export class ActorOptionsValidator<TMessage = unknown>
  extends OptionsValidator<ActorOptionsType<TMessage>> {
  constructor() {
    super('ActorOptions');
  }

  protected rules(s: Partial<ActorOptionsType<TMessage>>): void {
    this.positiveInt('mailboxCapacity');
    this.oneOf('mailboxOverflow', ['drop-head', 'drop-new', 'reject']);
    // A batch of zero would never dequeue a user message, so the actor would
    // accept mail and silently never read it — the failure mode is an actor
    // that looks alive and is not.
    this.positiveInt('throughput');
    // An overflow policy without a bound is a no-op, and a silent no-op in
    // an options object is the shape that makes someone believe they
    // configured something.
    //
    // Kept as-is now that `actor-ts.mailbox.default.capacity` can supply the
    // bound this rule says is missing (#862).  The premise did narrow — with
    // a global capacity set, a lone `withMailboxOverflow` would have a bound
    // to reshape — but the validator sees only the spawn site's own fields,
    // and giving it a `Config` would make one actor's options depend on which
    // system it is later spawned into.  So the rule keeps catching the case
    // it was written for, and the override is spelled by restating the
    // capacity.  The alternative — relaxing it — trades a real guard for an
    // ergonomic saving of one call.
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

/**
 * What `actor-ts.mailbox.default.*` says, resolved once per system (#862).
 *
 * Deliberately not an options triad: there is no `ActorSystemOptions` field
 * behind it, exactly as there is none behind `actor-ts.actor.throughput`.  A
 * global bound is an operator's decision about a deployment, and a code-level
 * setter for it would be a second way to say what the spawn site already says
 * better.
 *
 * Both fields are optional and absent when unset, because this is the
 * *middle* precedence layer — {@link ActorOptionsType} above it, the built-in
 * answer below it.  A field forced to an explicit `undefined` would shadow
 * the layer underneath instead of falling through to it.
 */
export type DefaultMailboxConfiguration = {
  /**
   * Queued user messages an actor under `/user` may hold before its overflow
   * policy starts shedding, or absent for "no global bound" — which is the
   * shipped answer, and the one `capacity = 0` spells in HOCON.
   */
  readonly capacity?: number;
  /**
   * System-wide overflow policy for **any** bounded mailbox, not only the
   * global bound: an actor that sets `withMailboxCapacity` and no policy of
   * its own takes this one.  That is the same shape as
   * `actor-ts.actor.throughput`, and it is what makes "this deployment
   * rejects instead of dropping" expressible in one line.
   */
  readonly overflow?: BoundedMailboxOverflow;
};

/**
 * Read `actor-ts.mailbox.default.*` into the layer `ActorCell` puts under a
 * spawn site's own mailbox settings.
 *
 * `capacity <= 0` leaves the field **absent** rather than passing the number
 * on.  Zero is the published spelling of "no global bound", so it has to mean
 * the same thing as an unset key; and `BoundedMailbox`'s validator rejects a
 * non-positive capacity, so forwarding it would turn a documented off-switch
 * into an `OptionsError` at the first spawn.  A negative value is that same
 * statement made by a typo and is answered the same way.
 *
 * `overflow` is passed through uninspected: the value is validated where
 * every other mailbox option is, by `BoundedMailboxOptionsValidator` at the
 * moment a bounded mailbox is actually built, so a typo fails loudly and in
 * one place rather than being silently swapped for a default here.
 */
export function readDefaultMailboxFromConfig(config: Config): DefaultMailboxConfiguration {
  const keys = ConfigKeys.mailbox.default;
  const out: {
    -readonly [K in keyof DefaultMailboxConfiguration]?: DefaultMailboxConfiguration[K]
  } = {};
  if (config.hasPath(keys.capacity)) {
    const capacity = config.getInt(keys.capacity);
    if (capacity > 0) out.capacity = capacity;
  }
  if (config.hasPath(keys.overflow)) {
    out.overflow = config.getString(keys.overflow) as BoundedMailboxOverflow;
  }
  return out;
}
