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
 *
 * All-or-nothing: {@link migrateBetweenJournals} decides every refusal in a
 * read-only preflight pass, before the first write.  A copy that gets as far
 * as its first `append` runs to the end, so the failure mode is never a
 * half-populated target plus an exception.
 */
import type { Journal } from '../Journal.js';
import type { SnapshotStore } from '../SnapshotStore.js';
import type { PersistentEvent } from '../JournalTypes.js';
import type { PersistenceOptions } from '../PersistenceOptions.js';
import { JournalIntegrityError } from '../Replay.js';
import { assertValidTags } from '../storage/TagValidator.js';

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

/**
 * Raised when a source event carries a tag list the target's `append` would
 * reject — a stream written before the tag rules of #740, most often one
 * holding an empty or repeated tag.
 *
 * Reading such a stream is still fine, and always will be: the rules run on
 * writes only, so a legacy journal replays unchanged.  A copy is where the
 * two halves meet — it reads a historical list and hands it straight to a
 * write — and that is the one operation the read/write split does not cover
 * on its own.
 *
 * Raised from the preflight, so nothing has been written when it surfaces.
 * The alternative the copy used to have — discover the bad list on the
 * append that rejects it — left a partially populated target behind together
 * with progress entries claiming the streams before it were done, which is
 * strictly worse than a refusal: a re-run with `skipExistingPersistenceIds`
 * then walks past the truncated stream because the target has *some* data
 * for it.
 */
export class MigrationTagError extends Error {
  constructor(
    readonly persistenceId: string,
    /** Sequence number of the offending event, in the source's numbering. */
    readonly sequenceNr: number,
    /** The list as it stood after `eventTransform` and the tag policy ran. */
    readonly tags: ReadonlyArray<string>,
    /** What the tag validator said about it. */
    readonly reason: string,
  ) {
    super(
      `[persistence] '${persistenceId}' sequenceNr=${sequenceNr} carries tags `
      + `${JSON.stringify(tags)} that the target journal's append rejects: ${reason} — refusing the `
      + 'whole copy before anything is written. Rewrite them with an eventTransform, or pass '
      + "invalidTags: 'sanitize' to drop empty and repeated tags as the copy runs",
    );
    this.name = 'MigrationTagError';
  }
}

/**
 * What a copy does with a source tag list its target's `append` rejects.
 *
 * `'refuse'` (the default) stops the whole run in the preflight and names the
 * event.  `'sanitize'` repairs the two shapes a repair can be honest about —
 * an empty member is dropped, a repeat is collapsed — and counts every list
 * it changed in {@link MigrateJournalsResult.eventsWithSanitizedTags}, so the
 * rewrite is reported rather than silent.  Anything else (a comma, a control
 * character, an over-long tag, too many tags) still refuses under both:
 * repairing those means either inventing a tag or dropping one the caller
 * meant, and `eventTransform` is where a caller says which.
 */
export type InvalidTagPolicy = 'refuse' | 'sanitize';

