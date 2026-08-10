import type { JournalEventBus } from './JournalEventBus.js';
import type { PersistentEvent } from './JournalTypes.js';

/**
 * Pluggable event journal — the persistence-plugin boundary.  Core ships
 * with an in-memory reference implementation and a SQLite-based one; the
 * interface is deliberately narrow so third-party plug-ins (Cassandra,
 * ScyllaDB, Postgres, …) only have to implement four methods.
 */
export interface Journal {
  /**
   * Append `events` to the stream of `persistenceId`, enforcing optimistic
   * concurrency: the current highest sequence number MUST equal `expectedSeq`
   * or the call throws `JournalConcurrencyError`.  Returns the written events
   * with their assigned sequence numbers.
   */
  append<E = unknown>(
    persistenceId: string,
    events: ReadonlyArray<E>,
    expectedSeq: number,
    tags?: ReadonlyArray<string>,
  ): Promise<PersistentEvent<E>[]>;

  /**
   * Return the events in `[fromSeq, …, toSeq]`, ascending by sequence
   * number.  `toSeq` defaults to the current highest sequence number.
   * Both bounds are inclusive — `fromSeq` is the first event returned,
   * not an "after" cursor.
   *
   * **Ordering and contiguity are part of the contract, and replay
   * enforces them** (#122).  Consecutive entries must differ by exactly
   * one, every `sequenceNr` must be a safe integer ≥ 1, and nothing may
   * fall outside the requested window.  `delete` compacts a *prefix*,
   * never a hole in the middle, so a gap inside the returned slice can
   * only mean a defect — a missing `ORDER BY`, a half-written append, a
   * store someone else can write.  `replayState` raises
   * `JournalIntegrityError` instead of folding it, because an actor
   * that recovers from a shuffled or holed stream reaches a state that
   * never existed and then fails every later `persist` with a
   * `JournalConcurrencyError` that has no visible cause.
   */
  read<E = unknown>(
    persistenceId: string,
    fromSeq: number,
    toSeq?: number,
  ): Promise<PersistentEvent<E>[]>;

  /** Current highest sequence number for `persistenceId` — 0 if no events exist. */
  highestSeq(persistenceId: string): Promise<number>;

  /**
   * Delete events up to and including `toSeq` — used when compacting past
   * a snapshot.  Only ever a prefix, so what survives is a suffix that
   * `read` still returns contiguously, and sequence numbers never rewind:
   * `highestSeq` keeps reporting the high-water mark afterwards.
   */
  delete(persistenceId: string, toSeq: number): Promise<void>;

  /** Persistence IDs currently known to the journal (useful for projections). */
  persistenceIds(): Promise<string[]>;

  /**
   * Optional in-process notification bus.  When present, the read-side
   * query layer subscribes here for sub-poll-interval push delivery
   * (see `JournalEventBus`).  Journals that span processes (Cassandra,
   * Postgres) leave it `undefined` — the query layer falls back to
   * the polling loop.
   */
  readonly events?: JournalEventBus;

  /** Best-effort teardown; idempotent. */
  close?(): Promise<void>;
}
