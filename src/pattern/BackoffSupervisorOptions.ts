import type { ActorClassOrFactory } from '../Actor.js';
import type { ActorOptions } from '../ActorOptions.js';
import type { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { mergeOptions } from '../util/OptionsMerge.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import type { BackoffPolicy } from './BackoffPolicy.js';

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

/**
 * The tuning half of a supervisor's options — every field a HOCON file could
 * conceivably carry, split out from {@link BackoffSupervisorOptionsType} so it
 * is free of the message-type parameter.
 *
 * That split is not cosmetic.  {@link OptionsValidator}'s check helpers key
 * their field names off `KeysMatching<T, …>`, a mapped type; over a generic
 * instantiation those names stay deferred and a literal like `'minBackoff'` no
 * longer type-checks.  Keeping the validated shape non-generic is what lets
 * every rule below be a one-liner with a typo-checked field name.
 */
export type BackoffSupervisorTuningType = {
  /** Name suffix for the child.  The actual child name is
   *  `${childName}-${incarnation}` so successive incarnations don't
   *  collide on names while the previous instance is still tearing down. */
  readonly childName?: string;
  /** Floor for the backoff delay, in ms.  Must be > 0. */
  readonly minBackoff?: number;
  /** Ceiling for the backoff delay, in ms.  Must be >= `minBackoff`. */
  readonly maxBackoff?: number;
  /** Jitter fraction in `[0, 1]`.  Default {@link DEFAULT_BACKOFF_RANDOM_FACTOR}. */
  readonly randomFactor?: number;
  /** Counter-reset rule.  Default {@link DEFAULT_BACKOFF_RESET_COUNTER}. */
  readonly resetCounter?: ResetCounter;
  /** What to do with messages while the child is dead.  Default {@link DEFAULT_BACKOFF_FORWARD}. */
  readonly forward?: ForwardStrategy;
  /**
   * Which terminations should trigger a respawn.  Default
   * {@link DEFAULT_BACKOFF_TRIGGER_ON} (respawn on crash AND on clean stop).
   * See {@link TerminationTrigger} for the three modes.
   */
  readonly triggerOn?: TerminationTrigger;
  /** Stash buffer size (only when `forward === 'stash'`).  Default {@link DEFAULT_BACKOFF_MAX_STASH_SIZE}. */
  readonly maxStashSize?: number;
  /**
   * Grace period after a respawn before stashed messages are forwarded
   * to the new child.  This protects buffered messages against children
   * that crash in `preStart` — if the child dies during the grace
   * window, the stash is preserved for the **next** incarnation.
   *
   * Default: `min(50ms, minBackoff)`.  Set `0` to disable (drain
   * immediately on spawn — the v0 behaviour).
   *
   * **Deliberately not a HOCON leaf.**  Its default is derived from another
   * field, so publishing a literal would freeze `50` for a supervisor whose
   * `minBackoff` is `10` and silently lengthen its grace past its own backoff
   * window.  There is no constant to pin it to either, which is the shape
   * `DocumentedDefaults` cannot express.
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
};

/** Plain options-object shape accepted by a `BackoffSupervisor`. */
export type BackoffSupervisorOptionsType<T> = BackoffSupervisorTuningType & {
  /** The child actor — its class, or a factory when it needs dependencies. */
  readonly child: ActorClassOrFactory<T>;
  /** Spawn options for the child.  Its supervision is fixed, see `BackoffSupervisor.factory`. */
  readonly childOptions?: ActorOptions<T>;
  /** Custom policy — overrides the default exponential backoff. */
  readonly policy?: BackoffPolicy;
  /** Override `Date.now`/`Math.random` for deterministic tests. */
  readonly clock?: () => number;
};

/**
 * Default child name when the user doesn't supply one.
 *
 * Not a config leaf: the child's name is per-call-site identity — two
 * supervisors in one process want two names — so a fleet-wide value would be
 * actively wrong rather than merely unhelpful.
 */
export const DEFAULT_BACKOFF_CHILD_NAME = 'child';
/**
 * Floor and ceiling of the built-in exponential delay.
 *
 * **These two are new** — before #865 both fields were required, so the
 * framework shipped no default to preserve, and "keep today's number" was not
 * an option.  200 ms / 10 s is the value the rest of the repository already
 * converged on for the same mechanism: `WorkerClusterOptions`'
 * `DEFAULT_RESTART_MIN_BACKOFF_MS` / `DEFAULT_RESTART_MAX_BACKOFF_MS` pace a
 * crashed worker slot's respawn with exactly this curve, the pattern's own
 * documentation narrates it ("200 ms, 400, 800, …") and its runnable example
 * passes it explicitly.  The alternative on the table was 1 s / 30 s, which no
 * call site in this repository uses and which would have made the published
 * narrative wrong on the first page a reader opens.  No measurement backs
 * either — this one is the one that leaves the tree self-consistent.
 */
export const DEFAULT_BACKOFF_MIN_MS = 200;
/** @see DEFAULT_BACKOFF_MIN_MS */
export const DEFAULT_BACKOFF_MAX_MS = 10_000;
/** Jitter fraction applied to the built-in exponential delay. */
export const DEFAULT_BACKOFF_RANDOM_FACTOR = 0.2;
/**
 * Default cap so a stuck supervisor doesn't OOM the process.
 *
 * Named for the field it defaults (`maxStashSize`) rather than the older
 * `DEFAULT_STASH_LIMIT`: this is now an exported name sharing a namespace with
 * `ActorCell`'s `DEFAULT_STASH_CAPACITY`, which bounds the unrelated per-actor
 * stash, and two "stash limit" constants a thousand apart are worth telling
 * apart at the import site.
 */
export const DEFAULT_BACKOFF_MAX_STASH_SIZE = 1000;
/**
 * Reset the restart counter once the child outlives one `minBackoff`.
 *
 * Typed as the literal rather than as `ResetCounter`: the union carries an
 * object variant, and `DocumentedDefaults` pins its constants as
 * `number | string | boolean`, so the wider annotation would put this leaf
 * out of reach of the guard that checks it against `reference.conf`.
 */
export const DEFAULT_BACKOFF_RESET_COUNTER = 'after-min-stable' as const satisfies ResetCounter;
/** Buffer messages arriving during a backoff window rather than dropping them. */
export const DEFAULT_BACKOFF_FORWARD: ForwardStrategy = 'stash';
/** Respawn on every termination — the original #48 behaviour. */
export const DEFAULT_BACKOFF_TRIGGER_ON: TerminationTrigger = 'any';

/**
 * Fields the built-in defaults always supply, so a merged settings object is
 * known to carry them without a non-null assertion at every read site.
 */
type DefaultedBackoffField =
  'childName' | 'minBackoff' | 'maxBackoff' | 'randomFactor'
  | 'resetCounter' | 'forward' | 'triggerOn' | 'maxStashSize';

/** The built-in layer — the lowest of the three, under HOCON and explicit options. */
const builtInBackoffSupervisorDefaults: Required<Pick<BackoffSupervisorTuningType, DefaultedBackoffField>> = {
  childName: DEFAULT_BACKOFF_CHILD_NAME,
  minBackoff: DEFAULT_BACKOFF_MIN_MS,
  maxBackoff: DEFAULT_BACKOFF_MAX_MS,
  randomFactor: DEFAULT_BACKOFF_RANDOM_FACTOR,
  resetCounter: DEFAULT_BACKOFF_RESET_COUNTER,
  forward: DEFAULT_BACKOFF_FORWARD,
  triggerOn: DEFAULT_BACKOFF_TRIGGER_ON,
  maxStashSize: DEFAULT_BACKOFF_MAX_STASH_SIZE,
};

/**
 * Merged supervisor settings: every defaulted field present, the rest as the
 * caller gave them.  What `BackoffSupervisor` resolves in `preStart` and what
 * {@link BackoffSupervisorOptionsValidator} runs against.
 */
export type BackoffSupervisorSettings<T> =
  Omit<BackoffSupervisorOptionsType<T>, DefaultedBackoffField>
  & Required<Pick<BackoffSupervisorOptionsType<T>, DefaultedBackoffField>>;

/**
 * Fluent builder for {@link BackoffSupervisorOptionsType}:
 *
 *     const supervisorOptions = BackoffSupervisorOptions.create<FlakyMessage>()
 *       .withChild(Flaky)
 *       .withMinBackoff(200)
 *       .withMaxBackoff(10_000);
 */
export class BackoffSupervisorOptionsBuilder<T> extends OptionsBuilder<BackoffSupervisorOptionsType<T>> {
  /** Start a fresh builder. */
  static create<T>(): BackoffSupervisorOptionsBuilder<T> {
    return new BackoffSupervisorOptionsBuilder<T>();
  }

  /** The child actor — its class, or a factory when it needs dependencies. */
  withChild(child: ActorClassOrFactory<T>): this {
    return this.set('child', child);
  }

  /** Spawn options for the child; its supervision is fixed regardless. */
  withChildOptions(childOptions: ActorOptions<T>): this {
    return this.set('childOptions', childOptions);
  }

  /** Name suffix for the child — the incarnation counter is appended. */
  withChildName(childName: string): this {
    return this.set('childName', childName);
  }

  /** Floor for the backoff delay, in ms.  Must be > 0. */
  withMinBackoff(minBackoff: number): this {
    return this.set('minBackoff', minBackoff);
  }

  /** Ceiling for the backoff delay, in ms.  Must be >= `minBackoff`. */
  withMaxBackoff(maxBackoff: number): this {
    return this.set('maxBackoff', maxBackoff);
  }

  /** Jitter fraction in `[0, 1]` — inert when a custom `policy` is set. */
  withRandomFactor(randomFactor: number): this {
    return this.set('randomFactor', randomFactor);
  }

  /** Custom policy — overrides the default exponential backoff. */
  withPolicy(policy: BackoffPolicy): this {
    return this.set('policy', policy);
  }

  /** Counter-reset rule. */
  withResetCounter(resetCounter: ResetCounter): this {
    return this.set('resetCounter', resetCounter);
  }

  /** What to do with messages while the child is dead. */
  withForward(forward: ForwardStrategy): this {
    return this.set('forward', forward);
  }

  /** Which terminations should trigger a respawn. */
  withTriggerOn(triggerOn: TerminationTrigger): this {
    return this.set('triggerOn', triggerOn);
  }

  /** Stash buffer size (only when `forward === 'stash'`). */
  withMaxStashSize(maxStashSize: number): this {
    return this.set('maxStashSize', maxStashSize);
  }

  /** Grace period after a respawn before the stash drains, in ms. */
  withDrainGraceMs(drainGraceMs: number): this {
    return this.set('drainGraceMs', drainGraceMs);
  }

  /** Whether messages arriving inside the grace window forward immediately. */
  withForwardDuringGrace(forwardDuringGrace: boolean): this {
    return this.set('forwardDuringGrace', forwardDuringGrace);
  }

  /** Override `Date.now` for deterministic tests. */
  withClock(clock: () => number): this {
    return this.set('clock', clock);
  }
}

/**
 * Validates resolved supervisor settings.
 *
 * It runs **once, in `preStart`, on the merged settings** — which is what
 * makes a bad `min-backoff` in a config file fail exactly like a bad one in
 * code.  Before #865 the same three rules were constructor throws, so the
 * config path did not exist to be checked; moving them here rather than
 * duplicating them is what keeps one rule with one message.
 *
 * `child` is not checked here: it is required-ness, not domain validity, and
 * every check helper is a deliberate no-op on `undefined`.  `BackoffSupervisor`
 * guards it where `BrokerActor.requiredOptions()` guards its own.
 */
export class BackoffSupervisorOptionsValidator extends OptionsValidator<BackoffSupervisorTuningType> {
  constructor() {
    super('BackoffSupervisorOptions');
  }

  protected rules(s: Partial<BackoffSupervisorTuningType>): void {
    this.positiveNumber('minBackoff');
    this.positiveNumber('maxBackoff');
    this.numberInRange('randomFactor', 0, 1);
    this.positiveInt('maxStashSize');
    this.nonNegativeNumber('drainGraceMs');
    this.nonEmptyString('childName');
    this.oneOf('forward', ['stash', 'drop']);
    this.oneOf('triggerOn', ['any', 'failure', 'stop']);
    // Cross-field: an inverted window would make `exponentialBackoff` clamp
    // every delay to a ceiling below its own floor.
    if (s.minBackoff !== undefined && s.maxBackoff !== undefined && s.maxBackoff < s.minBackoff) {
      this.fail('maxBackoff', `must be >= minBackoff (${s.minBackoff})`, s.maxBackoff);
    }
    // The object variant carries its own number, so no field helper reaches
    // it.  `!== null` because `typeof null` is also `'object'`, and a config
    // reader is not the only thing that can hand this validator a settings bag.
    const resetCounter = s.resetCounter;
    if (typeof resetCounter === 'object' && resetCounter !== null
      && (!Number.isFinite(resetCounter.ms) || resetCounter.ms < 0)) {
      this.fail('resetCounter.ms', 'must be a non-negative finite number', resetCounter.ms);
    }
  }
}

/**
 * The slice of supervisor settings HOCON can supply.
 *
 * Six fields are missing on purpose and none of them is an oversight:
 * `child` / `childOptions` / `childName` are the call site's own identity
 * rather than a fleet-wide value (see {@link DEFAULT_BACKOFF_CHILD_NAME}),
 * `policy` and `clock` are functions no config file can express, and
 * `drainGraceMs` has a *derived* default — see its JSDoc on
 * {@link BackoffSupervisorTuningType}.  `forwardDuringGrace` is the seventh
 * and the only debatable one: it is a #67-specific correctness opt-in that
 * only means anything alongside a `drainGraceMs` this block cannot carry, so
 * publishing it alone would offer half a knob.
 */
export type BackoffSupervisorConfigDefaults = Pick<
  BackoffSupervisorTuningType,
  'minBackoff' | 'maxBackoff' | 'randomFactor' | 'maxStashSize'
  | 'resetCounter' | 'forward' | 'triggerOn'
>;

/**
 * Read `actor-ts.backoff-supervisor.*`.
 *
 * The `Config` is a **required argument**, not a `Config.load()` default: a
 * `BackoffSupervisor` runs inside an `ActorSystem` and reaches its config
 * through `this.system.config`, so loading a second one would ignore
 * `ActorSystem.create({ config })` and re-read `application.conf` off disk on
 * every supervisor construction *and* every supervisor restart.
 * `WorkerClusterOptions` defaults the argument because `WorkerCluster.spawn`
 * is a static with no system in scope; that is the exception, not the shape to
 * copy.
 *
 * An absent leaf stays absent in the result rather than being filled with its
 * built-in default — that is what lets `mergeOptions` layer the three sources
 * per field instead of per block.
 */
export function readBackoffSupervisorOptionsFromConfig(config: Config): BackoffSupervisorConfigDefaults {
  const keys = ConfigKeys.backoffSupervisor;
  const out: { -readonly [K in keyof BackoffSupervisorConfigDefaults]: BackoffSupervisorConfigDefaults[K] } = {};
  if (config.hasPath(keys.minBackoff)) {
    out.minBackoff = config.getDuration(keys.minBackoff);
  }
  if (config.hasPath(keys.maxBackoff)) {
    out.maxBackoff = config.getDuration(keys.maxBackoff);
  }
  if (config.hasPath(keys.randomFactor)) {
    // `getNumber`, not `getInt`: a jitter fraction is legitimately fractional
    // and `getInt` throws outright on `0.2`.
    out.randomFactor = config.getNumber(keys.randomFactor);
  }
  if (config.hasPath(keys.maxStashSize)) {
    out.maxStashSize = config.getInt(keys.maxStashSize);
  }
  if (config.hasPath(keys.resetCounter)) {
    // One leaf, dual-read: the two string literals map straight through and
    // anything else is a duration for the `after-time` variant.  The raw value
    // decides which reader applies, not the key — the shape
    // `worker-cluster.workers` already uses for `"auto"` versus a count.
    const raw = config.getString(keys.resetCounter);
    out.resetCounter = raw === 'never' || raw === 'after-min-stable'
      ? raw
      : { kind: 'after-time', ms: config.getDuration(keys.resetCounter) };
  }
  if (config.hasPath(keys.forward)) {
    out.forward = config.getString(keys.forward) as ForwardStrategy;
  }
  if (config.hasPath(keys.triggerOn)) {
    out.triggerOn = config.getString(keys.triggerOn) as TerminationTrigger;
  }
  return out;
}

/**
 * Layer the config block under the caller's options — **explicit options >
 * HOCON > built-in defaults**, as everywhere else.  The result is what
 * {@link BackoffSupervisorOptionsValidator} sees, so an out-of-range value
 * from a config file is rejected exactly like one written in code.
 */
export function withBackoffSupervisorConfigDefaults<T>(
  options: Partial<BackoffSupervisorOptionsType<T>>,
  config: Config,
): BackoffSupervisorSettings<T> {
  return mergeOptions<BackoffSupervisorSettings<T>>(
    builtInBackoffSupervisorDefaults,
    readBackoffSupervisorOptionsFromConfig(config),
    options,
  );
}

/**
 * Accepted input for `BackoffSupervisor.factory`: the fluent
 * {@link BackoffSupervisorOptionsBuilder} OR a plain
 * {@link BackoffSupervisorOptionsType} object.
 *
 * The plain half is **not** `Partial<…>`, unlike its siblings: `child` is the
 * one field neither HOCON nor a built-in default can supply, so leaving it
 * required here is what keeps `BackoffSupervisor.factory({})` a compile error
 * instead of a `preStart` failure.
 */
export type BackoffSupervisorOptions<T> =
  BackoffSupervisorOptionsBuilder<T> | BackoffSupervisorOptionsType<T>;
/** Value alias so `BackoffSupervisorOptions.create()` resolves to the builder. */
export const BackoffSupervisorOptions = BackoffSupervisorOptionsBuilder;
