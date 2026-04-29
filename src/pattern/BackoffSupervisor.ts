import { Actor } from '../Actor.js';
import type { ActorRef } from '../ActorRef.js';
import { Props } from '../Props.js';
import { stoppingStrategy, type SupervisorStrategy } from '../Supervision.js';
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
 *      a v1, matches Akka's `BackoffSupervisor` "onTerminated" mode.
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
  /** Stash buffer size (only when `forward === 'stash'`).  Default 1000. */
  readonly maxStashSize?: number;
  /**
   * Grace period after a respawn before stashed messages are forwarded
   * to the new child.  This protects buffered messages against children
   * that crash in `preStart` — if the child dies during the grace
   * window, the stash is preserved for the **next** incarnation.  New
   * messages arriving during the grace window are still forwarded
   * immediately (no extra latency for the happy path).
   *
   * Default: `min(50ms, minBackoff)`.  Set `0` to disable (drain
   * immediately on spawn — the v0 behaviour).
   */
  readonly drainGraceMs?: number;
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
  }

  /**
   * The supervisor's own strategy applied to **its child**.  Forced to
   * `stoppingStrategy` so a child crash becomes a clean Stop and our
   * `Terminated` handler — not the cell's restart loop — drives the
   * respawn cadence.  Users should not override this; configure the
   * supervisor's parent instead.
   */
  override supervisorStrategy(): SupervisorStrategy { return stoppingStrategy; }

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
    // the child is still alive, drain the stash.  If it died in the
    // meantime, currentChild is null and we leave the stash for the
    // next incarnation.
    if (message === DRAIN_TICK) {
      if (this.currentChild) this.drainStash(this.currentChild);
      return;
    }
    // User message — forward or stash.
    if (this.currentChild) {
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
    if (this.stash.length === 0) return;
    if (this.drainGraceMs === 0) {
      this.drainStash(child);
    } else {
      // Wait one grace period before draining so a child that crashes
      // in preStart doesn't take the stash with it to dead-letter.
      this.context.timers.startSingleTimer(
        DRAIN_TIMER_KEY,
        DRAIN_TICK as unknown as never,
        this.drainGraceMs,
      );
    }
  }

  private handleTerminated(t: Terminated): void {
    // Ignore stale Terminated messages from a previous incarnation —
    // can happen if we already started a respawn before the old ref's
    // Terminated finished its trip through the mailbox.
    if (!this.currentChild || !t.actor.equals(this.currentChild)) {
      return;
    }
    const aliveFor = this.clock() - this.spawnTs;
    if (this.resetThresholdMs !== null && aliveFor >= this.resetThresholdMs) {
      this.restartCount = 0;
    }
    const delay = this.policy.delayFor(this.restartCount);
    this.restartCount += 1;
    this.currentChild = null;
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
      delayMs: delay,
      restartCount: this.restartCount,
      aliveMs: aliveFor,
    });
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
  if (rule === undefined || rule === 'after-min-stable') return minBackoff;
  if (rule === 'never') return null;
  if (rule.kind === 'after-time') {
    if (!Number.isFinite(rule.ms) || rule.ms < 0) {
      throw new Error(`BackoffSupervisor: resetCounter.ms must be a non-negative number, got ${rule.ms}`);
    }
    return rule.ms;
  }
  // Exhaustive — TS narrows above; this is just defensive at the type-erasure boundary.
  throw new Error(`BackoffSupervisor: unknown resetCounter rule: ${JSON.stringify(rule)}`);
}
