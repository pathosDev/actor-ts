import { match } from 'ts-pattern';
import { Actor } from '../Actor.js';
import type { ActorRef } from '../ActorRef.js';
import { Props } from '../Props.js';
import {
  Directive,
  OneForOneStrategy,
  type SupervisorStrategy,
} from '../Supervision.js';
import { Terminated } from '../SystemMessages.js';
import {
  type BackoffPolicy,
  exponentialBackoff,
} from './BackoffPolicy.js';

/**
 * BackoffSupervisor — wraps a single child actor and reschedules its
 * restart with an exponential backoff (plus jitter).  Use this when
 * the child's failure is **transient** — flaky DB, broker reconnect
 * window, third-party API hiccup — and immediate restart would just
 * hammer the broken dependency.
 *
 *   const supervisor = system.actorOf(
 *     BackoffSupervisor.props({
 *       childProps: Props.create(() => new MyFlaky()),
 *       minBackoff: 200,
 *       maxBackoff: 10_000,
 *       randomFactor: 0.2,
 *     }),
 *     'flaky-supervisor',
 *   );
 *   // Send messages to the supervisor — they're forwarded to the
 *   // current child, or stashed during a backoff window.
 *   supervisor.tell({ kind: 'do-work' }, replyTo);
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

/** Reset rule for the consecutive-restart counter. */
export type ResetCounter =
  /** Never reset — the counter grows monotonically. */
  | 'never'
  /** Reset after the child has been alive for `>= minBackoff` ms. */
  | 'after-min-stable'
  /** Reset after the child has been alive for `>= ms` ms. */
  | { readonly kind: 'after-time'; readonly ms: number };

/** What to do with messages that arrive while the child is dead. */
export type ForwardStrategy =
  /** Buffer them and re-deliver to the next child instance. */
  | 'stash'
  /** Drop them silently (the supervisor logs at debug level). */
  | 'drop';

/**
 * Which terminations should trigger a respawn (#68).  Two modes,
 * because the right answer depends on whether you treat a clean
 * self-stop as recoverable or as a deliberate end of life:
 *
 *   - `'any'` *(default)* — respawn on every termination, whether the
 *     child crashed (uncaught throw) or stopped itself cleanly
 *     (`context.stop(self)`, `PoisonPill`, parent-driven stop).  This
 *     is the original v1 (#48) behaviour.
 *   - `'failure'` — respawn only when the child crashed.  A clean
 *     self-stop is taken as "this child is done"; the supervisor
 *     itself stops afterwards instead of spawning a replacement.
 *   - `'stop'` — the inverse: respawn only on clean stops (e.g. a
 *     transient connection actor that periodically tears itself
 *     down).  Crashes propagate "up" by stopping the supervisor.
 *
 * Matching is on the **last termination only** — the supervisor
 * re-arms its tracking on every respawn, so a string of crashes
 * followed by a clean stop in `'failure'` mode would respawn through
 * each crash and then stop on the clean stop.
 */
export type TerminationTrigger = 'any' | 'failure' | 'stop';

export interface BackoffOptions<T> {
  /** How to construct the child. */
  readonly childProps: Props<T>;
  /** Name suffix for the child.  The actual child name is
   *  `${childName}-${incarnation}` so successive incarnations don't
   *  collide on names while the previous instance is still tearing down. */
  readonly childName?: string;
  /** Floor for the backoff delay, in ms.  Must be > 0. */
  readonly minBackoff: number;
  /** Ceiling for the backoff delay, in ms.  Must be >= `minBackoff`. */
  readonly maxBackoff: number;
  /** Jitter fraction in `[0, 1]`.  Default `0.2`. */
  readonly randomFactor?: number;
  /** Custom policy — overrides the default exponential backoff. */
  readonly policy?: BackoffPolicy;
  /** Counter-reset rule.  Default `'after-min-stable'`. */
  readonly resetCounter?: ResetCounter;
  /** What to do with messages while the child is dead.  Default `'stash'`. */
  readonly forward?: ForwardStrategy;
  /**
   * Which terminations should trigger a respawn.  Default `'any'`
   * (current v1 behaviour: respawn on crash AND on clean stop).
   * See {@link TerminationTrigger} for the three modes.
   */
  readonly triggerOn?: TerminationTrigger;
  /** Stash buffer size (only when `forward === 'stash'`).  Default 1000. */
  readonly maxStashSize?: number;
  /**
   * Grace period after a respawn before stashed messages are forwarded
   * to the new child.  This protects buffered messages against children
   * that crash in `preStart` — if the child dies during the grace
   * window, the stash is preserved for the **next** incarnation.
   *
   * Default: `min(50ms, minBackoff)`.  Set `0` to disable (drain
   * immediately on spawn — the v0 behaviour).
   */
  readonly drainGraceMs?: number;
  /**
   * What to do with messages that arrive during the grace window
   * (after a respawn, before the child has proven it survives
   * `drainGraceMs`).  Two modes (#67):
   *
   *   - `true` *(default)* — v1 behaviour.  New messages forward
   *     immediately to the about-to-be-confirmed child; if that
   *     child dies in `preStart`, those forwarded messages
   *     dead-letter.  Lowest latency on the happy path, accepts
   *     dead-letters during a preStart-crash cascade.
   *   - `false` — strict mode.  New messages stash until the grace
   *     expires, then drain alongside the carry-over stash from the
   *     previous incarnation.  Costs up to `drainGraceMs` of latency
   *     on the first messages after a respawn but guarantees nothing
   *     dead-letters when the child keeps crashing in `preStart`.
   *     Opt-in to fix the dead-letter cascade described in #67.
   *
   * Has no effect when `drainGraceMs === 0` — without a grace there
   * is no "uncertain" window for the gate to apply to.
   */
  readonly forwardDuringGrace?: boolean;
  /** Override `Date.now`/`Math.random` for deterministic tests. */
  readonly clock?: () => number;
}

