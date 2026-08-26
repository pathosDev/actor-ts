/**
 * `migrateBetweenJournals` against a stream whose tags predate the rules
 * `append` enforces today (#740 follow-up).
 *
 * #740 made `assertValidTags` reject empty and repeated tags at the journal's
 * write boundary, and promised in the same breath that *reading* is never
 * refused.  A copy is both: it reads a legacy list and hands it straight to
 * the target's `append`, so a database an older release wrote can still be
 * replayed but could no longer be migrated — and the refusal arrived halfway
 * through the sweep, after earlier persistence ids had already been written
 * and recorded as complete.
 *
 * The legacy shape is seeded the only way it can be: the events go in through
 * `append` with a list it accepts, and the comma-separated tag column is
 * rewritten underneath.  That is byte-for-byte the database a pre-#740
 * release produced — `SqliteJournal.read` splits that column on every comma,
 * so `'orders,'` comes back as `['orders', '']`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { InMemoryJournal } from '../../../../../src/persistence/journals/InMemoryJournal.js';
import { SqliteJournal } from '../../../../../src/persistence/journals/SqliteJournal.js';
import { SqliteJournalOptions } from '../../../../../src/persistence/journals/SqliteJournalOptions.js';
import {
  InMemoryMigrationProgressStore,
  type MigrateJournalsOptions,
  MigrationTagError,
  migrateBetweenJournals,
} from '../../../../../src/persistence/migration/JournalMigration.js';

/** Copied in the order given, so "the clean id was written first" is not luck. */
const orderedPersistenceIds = ['order-clean', 'order-legacy'];

let source: SqliteJournal | undefined;

afterEach(async () => {
  await source?.close();
  source = undefined;
});

/**
 * Rewrite one event's comma-separated tag column, bypassing `append`.
 * `SqliteJournal` keeps `db` private; a test that has to produce a row an
 * older release wrote reaches it the same way the tag-table migration suite
 * does.
 */
function rewriteTagColumn(
  journal: SqliteJournal,
  persistenceId: string,
  sequenceNr: number,
  commaSeparatedTags: string,
): void {
  const internal = journal as unknown as {
    db: { prepare(sql: string): { run(...args: unknown[]): unknown } };
  };
  internal.db
    .prepare('UPDATE events SET tags = ? WHERE persistence_id = ? AND sequence_nr = ?')
    .run(commaSeparatedTags, persistenceId, sequenceNr);
}

/**
 * A source holding one clean stream and one whose single event carries
 * `commaSeparatedTags` in the legacy column.
 */
async function seedLegacySource(commaSeparatedTags: string): Promise<SqliteJournal> {
  const journalOptions = SqliteJournalOptions.create().withPath(':memory:');
  const journal = new SqliteJournal(journalOptions);
  await journal.append('order-clean', [{ event: { kind: 'created' }, tags: ['orders'] }], 0);
  await journal.append('order-legacy', [{ event: { kind: 'created' }, tags: ['orders'] }], 0);
  // The join table keeps the row `append` wrote; only the CSV column — the one
  // `read` reconstructs the list from — carries the legacy shape.  That split
  // is the divergence #740 exists to close.
  rewriteTagColumn(journal, 'order-legacy', 1, commaSeparatedTags);
  return journal;
}

/** Run the copy and hand back whatever it threw, or `undefined` if it did not. */
async function copyAndCatch(
  legacySource: SqliteJournal,
  target: InMemoryJournal,
  options: MigrateJournalsOptions = {},
): Promise<Error | undefined> {
  return migrateBetweenJournals(legacySource, target, {
    persistenceIds: orderedPersistenceIds,
    ...options,
  }).then(() => undefined, (e: unknown) => e as Error);
}

