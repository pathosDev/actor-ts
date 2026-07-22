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

export interface MigrationProgress {
  /** Pids the helper has already finished — used to skip them on resume. */
  readonly completed: ReadonlyArray<string>;
}

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

export interface MigrateJournalsOptions<E = unknown> {
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
}

export interface MigrateJournalsResult {
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
}

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
 * **Tags.**  Each event's `tags` field is preserved via per-event
 * `append` calls (one event per call to keep the source's tag layout
 * exact).  Trade-off: more round-trips than a batched copy, but tag
 * fidelity is what most migrations care about.
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
    if (sourceEvents.length > 0) {
      let expected = targetHigh;
      for (const se of sourceEvents) {
        const transformed = transform(se);
        await target.append(persistenceId, [transformed.event], expected, transformed.tags);
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

export interface MigrateSnapshotStoresOptions<S = unknown> {
  /** Per-snapshot transform; default: pass through. */
  readonly stateTransform?: (s: S) => S;
  /** Set of pids to copy; default: caller must supply (no enumeration on snapshot stores). */
  readonly persistenceIds: ReadonlyArray<string>;
  readonly progress?: MigrationProgressStore;
  readonly onProgress?: (e: { persistenceId: string; index: number; total: number; copied: boolean }) => void;
  /** Skip pids whose target already has a latest snapshot. */
  readonly skipExistingPersistenceIds?: boolean;
}

export interface MigrateSnapshotStoresResult {
  readonly persistenceIdsInspected: number;
  readonly persistenceIdsCopied: number;
  readonly persistenceIdsEmpty: number;
  readonly persistenceIdsSkippedAlreadyDone: number;
  readonly persistenceIdsSkippedExistingTarget: number;
}

/**
 * Copy the LATEST snapshot for each `pid` from `source` to `target`.
 *
 * Snapshot stores don't expose a `persistenceIds()` enumeration (the
 * shape varies wildly across backends), so the caller hands in the pid
 * list — typically `await sourceJournal.persistenceIds()` when running
 * a paired journal + snapshot migration.
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
      const existing = await target.loadLatest<S>(persistenceId);
      if (!existing.isNone()) {
        result.persistenceIdsSkippedExistingTarget += 1;
        completed.add(persistenceId);
        if (progress) await progress.save({ completed: [...completed] });
        continue;
      }
    }

    const latest = await source.loadLatest<S>(persistenceId);
    if (latest.isNone()) {
      result.persistenceIdsEmpty += 1;
    } else {
      const snap = latest.value;
      await target.save<S>(persistenceId, snap.sequenceNr, transform(snap.state));
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
