/**
 * Shared configuration for every broker actor: the common options type
 * (reconnect / circuit-breaker / outbound buffer) that all broker actors
 * accept, the HOCON reader that resolves it, the error raised when a
 * required option is missing, and the builder base that concrete
 * `<X>Options` extend.  The layering that combines the reader's output with
 * defaults and constructor args is `mergeOptions` in `util/OptionsMerge`.
 *
 * The builder base is the "übergeordnete Klasse für gemeinsame Use-Cases"
 * layer between {@link OptionsBuilder} and the concrete builders, so each
 * concrete `<X>Options` (e.g. {@link MqttOptions}) only declares its
 * protocol-specific methods.
 *
 * The `as keyof T` / `as T[keyof T]` casts are the price of writing these
 * setters once against the generic `T extends BrokerCommonOptionsType`;
 * they are confined to this file — concrete subclasses stay fully
 * type-safe because their own methods target concrete field types.
 */
import { ConfigError } from '../../config/Config.js';
import type { Config } from '../../config/Config.js';
import { rejectRetiredLeaves } from '../../config/RetiredKeys.js';
import type { RetiredLeaves } from '../../config/RetiredKeys.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';

/**
 * Common options every broker actor accepts on top of its protocol-
 * specific options.  Subclasses extend this interface with their own
 * required fields (e.g. `brokerUrl`, `topics`).
 */
export type BrokerCommonOptionsType = {
  /**
   * Reconnect strategy applied when the underlying connection drops or
   * `connectImplementation` throws.  Default: exponential backoff starting at
   * `200ms`, doubling, capped at `30s`, jittered by ±20 %, infinite
   * attempts.  Set to `false` to disable auto-reconnect (one-shot
   * connections).
   */
  readonly reconnect?: false | {
    readonly initialDelayMs?: number;
    readonly maxDelayMs?: number;
    readonly factor?: number;
    /** Cap on retry attempts.  Default: `Infinity` (retry forever). */
    readonly maxAttempts?: number;
    /**
     * Jitter fraction in `[0, 1]`, applied to every reconnect wake-up.
     * Default `0.2` (±20 %).
     *
     * Without it the delay is a pure function of the attempt counter and
     * these options, so every broker actor that lost the same broker in the
     * same instant retries in the same millisecond — a thundering herd that
     * re-forms on every wave and can keep the recovering broker down
     * (#652).  `0` restores that fully deterministic schedule.
     */
    readonly randomFactor?: number;
    /**
     * Override `Math.random` for the jitter — the seam that makes a
     * reconnect schedule assertable in a test.  No HOCON leaf: a function
     * cannot come from config, and this is a test seam rather than a
     * tunable.
     */
    readonly random?: () => number;
  };

  /**
   * The `CircuitBreakerExtension` id the connect attempts are called through,
   * or `""` — the same as leaving it unset — for no breaker at all, which is
   * the default.
   *
   * An id rather than a block of numbers, the shape the persistence breakers
   * have (#874): the breaker's settings live under
   * `actor-ts.circuit-breaker.<id>`, layered over
   * `actor-ts.circuit-breaker.default`, which is the one home a breaker's
   * numbers have — a second copy under every broker root would be two (#1478).
   * The breaker is the pattern one, so it has a half-open probe, reopen
   * growth, jitter, `ignored-error-names` and `onStateChange`.
   *
   * Actors that name the same id share one breaker, and so one verdict: once
   * it opens, every one of them waits for the same window, and one probe
   * after it answers for all.  Name one id per broker *cluster*, not per
   * actor and not one for everything — a breaker shared by two unrelated
   * brokers opens on either's failures and holds both off.
   */
  readonly circuitBreaker?: string;

  /**
   * Maximum number of outbound messages buffered while the connection
   * is `connecting` or `disconnected`.  When the buffer is full the
   * oldest message is dropped (FIFO eviction) and a
   * `BrokerBufferOverflow` event is published.  Default: `1000`.  Set
   * to `0` to fail-fast (publish a `BrokerNotConnected` event and drop
   * the message).
   */
  readonly outboundBuffer?: number;
};

