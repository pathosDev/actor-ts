import type { PersistentEvent } from './JournalTypes.js';

/**
 * Pluggable event journal — the persistence-plugin boundary.  Core ships
 * with an in-memory reference implementation and a SQLite-based one; the
 * interface is deliberately narrow so third-party plug-ins (Cassandra,
 * ScyllaDB, Postgres, …) only have to implement four methods.
 */
export interface Journal {
  /**
   * Append `events` to the stream of `pid`, enforcing optimistic concurrency:
   * the current highest sequence number MUST equal `expectedSeq` or the
   * call throws `JournalConcurrencyError`.  Returns the written events
   * with their assigned sequence numbers.
   */
  append<E = unknown>(
    pid: string,
    events: ReadonlyArray<E>,
    expectedSeq: number,
    tags?: ReadonlyArray<string>,
  ): Promise<PersistentEvent<E>[]>;

  /**
   * Return events in `(fromSeq, …, toSeq]` order.  `toSeq` defaults to
   * the current highest sequence number.  Inclusive bounds — `fromSeq`
   * is the first event returned, not the "after" cursor.
   */
  read<E = unknown>(
    pid: string,
    fromSeq: number,
    toSeq?: number,
  ): Promise<PersistentEvent<E>[]>;

  /** Current highest sequence number for `pid` — 0 if no events exist. */
  highestSeq(pid: string): Promise<number>;

  /** Delete events up to and including `toSeq` — used when compacting past a snapshot. */
  delete(pid: string, toSeq: number): Promise<void>;

  /** Persistence IDs currently known to the journal (useful for projections). */
  persistenceIds(): Promise<string[]>;

  /** Best-effort teardown; idempotent. */
  close?(): Promise<void>;
}
