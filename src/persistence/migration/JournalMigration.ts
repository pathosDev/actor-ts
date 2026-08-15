/**
 * Generic journal-to-journal and snapshot-store-to-snapshot-store copy
 * helpers (#87) — for the common operations of "we're switching from
 * SQLite to Cassandra in production" or "rehydrate test fixtures from
 * a recorded production journal" or "snapshot a smoke-test bucket
 * before destroying it".
 *
 * Distinct from {@link wrapLegacy}'s helpers — those rewrite events in
 * place to wrap them in envelopes; these COPY from one backend to
 * another, optionally transforming as they go.  An eventTransform hook
 * lets you piggyback a schema migration on the copy (one less pass over
 * the data).
 *
 * Resumability: the optional {@link MigrationProgressStore} lets a
 * crashed sweep pick up where it left off — see `InMemoryMigrationProgress
 * Store` for the simplest implementation and the docstring on
 * {@link migrateBetweenJournals} for the semantics.
 */
import type { Journal } from '../Journal.js';
import type { SnapshotStore } from '../SnapshotStore.js';
import type { PersistentEvent } from '../JournalTypes.js';
import type { PersistenceOptions } from '../PersistenceOptions.js';
import { JournalIntegrityError } from '../Replay.js';

/* ============================== progress ============================== */

/**
 * Crash-resume hook for long-running migrations.  The helper calls
 * `load()` once at start (to skip already-completed pids), and `save()`
 * after each pid finishes.  Implementations write to a small KV store
 * (file, Redis, SQLite single-row, …).
 */
export interface MigrationProgressStore {
  load(): Promise<MigrationProgress>;
  save(state: MigrationProgress): Promise<void>;
  clear(): Promise<void>;
}

export type MigrationProgress = {
  /** Pids the helper has already finished — used to skip them on resume. */
  readonly completed: ReadonlyArray<string>;
};

/**
 * Simple in-process implementation, useful for tests and for short-
 * lived runs where progress only needs to survive within one process.
 * For long-running sweeps that should survive a process crash, write a
 * file-backed variant (a JSON dump of `{completed: [...]}` works).
 */
export class InMemoryMigrationProgressStore implements MigrationProgressStore {
  private state: MigrationProgress = { completed: [] };
  async load(): Promise<MigrationProgress> { return { completed: [...this.state.completed] }; }
  async save(state: MigrationProgress): Promise<void> { this.state = { completed: [...state.completed] }; }
  async clear(): Promise<void> { this.state = { completed: [] }; }
}

/* ============================== journal ============================== */

/**
 * Raised when a source stream's history starts above where the target's
 * does and the target journal has no {@link Journal.raiseCompactionMark} to
 * record the difference (#630).
 *
 * The alternative would be to append the surviving events from wherever the
 * target happens to be, which renumbers them — and a renumbered stream is
 * not a copy: the paired snapshot, every read-side offset and every
 * projection cursor still name the source's sequence numbers.  In the layout
 * `PersistentActor.deleteHistory` actually leaves behind (snapshot AT the
 * compaction point) the renumbering does not even fail loudly — recovery
 * folds a later tail onto an earlier state and the actor serves commands
 * from a state that never existed.  Refusing is the only honest answer a
 * target that cannot hold a mark can give.
 */
export class CompactedSourceError extends Error {
  constructor(
    readonly persistenceId: string,
    /** First sequence number the source still holds — above `targetHighestSeq + 1`. */
    readonly firstSourceSequenceNr: number,
    /** What the target reported before the copy. */
    readonly targetHighestSeq: number,
  ) {
    super(
      `[persistence] '${persistenceId}' source history starts at sequenceNr=${firstSourceSequenceNr} `
      + `but the target is at ${targetHighestSeq} and its journal cannot record a compaction mark `
      + '(no raiseCompactionMark) — refusing to copy, because appending here would renumber the '
      + 'stream and detach it from its snapshot and read-side offsets',
    );
    this.name = 'CompactedSourceError';
  }
}