export const DEFAULT_RECONNECT = {
  initialDelayMs: 200,
  maxDelayMs: 30_000,
  factor: 2,
  maxAttempts: Number.POSITIVE_INFINITY,
  /**
   * ±20 %, the same spread `exponentialBackoff` in `pattern/BackoffPolicy`
   * defaults to.  Jitter is on by default because the failure mode it
   * prevents — a fleet retrying in lockstep — only shows up in the
   * deployments least able to absorb it.
   */
  randomFactor: 0.2,
} as const;

export const DEFAULT_OUTBOUND_BUFFER = 1000;

/**
 * The full config paths of the leaves every broker block shares, under one
 * broker's root.  Built by {@link brokerCommonKeysUnder} rather than declared
 * once, because the root is the actor's `configKey()` — one per protocol, and
 * one an out-of-tree subclass chooses for itself.
 */
export type BrokerCommonKeys = {
  readonly root: string;
  readonly reconnect: {
    readonly root: string;
    readonly initialDelay: string;
    readonly maxDelay: string;
    readonly factor: string;
    readonly maxAttempts: string;
    readonly randomFactor: string;
  };
  /** A leaf, not a group: the breaker's id.  Its numbers live under `actor-ts.circuit-breaker.<id>`. */
  readonly circuitBreaker: string;
  readonly outboundBuffer: string;
};

/** The shared leaf paths under the broker root `root` — see {@link BrokerCommonKeys}. */
export function brokerCommonKeysUnder(root: string): BrokerCommonKeys {
  const reconnect = `${root}.reconnect`;
  return {
    root,
    reconnect: {
      root: reconnect,
      initialDelay: `${reconnect}.initial-delay`,
      maxDelay: `${reconnect}.max-delay`,
      factor: `${reconnect}.factor`,
      maxAttempts: `${reconnect}.max-attempts`,
      randomFactor: `${reconnect}.random-factor`,
    },
    circuitBreaker: `${root}.circuit-breaker`,
    outboundBuffer: `${root}.outbound-buffer`,
  };
}

/**
 * The camelCase spellings the shared reconnect and buffer leaves had before
 * #1443, mapped to the leaf that replaced each one, relative to a broker's
 * root.
 *
 * `BrokerActor` checks it against `configKey()` before anything is read, so
 * every subclass refuses the old spellings — the fifteen in this package and
 * any written outside it — instead of starting on the built-in reconnect
 * policy and buffer with nothing said.  `factor` is one word in both spellings
 * and has none.  The circuit breaker's old spellings are in a table of their
 * own, {@link RETIRED_BROKER_CIRCUIT_BREAKER_LEAVES}, because that rename moved
 * code as well and the refusal has to say so.  See `rejectRetiredLeaves` in
 * `config/RetiredKeys.ts` for why a retired spelling throws.
 */
export const RETIRED_BROKER_COMMON_LEAVES: RetiredLeaves = {
  'reconnect.initialDelayMs': 'reconnect.initial-delay',
  'reconnect.maxDelayMs': 'reconnect.max-delay',
  'reconnect.maxAttempts': 'reconnect.max-attempts',
  'reconnect.randomFactor': 'reconnect.random-factor',
  outboundBuffer: 'outbound-buffer',
};

/**
 * Every spelling the broker breaker's block has had, relative to a broker's
 * root, mapped to the leaf that replaced it — `circuit-breaker`, which holds
 * an id now (#1478).
 *
 * Two generations, refused alike: the camelCase group and children #1443
 * retired, and the kebab-case `failure-threshold` / `reset` pair it introduced,
 * which the id retired in turn.  A group of numbers at a broker's root is what
 * all five spell, and there is no compatibility reading of one — the numbers
 * belong under `actor-ts.circuit-breaker.<id>`, under the pattern breaker's
 * names, and a block read as an id would be a type error a line later anyway.
 * The table is checked before anything is read, so the operator meets the
 * shape the key has now rather than that type error.
 *
 * A table of its own rather than entries in {@link RETIRED_BROKER_COMMON_LEAVES}
 * because the refusal's note about code has to differ: the reconnect and
 * buffer renames moved only the HOCON spelling, while this one moved the field
 * and the builder method too — see {@link BROKER_CIRCUIT_BREAKER_CODE_NOTE}.
 */
