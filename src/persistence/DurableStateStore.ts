import type { Option } from '../util/Option.js';
import type { PersistenceOptions } from './PersistenceOptions.js';

/**
 * Storage contract for Durable State — the "event-free" cousin of Event
 * Sourcing.  Instead of appending events that are replayed, a Durable State
 * actor overwrites a single snapshot per persistence id.  This trades off
 * the audit log for simpler implementation and faster recovery.
 *
 * Revision is a monotonic counter used for optimistic concurrency: writes
 * must pass the expected previous revision or they fail.
 */
export interface DurableStateRecord<S> {
  readonly persistenceId: string;
  readonly revision: number;
  readonly state: S;
  readonly timestamp: number;
}

export class DurableStateConcurrencyError extends Error {
  constructor(
    public readonly persistenceId: string,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(`durable-state concurrency conflict on ${persistenceId}: expected rev=${expected} but was ${actual}`);
    this.name = 'DurableStateConcurrencyError';
  }
}

export interface DurableStateStore {
  /**
   * Upsert the state for `persistenceId`.  `expectedRevision` must match the
   * current stored revision (0 when no record exists yet).  Throws
   * `DurableStateConcurrencyError` on conflict.  Optional `options`
   * carry per-call preferences from the caller (e.g. compression /
   * encryption set on the actor); stores that cannot honour them
   * silently ignore the field.
   */
  upsert<S>(
    persistenceId: string,
    expectedRevision: number,
    state: S,
    options?: PersistenceOptions,
  ): Promise<DurableStateRecord<S>>;

  /**
   * Load the latest record for `persistenceId`, or None if none exists.
   * `options.encryption` is required when client-side encryption was
   * used at write time.
   */
  load<S>(persistenceId: string, options?: PersistenceOptions): Promise<Option<DurableStateRecord<S>>>;

  /** Remove the record entirely.  Idempotent. */
  delete(persistenceId: string): Promise<void>;
}