export type MigrateJournalsOptions<E = unknown> = {
  /**
   * Per-event transform.  Default: pass through unchanged.  Use this
   * to piggyback a schema migration (envelope wrap, V1→V2 rename, …)
   * on the same pass that copies the data — saves an extra sweep.
   */
  readonly eventTransform?: (e: PersistentEvent<E>) => PersistentEvent<E>;
  /** Resume-state.  See {@link MigrationProgressStore}. */
  readonly progress?: MigrationProgressStore;
  /** Optional progress hook called once per pid after a successful copy. */
  readonly onProgress?: (e: { persistenceId: string; events: number; index: number; total: number }) => void;
  /**
   * Pids to copy.  Default: every pid `source.persistenceIds()`
   * returns.  Subset useful for sharded migrations (e.g. one worker
   * per shard).
   */
  readonly persistenceIds?: ReadonlyArray<string>;
  /**
   * When true, skip pids that already exist in `target` (any non-zero
   * highestSeq).  Default: false — append from `target.highestSeq + 1`
   * onward, useful for resuming an interrupted copy mid-pid.
   */
  readonly skipExistingPersistenceIds?: boolean;
};

export type MigrateJournalsResult = {
  /** Pids inspected (incl. skipped). */
  readonly persistenceIdsInspected: number;
  /** Pids the helper actually wrote events for. */
  readonly persistenceIdsWritten: number;
  /** Pids fully skipped because they were already in `completed`. */
  readonly persistenceIdsSkippedAlreadyDone: number;
  /** Pids skipped because of `skipExistingPersistenceIds: true` and target had data. */
  readonly persistenceIdsSkippedExistingTarget: number;
  /** Total events written to the target. */
  readonly eventsWritten: number;
  /**
   * Pids whose source had a compacted prefix the target had to inherit
   * before the copy (#630).  Non-zero means the source was compacted —
   * useful as a sanity check when a run is expected to be gap-free.
   */
  readonly persistenceIdsCompactionMarkRaised: number;
};

/**
 * Copy every event from `source` to `target`, in pid+seq order.
 *
 * **Idempotent resume.**  For each pid the helper reads `target.highestSeq`
 * first; only events with strictly higher seq are read from `source` and
 * appended.  A run that completed pid-A and crashed mid-pid-B can be
 * re-run safely — pid-A's count is `0` writes, pid-B picks up where it
 * left off.
 *
 * **Concurrency.**  Single-writer.  Don't run two `migrateBetweenJournals`
 * for the same `target` simultaneously — the `expectedSeq` race would
 * surface as `JournalConcurrencyError`.
 *
 * **Tags.**  Each event's `tags` field is carried across verbatim: the
 * copy hands the target one journal entry per source event, so a
 * stream whose events are tagged differently from one another arrives
 * tagged the same way.  Events are still appended one call at a time —
 * more round-trips than a batched copy, but it keeps every write a
 * separate resume point.
 *
 * **Sequence numbers are preserved, including across a compaction** (#630).
 * A source that has been compacted past a snapshot no longer starts at 1,
 * and may hold no events at all while its high-water mark still remembers
 * them.  Both are copied faithfully: the target's compaction mark is raised
 * to just below the first surviving event first (see
 * {@link Journal.raiseCompactionMark}), so `append` lands every event on the
 * sequence number it had in the source.  That is what keeps the paired
 * snapshot, the read-side offsets and the projection cursors — all of which
 * name `(persistenceId, sequenceNr)` — pointing at the same events after the
 * move.  A target journal that cannot record a mark makes the copy throw
 * {@link CompactedSourceError} rather than renumber the stream.
 *
 *   await migrateBetweenJournals(sqliteSource, cassandraTarget, {
 *     eventTransform: (e) => ({
 *       ...e,
 *       event: oldShapeToNew(e.event),
 *     }),
 *     onProgress: (p) => console.log(
 *       `[${p.index}/${p.total}] ${p.persistenceId}: ${p.events} events`),
 *   });
 */