export const RETIRED_BROKER_CIRCUIT_BREAKER_LEAVES: RetiredLeaves = {
  circuitBreaker: 'circuit-breaker',
  'circuit-breaker.failureThreshold': 'circuit-breaker',
  'circuit-breaker.resetMs': 'circuit-breaker',
  'circuit-breaker.failure-threshold': 'circuit-breaker',
  'circuit-breaker.reset': 'circuit-breaker',
};

/**
 * What refusing a retired breaker spelling tells the operator about the new
 * shape and about their code — the latter changed with it, so the default note
 * ("no code change is needed") would be false.
 */
const BROKER_CIRCUIT_BREAKER_CODE_NOTE =
  'The broker breaker is resolved by id now: set circuit-breaker = "<id>" here and put its numbers under '
  + 'actor-ts.circuit-breaker.<id> (failure-threshold is max-failures, reset is reset-timeout).  In code, '
  + 'the circuitBreaker field is that id, and withCircuitBreaker(failureThreshold, resetMs) is withCircuitBreaker(id).';

/**
 * Refuse every retired spelling of the leaves every broker shares under
 * `root`, each table with the note about code that is true of it.  One door
 * for both, so no caller can check one table and forget the other.
 */
export function rejectRetiredBrokerCommonLeaves(config: Config, root: string): void {
  rejectRetiredLeaves(config, root, RETIRED_BROKER_COMMON_LEAVES);
  rejectRetiredLeaves(config, root, RETIRED_BROKER_CIRCUIT_BREAKER_LEAVES, BROKER_CIRCUIT_BREAKER_CODE_NOTE);
}

/** The object form of {@link BrokerCommonOptionsType.reconnect} — the only one HOCON can spell. */
type ReconnectPolicy = Exclude<NonNullable<BrokerCommonOptionsType['reconnect']>, false>;

/**
 * Read the shared reconnect / circuit-breaker / buffer leaves of one broker
 * block, at the full paths `keys` names — `BrokerActor` passes the system
 * config and `brokerCommonKeysUnder(configKey())`.  Subclass-specific fields
 * are read by the subclass' own `readOptionsFromConfig()` method.  This is
 * also the name the dead-key gate registers for these leaves
 * (`tests/util/ConfigReaderRegistry.ts`), so `BrokerActor` reads through it.
 *
 * Leaf names are the kebab-case of the fields with any unit suffix dropped
 * (#1443), so `initialDelayMs` is read from `reconnect.initial-delay` and
 * `maxDelayMs` from `reconnect.max-delay`; `getDuration` takes `30s` and a bare
 * millisecond count alike.  `factor` and `random-factor` go through
 * `getNumber`, not `getInt`, which throws outright on `0.2`.  `max-attempts` is
 * a count and goes through `getInt`, so `7.5` fails the start naming the key
 * instead of reaching the retry loop, which compares a whole attempt counter
 * against it and quietly reads it as `7`.  An unset leaf is omitted rather than
 * written as `undefined`.  `circuit-breaker` is a leaf holding an id (#1478):
 * the breaker's numbers are `CircuitBreakerExtension`'s to read, under
 * `actor-ts.circuit-breaker.<id>`, so a block in its place is refused rather
 * than read.  `random` has no leaf: a function cannot come from HOCON.
 *
 * Note: to *disable* reconnect via HOCON, set the leaf
 * `reconnect.max-attempts = 1` (one connect attempt, no retry).  The
 * boolean `false` form is only supported via the constructor argument.
 */
export function readBrokerCommonOptionsFromConfig(config: Config, keys: BrokerCommonKeys): BrokerCommonOptionsType {
  const out: { -readonly [K in keyof BrokerCommonOptionsType]: BrokerCommonOptionsType[K] } = {};

  if (config.hasPath(keys.reconnect.root)) {
    // Asked for as a block before its leaves are read by path: `reconnect =
    // false` has no leaves to find, and reading it as an empty policy would
    // mean "retry forever on the defaults" — the opposite of what was written.
    config.getObject(keys.reconnect.root);
    const reconnect: { -readonly [K in keyof ReconnectPolicy]: ReconnectPolicy[K] } = {};
    if (config.hasPath(keys.reconnect.initialDelay)) reconnect.initialDelayMs = config.getDuration(keys.reconnect.initialDelay);
    if (config.hasPath(keys.reconnect.maxDelay)) reconnect.maxDelayMs = config.getDuration(keys.reconnect.maxDelay);
    if (config.hasPath(keys.reconnect.factor)) reconnect.factor = config.getNumber(keys.reconnect.factor);
    if (config.hasPath(keys.reconnect.maxAttempts)) reconnect.maxAttempts = config.getInt(keys.reconnect.maxAttempts);
    if (config.hasPath(keys.reconnect.randomFactor)) reconnect.randomFactor = config.getNumber(keys.reconnect.randomFactor);
    out.reconnect = reconnect;
  }

  if (config.hasPath(keys.circuitBreaker)) out.circuitBreaker = readCircuitBreakerId(config, keys.circuitBreaker);

  if (config.hasPath(keys.outboundBuffer)) out.outboundBuffer = config.getInt(keys.outboundBuffer);

  return out;
}

