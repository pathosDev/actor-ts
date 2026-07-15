/**
 * Shared configuration for every broker actor: the common options type
 * (reconnect / circuit-breaker / outbound buffer) that all broker actors
 * accept, the read/merge helpers that resolve it, the error raised when a
 * required option is missing, and the builder base that concrete
 * `<X>Options` extend.
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
import type { Config } from '../../config/Config.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';

/**
 * Common options every broker actor accepts on top of its protocol-
 * specific options.  Subclasses extend this interface with their own
 * required fields (e.g. `brokerUrl`, `topics`).
 */
export interface BrokerCommonOptionsType {
  /**
   * Reconnect strategy applied when the underlying connection drops or
   * `connectImplementation` throws.  Default: exponential backoff starting at
   * `200ms`, doubling, capped at `30s`, infinite attempts.  Set to
   * `false` to disable auto-reconnect (one-shot connections).
   */
  readonly reconnect?: false | {
    readonly initialDelayMs?: number;
    readonly maxDelayMs?: number;
    readonly factor?: number;
    /** Cap on retry attempts.  Default: `Infinity` (retry forever). */
    readonly maxAttempts?: number;
  };

  /**
   * Optional circuit-breaker around `connectImplementation`.  After
   * `failureThreshold` consecutive failed connect attempts the breaker
   * opens for `resetMs` and rejects new attempts immediately.
   */
  readonly circuitBreaker?: {
    readonly failureThreshold: number;
    readonly resetMs: number;
  };

  /**
   * Maximum number of outbound messages buffered while the connection
   * is `connecting` or `disconnected`.  When the buffer is full the
   * oldest message is dropped (FIFO eviction) and a
   * `BrokerBufferOverflow` event is published.  Default: `1000`.  Set
   * to `0` to fail-fast (publish a `BrokerNotConnected` event and drop
   * the message).
   */
  readonly outboundBuffer?: number;
}

export const DEFAULT_RECONNECT = {
  initialDelayMs: 200,
  maxDelayMs: 30_000,
  factor: 2,
  maxAttempts: Number.POSITIVE_INFINITY,
} as const;

export const DEFAULT_OUTBOUND_BUFFER = 1000;

/**
 * Read the common reconnect / circuit-breaker / buffer fields from a
 * Config block.  Subclass-specific fields are read by the subclass'
 * own `readOptionsFromConfig()` method.
 *
 * Note: to *disable* reconnect via HOCON, set the leaf
 * `reconnect.maxAttempts = 1` (one connect attempt, no retry).  The
 * boolean `false` form is only supported via the constructor argument.
 */
export function readCommonOptions(config: Config): BrokerCommonOptionsType {
  const out: { -readonly [K in keyof BrokerCommonOptionsType]: BrokerCommonOptionsType[K] } = {};

  if (config.hasPath('reconnect')) {
    const sub = config.getConfig('reconnect');
    out.reconnect = {
      initialDelayMs: sub.hasPath('initialDelayMs') ? sub.getDuration('initialDelayMs') : undefined,
      maxDelayMs: sub.hasPath('maxDelayMs') ? sub.getDuration('maxDelayMs') : undefined,
      factor: sub.hasPath('factor') ? sub.getNumber('factor') : undefined,
      maxAttempts: sub.hasPath('maxAttempts') ? sub.getNumber('maxAttempts') : undefined,
    };
  }

  if (config.hasPath('circuitBreaker')) {
    const sub = config.getConfig('circuitBreaker');
    out.circuitBreaker = {
      failureThreshold: sub.getInt('failureThreshold'),
      resetMs: sub.getDuration('resetMs'),
    };
  }

  if (config.hasPath('outboundBuffer')) {
    out.outboundBuffer = config.getInt('outboundBuffer');
  }

  return out;
}

/**
 * Merge options in the documented precedence order:
 *   1. constructor args  (highest)
 *   2. HOCON config under `configKey`
 *   3. built-in defaults  (lowest)
 *
 * Falsy / undefined values from a higher layer don't shadow lower
 * layers — `undefined` means "not set", not "explicitly clear".
 */
export function mergeOptions<S extends object>(
  builtInDefaultOptions: Partial<S>,
  fromConfig: Partial<S>,
  fromConstructor: Partial<S>,
): S {
  return {
    ...builtInDefaultOptions,
    ...stripUndefined(fromConfig),
    ...stripUndefined(fromConstructor),
  } as S;
}

function stripUndefined<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
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

  /** Circuit breaker around connect attempts. */
  withCircuitBreaker(failureThreshold: number, resetMs: number): this {
    return this.set('circuitBreaker' as keyof T, { failureThreshold, resetMs } as T[keyof T]);
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
 * The common fields include nested objects (`reconnect`, `circuitBreaker`)
 * whose leaves are not top-level settings, so they are checked imperatively
 * against the known `BrokerCommonOptionsType` shape rather than via the
 * field-name helpers (which only address top-level keys).
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
    }

    if (common.circuitBreaker !== undefined) {
      const cb = common.circuitBreaker;
      if (typeof cb.failureThreshold !== 'number' || !Number.isInteger(cb.failureThreshold) || cb.failureThreshold < 1) {
        this.fail('circuitBreaker.failureThreshold', 'must be an integer >= 1', cb.failureThreshold);
      }
      this.nestedPositive('circuitBreaker.resetMs', cb.resetMs);
    }
  }

  /**
   * Positive-finite check for a nested or union-typed numeric leaf that the
   * field-name helpers can't address (e.g. `circuitBreaker.resetMs`,
   * `consumer.commitTimeoutMs`).  No-op if unset.
   */
  protected nestedPositive(field: string, v: number | undefined): void {
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
      this.fail(field, 'must be a positive finite number', v);
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