export async function migrateBetweenJournals<E = unknown>(
  source: Journal,
  target: Journal,
  options: MigrateJournalsOptions<E> = {},
): Promise<MigrateJournalsResult> {
  const allPersistenceIds = options.persistenceIds ?? await source.persistenceIds();
  const progress = options.progress;
  const completed = new Set(progress ? (await progress.load()).completed : []);
  const transform = options.eventTransform ?? ((e: PersistentEvent<E>) => e);
  const result = {
    persistenceIdsInspected: 0,
    persistenceIdsWritten: 0,
    persistenceIdsSkippedAlreadyDone: 0,
    persistenceIdsSkippedExistingTarget: 0,
    eventsWritten: 0,
    persistenceIdsCompactionMarkRaised: 0,
  };

  for (let index = 0; index < allPersistenceIds.length; index++) {
    const persistenceId = allPersistenceIds[index]!;
    result.persistenceIdsInspected += 1;

    if (completed.has(persistenceId)) {
      result.persistenceIdsSkippedAlreadyDone += 1;
      continue;
    }

    const targetHigh = await target.highestSeq(persistenceId);
    if (options.skipExistingPersistenceIds && targetHigh > 0) {
      result.persistenceIdsSkippedExistingTarget += 1;
      // Treat as completed for future resume runs.
      completed.add(persistenceId);
      if (progress) await progress.save({ completed: [...completed] });
      continue;
    }

    // Source events strictly above what's already in the target.
    const sourceEvents = await source.read<E>(persistenceId, targetHigh + 1);
    // Where the source's surviving history begins.  With nothing left to copy
    // that is one past its high-water mark — a fully compacted stream holds no
    // events but still remembers the sequence numbers it handed out, and the
    // target has to inherit that or it restarts the stream at 1 (#630).  The
    // extra read only happens on the empty path.
    const firstSourceSeq = sourceEvents.length > 0
      ? sourceEvents[0]!.sequenceNr
      : (await source.highestSeq(persistenceId)) + 1;

    // A gap between the two means the source was compacted past what the
    // target holds.  Adopt the mark BEFORE appending, so `expectedSeq` and
    // therefore every written sequence number line up with the source's.
    if (firstSourceSeq > targetHigh + 1) {
      if (target.raiseCompactionMark === undefined) {
        throw new CompactedSourceError(persistenceId, firstSourceSeq, targetHigh);
      }
      await target.raiseCompactionMark(persistenceId, firstSourceSeq - 1);
      result.persistenceIdsCompactionMarkRaised += 1;
    }

    if (sourceEvents.length > 0) {
      let expected = firstSourceSeq - 1;
      for (const sourceEvent of sourceEvents) {
        // `append` derives what it writes from `expectedSeq`, so this is the
        // one place "the copy preserves sequence numbers" is actually decided.
        // A source that handed back a hole would have it silently closed up
        // here, renumbering everything after it — `Journal.read` promises
        // contiguity, and a source that breaks the promise is worth stopping
        // on rather than writing a differently-numbered copy of.
        if (sourceEvent.sequenceNr !== expected + 1) {
          throw new JournalIntegrityError(
            `[persistence] '${persistenceId}' source journal has a gap: expected sequenceNr=${expected + 1}, `
            + `got ${sourceEvent.sequenceNr} — refusing to copy a stream whose sequence numbers cannot be preserved`,
            persistenceId,
            sourceEvent.sequenceNr,
          );
        }
        const transformed = transform(sourceEvent);
        await target.append(
          persistenceId, [{ event: transformed.event, tags: transformed.tags }], expected,
        );
        expected += 1;
        result.eventsWritten += 1;
      }
      result.persistenceIdsWritten += 1;
    }

    completed.add(persistenceId);
    if (progress) await progress.save({ completed: [...completed] });
    options.onProgress?.({
      persistenceId, events: sourceEvents.length, index, total: allPersistenceIds.length,
    });
  }

  return result;
}

/* =========================== snapshot store =========================== */

export type MigrateSnapshotStoresOptions<S = unknown> = {
  /** Per-snapshot transform; default: pass through. */
  readonly stateTransform?: (s: S) => S;
  /** Set of pids to copy; default: caller must supply (no enumeration on snapshot stores). */
  readonly persistenceIds: ReadonlyArray<string>;
  readonly progress?: MigrationProgressStore;
  readonly onProgress?: (e: { persistenceId: string; index: number; total: number; copied: boolean }) => void;
  /** Skip pids whose target already has a latest snapshot. */
  readonly skipExistingPersistenceIds?: boolean;
  /**
   * Per-call options for every read from `source` — in practice the
   * `encryption` config a client-side-encrypted snapshot was written under,
   * since the store has no other way to obtain the master key.
   *
   * Only needed when the key is supplied per call (a `PersistentActor`'s
   * `persistenceOptions()`); a store constructed `withEncryption(...)` falls
   * back to its own config and reads fine without this.
   */
  readonly sourcePersistenceOptions?: PersistenceOptions;
  /**
   * Per-call options for every write to `target`, and for the
   * `skipExistingPersistenceIds` probe that reads it.
   *
   * **Separate from `sourcePersistenceOptions` on purpose.**  A re-key sweep
   * is an ordinary reason to migrate, so the two stores routinely hold
   * different keys or keyrings — one shared field could not express it.  And
   * omitting this on a target that encrypts per call is not benign: the
   * write silently degrades to `{ mode: 'none' }` and the migrated snapshot
   * lands in the bucket as plaintext.
   */
  readonly targetPersistenceOptions?: PersistenceOptions;
};