describe('migrateBetweenJournals — legacy tag lists (#740)', () => {
  test('refuses an empty tag before writing anything to the target', async () => {
    source = await seedLegacySource('orders,');
    const target = new InMemoryJournal();

    const error = await copyAndCatch(source, target);

    expect(error).toBeInstanceOf(MigrationTagError);
    // The point of the refusal, asserted first because it is the defect: the
    // copy stops before the FIRST append, not halfway down the list with
    // `order-clean` already written and an exception on top of it.
    expect(await target.persistenceIds()).toEqual([]);
    expect(await target.highestSeq('order-clean')).toBe(0);
    expect(error!.name).toBe('MigrationTagError');
    expect(error!.message).toContain('order-legacy');
    expect(error!.message).toContain('sequenceNr=1');
    // The diagnosis names both escape hatches, since neither is discoverable
    // from a validator message about an empty tag.
    expect(error!.message).toContain('eventTransform');
    expect(error!.message).toContain("invalidTags: 'sanitize'");
  });

  test('a resume run with skipExistingPersistenceIds has no truncated stream to walk past', async () => {
    source = await seedLegacySource('orders,');
    const target = new InMemoryJournal();

    const first = await copyAndCatch(source, target, { skipExistingPersistenceIds: true });
    expect(first).toBeInstanceOf(MigrationTagError);

    // The refusal left nothing behind, so the re-run reaches the same verdict
    // instead of treating a half-copied `order-legacy` as already present.
    const second = await copyAndCatch(source, target, { skipExistingPersistenceIds: true });
    expect(second).toBeInstanceOf(MigrationTagError);
    expect(await target.persistenceIds()).toEqual([]);
  });

  test('records nothing in the progress store when it refuses', async () => {
    source = await seedLegacySource('orders,');
    const target = new InMemoryJournal();
    const progress = new InMemoryMigrationProgressStore();

    const error = await copyAndCatch(source, target, { progress });

    expect(error).toBeInstanceOf(MigrationTagError);
    // A resume run that finds `order-clean` marked complete skips a stream the
    // target never received — and with `skipExistingPersistenceIds` it would
    // skip the half-written one too.
    expect((await progress.load()).completed).toEqual([]);
  });

  test('refuses a repeated tag before writing anything to the target', async () => {
    source = await seedLegacySource('orders,orders');
    const target = new InMemoryJournal();

    const error = await copyAndCatch(source, target);

    expect(error).toBeInstanceOf(MigrationTagError);
    expect(error!.message).toContain('duplicate tags are not allowed');
    expect(await target.persistenceIds()).toEqual([]);
  });

  test("invalidTags: 'sanitize' completes the copy and counts what it changed", async () => {
    source = await seedLegacySource('orders,');
    const target = new InMemoryJournal();

    const result = await migrateBetweenJournals(source, target, {
      persistenceIds: orderedPersistenceIds,
      invalidTags: 'sanitize',
    });

    expect(result.eventsWritten).toBe(2);
    expect(result.eventsWithSanitizedTags).toBe(1);
    const copied = await target.read('order-legacy', 1);
    expect(copied[0]!.tags).toEqual(['orders']);
    const untouched = await target.read('order-clean', 1);
    expect(untouched[0]!.tags).toEqual(['orders']);
  });

  test("invalidTags: 'sanitize' collapses a repeated tag", async () => {
    source = await seedLegacySource('orders,orders');
    const target = new InMemoryJournal();

    const result = await migrateBetweenJournals(source, target, {
      persistenceIds: orderedPersistenceIds,
      invalidTags: 'sanitize',
    });

    expect(result.eventsWithSanitizedTags).toBe(1);
    const copied = await target.read('order-legacy', 1);
    expect(copied[0]!.tags).toEqual(['orders']);
  });

  test("invalidTags: 'sanitize' still refuses a tag it cannot repair", async () => {
    // Over-length is representable in the CSV column and is not a shape
    // dropping or de-duplicating can fix — repairing it would mean truncating
    // a tag, which invents a different one.
    source = await seedLegacySource('x'.repeat(256));
    const target = new InMemoryJournal();

    const error = await copyAndCatch(source, target, { invalidTags: 'sanitize' });

    expect(error).toBeInstanceOf(MigrationTagError);
    expect(error!.name).toBe('MigrationTagError');
    expect(await target.persistenceIds()).toEqual([]);
  });

  test('an eventTransform that fixes the tags is enough on its own', async () => {
    source = await seedLegacySource('orders,');
    const target = new InMemoryJournal();

    const result = await migrateBetweenJournals(source, target, {
      persistenceIds: orderedPersistenceIds,
      eventTransform: (e) => ({ ...e, tags: e.tags?.filter((tag) => tag.length > 0) }),
    });

    expect(result.eventsWritten).toBe(2);
    expect(result.eventsWithSanitizedTags).toBe(0);
    const copied = await target.read('order-legacy', 1);
    expect(copied[0]!.tags).toEqual(['orders']);
  });
});
