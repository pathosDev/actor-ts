import type { JournalEventBus } from './JournalEventBus.js';
import type { JournalEntry, PersistentEvent } from './JournalTypes.js';
import type { StorageLocality } from './StorageLocality.js';

/**
 * Pluggable event journal — the persistence-plugin boundary.  Core ships
 * with an in-memory reference implementation and a SQLite-based one; the
 * interface is deliberately narrow so third-party plug-ins (Cassandra,
 * ScyllaDB, Postgres, …) only have to implement four methods.
 */
export interface Journal {
  /**
   * Append `entries` to the stream of `persistenceId`, enforcing optimistic
   * concurrency: the current highest sequence number MUST equal `expectedSeq`
   * or the call throws `JournalConcurrencyError`.  Returns the written events
   * with their assigned sequence numbers.
   *
   * **Tags are per entry, not per batch** ({@link JournalEntry}).  A batch is
   * still one atomic append — splitting it by tag set is explicitly not the
   * contract (#959) — but each event carries only the tags it was given, and
   * the per-event tag cap is enforced per event rather than per call (#631).
   */
  append<E = unknown>(
    persistenceId: string,
    entries: ReadonlyArray<JournalEntry<E>>,
    expectedSeq: number,
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
   *
   * **A deleted event must leave the read side too** (#654).  Whatever a
   * backend maintains so that `currentEventsByTag` can answer without
   * scanning the journal — a join table, a side table, a secondary index —
   * is part of what `delete` compacts.  This is easy to miss precisely
   * because it is invisible to `read` and `highestSeq`: the two things a
   * delete test naturally asserts still pass while a by-tag query keeps
   * serving the event, and where that structure carries its own copy of the
   * payload (Cassandra's `events_by_tag`) the bytes are retained as well, so
   * the miss is a data-retention defect and not only a stale read.  Backends
   * whose index is over the event record itself (Mongo's multikey `tags`)
   * satisfy this for free; ones with a separate physical structure must
   * delete from it explicitly, and before the events, so a crash mid-delete
   * cannot strand rows whose key can no longer be reconstructed.
   */
  delete(persistenceId: string, toSeq: number): Promise<void>;

  /**
   * Raise the compaction high-water mark to `throughSeq` without deleting
   * anything — the write half of what `delete` leaves behind, for a stream
   * whose prefix was compacted somewhere else.
   *
   * **Monotonic.**  A `throughSeq` at or below the current mark is a no-op,
   * never a rewind: a sequence number handed out once may never be handed
   * out again, which is why every backend's underlying primitive is a
   * `GREATEST` / `MAX` / `$max` / conditional update rather than a plain
   * assignment.
   *
   * **Why the contract needs it.**  A journal-to-journal copy is the caller
   * (#630).  `append` derives the sequence it writes from `expectedSeq`
   * alone, so copying a compacted stream — one whose first surviving event
   * is 5, not 1 — into a fresh target renumbered it from 1, and the paired
   * snapshot then referred to a sequence that no longer meant what it said:
   * either loud (`SnapshotIntegrityError`) or, in the layout
   * `PersistentActor.deleteHistory` actually produces, silent, folding the
   * wrong tail onto the snapshot's state.  Seeding the mark first makes the
   * target's `expectedSeq` line up with the source's numbering, so the copy
   * preserves it and every read-side offset, projection cursor and snapshot
   * that refers to `(persistenceId, sequenceNr)` still points at the same
   * event.
   *
   * **Optional, and absence is meaningful.**  Every in-tree journal
   * implements it — all of them already store the mark (`deleted_to`,
   * `deletedTo`, `max_sequence_nr`); they simply had no way to be told one.
   * A third-party journal that cannot record a mark independently of its
   * events omits the method, and `migrateBetweenJournals` refuses a
   * compacted stream rather than silently renumbering it.
   */
  raiseCompactionMark?(persistenceId: string, throughSeq: number): Promise<void>;

  /**
   * Persistence IDs currently known to the journal (useful for projections).
   * Distinct — one entry per id, not one per event.
   *
   * **Whether a fully compacted stream still enumerates is deliberately not
   * specified** (#654), and the two in-tree answers are both intentional.
   * `InMemoryJournal` and `CassandraJournal` keep the id: a stream whose
   * events are all gone but whose high-water mark stands is *known to the
   * journal*, just without surviving history, and `raiseCompactionMark`
   * materialises exactly that shape.  The backends that enumerate by reading
   * their events table — SQLite, the relational family, Mongo, DynamoDB —
   * drop it, because for them "known" and "holds an event" are the same
   * query.
   *
   * The difference is observable, and one caller cares:
   * `migrateBetweenJournals` walks the source with this method, so on a
   * journal of the first kind a fully compacted stream carries its mark
   * across the copy and on one of the second kind it is not visited at all.
   * Do not build on either answer without passing an explicit
   * `persistenceIds` list. Converging them means teaching the second group
   * to enumerate a mark-only stream — a separate change, not something to
   * settle by dropping the row on the first group.
   */
  persistenceIds(): Promise<string[]>;

  /**
   * One ascending page of persistence ids: those strictly greater than
   * `afterPersistenceId` — all of them when it is `undefined` — capped at
   * `limit`.  Returning fewer than `limit` means the journal is exhausted.
   *
   * **Optional on purpose.**  Not every store can enumerate ids in order:
   * DynamoDB reaches partition keys only through a full table scan, and
   * MongoDB's `distinct` has no cursor.  A journal without a sorted index
   * over its ids omits this, and the query layer falls back to
   * `persistenceIds()` plus an in-process slice — correct, just not cheaper
   * than the full list.  Implement it wherever a sorted key exists; that is
   * what keeps `currentPersistenceIdsPaginated` from materialising a million
   * rows to hand back the first 256.
   *
   * **Which ascending order is the backend's business.**  `afterPersistenceId`
   * is compared in the same order the page is sorted by, so Postgres' collated
   * `ORDER BY` and SQLite's byte-wise one are both fine — a paginated walk only
   * needs the order to be *total and stable within one journal*.  What a
   * journal must not do is mix two orders across calls, which would make the
   * cursor skip ids.
   */
  persistenceIdsPaginated?(
    afterPersistenceId: string | undefined,
    limit: number,
  ): Promise<string[]>;

  /**
   * Optional in-process notification bus.  When present, the read-side
   * query layer subscribes here for sub-poll-interval push delivery
   * (see `JournalEventBus`).  Journals that span processes (Cassandra,
   * Postgres) leave it `undefined` — the query layer falls back to
   * the polling loop.
   */
  readonly events?: JournalEventBus;

  /**
   * Where this journal's data lives relative to cluster nodes — `'node-local'`
   * storage no other node can reach, or a `'shared'` database service.  See
   * {@link StorageLocality} for the full semantics.  Optional, and absence is
   * meaningful like {@link raiseCompactionMark}: an undeclared journal is
   * unknown, and the cluster's storage advisory stays silent instead of
   * guessing (#1356).  Instance-level on purpose — one in-memory journal
   * shared across in-process systems genuinely is `'shared'`.
   */
  readonly storageLocality?: StorageLocality;

  /** Best-effort teardown; idempotent. */
  close?(): Promise<void>;
}

/**
 * Cut one page out of a full list of persistence ids — the reference
 * semantics every {@link Journal.persistenceIdsPaginated} implementation has
 * to match, and the fallback the query layer uses for a journal that has no
 * such method.
 *
 * Lives here rather than in the query layer because it is a statement about
 * the *journal* contract: it defines what "ascending" and "after" mean for a
 * backend that has no opinion of its own.  `InMemoryJournal` uses it as its
 * implementation; the tests use it as the oracle the SQL and CQL push-downs
 * are checked against.
 *
 * The dedupe is not redundant with `persistenceIds()` being distinct: it is
 * what makes "each id exactly once per sweep" hold even for a journal whose
 * enumeration repeats an id, and it costs one pass over a list already being
 * sorted.
 */
export function persistenceIdPage(
  all: ReadonlyArray<string>,
  afterPersistenceId: string | undefined,
  limit: number,
): string[] {
  const sorted = [...new Set(all)].sort();
  const start = afterPersistenceId === undefined
    ? 0
    : sorted.findIndex((persistenceId) => persistenceId > afterPersistenceId);
  // `findIndex` returning -1 means every id is at or before the cursor.
  if (start < 0) return [];
  return sorted.slice(start, start + limit);
}