export type MigrateSnapshotStoresResult = {
  readonly persistenceIdsInspected: number;
  readonly persistenceIdsCopied: number;
  readonly persistenceIdsEmpty: number;
  readonly persistenceIdsSkippedAlreadyDone: number;
  readonly persistenceIdsSkippedExistingTarget: number;
};

/**
 * Copy the LATEST snapshot for each `pid` from `source` to `target`.
 *
 * Snapshot stores don't expose a `persistenceIds()` enumeration (the
 * shape varies wildly across backends), so the caller hands in the pid
 * list — typically `await sourceJournal.persistenceIds()` when running
 * a paired journal + snapshot migration.
 *
 * **Run the journal half first when running the pair.**  A snapshot is copied
 * at the sequence number it already has, and it only means anything against a
 * journal numbered the same way; `migrateBetweenJournals` is what makes that
 * true, including for a compacted source (#630).  Copying snapshots onto a
 * target whose journal is empty or renumbered is what produced the failure
 * that seam exists to prevent.
 *
 * **Encryption is per call, and per side.**  Pass
 * `sourcePersistenceOptions` / `targetPersistenceOptions` whenever the actor
 * — rather than the store's own constructor — supplies the master key.
 * Without the target one, a store that would have encrypted resolves to
 * `{ mode: 'none' }` and writes the snapshot in the clear.
 *
 * Historical snapshots aren't copied — only the most recent one per
 * pid.  Cold-start recovery only ever reads the latest plus events
 * since, so the older history isn't load-bearing.  If you need
 * historical snapshots too, run the helper repeatedly with the source
 * narrowing on each pass (loadBefore + manual save).
 */
export async function migrateBetweenSnapshotStores<S = unknown>(
  source: SnapshotStore,
  target: SnapshotStore,
  options: MigrateSnapshotStoresOptions<S>,
): Promise<MigrateSnapshotStoresResult> {
  const progress = options.progress;
  const completed = new Set(progress ? (await progress.load()).completed : []);
  const transform = options.stateTransform ?? ((s: S) => s);
  const result = {
    persistenceIdsInspected: 0,
    persistenceIdsCopied: 0,
    persistenceIdsEmpty: 0,
    persistenceIdsSkippedAlreadyDone: 0,
    persistenceIdsSkippedExistingTarget: 0,
  };

  for (let index = 0; index < options.persistenceIds.length; index++) {
    const persistenceId = options.persistenceIds[index]!;
    result.persistenceIdsInspected += 1;
    if (completed.has(persistenceId)) {
      result.persistenceIdsSkippedAlreadyDone += 1;
      continue;
    }
    if (options.skipExistingPersistenceIds) {
      const existing = await target.loadLatest<S>(persistenceId, options.targetPersistenceOptions);
      if (!existing.isNone()) {
        result.persistenceIdsSkippedExistingTarget += 1;
        completed.add(persistenceId);
        if (progress) await progress.save({ completed: [...completed] });
        continue;
      }
    }

    const latest = await source.loadLatest<S>(persistenceId, options.sourcePersistenceOptions);
    if (latest.isNone()) {
      result.persistenceIdsEmpty += 1;
    } else {
      const snapshot = latest.value;
      await target.save<S>(
        persistenceId,
        snapshot.sequenceNr,
        transform(snapshot.state),
        options.targetPersistenceOptions,
      );
      result.persistenceIdsCopied += 1;
    }

    completed.add(persistenceId);
    if (progress) await progress.save({ completed: [...completed] });
    options.onProgress?.({
      persistenceId, index, total: options.persistenceIds.length, copied: !latest.isNone(),
    });
  }

  return result;
}