/**
 * The breaker id at `path`, refusing a block there by the shape it should have.
 *
 * The retired spellings have their own refusal, checked before anything is
 * read; what reaches this is a block that matches none of them — the pattern
 * breaker's own leaves written under the broker's root
 * (`circuit-breaker { max-failures = 3 }`), which is the likeliest way to
 * misread "the broker breaker is a pattern breaker".  `getString` would refuse
 * it too, as "not a string", which names the path and not the fix.
 */
function readCircuitBreakerId(config: Config, path: string): string {
  if (isBlock(config, path)) {
    throw new ConfigError(
      `${path} names a circuit breaker by id and holds no settings of its own: write ${path} = "<id>" and `
      + 'put max-failures, reset-timeout and the rest under actor-ts.circuit-breaker.<id>, where '
      + 'CircuitBreakerExtension reads them over actor-ts.circuit-breaker.default.',
    );
  }
  return config.getString(path);
}

/** Whether `path` holds a block — what `getObject` takes and every other getter refuses. */
function isBlock(config: Config, path: string): boolean {
  try {
    config.getObject(path);
    return true;
  } catch {
    return false;
  }
}

/** Raised when required options are missing from every layer. */
export class BrokerOptionsError extends Error {
  constructor(message: string, public readonly configKey: string) {
    super(message);
    this.name = 'BrokerOptionsError';
  }
}

export abstract class BrokerOptionsBuilder<T extends BrokerCommonOptionsType> extends OptionsBuilder<T> {
  /** Reconnect policy (or `false` to disable auto-reconnect). */
  withReconnect(policy: BrokerCommonOptionsType['reconnect']): this {
    return this.set('reconnect' as keyof T, policy as T[keyof T]);
  }

  /**
   * Call the connect attempts through the `CircuitBreakerExtension` breaker
   * named `id`, whose settings live under `actor-ts.circuit-breaker.<id>`.
   * `""` means no breaker, the default.  See
   * {@link BrokerCommonOptionsType.circuitBreaker} for what sharing an id means.
   */
  withCircuitBreaker(id: string): this {
    return this.set('circuitBreaker' as keyof T, id as T[keyof T]);
  }

  /** Outbound buffer size (messages held while disconnected).  Default 1000; 0 = fail-fast. */
  withOutboundBuffer(limit: number): this {
    return this.set('outboundBuffer' as keyof T, limit as T[keyof T]);
  }
}

/**
 * Shared validator base for every broker options type — the counterpart to
 * {@link BrokerOptionsBuilder}.  Concrete broker validators call
 * {@link commonRules} at the top of their own `rules()` to cover the
 * reconnect / circuit-breaker / outbound-buffer fields, then add their
 * protocol-specific checks.
 *
 * The common fields include a nested object (`reconnect`) whose leaves are
 * not top-level settings, so they are checked imperatively against the known
 * `BrokerCommonOptionsType` shape rather than via the field-name helpers
 * (which only address top-level keys).
 */
