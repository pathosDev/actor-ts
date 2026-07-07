import type { Config } from '../../config/Config.js';

/**
 * Common settings every broker actor accepts on top of its protocol-
 * specific options.  Subclasses extend this interface with their own
 * required fields (e.g. `brokerUrl`, `topics`).
 */
export interface BrokerCommonOptionsType {
  /**
   * Reconnect strategy applied when the underlying connection drops or
   * `connectImpl` throws.  Default: exponential backoff starting at
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
   * Optional circuit-breaker around `connectImpl`.  After
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
 * own `readSettingsFromConfig()` method.
 *
 * Note: to *disable* reconnect via HOCON, set the leaf
 * `reconnect.maxAttempts = 1` (one connect attempt, no retry).  The
 * boolean `false` form is only supported via the constructor argument.
 */
export function readCommonSettings(config: Config): BrokerCommonOptionsType {
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
 * Merge settings in the documented precedence order:
 *   1. constructor args  (highest)
 *   2. HOCON config under `configKey`
 *   3. built-in defaults  (lowest)
 *
 * Falsy / undefined values from a higher layer don't shadow lower
 * layers — `undefined` means "not set", not "explicitly clear".
 */
export function mergeSettings<S extends object>(
  builtInDefaults: Partial<S>,
  fromConfig: Partial<S>,
  fromConstructor: Partial<S>,
): S {
  return {
    ...builtInDefaults,
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

/** Raised when required settings are missing from every layer. */
export class BrokerSettingsError extends Error {
  constructor(message: string, public readonly configKey: string) {
    super(message);
    this.name = 'BrokerSettingsError';
  }
}