/** Default child name when the user doesn't supply one. */
const DEFAULT_CHILD_NAME = 'child';
/** Default cap so a stuck supervisor doesn't OOM the process. */
const DEFAULT_STASH_LIMIT = 1000;

interface StashedMessage {
  readonly msg: unknown;
  readonly sender: ActorRef | null;
}

export class BackoffSupervisor<T> extends Actor<unknown> {
  /**
   * Build a `Props` that spawns a `BackoffSupervisor` configured with
   * the given options.  Apply `withSupervisorStrategy` if you want to
   * change how the supervisor itself is supervised (the **child** is
   * always run under `stoppingStrategy` regardless of this).
   */
  static props<T>(opts: BackoffOptions<T>): Props<unknown> {
    return Props.create<unknown>(() => new BackoffSupervisor(opts) as unknown as Actor<unknown>);
  }

  private readonly opts: BackoffOptions<T>;
  private readonly policy: BackoffPolicy;
  private readonly childName: string;
  private readonly forward: ForwardStrategy;
  private readonly stashLimit: number;
  private readonly resetThresholdMs: number | null;
  private readonly drainGraceMs: number;
  private readonly clock: () => number;
  private readonly triggerOn: TerminationTrigger;
  private readonly forwardDuringGrace: boolean;
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
  /** Counter for the **next** restart's delay (0 = first respawn). */
  private restartCount = 0;
  /** Wall-clock ts of the last successful spawn, for the reset-window check. */
  private spawnTs = 0;
  /** Monotonic incarnation counter — used to disambiguate child names. */
  private incarnation = 0;
  /** Buffered messages waiting for the next child. */
  private readonly stash: StashedMessage[] = [];

