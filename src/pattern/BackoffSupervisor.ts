import { match } from 'ts-pattern';
import { Actor, type ActorClassOrFactory, type ActorFactory } from '../Actor.js';
import type { ActorOptions } from '../ActorOptions.js';
import type { ActorRef } from '../ActorRef.js';
import { LocalActorRef } from '../internal/LocalActorRef.js';
import { LogContext, type LogContextData } from '../LogContext.js';
import {
  Directive,
  OneForOneStrategy,
  type SupervisorStrategy,
} from '../Supervision.js';
import { DeadLetter, Terminated } from '../SystemMessages.js';
import { OptionsError } from '../util/OptionsValidator.js';
import {
  type BackoffPolicy,
  exponentialBackoff,
} from './BackoffPolicy.js';
import {
  BackoffSupervisorOptionsValidator,
  withBackoffSupervisorConfigDefaults,
} from './BackoffSupervisorOptions.js';
import type {
  BackoffSupervisorOptions,
  BackoffSupervisorOptionsType,
  ForwardStrategy,
  ResetCounter,
  TerminationTrigger,
} from './BackoffSupervisorOptions.js';

/**
 * BackoffSupervisor — wraps a single child actor and reschedules its
 * restart with an exponential backoff (plus jitter).  Use this when
 * the child's failure is **transient** — flaky DB, broker reconnect
 * window, third-party API hiccup — and immediate restart would just
 * hammer the broken dependency.
 *
 *   const supervisor = system.spawn(
 *     BackoffSupervisor.factory({ child: MyFlaky }),
 *     'flaky-supervisor',
 *   );
 *   // Send messages to the supervisor — they're forwarded to the
 *   // current child, or stashed during a backoff window.
 *   supervisor.tell({ kind: 'do-work' }, replyTo);
 *
 * `child` is the only required field.  Everything else comes from
 * `actor-ts.backoff-supervisor.*` when a config file sets it and from the
 * built-in defaults otherwise, with an option passed here outranking both —
 * per field, the usual three layers (#865).  The merge happens in `preStart`,
 * because that is the first moment `system.config` is reachable.
 *
 * **Mechanism.**  The supervisor:
 *
 *   1. Runs the child under `stoppingStrategy` so a child crash leads
 *      to a clean Stop (rather than an immediate Restart).
 *   2. Death-watches the child (`context.watch`) and listens for
 *      `Terminated`.  Either a crash-induced stop or an external
 *      `child.stop()` triggers the same backoff path — pragmatic for
 *      a v1; finer-grained "respawn only on crash" behaviour is
 *      available via the `respawnOn: 'failure'` option below.
 *   3. On `Terminated` it schedules a single-shot timer to spawn a
 *      fresh child after `policy.delayFor(restartCount)` ms.
 *   4. While the child is dead, user messages are buffered (`stash`
 *      mode, default) or dropped (`drop` mode).  Stashed messages are
 *      flushed to the new child once it spawns, preserving sender refs
 *      so ask-replies still go to the original asker.  An optional
 *      `drainGraceMs` window delays the drain so a child that crashes
 *      in `preStart` doesn't take the stash with it to dead-letter
 *      — the stash is held back until the new child has clearly
 *      survived its grace window.  New messages arriving during the
 *      grace forward immediately so the happy-path latency is
 *      unaffected.
 *   5. The restart counter resets when the child has been alive for
 *      `resetCounter` ms — default `'after-min-stable'` which uses
 *      `minBackoff` as the threshold.  After a long-running successful
 *      child, the next failure starts the backoff at `minBackoff` again
 *      rather than where the last failure left off.
 *
 * **Out of scope (v1).**
 *   - Cluster-aware supervision.  This pattern is local to the parent
 *     by design — distributed restart coordination belongs in a sharded
 *     entity or a cluster-singleton, not the supervisor.
 *   - `onFailure`-only mode (respawn only on crash, not on external
 *     stop).  Workaround: configure the child to terminate itself only
 *     on errors and use an explicit `PoisonPill` for shutdown — the
 *     supervisor will respawn either way until **it** is stopped.
 */