export abstract class BrokerOptionsValidator<T extends BrokerCommonOptionsType> extends OptionsValidator<T> {
  protected commonRules(s: Partial<T>): void {
    const common = s as Partial<BrokerCommonOptionsType>;

    if (
      common.outboundBuffer !== undefined &&
      (typeof common.outboundBuffer !== 'number' || !Number.isInteger(common.outboundBuffer) || common.outboundBuffer < 0)
    ) {
      this.fail('outboundBuffer', 'must be an integer >= 0', common.outboundBuffer);
    }

    if (common.reconnect !== undefined && common.reconnect !== false) {
      const reconnect = common.reconnect;
      this.nestedPositive('reconnect.initialDelayMs', reconnect.initialDelayMs);
      this.nestedPositive('reconnect.maxDelayMs', reconnect.maxDelayMs);
      if (reconnect.factor !== undefined && (typeof reconnect.factor !== 'number' || !Number.isFinite(reconnect.factor) || reconnect.factor < 1)) {
        this.fail('reconnect.factor', 'must be a number >= 1', reconnect.factor);
      }
      // maxAttempts: positive; Infinity is allowed and is the default (retry forever).
      if (
        reconnect.maxAttempts !== undefined &&
        (typeof reconnect.maxAttempts !== 'number' || Number.isNaN(reconnect.maxAttempts) || reconnect.maxAttempts <= 0)
      ) {
        this.fail('reconnect.maxAttempts', 'must be a positive number (Infinity allowed)', reconnect.maxAttempts);
      }
      // The bound is checked here rather than left to the scheduling site:
      // a fraction outside [0, 1] would only ever surface as a nonsensical
      // delay on a reconnect — i.e. during an outage, which is the worst
      // moment to learn the config was wrong.  Written as `!(… && …)` so
      // NaN is rejected too.
      if (
        reconnect.randomFactor !== undefined &&
        (typeof reconnect.randomFactor !== 'number' || !(reconnect.randomFactor >= 0 && reconnect.randomFactor <= 1))
      ) {
        this.fail('reconnect.randomFactor', 'must be a number in [0, 1]', reconnect.randomFactor);
      }
    }

    // The compiler holds a typed caller to a string; a plain-JavaScript one —
    // or one still passing the `{ failureThreshold, resetMs }` object this
    // field used to take — would otherwise reach `breaker(id)` with an object
    // for an id, and a breaker named "[object Object]" would be resolved in
    // silence (#1478).
    if (common.circuitBreaker !== undefined && typeof common.circuitBreaker !== 'string') {
      this.fail(
        'circuitBreaker',
        'must be a circuit-breaker id (a string; "" for none) — its settings live under actor-ts.circuit-breaker.<id>',
        common.circuitBreaker,
      );
    }
  }

  /**
   * Positive-finite check for a nested or union-typed numeric leaf that the
   * field-name helpers can't address (e.g. `reconnect.initialDelayMs`,
   * `consumer.commitTimeoutMs`).  No-op if unset.
   */
  protected nestedPositive(field: string, v: number | undefined): void {
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
      this.fail(field, 'must be a positive finite number', v);
    }
  }

  /**
   * {@link nestedPositive} for a leaf whose broker also gives "no bound" an
   * out-of-band spelling — NATS's `-1` on `max_msgs`, its `0` on `max_age`.
   *
   * A sentinel is not a bound of zero; it is the same category of value as
   * `undefined`, which every helper here already passes over, so it is
   * admitted rather than rounded up into the positive range.  Refusing it
   * would refuse a configuration the broker's own documentation prescribes,
   * and the field passes through verbatim, so the validator's domain has to
   * be the wire protocol's and not a symmetric guess (#871).
   *
   * The sentinel is a parameter for the same reason: the values are per
   * field, not per broker — NATS spells the unlimited count `-1` and the
   * unlimited age `0`.  Everything else non-positive is still refused, so
   * `-2` remains the typo it is.
   */
  protected nestedPositiveOrSentinel(field: string, v: number | undefined, sentinel: number): void {
    if (v === sentinel) return;
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
      this.fail(field, `must be a positive finite number, or ${sentinel} for "no limit"`, v);
    }
  }

  /**
   * Non-empty check for a `string | string[]` field (Kafka `brokers`, NATS
   * `servers`) — a union the typed helpers can't address.  No-op if unset.
   */
  protected nonEmptyStringOrArray(field: string, v: string | ReadonlyArray<string> | undefined): void {
    if (v === undefined) return;
    const empty = typeof v === 'string' ? v.length === 0 : !Array.isArray(v) || v.length === 0;
    if (empty) this.fail(field, 'must not be empty', v);
  }
}
