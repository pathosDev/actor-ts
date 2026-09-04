import type { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/**
 * Built-in `maxFailures`, published as
 * `actor-ts.circuit-breaker.default.max-failures`.
 *
 * Applied by {@link CircuitBreakerExtension}, not by the constructor: a
 * `new CircuitBreaker({})` still throws, because a breaker whose failure
 * budget nobody chose would silently never open.  The extension is the door
 * that has a configuration file behind it, so it is the one that can supply a
 * floor without inventing it.
 */
export const DEFAULT_CIRCUIT_BREAKER_MAX_FAILURES = 10;

/**
 * Built-in `resetTimeoutMs`, published as
 * `actor-ts.circuit-breaker.default.reset-timeout`.  Same reasoning as
 * {@link DEFAULT_CIRCUIT_BREAKER_MAX_FAILURES} — the extension applies it, the
 * constructor keeps refusing to invent one.
 */
export const DEFAULT_CIRCUIT_BREAKER_RESET_TIMEOUT_MS = 15_000;

/**
 * Ceiling the grown reopen window is clamped to — the default for
 * {@link CircuitBreakerOptionsType.maxResetTimeoutMs}, published as
 * `actor-ts.circuit-breaker.default.max-reset-timeout`.
 *
 * One minute is the number the rest of the project converged on for a backoff
 * someone is waiting behind: `DEFAULT_MAX_RETRY_DELAY_MS`,
 * `actor-ts.projection.max-retry-backoff` and the broker reconnect loop all
 * land in the same place.  Four doublings from the 15 s default window.
 *
 * Deliberately **not** Akka's `36500d`.  A 100-year sentinel meaning "no cap"
 * parses here, but it publishes 3.15e12 ms as a documented default that says
 * nothing, and the value it stands for — an unbounded window — is the state
 * this project already refuses for a `resetTimeoutMs` (`nonNegativeNumber`
 * rejects `Infinity`).  A finite ceiling an operator can see and raise is the
 * shape the retry ceiling arrived at for the same reason (#771).
 */
export const DEFAULT_CIRCUIT_BREAKER_MAX_RESET_TIMEOUT_MS = 60_000;

/**
 * Built-in `backoffFactor`, published as
 * `actor-ts.circuit-breaker.default.backoff-factor`.
 *
 * `1` is "no growth", which reproduces the flat reopen window every release
 * before #864 had — so the schedule only changes for a deployment that asks
 * for it.  The same call the retry jitter fix made (#771).
 */
export const DEFAULT_CIRCUIT_BREAKER_BACKOFF_FACTOR = 1;

/**
 * Built-in `randomFactor`, published as
 * `actor-ts.circuit-breaker.default.random-factor`.  `0` is "no jitter", for
 * the same additive reason as {@link DEFAULT_CIRCUIT_BREAKER_BACKOFF_FACTOR};
 * `0.2` is the spread the rest of the project uses when it is turned on.
 */
export const DEFAULT_CIRCUIT_BREAKER_RANDOM_FACTOR = 0;

/** Plain options-object shape accepted by a {@link CircuitBreaker}. */
export type CircuitBreakerOptionsType = {
  /** Consecutive failures before the breaker opens.  Must be >= 1. */
  readonly maxFailures: number;
  /** How long the breaker stays open before letting a probe through.  ms. */
  readonly resetTimeoutMs: number;
  /** Per-call timeout; exceeding this counts as a failure. */
  readonly callTimeoutMs?: number;
  /** Optional: classify errors as non-failures to bypass breaker counting. */
  readonly isFailure?: (err: Error) => boolean;
  /**
   * Ceiling the reopen window may grow to under {@link backoffFactor}, in ms.
   * Defaults to {@link DEFAULT_CIRCUIT_BREAKER_MAX_RESET_TIMEOUT_MS}.
   *
   * It bounds the *whole* window rather than only the growth, so a
   * `resetTimeoutMs` above the ceiling is a contradiction rather than a
   * silently shortened window — the validator refuses that pair and names this
   * field.  Clamping quietly would take a reopen window an operator chose and
   * replace it with one nobody wrote down.
   */
  readonly maxResetTimeoutMs?: number;
  /**
   * Multiplier applied to the reopen window per consecutive open, `>= 1`.
   * Defaults to {@link DEFAULT_CIRCUIT_BREAKER_BACKOFF_FACTOR} (`1` — no
   * growth, the shipped behaviour).
   *
   * The window is `resetTimeoutMs * backoffFactor^(consecutive opens - 1)`,
   * clamped to {@link maxResetTimeoutMs}.  Below `1` it would *shrink*, so a
   * breaker would probe a dependency more often the longer that dependency
   * stayed broken — the inverse of what a backoff is for, which is why the
   * validator refuses it rather than treating it as an exotic choice.
   */
  readonly backoffFactor?: number;
  /**
   * Jitter fraction in `[0, 1]` applied to the reopen window: the delay is
   * multiplied by `1 + random(-randomFactor, +randomFactor)`.  Defaults to
   * {@link DEFAULT_CIRCUIT_BREAKER_RANDOM_FACTOR} (`0` — no jitter).
   *
   * Same contract as `RetryOptions.randomFactor` and
   * `ExponentialBackoffOptions.randomFactor`.  What it buys a breaker is the
   * same thing it buys a reconnect loop: N replicas that opened on one
   * upstream event stop probing it in lockstep, so the recovering dependency
   * meets a spread of probes instead of a synchronised wave.
   */
  readonly randomFactor?: number;
  /**
   * `Error.name` values that never count as a failure.  Absent and `[]` mean
   * the same thing, which is what lets the HOCON leaf publish `[]`.
   *
   * Checked **before** {@link isFailure}, and that order is the point: this
   * list is the operator's half of the classifier and arrives from a config
   * file, while `isFailure` is the developer's and is compiled in.  If the
   * predicate could override the list, an operator adding a name would be
   * writing a key that goes inert for exactly the deployments that needed it.
   *
   * `"CircuitBreakerTimeoutError"` is listable and means "a call that blew its
   * own `callTimeoutMs` does not count against the breaker" — coherent, and
   * surprising enough to be worth saying out loud.
   */
  readonly ignoredErrorNames?: readonly string[];
  /**
   * Override `Math.random` for deterministic tests.  No HOCON leaf and it
   * cannot have one — a config file expresses values, not functions.  The same
   * seam `RetryOptions.random` and `BrokerCommonOptionsType.reconnect.random`
   * carry, and without it the jittered schedule is only assertable through a
   * range, which is a test that passes for a broken multiplier.
   */
  readonly random?: () => number;
};

/**
 * Fluent builder for {@link CircuitBreakerOptionsType}:
 *
 *     new CircuitBreaker(CircuitBreakerOptions.create()
 *       .withMaxFailures(5)
 *       .withResetTimeoutMs(10_000));
 */
export class CircuitBreakerOptionsBuilder extends OptionsBuilder<CircuitBreakerOptionsType> {
  /** Start a fresh builder. */
  static create(): CircuitBreakerOptionsBuilder {
    return new CircuitBreakerOptionsBuilder();
  }

  /** Consecutive failures before the breaker opens.  Must be >= 1. */
  withMaxFailures(maxFailures: number): this {
    return this.set('maxFailures', maxFailures);
  }

  /** How long the breaker stays open before letting a probe through (ms). */
  withResetTimeoutMs(resetTimeoutMs: number): this {
    return this.set('resetTimeoutMs', resetTimeoutMs);
  }

  /** Per-call timeout; exceeding it counts as a failure. */
  withCallTimeoutMs(callTimeoutMs: number): this {
    return this.set('callTimeoutMs', callTimeoutMs);
  }

  /** Classify errors as non-failures to bypass breaker counting. */
  withIsFailure(isFailure: (err: Error) => boolean): this {
    return this.set('isFailure', isFailure);
  }

  /** Ceiling the reopen window may grow to under `withBackoffFactor` (ms). */
  withMaxResetTimeoutMs(maxResetTimeoutMs: number): this {
    return this.set('maxResetTimeoutMs', maxResetTimeoutMs);
  }

  /** Multiplier applied to the reopen window per consecutive open (>= 1). */
  withBackoffFactor(backoffFactor: number): this {
    return this.set('backoffFactor', backoffFactor);
  }

  /** Jitter fraction in `[0, 1]` spread over the reopen window. */
  withRandomFactor(randomFactor: number): this {
    return this.set('randomFactor', randomFactor);
  }

  /** `Error.name` values that never count as a failure. */
  withIgnoredErrorNames(ignoredErrorNames: readonly string[]): this {
    return this.set('ignoredErrorNames', ignoredErrorNames);
  }

  /** Override `Math.random` — deterministic jitter for tests. */
  withRandom(random: () => number): this {
    return this.set('random', random);
  }
}

/**
 * Validates resolved {@link CircuitBreakerOptionsType} settings.
 * `maxFailures` and `resetTimeoutMs` are required at runtime too — a breaker
 * without them would silently never open / never probe.
 */
export class CircuitBreakerOptionsValidator extends OptionsValidator<CircuitBreakerOptionsType> {
  constructor() {
    super('CircuitBreakerOptions');
  }
  protected rules(s: Partial<CircuitBreakerOptionsType>): void {
    if (s.maxFailures === undefined) this.fail('maxFailures', 'is required');
    if (s.resetTimeoutMs === undefined) this.fail('resetTimeoutMs', 'is required');
    this.positiveInt('maxFailures');
    this.nonNegativeNumber('resetTimeoutMs');
    this.positiveNumber('callTimeoutMs');
    this.positiveNumber('maxResetTimeoutMs');
    this.numberInRange('randomFactor', 0, 1);
    // `>= 1` has no helper, and `numberInRange(field, 1, Infinity)` would not
    // be one either — its upper bound has to be finite to reject a NaN.
    if (s.backoffFactor !== undefined
      && (typeof s.backoffFactor !== 'number'
        || !Number.isFinite(s.backoffFactor)
        || s.backoffFactor < 1)) {
      this.fail('backoffFactor', 'must be a finite number >= 1', s.backoffFactor);
    }
    // `nonEmptyArray` is the wrong helper here: `[]` is the neutral value and
    // the one reference.conf publishes.  What is worth refusing is a member
    // that could never equal an `Error.name`.
    if (s.ignoredErrorNames !== undefined) {
      if (!Array.isArray(s.ignoredErrorNames)) {
        this.fail('ignoredErrorNames', 'must be an array of error names', s.ignoredErrorNames);
      }
      for (const [index, name] of s.ignoredErrorNames.entries()) {
        if (typeof name !== 'string' || name.length === 0) {
          this.fail(`ignoredErrorNames[${index}]`, 'must be a non-empty string', name);
        }
      }
    }
    // Cross-field, and against the *effective* ceiling rather than only a set
    // one: an unset `maxResetTimeoutMs` still clamps at
    // DEFAULT_CIRCUIT_BREAKER_MAX_RESET_TIMEOUT_MS, so a longer
    // `resetTimeoutMs` with no ceiling named would be shortened on the very
    // first open with nothing to see it happen.
    const ceiling = s.maxResetTimeoutMs ?? DEFAULT_CIRCUIT_BREAKER_MAX_RESET_TIMEOUT_MS;
    if (s.resetTimeoutMs !== undefined && Number.isFinite(s.resetTimeoutMs) && ceiling < s.resetTimeoutMs) {
      this.fail(
        'maxResetTimeoutMs',
        `must be at least resetTimeoutMs (${s.resetTimeoutMs})`,
        s.maxResetTimeoutMs,
      );
    }
  }
}

/**
 * The full config paths of one circuit-breaker block's leaves.  The defaults
 * block's copy is `ConfigKeys.circuitBreaker.default`; a per-breaker block's is
 * built by {@link circuitBreakerKeysUnder}, since its root contains an id only
 * the application knows.
 *
 * `callTimeout` is in here but has no `reference.conf` leaf — see
 * {@link readCircuitBreakerOptionsFromConfig}.  `isFailure` and `random` are
 * absent and cannot be added: HOCON expresses values, not functions.
 */
export type CircuitBreakerKeys = {
  readonly maxFailures: string;
  readonly resetTimeout: string;
  readonly callTimeout: string;
  readonly maxResetTimeout: string;
  readonly backoffFactor: string;
  readonly randomFactor: string;
  readonly ignoredErrorNames: string;
};

/** The leaf paths of the circuit-breaker block at `root` — see {@link CircuitBreakerKeys}. */
export function circuitBreakerKeysUnder(root: string): CircuitBreakerKeys {
  return {
    maxFailures: `${root}.max-failures`,
    resetTimeout: `${root}.reset-timeout`,
    callTimeout: `${root}.call-timeout`,
    maxResetTimeout: `${root}.max-reset-timeout`,
    backoffFactor: `${root}.backoff-factor`,
    randomFactor: `${root}.random-factor`,
    ignoredErrorNames: `${root}.ignored-error-names`,
  };
}

/**
 * Read one `actor-ts.circuit-breaker.*` block, omitting absent leaves so an
 * unset one falls through to the layer below instead of shadowing it — the
 * rule `mergeOptions` encodes.
 *
 * Leaf names are the kebab-case of the {@link CircuitBreakerOptionsType} fields
 * with any unit suffix dropped (#1405), so `resetTimeoutMs` is read from
 * `reset-timeout`; `getDuration` takes `15s` and a bare millisecond count
 * alike.  `backoff-factor` and `random-factor` go through `getNumber` and not
 * `getInt`, which throws outright on `0.2`.
 *
 * **`call-timeout` is deliberately not in `reference.conf`.**  Omitting
 * `callTimeoutMs` is what disables the per-call timeout, and the validator
 * refuses `0`, so "no deadline" is a state only a missing key can express —
 * the same reason `actor-ts.cache.redis.host` is a comment.  Publishing a real
 * default here would hand every config-resolved breaker a deadline that a
 * hand-built one does not have.  The key is still read, so a deployment that
 * writes it gets it.
 */
export function readCircuitBreakerOptionsFromConfig(
  config: Config,
  keys: CircuitBreakerKeys = ConfigKeys.circuitBreaker.default,
): Partial<CircuitBreakerOptionsType> {
  const out: { -readonly [K in keyof CircuitBreakerOptionsType]?: CircuitBreakerOptionsType[K] } = {};
  if (config.hasPath(keys.maxFailures)) out.maxFailures = config.getInt(keys.maxFailures);
  if (config.hasPath(keys.resetTimeout)) out.resetTimeoutMs = config.getDuration(keys.resetTimeout);
  if (config.hasPath(keys.callTimeout)) out.callTimeoutMs = config.getDuration(keys.callTimeout);
  if (config.hasPath(keys.maxResetTimeout)) {
    out.maxResetTimeoutMs = config.getDuration(keys.maxResetTimeout);
  }
  if (config.hasPath(keys.backoffFactor)) out.backoffFactor = config.getNumber(keys.backoffFactor);
  if (config.hasPath(keys.randomFactor)) out.randomFactor = config.getNumber(keys.randomFactor);
  if (config.hasPath(keys.ignoredErrorNames)) {
    out.ignoredErrorNames = config.getStringList(keys.ignoredErrorNames);
  }
  return out;
}

/**
 * Accepted input for the {@link CircuitBreaker} constructor: the fluent
 * {@link CircuitBreakerOptionsBuilder} OR a plain
 * {@link CircuitBreakerOptionsType} object.
 */
export type CircuitBreakerOptions = CircuitBreakerOptionsBuilder | Partial<CircuitBreakerOptionsType>;
/** Value alias so `CircuitBreakerOptions.create()` / `new CircuitBreakerOptions()` resolve to the builder. */
export const CircuitBreakerOptions = CircuitBreakerOptionsBuilder;
