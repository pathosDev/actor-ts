import type { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/**
 * Built-in default for {@link DiagnosticsOptionsType.logDeadLetters} — ten
 * full records before logging suspends.
 *
 * Ten and not one: the first dead letter of a run is rarely the informative
 * one.  A misrouted name, a stopped supervisor, an ask that timed out — each
 * usually produces a small handful in quick succession, and seeing the shape
 * of the handful is what identifies the sender.  Ten and not a hundred: a
 * delivery outage produces dead letters at message rate, and a hundred lines
 * of the same record buries whatever else the log was saying.
 *
 * There is no measurement behind the number; it is a defensible starting
 * point, and the throttle exists precisely because the exact figure is not
 * load-bearing (#1000).
 */
export const DEFAULT_LOG_DEAD_LETTERS = 10;

/**
 * Built-in default for
 * {@link DiagnosticsOptionsType.logDeadLettersDuringShutdown} — off.
 *
 * `terminate()` drains every stashed and queued user message to dead letters
 * on the way down, so a large system's teardown is a burst that is both
 * expected and uninteresting.  Logging it would make an orderly shutdown look
 * like an incident, which is the fastest way to teach an operator to ignore
 * the record entirely.
 */
export const DEFAULT_LOG_DEAD_LETTERS_DURING_SHUTDOWN = false;

/**
 * Built-in default for
 * {@link DiagnosticsOptionsType.logDeadLettersSuspendDurationMs} — five
 * minutes.
 *
 * Long enough that a sustained delivery failure costs one burst of records per
 * incident rather than one per message; short enough that an operator who
 * fixes the cause sees the log come back within the same sitting.  Like the
 * count above it is a starting point, not a measured value.
 */
export const DEFAULT_LOG_DEAD_LETTERS_SUSPEND_DURATION_MS = 5 * 60 * 1_000;

/**
 * Built-in default for {@link DiagnosticsOptionsType.logConfigOnStart} — off.
 *
 * Off for two reasons that point the same way.  A framework that starts
 * writing a record it never wrote is a behaviour change for every existing
 * deployment, and this particular record is a few hundred lines.  And the
 * dump prints the merged tree: redaction withholds the keys whose *name* says
 * they are secret, which is a guess, so the posture that does not depend on a
 * guess is not printing it unless someone asked (#867).
 */
export const DEFAULT_LOG_CONFIG_ON_START = false;

/**
 * Built-in default for {@link DiagnosticsOptionsType.debugUnhandled} — off.
 *
 * A declined message is already counted (`actor_unhandled_total`) and already
 * dead-lettered, both unconditionally.  The record this adds is the one that
 * names the *message*, so it is per declined message on a path a protocol
 * drift can drive at traffic rate — the same reason its two neighbours below
 * are switches rather than always-on (#1178).
 */
export const DEFAULT_DEBUG_UNHANDLED = false;

/**
 * Built-in default for {@link DiagnosticsOptionsType.debugLifecycle} — off.
 *
 * One record per actor per transition, on the framework's most-created
 * object.  A system that spawns per request would pay for it on every
 * request, and the three transitions are already observable without a log line
 * at all — `ActorStarted`, `ActorStopped` and `ActorRestarted` are published
 * on the event stream, where a subscriber can be selective in a way a level
 * cannot.
 */
export const DEFAULT_DEBUG_LIFECYCLE = false;

/**
 * Built-in default for {@link DiagnosticsOptionsType.debugEventStream} — off.
 *
 * Same argument as {@link DEFAULT_DEBUG_LIFECYCLE}, and one restriction of
 * its own: it traces subscribe and unsubscribe, never `publish`.  Every actor
 * stop unsubscribes, so subscription churn already follows actor churn; a
 * record per publish would additionally follow every actor start, every stop
 * and every dead letter, which is the bus's hot path and not something a
 * config key should be able to put a log call on.
 */
export const DEFAULT_DEBUG_EVENT_STREAM = false;

/**
 * Plain options-object shape behind `actor-ts.diagnostics.*` — what the
 * framework says about itself, as opposed to what it does.
 *
 * Deliberately a separate family from `DeadLetterQueueOptions`, and the split
 * is by *reader*: everything there is read by `DeadLetterQueue` and decides
 * what is **retained**; everything here is read on the publish side by
 * `DeadLetterRef` and decides how loudly a letter is **announced**
 * (`ConfigKeys.deadLetters` carries the long form of that argument).  Folding
 * them together would make a suppression knob look like it gates capture,
 * which the code deliberately prevents by capturing before it logs.
 */
export type DiagnosticsOptionsType = {
  /**
   * Dead letters logged in full before logging suspends.  `0` turns
   * dead-letter logging off entirely.
   *
   * A count rather than the `count | on | off` union the issue sketched: a
   * union-typed leaf has no clean `Config` getter, and "`0` disables" is the
   * convention `retention`, `weakly-up-after` and `max-tombstones` already
   * use.  "On, unthrottled" is
   * {@link logDeadLettersSuspendDurationMs} `= 0`, not a third value here.
   */
  readonly logDeadLetters?: number;
  /**
   * Log the burst `terminate()` produces while it drains mailboxes to dead
   * letters.  Off by default — see
   * {@link DEFAULT_LOG_DEAD_LETTERS_DURING_SHUTDOWN}.
   */
  readonly logDeadLettersDuringShutdown?: boolean;
  /**
   * How long dead-letter logging stays suspended after the count above is
   * reached.  `0` never suspends, which is how "log every letter" is spelled.
   */
  readonly logDeadLettersSuspendDurationMs?: number;
  /**
   * Write the merged configuration to the log once, at startup, with the
   * layer each value came from and secret-looking keys withheld.
   *
   * Emitted at `info`, unlike the three `debug*` switches below — an
   * operator who asks for the dump has asked for output, and burying it at a
   * level they would also have to raise makes the switch look broken.
   */
  readonly logConfigOnStart?: boolean;
  /**
   * Trace every message an actor was handed and declined.  The HOCON leaf
   * is `actor-ts.diagnostics.debug.unhandled`.
   */
  readonly debugUnhandled?: boolean;
  /**
   * Trace actor lifecycle transitions — start, stop, restart —
   * `actor-ts.diagnostics.debug.lifecycle`.
   */
  readonly debugLifecycle?: boolean;
  /**
   * Trace event-stream subscribe and unsubscribe —
   * `actor-ts.diagnostics.debug.event-stream`.  Never publish.
   */
  readonly debugEventStream?: boolean;
};

/**
 * The resolved diagnostics settings a running system carries, with every
 * field decided.
 *
 * `ActorSystem` exposes one of these rather than the optional shape above,
 * because a per-message read site (`recordUnhandled`) must be a plain boolean
 * test and not a `?? DEFAULT_…` — a default applied at the read site is a
 * default that can disagree with the one the merge applied.
 */
export type ResolvedDiagnostics = Required<DiagnosticsOptionsType>;

/** Fluent builder for {@link DiagnosticsOptionsType}. */
export class DiagnosticsOptionsBuilder extends OptionsBuilder<DiagnosticsOptionsType> {
  /** Start a fresh builder. */
  static create(): DiagnosticsOptionsBuilder {
    return new DiagnosticsOptionsBuilder();
  }

  /** Dead letters logged in full before logging suspends.  `0` disables it. */
  withLogDeadLetters(logDeadLetters: number): this {
    return this.set('logDeadLetters', logDeadLetters);
  }

  /** Log the dead letters `terminate()`'s mailbox drain produces. */
  withLogDeadLettersDuringShutdown(logDeadLettersDuringShutdown: boolean): this {
    return this.set('logDeadLettersDuringShutdown', logDeadLettersDuringShutdown);
  }

  /** How long logging stays suspended after the cap.  `0` never suspends. */
  withLogDeadLettersSuspendDurationMs(logDeadLettersSuspendDurationMs: number): this {
    return this.set('logDeadLettersSuspendDurationMs', logDeadLettersSuspendDurationMs);
  }

  /** Dump the merged configuration to the log once at startup. */
  withLogConfigOnStart(logConfigOnStart = true): this {
    return this.set('logConfigOnStart', logConfigOnStart);
  }

  /** Trace messages an actor was handed and declined. */
  withDebugUnhandled(debugUnhandled = true): this {
    return this.set('debugUnhandled', debugUnhandled);
  }

  /** Trace actor start, stop and restart. */
  withDebugLifecycle(debugLifecycle = true): this {
    return this.set('debugLifecycle', debugLifecycle);
  }

  /** Trace event-stream subscribe and unsubscribe.  Never publish. */
  withDebugEventStream(debugEventStream = true): this {
    return this.set('debugEventStream', debugEventStream);
  }
}

/** Validates resolved {@link DiagnosticsOptionsType} settings. */
export class DiagnosticsOptionsValidator extends OptionsValidator<DiagnosticsOptionsType> {
  constructor() {
    super('DiagnosticsOptions');
  }

  protected rules(_s: Partial<DiagnosticsOptionsType>): void {
    // Non-negative rather than positive on both: `0` is a documented posture
    // on each — no logging at all, and never suspending — so rejecting it
    // would remove the only way to say either.
    this.nonNegativeInt('logDeadLetters');
    this.nonNegativeInt('logDeadLettersSuspendDurationMs');
  }
}

/**
 * Accepted input for anything that takes diagnostics options: the fluent
 * builder or the plain object, interchangeably.
 */
export type DiagnosticsOptions = DiagnosticsOptionsBuilder | DiagnosticsOptionsType;
/** Value alias so `DiagnosticsOptions.create()` resolves to the builder. */
export const DiagnosticsOptions = DiagnosticsOptionsBuilder;

/**
 * Read `actor-ts.diagnostics.*` into the shape the `ActorSystem` layers under
 * any explicit options.  Only keys actually present are returned, so an absent
 * one falls through to the built-in default rather than landing as an explicit
 * `undefined` that would shadow it.
 */
export function readDiagnosticsOptionsFromConfig(
  config: Config,
): Partial<DiagnosticsOptionsType> {
  const keys = ConfigKeys.diagnostics;
  const out: {
    -readonly [K in keyof DiagnosticsOptionsType]?: DiagnosticsOptionsType[K]
  } = {};
  if (config.hasPath(keys.logDeadLetters)) {
    out.logDeadLetters = config.getInt(keys.logDeadLetters);
  }
  if (config.hasPath(keys.logDeadLettersDuringShutdown)) {
    out.logDeadLettersDuringShutdown = config.getBoolean(keys.logDeadLettersDuringShutdown);
  }
  if (config.hasPath(keys.logDeadLettersSuspendDuration)) {
    out.logDeadLettersSuspendDurationMs = config.getDuration(keys.logDeadLettersSuspendDuration);
  }
  if (config.hasPath(keys.logConfigOnStart)) {
    out.logConfigOnStart = config.getBoolean(keys.logConfigOnStart);
  }
  if (config.hasPath(keys.debugUnhandled)) {
    out.debugUnhandled = config.getBoolean(keys.debugUnhandled);
  }
  if (config.hasPath(keys.debugLifecycle)) {
    out.debugLifecycle = config.getBoolean(keys.debugLifecycle);
  }
  if (config.hasPath(keys.debugEventStream)) {
    out.debugEventStream = config.getBoolean(keys.debugEventStream);
  }
  return out;
}