  constructor(opts: BackoffOptions<T>) {
    super();
    if (!Number.isFinite(opts.minBackoff) || opts.minBackoff <= 0) {
      throw new Error(`BackoffSupervisor: minBackoff must be > 0, got ${opts.minBackoff}`);
    }
    if (!Number.isFinite(opts.maxBackoff) || opts.maxBackoff < opts.minBackoff) {
      throw new Error(
        `BackoffSupervisor: maxBackoff (${opts.maxBackoff}) must be >= minBackoff (${opts.minBackoff})`,
      );
    }
    this.opts = opts;
    this.policy = opts.policy ?? exponentialBackoff({
      minMs: opts.minBackoff,
      maxMs: opts.maxBackoff,
      randomFactor: opts.randomFactor ?? 0.2,
    });
    this.childName = opts.childName ?? DEFAULT_CHILD_NAME;
    this.forward = opts.forward ?? 'stash';
    this.stashLimit = opts.maxStashSize ?? DEFAULT_STASH_LIMIT;
    this.resetThresholdMs = resolveResetThreshold(opts.resetCounter, opts.minBackoff);
    if (opts.drainGraceMs !== undefined) {
      if (!Number.isFinite(opts.drainGraceMs) || opts.drainGraceMs < 0) {
        throw new Error(`BackoffSupervisor: drainGraceMs must be >= 0, got ${opts.drainGraceMs}`);
      }
      this.drainGraceMs = opts.drainGraceMs;
    } else {
      this.drainGraceMs = Math.min(50, opts.minBackoff);
    }
    this.clock = opts.clock ?? Date.now;
    this.triggerOn = opts.triggerOn ?? 'any';
    // Default `true` keeps the v1 fast-forward path; the dead-letter
    // protection is opt-in (#67) because every respawn would
    // otherwise pay `drainGraceMs` of latency on the happy path.
    this.forwardDuringGrace = opts.forwardDuringGrace ?? true;
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

  override preStart(): void {
    this.spawnChild();
  }

  override async onReceive(message: unknown): Promise<void> {
    if (message instanceof Terminated) {
      this.handleTerminated(message);
      return;
    }
    // Internal respawn tick — we only ever schedule it via timers, so
    // any other appearance is a bug somewhere upstream.
    if (message === RESPAWN_TICK) {
      this.respawn();
      return;
    }
    // Internal drain tick — fired drainGraceMs after a respawn.  If
    // the child is still alive, mark it confirmed and drain the
    // stash.  If it died in the meantime, currentChild is null and
    // we leave the stash for the next incarnation.
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
    if (this.currentChild && (this.childConfirmedAlive || this.forwardDuringGrace)) {
      this.currentChild.tell(message as T, this.sender.toNullable());
      return;
    }
    if (this.forward === 'drop') {
      this.log.debug('BackoffSupervisor: dropping message during backoff window', { message });
      return;
    }
    // 'stash' mode.
    if (this.stash.length >= this.stashLimit) {
      this.log.warn('BackoffSupervisor: stash full — dropping oldest message', {
        stashLimit: this.stashLimit,
      });
      this.stash.shift();
    }
    this.stash.push({ msg: message, sender: this.sender.toNullable() });
  }

  override postStop(): void {
    // Cancel any pending respawn / drain — the cell already cancels
    // its timers for us, but doing it explicitly keeps the intent
    // obvious if someone refactors `timers.cancelAll`.
    this.context.timers.cancel(RESPAWN_TIMER_KEY);
    this.context.timers.cancel(DRAIN_TIMER_KEY);
    this.stash.length = 0;
  }

  /* ------------------------- internals ---------------------------------- */

  private spawnChild(): void {
    this.incarnation += 1;
    const name = `${this.childName}-${this.incarnation}`;
    const child = this.context.actorOf(this.opts.childProps, name);
    this.context.watch(child);
    this.currentChild = child;
    this.spawnTs = this.clock();
    // Reset the alive-confirmation flag.  In the default
    // `forwardDuringGrace: true` mode this only matters for the
    // explicit-stash carry-over (the gate doesn't apply); in the
    // opt-in strict mode it gates new forwards until DRAIN_TICK
    // flips it back to true.  `drainGraceMs === 0` skips the grace
    // entirely.
    this.childConfirmedAlive = this.drainGraceMs === 0;
    if (this.drainGraceMs === 0) {
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
      this.drainGraceMs,
    );
  }

  private handleTerminated(t: Terminated): void {
    // Ignore stale Terminated messages from a previous incarnation —
    // can happen if we already started a respawn before the old ref's
    // Terminated finished its trip through the mailbox.
    if (!this.currentChild || !t.actor.equals(this.currentChild)) {
      return;
    }
    // Snapshot + clear the failure flag set by the decider.  Doing it
    // here (not later) keeps the supervisor's state clean even if the
    // triggerOn check causes us to stop ourselves and skip the rest.
    const wasFailure = this.lastTerminationWasFailure;
    this.lastTerminationWasFailure = false;

    if (!this.shouldRespawn(wasFailure)) {
      this.log.info('BackoffSupervisor: child terminated, triggerOn rejected — supervisor stops', {
        child: t.actor.toString(),
        cause: wasFailure ? 'failure' : 'stop',
        triggerOn: this.triggerOn,
      });
      // Stop ourselves — the parent (or whoever spawned us) gets a
      // Terminated for the supervisor and decides what to do next.
      this.currentChild = null;
      this.childConfirmedAlive = false;
      this.context.timers.cancel(DRAIN_TIMER_KEY);
      this.context.stop(this.self);
      return;
    }

    const aliveFor = this.clock() - this.spawnTs;
    if (this.resetThresholdMs !== null && aliveFor >= this.resetThresholdMs) {
      this.restartCount = 0;
    }
    const delay = this.policy.delayFor(this.restartCount);
    this.restartCount += 1;
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
      child: t.actor.toString(),
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
    return match(this.triggerOn)
      .with('any',     () => true)
      .with('failure', () => wasFailure)
      .with('stop',    () => !wasFailure)
      .exhaustive();
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
    for (const { msg, sender } of drained) {
      child.tell(msg as T, sender);
    }
  }
}

/** Sentinel for the respawn timer message. */
const RESPAWN_TICK = Symbol.for('actor-ts.pattern.BackoffSupervisor.respawn');
const RESPAWN_TIMER_KEY = 'actor-ts.pattern.BackoffSupervisor.respawn';
/** Sentinel for the stash-drain timer message. */
const DRAIN_TICK = Symbol.for('actor-ts.pattern.BackoffSupervisor.drain');
const DRAIN_TIMER_KEY = 'actor-ts.pattern.BackoffSupervisor.drain';

function resolveResetThreshold(
  rule: ResetCounter | undefined, minBackoff: number,
): number | null {
  // Exhaustive over `ResetCounter | undefined`.  `undefined` maps to
  // the same default behaviour as 'after-min-stable'.  Adding a new
  // ResetCounter variant forces this site to be updated.
  return match(rule)
    .with(undefined, 'after-min-stable', () => minBackoff)
    .with('never', () => null)
    .with({ kind: 'after-time' }, (r) => {
      if (!Number.isFinite(r.ms) || r.ms < 0) {
        throw new Error(`BackoffSupervisor: resetCounter.ms must be a non-negative number, got ${r.ms}`);
      }
      return r.ms;
    })
    .exhaustive();
}
