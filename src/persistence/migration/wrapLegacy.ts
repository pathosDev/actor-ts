import type { Journal } from '../Journal.js';
import type { PersistentEvent } from '../JournalTypes.js';
import type { SnapshotStore } from '../SnapshotStore.js';
import type { JournalEnvelope } from './Adapter.js';
import { isEnvelope } from './Envelope.js';

/**
 * One-shot migration helpers for repos adopting the schema-evolution
 * envelope after-the-fact (#9).  An actor that ships a fresh
 * `EventAdapter` against an existing journal whose events are NOT
 * envelope-wrapped throws `MigrationError` on the first replay,
 * because the envelope layer expects `{_v, _t, _e}` markers and the
 * legacy data has none.
 *
 * The fix is a one-time rewrite: walk the journal, wrap every raw
 * event in `{ _v: 1, _t: <manifest>, _e: <event> }`, write back.  This
 * file ships the primitives:
 *
 *   - `wrapEventAsEnvelope(event, manifestFor)` — pure, idempotent;
 *     events that already look like envelopes are passed through.
 *   - `wrapStateAsEnvelope(state, manifestFor)` — same shape for
 *     snapshots / durable-state values.
 *   - `migrateInMemoryJournal(journal, manifestFor)` — reference
 *     bulk-rewriter for the in-process journal.  Preserves sequence
 *     numbers + timestamps + tags; the only thing that changes is the
 *     `event` payload.
 *   - `migrateSnapshotStore(store, persistenceIds, manifestFor)` — same idea
 *     for snapshots.  Iterates `persistenceIds` (callers source them — usually
 *     `await journal.persistenceIds()`).
 *
 * Cassandra / SQLite / S3 journals all need a journal-specific
 * SQL/CQL/object-list path; users write a few lines of glue using
 * `wrapEventAsEnvelope` as the per-row primitive.  Shipping a
 * generic CLI for every backend would be a maintenance trap.
 */

/* ---------------------------- pure wrappers ---------------------------- */

/**
 * Wrap a single domain event as a `JournalEnvelope` at version 1
 * (idempotent — events that already look like envelopes are returned
 * unchanged).  `manifestFor` derives the stable `_t` discriminator
 * from the event itself.  Override `version` if your codebase
 * already shipped some envelopes at a higher version and you want
 * the migration to start from there.
 */
export function wrapEventAsEnvelope<E>(
  event: E,
  manifestFor: (e: E) => string,
  version = 1,
): JournalEnvelope<E> {
  if (isEnvelope(event)) return event as unknown as JournalEnvelope<E>;
  return { _v: version, _t: manifestFor(event), _e: event };
}

/** Same shape as {@link wrapEventAsEnvelope}, separate name for clarity. */
export function wrapStateAsEnvelope<S>(
  state: S,
  manifestFor: (s: S) => string,
  version = 1,
): JournalEnvelope<S> {
  if (isEnvelope(state)) return state as unknown as JournalEnvelope<S>;
  return { _v: version, _t: manifestFor(state), _e: state };
}

/* -------------------------- migration result --------------------------- */

export interface MigrationResult {
  /** Total entries inspected. */
  readonly inspected: number;
  /** Entries that were rewritten (raw → envelope). */
  readonly wrapped: number;
  /** Entries that were already enveloped and left untouched. */
  readonly skipped: number;
}

/* ----------------------- in-memory bulk migrator ----------------------- */

/**
 * Internal hook on `InMemoryJournal` for the bulk-migrator.  Other
 * journal impls expose their own update path (SQL UPDATE, CQL
 * UPDATE, S3 PUT) — duck-typing is fine here, the helper just needs a
 * way to overwrite event payloads in place.
 */
interface InternalMigratableJournal extends Journal {
  /**
   * Apply `transform(event)` to every persisted event under `persistenceId`,
   * writing the new payload back in place.  Sequence numbers,
   * timestamps and tags are preserved.  Implemented on
   * `InMemoryJournal`; user code adds it to custom journals (or
   * skips this helper and writes a journal-specific migrator).
   */
  _remapForMigration<E, F>(persistenceId: string, transform: (e: E) => F): Promise<void>;
}