/**
 * Everything the supervisor derives once from its merged settings.
 *
 * One object rather than nine fields because it is resolved in `preStart`
 * (the first point where `this.system.config` exists) and not in the
 * constructor: a null-until-preStart box behind an accessor that throws says
 * "read before it was resolved" out loud, where nine `!`-asserted fields would
 * each read as `undefined` at the use site.  `BrokerActor._options` is the
 * same shape for the same reason.
 */
type ResolvedBackoffSettings<T> = {
  readonly child: ActorClassOrFactory<T>;
  readonly childOptions: ActorOptions<T> | undefined;
  readonly policy: BackoffPolicy;
  readonly childName: string;
  readonly forward: ForwardStrategy;
  readonly stashLimit: number;
  readonly resetThresholdMs: number | null;
  readonly drainGraceMs: number;
  readonly clock: () => number;
  readonly triggerOn: TerminationTrigger;
  readonly forwardDuringGrace: boolean;
};

/**
 * One buffered message, plus what the framework can still say about where it
 * came from once it is evicted (#773).
 *
 * **The MDC snapshot is taken here, at stash time, and it has to be.**  The
 * cell runs each handler inside `LogContext.run(envelope.context, …)`, so
 * `LogContext.get()` during `onReceive` *is* the arriving envelope's own
 * context — but {@link BackoffSupervisor.evictOldestStashed} runs while
 * handling a *later* message, and reading it there would attribute the loss to
 * whichever message happened to trigger the overflow instead of to the one
 * being discarded.  A stash entry outlives its turn; the context does not.
 *
 * **There is deliberately no `trace`.**  Nothing exposes the arriving
 * envelope's `trace` to actor code — `ActorContext` has no span accessor, and
 * the receive span the cell opens is never made active — so the only span
 * reachable from in here belongs to a different operation than the one that
 * sent the message.  Recording it under the same field the mailbox path fills
 * with the *sender's* span would make one field mean two things.  Closing that
 * needs a seam on `ActorContext`, which is an API change #773 does not ask
 * for.
 */
type StashedMessage = {
  readonly message: unknown;
  readonly sender: ActorRef | null;
  /** The MDC in force when this message arrived, if it carried one. */
  readonly context?: LogContextData;
};

export class BackoffSupervisor<T> extends Actor<unknown> {
  /**
   * Build the factory that spawns a `BackoffSupervisor` configured with the
   * given options.  Pass `supervisorStrategy` in the supervisor's own spawn
   * options to change how the *supervisor* is supervised — the **child** is
   * always run under `stoppingStrategy` regardless.
   */
  static factory<T>(options: BackoffSupervisorOptions<T>): ActorFactory<unknown> {
    return () => new BackoffSupervisor(options) as unknown as Actor<unknown>;
  }

  /** Constructor options — partial; merged with HOCON + defaults in preStart. */
  private readonly constructorOptions: Partial<BackoffSupervisorOptionsType<T>>;
  /** Everything derived from the merged settings.  `null` until preStart ran. */
  private resolved: ResolvedBackoffSettings<T> | null = null;
  /**
   * Set by the supervisor's decider (#68) on the way to `Stop` so
   * `handleTerminated` can distinguish a crash-driven termination from
   * a clean self-stop.  Reset after every Terminated handling so a
   * stale "true" can't be carried over into the next incarnation's
   * lifecycle.
   */
  private lastTerminationWasFailure = false;
  /**
   * `true` once the current child has survived the `drainGraceMs`
   * window (#67).  Cleared on every spawn + Terminated.  Gates
   * direct-forwarding of new messages while the child is still in
   * its uncertain grace period — without the gate, messages arriving
   * between two failed respawn attempts forward straight into a
   * crashing child and dead-letter.
   */
  private childConfirmedAlive = false;