export type MigrateJournalsOptions<E = unknown> = {
  /**
   * Per-event transform.  Default: pass through unchanged.  Use this
   * to piggyback a schema migration (envelope wrap, V1→V2 rename, …)
   * on the same pass that copies the data — saves an extra sweep.  It is
   * also the general answer to a source whose tags no longer pass
   * validation, since the transform runs *before* the check and may rewrite
   * `tags` as freely as it rewrites `event`.
   *
   * **Must be pure.**  It is called once in the preflight and once during
   * the copy, so a transform that counts or logs counts twice.  Use
   * `onProgress` for that.
   */
  readonly eventTransform?: (e: PersistentEvent<E>) => PersistentEvent<E>;
  /**
   * What to do with a tag list the target's `append` rejects.  Default:
   * `'refuse'`.  See {@link InvalidTagPolicy}.
   */
  readonly invalidTags?: InvalidTagPolicy;
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
  /**
   * Events whose tag list `invalidTags: 'sanitize'` rewrote on the way
   * across — always `0` under the default `'refuse'`.  Reported so an
   * opt-in repair of historical data is a number in the result and not a
   * silent edit; a run that expected clean tags can assert it is zero.
   */
  readonly eventsWithSanitizedTags: number;
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
 * **Nothing is written until the whole copy is known to be possible.**  A
 * read-only preflight walks every pid the run will touch — the same slices
 * the copy will read — and raises {@link MigrationTagError},
 * {@link CompactedSourceError} or `JournalIntegrityError` there.  So a run
 * either refuses with the target untouched and the progress store unchanged,
 * or it completes; it never stops halfway with some streams copied, some
 * truncated, and earlier pids already recorded as done.  The cost is one
 * extra read of the source, which on a resume covers only what is left.
 *
 * **Tags.**  Each event's `tags` field is carried across verbatim: the
 * copy hands the target one journal entry per source event, so a
 * stream whose events are tagged differently from one another arrives
 * tagged the same way.  Events are still appended one call at a time —
 * more round-trips than a batched copy, but it keeps every write a
 * separate resume point.
 *
 * Verbatim is also why a copy is the one place a *read* can fail on tags.
 * Tag validation runs on writes only (#740), so a stream holding an empty or
 * repeated tag replays unchanged forever — but copying it means offering
 * that list to an `append`, which rejects it.  The preflight turns that into
 * an up-front {@link MigrationTagError} naming the pid and sequence number;
 * `eventTransform` rewrites the lists, and `invalidTags: 'sanitize'` opts
 * into the two repairs that need no judgement (see {@link InvalidTagPolicy}).
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
  const plan: MigrationPlan<E> = {
    source: source,
    target: target,
    transform: options.eventTransform ?? ((e: PersistentEvent<E>) => e),
    invalidTags: options.invalidTags ?? 'refuse',
    skipExistingPersistenceIds: options.skipExistingPersistenceIds === true,
  };
  const result = {
    persistenceIdsInspected: 0,
    persistenceIdsWritten: 0,
    persistenceIdsSkippedAlreadyDone: 0,
    persistenceIdsSkippedExistingTarget: 0,
    eventsWritten: 0,
    persistenceIdsCompactionMarkRaised: 0,
    eventsWithSanitizedTags: 0,
  };

  // Preflight.  Read-only, and the only place this helper raises: every
  // stream the copy will touch is prepared and checked here, so a refusal
  // leaves the target and the progress store exactly as it found them.
  for (const persistenceId of allPersistenceIds) {
    if (completed.has(persistenceId)) continue;
    await prepareStream(plan, persistenceId);
  }

  for (let index = 0; index < allPersistenceIds.length; index++) {
    const persistenceId = allPersistenceIds[index]!;
    result.persistenceIdsInspected += 1;

    if (completed.has(persistenceId)) {
      result.persistenceIdsSkippedAlreadyDone += 1;
      continue;
    }

    // Same call the preflight made, and nothing may write to either journal
    // in between (single-writer), so it yields the same slice — already
    // transformed, already checked.
    const stream = await prepareStream(plan, persistenceId);
    if (stream === undefined) {
      result.persistenceIdsSkippedExistingTarget += 1;
      // Treat as completed for future resume runs.
      completed.add(persistenceId);
      if (progress) await progress.save({ completed: [...completed] });
      continue;
    }

    // A gap between the two means the source was compacted past what the
    // target holds.  Adopt the mark BEFORE appending, so `expectedSeq` and
    // therefore every written sequence number line up with the source's.
    if (stream.firstSourceSeq > stream.targetHighestSeq + 1) {
      // The preflight already refused a target that cannot record one; this
      // is the compiler's narrowing, not a second decision.
      if (target.raiseCompactionMark === undefined) {
        throw new CompactedSourceError(persistenceId, stream.firstSourceSeq, stream.targetHighestSeq);
      }
      await target.raiseCompactionMark(persistenceId, stream.firstSourceSeq - 1);
      result.persistenceIdsCompactionMarkRaised += 1;
    }

    if (stream.entries.length > 0) {
      // `append` derives what it writes from `expectedSeq`, so this is the
      // one place "the copy preserves sequence numbers" is actually decided.
      // The preflight proved the slice contiguous from here.
      let expected = stream.firstSourceSeq - 1;
      for (const entry of stream.entries) {
        await target.append(persistenceId, [{ event: entry.event, tags: entry.tags }], expected);
        expected += 1;
        result.eventsWritten += 1;
        if (entry.tagsSanitized) result.eventsWithSanitizedTags += 1;
      }
      result.persistenceIdsWritten += 1;
    }

    completed.add(persistenceId);
    if (progress) await progress.save({ completed: [...completed] });
    options.onProgress?.({
      persistenceId, events: stream.entries.length, index, total: allPersistenceIds.length,
    });
  }

  return result;
}

/* --------------------- preflight / stream preparation --------------------- */

/** The inputs of one {@link migrateBetweenJournals} run that never vary per pid. */
type MigrationPlan<E> = {
  readonly source: Journal;
  readonly target: Journal;
  readonly transform: (e: PersistentEvent<E>) => PersistentEvent<E>;
  readonly invalidTags: InvalidTagPolicy;
  readonly skipExistingPersistenceIds: boolean;
};

/** One source event, transformed, with the tag list the target will be handed. */
type PreparedEntry<E> = {
  readonly event: E;
  readonly tags: ReadonlyArray<string> | undefined;
  /** True when the tag policy rewrote the list — counted into the result. */
  readonly tagsSanitized: boolean;
};

/** One pid's remaining slice: checked, transformed, ready to append. */
type PreparedStream<E> = {
  /** What the target reported before the copy. */
  readonly targetHighestSeq: number;
  /** Sequence number the first entry must land on. */
  readonly firstSourceSeq: number;
  readonly entries: ReadonlyArray<PreparedEntry<E>>;
};

/**
 * Read one pid's remaining slice from the source, apply the transform and the
 * tag policy, and check everything the copy can refuse over — a gap in the
 * source's numbering, a compacted prefix the target cannot represent, a tag
 * list the target's `append` would reject.
 *
 * Read-only: it asks the target how far it has got and touches it no other
 * way.  Called twice per pid — once by the preflight to decide whether the
 * run may proceed at all, once by the copy to get the entries it writes —
 * which is what makes "refuse before the first write" affordable without
 * holding the whole journal in memory.  A pid the run is to skip because the
 * target already has data for it returns `undefined`.
 */
async function prepareStream<E>(
  plan: MigrationPlan<E>,
  persistenceId: string,
): Promise<PreparedStream<E> | undefined> {
  const targetHighestSeq = await plan.target.highestSeq(persistenceId);
  if (plan.skipExistingPersistenceIds && targetHighestSeq > 0) return undefined;

  // Source events strictly above what's already in the target.
  const sourceEvents = await plan.source.read<E>(persistenceId, targetHighestSeq + 1);
  // Where the source's surviving history begins.  With nothing left to copy
  // that is one past its high-water mark — a fully compacted stream holds no
  // events but still remembers the sequence numbers it handed out, and the
  // target has to inherit that or it restarts the stream at 1 (#630).  The
  // extra read only happens on the empty path.
  const firstSourceSeq = sourceEvents.length > 0
    ? sourceEvents[0]!.sequenceNr
    : (await plan.source.highestSeq(persistenceId)) + 1;

  if (firstSourceSeq > targetHighestSeq + 1 && plan.target.raiseCompactionMark === undefined) {
    throw new CompactedSourceError(persistenceId, firstSourceSeq, targetHighestSeq);
  }

  const entries: PreparedEntry<E>[] = [];
  let expected = firstSourceSeq - 1;
  for (const sourceEvent of sourceEvents) {
    // A source that handed back a hole would have it silently closed up by
    // `append`, renumbering everything after it — `Journal.read` promises
    // contiguity, and a source that breaks the promise is worth stopping on
    // rather than writing a differently-numbered copy of.
    if (sourceEvent.sequenceNr !== expected + 1) {
      throw new JournalIntegrityError(
        `[persistence] '${persistenceId}' source journal has a gap: expected sequenceNr=${expected + 1}, `
        + `got ${sourceEvent.sequenceNr} — refusing to copy a stream whose sequence numbers cannot be preserved`,
        persistenceId,
        sourceEvent.sequenceNr,
      );
    }
    expected += 1;
    const transformed = plan.transform(sourceEvent);
    const applied = applyTagPolicy(transformed.tags, plan.invalidTags);
    try {
      assertValidTags(applied.tags);
    } catch (cause) {
      throw new MigrationTagError(
        persistenceId, sourceEvent.sequenceNr, applied.tags ?? [], (cause as Error).message,
      );
    }
    entries.push({ event: transformed.event, tags: applied.tags, tagsSanitized: applied.sanitized });
  }

  return { targetHighestSeq: targetHighestSeq, firstSourceSeq: firstSourceSeq, entries: entries };
}

/** The tag list to hand `append`, plus whether producing it changed anything. */
type AppliedTags = {
  readonly tags: ReadonlyArray<string> | undefined;
  readonly sanitized: boolean;
};

/**
 * Apply {@link InvalidTagPolicy} to one source event's tag list.
 *
 * `'sanitize'` drops empty members and collapses repeats, keeping
 * first-occurrence order so the surviving tags stay in the order the source
 * wrote them.  Everything else is left alone for the validator to reject:
 * truncating an over-long tag or stripping a comma out of one invents a tag
 * the source never held, and a caller who wants that says so in
 * `eventTransform`, where the rule is visible.
 */
function applyTagPolicy(
  tags: ReadonlyArray<string> | undefined,
  policy: InvalidTagPolicy,
): AppliedTags {
  if (tags === undefined || policy === 'refuse') return { tags: tags, sanitized: false };
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    if (tag.length === 0 || seen.has(tag)) continue;
    seen.add(tag);
    kept.push(tag);
  }
  if (kept.length === tags.length) return { tags: tags, sanitized: false };
  return { tags: kept, sanitized: true };
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