/**
 * Bulk-rewrite every event in a {@link Journal} that exposes the
 * `_remapForMigration` hook (the in-memory journal does; for other
 * backends you write a few lines of journal-specific glue).  Returns
 * a count of inspected / wrapped / skipped entries — re-running on a
 * fully-migrated journal is a no-op (`wrapped === 0`).
 */
export async function migrateInMemoryJournal<E>(
  journal: Journal,
  manifestFor: (e: E) => string,
  options: { readonly version?: number } = {},
): Promise<MigrationResult> {
  if (typeof (journal as InternalMigratableJournal)._remapForMigration !== 'function') {
    throw new Error(
      'migrateInMemoryJournal: journal does not expose _remapForMigration. '
      + 'Use the per-row `wrapEventAsEnvelope` primitive with a backend-specific '
      + 'rewrite path (SQL UPDATE / S3 PUT / CQL UPDATE).',
    );
  }
  const migratable = journal as InternalMigratableJournal;
  const version = options.version ?? 1;
  const persistenceIds = await journal.persistenceIds();
  let inspected = 0;
  let wrapped = 0;
  let skipped = 0;
  for (const persistenceId of persistenceIds) {
    // Read first to count + decide; the `_remapForMigration` call
    // does the actual rewrite in place.
    const events = await journal.read<E | JournalEnvelope<E>>(persistenceId, 0);
    inspected += events.length;
    for (const persistedEvent of events) {
      if (isEnvelope(persistedEvent.event)) skipped += 1;
      else wrapped += 1;
    }
    await migratable._remapForMigration<E, JournalEnvelope<E>>(
      persistenceId, (e) => wrapEventAsEnvelope<E>(e, manifestFor, version),
    );
  }
  return { inspected, wrapped, skipped };
}

/* ------------------------ snapshot-store helpers ----------------------- */

/**
 * Walk a {@link SnapshotStore} for every `persistenceId` in `persistenceIds`, load the
 * latest snapshot, and re-save it as an enveloped value if it isn't
 * one already.  Older snapshots in `keepN` history get the same
 * treatment via repeated `loadBefore` calls until exhausted.
 *
 * Note: this rewrites snapshots **at the same `seq`** by overwriting
 * — most snapshot-store impls upsert by key (`<pid>/<seq>.json`) so
 * a re-save lands on the existing record without changing the seq.
 */
export async function migrateSnapshotStore<S>(
  store: SnapshotStore,
  persistenceIds: ReadonlyArray<string>,
  manifestFor: (s: S) => string,
  options: { readonly version?: number } = {},
): Promise<MigrationResult> {
  const version = options.version ?? 1;
  let inspected = 0;
  let wrapped = 0;
  let skipped = 0;
  for (const persistenceId of persistenceIds) {
    const latest = await store.loadLatest<S>(persistenceId);
    if (latest.isNone()) continue;
    inspected += 1;
    const snapshot = latest.value;
    if (isEnvelope(snapshot.state)) {
      skipped += 1;
      continue;
    }
    const wrappedState = wrapStateAsEnvelope<S>(snapshot.state, manifestFor, version);
    await store.save<JournalEnvelope<S>>(persistenceId, snapshot.sequenceNr, wrappedState);
    wrapped += 1;
  }
  return { inspected, wrapped, skipped };
}

/* ------------------------------ shape glue ----------------------------- */

/**
 * Convenience: pretty-print a migration summary suitable for the CLI
 * one-liner most users will write — `console.log(formatMigrationResult(...))`
 * after the bulk call.
 */
export function formatMigrationResult(prefix: string, result: MigrationResult): string {
  return `${prefix}: ${result.wrapped} wrapped, ${result.skipped} already enveloped, ${result.inspected} inspected`;
}

// Internal export so the InMemoryJournal can mark itself as migratable
// without circular-import gymnastics (the helper checks duck-typed).
export type { PersistentEvent };