  /** The currently-live child, or `null` while we're in a backoff window. */
  private currentChild: ActorRef<T> | null = null;
  /**
   * The child whose `Terminated` opened the current backoff window, held
   * until its replacement is spawned.
   *
   * Only {@link stopPreviousChild} reads it, and only to make sure the
   * predecessor is not still running when the successor appears (#769).  It is
   * `null` outside a backoff window, so a stopped supervisor is not holding a
   * ref to an actor it no longer supervises.
   */
  private previousChild: ActorRef<T> | null = null;
  /** Counter for the **next** restart's delay (0 = first respawn). */
  private restartCount = 0;
  /** Wall-clock ts of the last successful spawn, for the reset-window check. */
  private spawnTs = 0;
  /** Monotonic incarnation counter — used to disambiguate child names. */
  private incarnation = 0;
  /** Buffered messages waiting for the next child. */
  private readonly stash: StashedMessage[] = [];
  /** Cumulative count of stash entries evicted for want of room (#773). */
  private stashDropCount = 0;
  /**
   * The eviction count at which the next warning fires — see
   * {@link evictOldestStashed}.  Starts at 1 so the first eviction is always
   * reported, then doubles, so a sustained overflow costs log lines in the
   * logarithm of the messages lost rather than one apiece.
   */
  private stashDropWarnAt = 1;

  constructor(options: BackoffSupervisorOptions<T>) {
    super();
    // A builder carries its set fields as own enumerable props, so one spread
    // normalizes builder OR plain object into the same `Partial` snapshot.
    // Nothing is derived here: `this.system.config` does not exist yet — the
    // cell calls the blueprint factory and only then attaches the context —
    // so the merge that HOCON participates in has to wait for `preStart`.
    this.constructorOptions = { ...(options as Partial<BackoffSupervisorOptionsType<T>>) };
  }

  /** Derived settings — only valid after `preStart`. */
  private get settings(): ResolvedBackoffSettings<T> {
    if (this.resolved === null) {
      throw new Error('BackoffSupervisor: settings read before preStart resolved them');
    }
    return this.resolved;
  }

  /**
   * The supervisor's own strategy applied to **its child**.  The
   * decider always returns `Directive.Stop` (so the cell's restart
   * loop doesn't fight ours), but BEFORE returning it sets
   * {@link lastTerminationWasFailure} — that's the only place we can
   * tell "the child crashed" apart from "the child stopped itself
   * cleanly".  `handleTerminated` reads the flag, applies the
   * `triggerOn` policy (#68), then resets it.
   *
   * Users should not override this; configure the supervisor's parent
   * instead if you want a different policy for the supervisor itself.
   */
  override supervisorStrategy(): SupervisorStrategy {
    return new OneForOneStrategy((_err) => {
      this.lastTerminationWasFailure = true;
      return Directive.Stop;
    });
  }

  /**
   * Resolve first, spawn second — the order is load-bearing:
   * {@link spawnChild} reads `childName`, `clock` and `drainGraceMs`.
   *
   * `postRestart` re-runs this by default, so a restarted supervisor re-reads
   * the config.  That costs nothing: `system.config` is an already-parsed
   * object, not a file the merge goes back to disk for.
   */
  override preStart(): void {
    this.resolved = this.resolveSettings();
    this.spawnChild();
  }

  override async onReceive(message: unknown): Promise<void> {
    if (message instanceof Terminated) {
      this.handleTerminated(message);
      return;
    }
    // Internal respawn tick.  The timer below is the only thing that can put
    // one on this queue — not by convention but because `RESPAWN_TICK` is a
    // module-private symbol nothing outside this file can name or rebuild, and
    // a symbol survives no wire codec, so an arriving message that is `===` to
    // it came from our own `startSingleTimer` (#770).  Before that it was
    // `Symbol.for`, and the comment here claimed a guarantee the code did not
    // enforce: anyone with the registry string could forge a tick and collapse
    // the backoff window this class exists to impose.
    if (message === RESPAWN_TICK) {
      this.respawn();
      return;
    }
    // Internal drain tick — fired drainGraceMs after a respawn.  If
    // the child is still alive, mark it confirmed and drain the
    // stash.  If it died in the meantime, currentChild is null and
    // we leave the stash for the next incarnation.  Module-private for the
    // same reason as the respawn tick above: a forged one flushed the stash
    // into a child that had not yet cleared `preStart` (#770).
    if (message === DRAIN_TICK) {
      if (this.currentChild) {
        this.childConfirmedAlive = true;
        this.drainStash(this.currentChild);
      }
      return;
    }
    // User message — forward (when confirmed alive) or stash.  The
    // `forwardDuringGrace` opt-out preserves the v1 behaviour for
    // users who prefer zero-latency forwarding over the
    // dead-letter-during-preStart-crash protection (#67).
    if (this.currentChild && (this.childConfirmedAlive || this.settings.forwardDuringGrace)) {
      this.currentChild.tell(message as T, this.sender.toNullable());
      return;
    }
    if (this.settings.forward === 'drop') {
      this.log.debug('BackoffSupervisor: dropping message during backoff window', { message });
      return;
    }
    // 'stash' mode.
    if (this.stash.length >= this.settings.stashLimit) this.evictOldestStashed();
    // The MDC is snapshotted now rather than at eviction, for the reason
    // `StashedMessage` gives: by then this turn's context is somebody else's.
    // Omitted when there is none, exactly as `LocalActorRef.tell` omits it —
    // an empty context on the entry would say the sender had one.
    const context = LogContext.get();
    this.stash.push(
      LogContext.isEmpty(context)
        ? { message, sender: this.sender.toNullable() }
        : { message, sender: this.sender.toNullable(), context },
    );
  }

