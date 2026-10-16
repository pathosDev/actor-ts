/**
 * Lifecycle events published on `system.eventStream` by every
 * `BrokerActor`.  Health-checks, metrics, and admin tools subscribe
 * via `system.eventStream.subscribe(probeRef, BrokerConnected)` to get
 * a uniform view across all broker types.
 *
 * Each event carries the actor path so listeners can attribute it
 * even when many broker actors run in the same system.
 */
import type { CircuitState } from '../../pattern/CircuitBreaker.js';

export class BrokerConnected {
  constructor(
    public readonly actorPath: string,
    public readonly endpoint: string,
  ) {}
}

export class BrokerDisconnected {
  constructor(
    public readonly actorPath: string,
    public readonly endpoint: string,
    public readonly cause?: Error,
  ) {}
}

export class BrokerReconnectAttempt {
  constructor(
    public readonly actorPath: string,
    public readonly endpoint: string,
    /** 1-based attempt counter for the *current* reconnect cycle. */
    public readonly attempt: number,
    public readonly delayMs: number,
  ) {}
}

export class BrokerReconnectFailed {
  constructor(
    public readonly actorPath: string,
    public readonly endpoint: string,
    /** Total attempts that ran in the cycle that just gave up. */
    public readonly attempts: number,
    public readonly cause: Error,
  ) {}
}

/**
 * One outbound message had to be evicted because the buffer was full.
 * The dropped envelope is *not* attached — listeners that need it
 * should use a smaller buffer with explicit overflow handling.
 */
export class BrokerBufferOverflow {
  constructor(
    public readonly actorPath: string,
    public readonly bufferLimit: number,
  ) {}
}

/**
 * An attempt to send while disconnected was rejected because the
 * outbound buffer is sized `0` (fail-fast mode).
 */
export class BrokerNotConnected {
  constructor(
    public readonly actorPath: string,
  ) {}
}

/**
 * The circuit breaker a broker actor connects through changed state.
 *
 * Published by every actor that names the breaker, each under its own path:
 * a breaker resolved by id is shared, and while it is open every actor sharing
 * it has its connect attempts refused — which, unlike a failed attempt,
 * publishes nothing else, so without this event an actor held off by the
 * breaker would simply go quiet on the stream (#1478).  `open` is the one to
 * alert on; `half-open` means the window has passed and a probe is under way;
 * `closed` means a connect succeeded through it.
 */
export class BrokerCircuitBreakerStateChanged {
  constructor(
    public readonly actorPath: string,
    public readonly endpoint: string,
    /** The `CircuitBreakerExtension` id the actor names in its `circuitBreaker` option. */
    public readonly circuitBreaker: string,
    public readonly state: CircuitState,
  ) {}
}
