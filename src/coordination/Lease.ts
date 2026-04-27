/**
 * Abstract distributed lease.  A lease is owned by a single holder for a
 * bounded duration; renewed periodically by the holder to keep ownership.
 *
 * Four-method contract:
 *   - `acquire()` tries to claim the lease; returns true on success.
 *   - `release()` voluntarily drops ownership.
 *   - `checkAlive()` is a cheap "do I still own this lease?" check used by
 *     failure-detection logic.
 *   - `onLost(cb)` registers a callback fired if ownership is lost
 *     unexpectedly (TTL expired, another holder took over, etc.).
 *
 * Different backends implement the contract differently — see
 * `InMemoryLease` (reference + tests) and `KubernetesLease` (production).
 */
export interface Lease {
  /** Try to acquire the lease.  Resolves true on success, false on contention. */
  acquire(): Promise<boolean>;

  /** Release the lease voluntarily.  No-op if not held. */
  release(): Promise<void>;

  /** True if this process currently owns the lease.  Purely local — no IO. */
  checkAlive(): boolean;

  /** Register a handler fired when ownership is lost unexpectedly. */
  onLost(handler: (reason: string) => void): () => void;
}

export interface LeaseSettings {
  /** Lease name — unique identifier within the namespace. */
  readonly name: string;
  /** Identifier of the holder (pod name / host name / uuid). */
  readonly owner: string;
  /** Time-to-live in ms — the backend auto-expires if we fail to renew. */
  readonly ttlMs: number;
  /** How often to renew (< ttlMs — typically ttl/3). */
  readonly renewalIntervalMs?: number;
  /** Max attempts for a single `acquire()` before returning false. */
  readonly acquireRetries?: number;
  /** Delay between acquire retries. */
  readonly acquireRetryDelayMs?: number;
}