  override postStop(): void {
    // Cancel any pending respawn / drain — the cell already cancels
    // its timers for us, but doing it explicitly keeps the intent
    // obvious if someone refactors `timers.cancelAll`.
    this.context.timers.cancel(RESPAWN_TIMER_KEY);
    this.context.timers.cancel(DRAIN_TIMER_KEY);
    this.stash.length = 0;
    // The respawn that would have consumed it is never going to happen, and
    // the cell stops every child of ours anyway — so holding the ref past
    // here would only make the field's own invariant untrue.
    this.previousChild = null;
  }

  /* ------------------------- internals ---------------------------------- */

  /**
   * Merge the three layers, check them, and derive what the message loop
   * reads — the whole of what used to happen in the constructor (#865).
   *
   * **Where a bad value surfaces moved with it, deliberately.**  Before this,
   * `minBackoff <= 0` threw synchronously out of `new BackoffSupervisor(...)`;
   * now it fails the supervisor's `preStart` and reaches whoever supervises
   * *it*.  That is the price of the config layer existing at all — a value
   * from `application.conf` cannot be checked at a call site that never saw it
   * — and it is the shape every other configurable actor in the framework
   * already has (`BrokerActor` runs `optionsValidator()` in `preStart` for the
   * same reason).  The gain is that one rule now covers all three sources
   * instead of the code path only.
   */
  private resolveSettings(): ResolvedBackoffSettings<T> {
    const merged = withBackoffSupervisorConfigDefaults<T>(this.constructorOptions, this.system.config);
    // Required-ness first and by hand: every check helper is a deliberate
    // no-op on `undefined`, and `child` is the one field neither HOCON nor a
    // built-in default can supply.  Same split as
    // `BrokerActor.requiredOptions()`.
    if (merged.child === undefined) {
      throw new OptionsError(
        'BackoffSupervisorOptions: child is required — there is no actor to supervise without it',
        'BackoffSupervisorOptions',
        'child',
      );
    }
    new BackoffSupervisorOptionsValidator().validate(merged);
    return {
      child: merged.child,
      childOptions: merged.childOptions,
      // A custom policy computes the whole delay, so `randomFactor` is inert
      // for a caller that supplies one — while `minBackoff` / `maxBackoff`
      // still apply, through the reset threshold and the drain grace below.
      policy: merged.policy ?? exponentialBackoff({
        minMs: merged.minBackoff,
        maxMs: merged.maxBackoff,
        randomFactor: merged.randomFactor,
      }),
      childName: merged.childName,
      forward: merged.forward,
      stashLimit: merged.maxStashSize,
      resetThresholdMs: resolveResetThreshold(merged.resetCounter, merged.minBackoff),
      // Derived from another field, which is exactly why it is not a HOCON
      // leaf: a published `50ms` would outlast the backoff window of a
      // supervisor whose `minBackoff` is smaller.
      drainGraceMs: merged.drainGraceMs ?? Math.min(50, merged.minBackoff),
      clock: merged.clock ?? Date.now,
      triggerOn: merged.triggerOn,
      // Default `true` keeps the v1 fast-forward path; the dead-letter
      // protection is opt-in (#67) because every respawn would
      // otherwise pay `drainGraceMs` of latency on the happy path.
      forwardDuringGrace: merged.forwardDuringGrace ?? true,
    };
  }

