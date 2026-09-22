/**
 * The `DISTINCT` branch of the tag-join fake, and specifically its key
 * separator (#1508).
 *
 * `runTagJoinQuery` collapses repeated rows by building a string key out of
 * `persistence_id` and `sequence_nr`. The separator between them was written
 * as a raw U+0000 byte, which made the whole file read as binary to git — so
 * the fix is to spell it as an escape. That edit is invisible in a diff (the
 * file was binary before it and the byte is invisible after it), and the
 * obvious way to get it wrong is to decide the strange byte was noise and
 * drop it: `${persistence_id}${sequence_nr}` still deduplicates, still passes
 * every existing test, and quietly merges two different events.
 *
 * Nothing in the tree pinned that separator, which is why these cases exist.
 * They are about the fake, not the query — but the fake is what
 * `RelationalQuery.test.ts` reads its answers out of, so a fake that merges
 * two events reports a wrong answer as a passing test.
 */
import { describe, expect, test } from 'bun:test';
import {
  isTagJoinQuery,
  runTagJoinQuery,
  type JoinedEventRow,
  type TagIndexRow,
} from './TagJoinQuery.js';

/** The statement shape `RelationalQuery` emits for a single-tag query. */
const singleTagJoin = (distinct: boolean): string =>
  `SELECT ${distinct ? 'DISTINCT ' : ''}e.persistence_id, e.sequence_nr, e.payload, `
  + 'e.tags, e.timestamp FROM events_tags t JOIN events e '
  + 'ON t.persistence_id = e.persistence_id AND t.sequence_nr = e.sequence_nr '
  + 'WHERE t.tag = ? AND t.timestamp >= ?';

/** …and for a multi-tag one, which is where `DISTINCT` earns its place. */
const multiTagJoin = (distinct: boolean): string =>
  `SELECT ${distinct ? 'DISTINCT ' : ''}e.persistence_id, e.sequence_nr, e.payload, `
  + 'e.tags, e.timestamp FROM events_tags t JOIN events e '
  + 'ON t.persistence_id = e.persistence_id AND t.sequence_nr = e.sequence_nr '
  + 'WHERE t.tag IN (?, ?) AND t.timestamp >= ?';

const tagRow = (persistenceId: string, sequenceNr: number, tag: string): TagIndexRow =>
  ({ persistence_id: persistenceId, sequence_nr: sequenceNr, tag, timestamp: 1_000 });

const eventRow = (persistenceId: string, sequenceNr: number): JoinedEventRow => ({
  persistence_id: persistenceId,
  sequence_nr: sequenceNr,
  payload: `${persistenceId}#${sequenceNr}`,
  tags: 'ledger,audit',
  timestamp: 1_000,
});

/**
 * Two events whose composite keys are one character apart, and which collide
 * exactly when the separator is dropped: `('a1', 2)` and `('a', 12)` both
 * concatenate to `a12`.
 */
const collidingEvents: ReadonlyArray<JoinedEventRow> = [eventRow('a1', 2), eventRow('a', 12)];

const run = (
  sql: string,
  parameters: ReadonlyArray<unknown>,
  tagRows: ReadonlyArray<TagIndexRow>,
  eventRows: ReadonlyArray<JoinedEventRow>,
): JoinedEventRow[] => runTagJoinQuery(sql, parameters, () => tagRows, () => eventRows);

describe('runTagJoinQuery — the DISTINCT key separates the two key columns', () => {
  test('two events whose concatenation collides both survive DISTINCT', () => {
    // The case a missing separator merges. `('a1', 2)` and `('a', 12)` are
    // different events of different streams; concatenated without a separator
    // they are the same eight characters, and the second one is dropped.
    const tagRows = [tagRow('a1', 2, 'ledger'), tagRow('a', 12, 'ledger')];
    const rows = run(singleTagJoin(true), ['ledger', 0], tagRows, collidingEvents);

    expect(rows.map((row) => `${row.persistence_id}#${row.sequence_nr}`))
      .toEqual(['a#12', 'a1#2']);
  });

  test('DISTINCT still collapses one event reached through two tags', () => {
    // The other half of the pair: a separator that never collides is trivial
    // to get by never deduplicating at all, so the collapsing behaviour is
    // asserted here rather than assumed.
    const tagRows = [tagRow('order-1', 1, 'ledger'), tagRow('order-1', 1, 'audit')];
    const events = [eventRow('order-1', 1)];
    const rows = run(multiTagJoin(true), ['ledger', 'audit', 0], tagRows, events);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.persistence_id).toBe('order-1');
  });

  test('without DISTINCT the same event comes back once per matching tag row', () => {
    // Which is what makes the statement's `DISTINCT ` prefix meaningful and
    // proves the two branches are actually different code paths.
    const tagRows = [tagRow('order-1', 1, 'ledger'), tagRow('order-1', 1, 'audit')];
    const events = [eventRow('order-1', 1)];
    const rows = run(multiTagJoin(false), ['ledger', 'audit', 0], tagRows, events);

    expect(rows).toHaveLength(2);
  });

  test('both statement shapes are recognised as tag joins', () => {
    // A statement this fake does not recognise falls through to the journal
    // scan, and every case above would then be testing the wrong path.
    for (const distinct of [true, false]) {
      expect(isTagJoinQuery(singleTagJoin(distinct))).toBe(true);
      expect(isTagJoinQuery(multiTagJoin(distinct))).toBe(true);
    }
    expect(isTagJoinQuery('SELECT persistence_id, sequence_nr, payload, tags, timestamp FROM events'))
      .toBe(false);
  });
});