  /**
   * Make room in a full stash, and account for what that costs (#773).
   *
   * **The evicted message becomes a dead letter.**  A stash entry is an
   * application message that was `tell`ed to this supervisor and accepted by
   * it; every other way it can end — the drain into a child that then dies,
   * a supervision stop — already reaches `system.deadLetters`, and there is
   * no reason the one path that discards it on purpose should be the one
   * that leaves no record.  Unlike a mailbox drop this is unconditional: it
   * runs inside the supervisor's own `onReceive` rather than on the sender's
   * stack, so nothing here is charged to whoever produced the burst.
   *
   * **The warning is aggregated, not per message.**  One `log.warn` per
   * evicted message meant a supervisor stuck in a long backoff window turned
   * a message flood into a log flood at exactly the same rate.  The line now
   * fires on the first eviction and then at each doubling — 1, 2, 4, 8, … —
   * the shape `ActorCell._onMailboxHighWaterMark` already uses for a
   * condition that repeats as fast as traffic arrives, and the one that needs
   * no tuned interval to be picked and defended.  It carries the running
   * total, so a line arriving late still says how much was lost.
   *
   * **The letter carries the MDC the message arrived with**, captured at stash
   * time — see {@link StashedMessage}, which also says why it carries no span
   * context.  Without it an operator reading the dead-letter stream can see
   * that a supervisor in a backoff window shed a message and not which request
   * it belonged to, which is the same gap the mailbox path had.
   */
  private evictOldestStashed(): void {
    const evicted = this.stash.shift();
    if (evicted === undefined) return;
    this.system.deadLetters.tell(
      new DeadLetter(evicted.message, evicted.sender, this.self, { context: evicted.context }),
    );
    this.stashDropCount += 1;
    if (this.stashDropCount < this.stashDropWarnAt) return;
    this.log.warn('BackoffSupervisor: stash full — oldest message dead-lettered', {
      stashLimit: this.settings.stashLimit,
      droppedTotal: this.stashDropCount,
    });
    this.stashDropWarnAt = this.stashDropCount * 2;
  }

  private spawnChild(): void {
    this.stopPreviousChild();
    this.incarnation += 1;
    const name = `${this.settings.childName}-${this.incarnation}`;
    const child = this.context.spawn(this.settings.child, name, this.settings.childOptions);
    this.context.watch(child);
    this.currentChild = child;
    this.spawnTs = this.settings.clock();
    // Reset the alive-confirmation flag.  In the default
    // `forwardDuringGrace: true` mode this only matters for the
    // explicit-stash carry-over (the gate doesn't apply); in the
    // opt-in strict mode it gates new forwards until DRAIN_TICK
    // flips it back to true.  `drainGraceMs === 0` skips the grace
    // entirely.
    this.childConfirmedAlive = this.settings.drainGraceMs === 0;
    if (this.settings.drainGraceMs === 0) {
      this.drainStash(child);
      return;
    }
    // Wait one grace period before flipping confirmedAlive AND
    // draining the stash — a child that crashes in `preStart`
    // doesn't take the stash with it to dead-letter, and (with
    // `forwardDuringGrace: false`, the default) new messages
    // arriving in the post-respawn window are stashed too.
    this.context.timers.startSingleTimer(
      DRAIN_TIMER_KEY,
      DRAIN_TICK as unknown as never,
      this.settings.drainGraceMs,
    );
  }

  private handleTerminated(message: Terminated): void {
    // Ignore stale Terminated messages from a previous incarnation —
    // can happen if we already started a respawn before the old ref's
    // Terminated finished its trip through the mailbox.
    //
    // Identity, not `equals`: `ActorRef.equals` compares rendered paths, which
    // omit the incarnation uid, so an address match cannot tell a name's
    // previous occupant from its current one — the same reasoning
    // `Router.onTerminated` records.  The supervisor spawned this child, so the
    // ref it holds is the one that has to have died.
    const child = this.currentChild;
    if (child === null || message.actor !== child) {
      return;
    }
    // And the notification is a claim, not a proof: it carries a ref and
    // nothing else.  `ActorCell` now refuses to act on a `Terminated` the
    // runtime did not emit (#769), which closes the forgery route, but a
    // branded one still only means "the runtime sent this" — `watchNotify`
    // builds one for whatever target it is handed.  Retiring the child,
    // bumping the backoff counter and spawning a replacement are all
    // irreversible, so ask the child's own cell whether it is actually gone.
    // Safe to ask at exactly this moment: `finalizeTermination` flips the cell
    // to `terminated` before it notifies any watcher, so a genuine
    // notification can never arrive ahead of the state it reports.
    if (!hasTerminated(child)) {
      this.log.warn('BackoffSupervisor: ignoring a Terminated for a child that is still running', {
        child: child.toString(),
      });
      return;
    }
    // Snapshot + clear the failure flag set by the decider.  Doing it
    // here (not later) keeps the supervisor's state clean even if the
    // triggerOn check causes us to stop ourselves and skip the rest.
    const wasFailure = this.lastTerminationWasFailure;
    this.lastTerminationWasFailure = false;

    if (!this.shouldRespawn(wasFailure)) {
      this.log.info('BackoffSupervisor: child terminated, triggerOn rejected — supervisor stops', {
        child: message.actor.toString(),
        cause: wasFailure ? 'failure' : 'stop',
        triggerOn: this.settings.triggerOn,
      });
      // Stop ourselves — the parent (or whoever spawned us) gets a
      // Terminated for the supervisor and decides what to do next.
      this.currentChild = null;
      this.childConfirmedAlive = false;
      this.context.timers.cancel(DRAIN_TIMER_KEY);
      this.context.stop(this.self);
      return;
    }

    const aliveFor = this.settings.clock() - this.spawnTs;
    if (this.settings.resetThresholdMs !== null && aliveFor >= this.settings.resetThresholdMs) {
      this.restartCount = 0;
    }
    const delay = this.settings.policy.delayFor(this.restartCount);
    this.restartCount += 1;
    this.previousChild = child;
    this.currentChild = null;
    // Reset the alive-confirmation flag (#67) — the next spawn starts
    // its grace window from scratch, and any messages arriving
    // between now and that spawn must stash, not forward.
    this.childConfirmedAlive = false;
    // Cancel any pending drain — the child it was waiting on is gone.
    // The stash itself is preserved for the next incarnation.
    this.context.timers.cancel(DRAIN_TIMER_KEY);
    this.context.timers.startSingleTimer(
      RESPAWN_TIMER_KEY,
      RESPAWN_TICK as unknown as never,
      Math.max(0, Math.round(delay)),
    );
    this.log.info('BackoffSupervisor: child terminated, respawn scheduled', {
      child: message.actor.toString(),
      cause: wasFailure ? 'failure' : 'stop',
      delayMs: delay,
      restartCount: this.restartCount,
      aliveMs: aliveFor,
    });
  }

  /**
   * Translate the `(triggerOn, wasFailure)` pair into a respawn / stop
   * decision (#68).  Pure function — easy to unit-test in isolation
   * if we ever want to.
   */
  private shouldRespawn(wasFailure: boolean): boolean {
    // Exhaustive match — adding a new TerminationTrigger variant
    // forces this site to be updated (TS error otherwise).
    return match(this.settings.triggerOn)
      .with('any',     () => true)
      .with('failure', () => wasFailure)
      .with('stop',    () => !wasFailure)
      .exhaustive();
  }

  /**
   * Never let a replacement child exist alongside the one it replaces.
   *
   * The two guards in {@link handleTerminated} should make this unreachable —
   * a `Terminated` only opens a backoff window once the child's own cell says
   * it is gone.  This is the backstop for the day one of them is weakened or
   * a new path reaches `spawnChild`: a child the supervisor has stopped
   * tracking but nobody stopped keeps whatever it owned — a broker connection,
   * a database pool, a leased lock — and no longer answers to anything, so
   * stopping it explicitly is strictly better than the log line that is all
   * an orphan would otherwise produce (#769).
   *
   * The check is what keeps this silent on the happy path: the predecessor is
   * already terminated by then, so nothing is sent and no dead letter is
   * produced.  Distinct from the orphan #926 describes — that one comes from
   * the *supervisor's* own restart resetting the incarnation counter, and the
   * ref this field holds does not survive that restart either.
   */
  private stopPreviousChild(): void {
    const previous = this.previousChild;
    this.previousChild = null;
    if (previous === null || hasTerminated(previous)) return;
    this.log.warn('BackoffSupervisor: previous child still alive at respawn — stopping it', {
      child: previous.toString(),
    });
    this.context.stop(previous);
  }

  private respawn(): void {
    if (this.currentChild !== null) {
      // Defensive — should never happen, but a lingering tick is a
      // correctness hazard worth a log line.
      this.log.warn('BackoffSupervisor: respawn tick fired with a live child — ignoring');
      return;
    }
    this.spawnChild();
  }

  private drainStash(child: ActorRef<T>): void {
    if (this.stash.length === 0) return;
    const drained = this.stash.splice(0, this.stash.length);
    for (const { message, sender } of drained) {
      child.tell(message as T, sender);
    }
  }
}

/*
 * The two control ticks, and why they are `Symbol()` and not `Symbol.for()`
 * (#770).
 *
 * `onReceive` is the supervisor's public, arbitrary-message entry point — it
 * forwards anything it does not recognise to the child — and it recognises
 * these two by bare value equality.  `Symbol.for` resolves through the
 * cross-realm global registry, so the sentinel was reconstructible by anyone
 * holding the string, and the string was a compile-time constant in a
 * published package.  Telling a forged `RESPAWN_TICK` during a backoff window
 * collapsed that window to zero; a forged `DRAIN_TICK` flushed the stash into
 * a child that had not yet cleared `preStart`.
 *
 * A plain `Symbol()` is unguessable and costs nothing, because global identity
 * was never needed: this module is the only place that constructs either one
 * and the only place that compares them.  The timer *keys* stay strings — they
 * name entries in the actor's own `TimerScheduler`, which is reachable only
 * from inside the actor, so there is no channel for a collision to arrive on.
 *
 * Honest scope, so nobody reads more into this than it carries: no trust
 * boundary was crossed.  A symbol survives neither JSON nor CBOR, so no
 * cluster peer could ever produce one, and the only caller who could is
 * in-process code already holding the supervisor's ref — which could equally
 * reassign this module's state directly.  This is a published constant string
 * colliding with a public message channel, not a privilege boundary.
 */
/** Sentinel for the respawn timer message. */
const RESPAWN_TICK = Symbol('actor-ts.pattern.BackoffSupervisor.respawn');
const RESPAWN_TIMER_KEY = 'actor-ts.pattern.BackoffSupervisor.respawn';
/** Sentinel for the stash-drain timer message. */
const DRAIN_TICK = Symbol('actor-ts.pattern.BackoffSupervisor.drain');
const DRAIN_TIMER_KEY = 'actor-ts.pattern.BackoffSupervisor.drain';

/**
 * Has the actor behind this ref finished terminating?
 *
 * The one question a `Terminated` cannot answer about itself, and the reason
 * it has to be asked of the cell instead: the message carries a ref and a pair
 * of flags, none of which the runtime checks against reality (#769).
 *
 * A ref that is not local is answered `false` — "cannot confirm", not
 * "alive" — which makes the callers conservative in the safe direction: an
 * unconfirmable death does not retire the child, and an unconfirmable
 * predecessor is stopped rather than left running.  A `BackoffSupervisor`
 * spawns its own child, so in practice the ref is always local and the
 * fallback never fires.
 */
function hasTerminated(ref: ActorRef): boolean {
  return ref instanceof LocalActorRef && ref.getCell().isTerminated();
}

/**
 * Turn the reset rule into the milliseconds `handleTerminated` compares
 * against, or `null` for "never reset".
 *
 * It no longer range-checks `ms`: that rule lives in
 * {@link BackoffSupervisorOptionsValidator}, which runs on the merged settings
 * just above this call, so a value arriving from a config file is rejected by
 * the same message a value written in code is.  Keeping a second throw here
 * would be one rule with two wordings.
 */
function resolveResetThreshold(
  rule: ResetCounter | undefined, minBackoff: number,
): number | null {
  // Exhaustive over `ResetCounter | undefined`.  `undefined` maps to
  // the same default behaviour as 'after-min-stable'.  Adding a new
  // ResetCounter variant forces this site to be updated.
  return match(rule)
    .with(undefined, 'after-min-stable', () => minBackoff)
    .with('never', () => null)
    .with({ kind: 'after-time' }, (r) => r.ms)
    .exhaustive();
}
