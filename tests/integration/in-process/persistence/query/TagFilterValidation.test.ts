/**
 * Read-side tag-filter validation (#738).
 *
 * `TagFilter`'s `ReadonlyArray<string>` is erased at runtime, so an
 * application that builds a filter out of request data can hand a query an
 * object where a tag string belongs.  Every backend except MongoDB binds the
 * value and its driver refuses it; `MongoQuery` puts it into the filter
 * document, where an object is read as an operator expression and the multikey
 * tag index stops serving the query.  The guard lives in `normalizeTagFilter`
 * — the one function every backend's tag path routes through — so this file
 * checks it there *and* through the backends, since "every backend inherits
 * it" is the claim that actually needs holding down.
 *
 * The second half is the more important one: the read-side rules are
 * deliberately **not** the write-side rules, and the accepting tests pin the
 * difference.  A later sweep that makes the two "symmetrical" would withdraw
 * the empty-tag query #740 names as the way to find a bad `''` bucket, and it
 * would do so with every existing test still green.
 */
import { describe, expect, test } from 'bun:test';
import { MAX_TAGS_PER_EVENT, MAX_TAG_LENGTH } from '../../../../../src/persistence/Constants.js';
import { JournalError } from '../../../../../src/persistence/JournalTypes.js';
import { InMemoryJournal } from '../../../../../src/persistence/journals/InMemoryJournal.js';
import { MongoJournal } from '../../../../../src/persistence/journals/MongoJournal.js';
import { MongoJournalOptions } from '../../../../../src/persistence/journals/MongoJournalOptions.js';
import { SqliteJournal } from '../../../../../src/persistence/journals/SqliteJournal.js';
import { SqliteJournalOptions } from '../../../../../src/persistence/journals/SqliteJournalOptions.js';
import { InMemoryQuery } from '../../../../../src/persistence/query/InMemoryQuery.js';
import { MongoQuery } from '../../../../../src/persistence/query/MongoQuery.js';
import { SqliteQuery } from '../../../../../src/persistence/query/SqliteQuery.js';
import {
  normalizeTagFilter,
  offsetStart,
  type TagFilter,
} from '../../../../../src/persistence/query/PersistenceQuery.js';
import { assertValidFilterTags as publiclyExportedAssertValidFilterTags } from '../../../../../src/persistence/index.js';
import { assertValidFilterTags } from '../../../../../src/persistence/storage/TagValidator.js';
import { FakeMongoClient } from '../FakeMongoClient.js';

/**
 * A filter as it actually arrives from an HTTP body parser: the declared type
 * is compile-time only, and `?tag[$ne]=x` is an object by the time Express,
 * Fastify or Hono is done with it.  Casting here is the whole premise — a test
 * that could write the bad filter in typed TypeScript would not be testing a
 * runtime guard.
 */
const asRequestData = (filter: unknown): TagFilter => filter as TagFilter;

/** The payload from the issue: an operator expression wearing a tag's clothes. */
const operatorExpression = { $ne: null };

describe('normalizeTagFilter — rules that transfer from the write side', () => {
  test('rejects a non-string member of all, any and not', () => {
    expect(() => normalizeTagFilter(asRequestData({ all: [operatorExpression] })))
      .toThrow(/all\[0\] is object, not a string/);
    expect(() => normalizeTagFilter(asRequestData({ any: [{ $gt: '' }] })))
      .toThrow(/any\[0\] is object, not a string/);
    expect(() => normalizeTagFilter(asRequestData({ not: [{ $exists: true }] })))
      .toThrow(/not\[0\] is object, not a string/);
  });

  test('names the offending position, and reports every non-string shape', () => {
    // A filter is usually built by concatenation, so the bad member is rarely
    // the first one; a message that cannot say which is a message that sends
    // the caller looking through a list of twenty.
    expect(() => normalizeTagFilter(asRequestData({ all: ['orders', 'eu', operatorExpression] })))
      .toThrow(/all\[2\]/);
    expect(() => normalizeTagFilter(asRequestData({ all: [null] }))).toThrow(/is null/);
    expect(() => normalizeTagFilter(asRequestData({ all: [undefined] }))).toThrow(/is undefined/);
    expect(() => normalizeTagFilter(asRequestData({ all: [42] }))).toThrow(/is a number/);
    expect(() => normalizeTagFilter(asRequestData({ all: [['nested']] }))).toThrow(/is an array/);
  });

  test('rejects a member longer than any tag that could have been stored', () => {
    // Writes have been capped at MAX_TAG_LENGTH since #136, so a longer filter
    // member cannot match anything — refusing it withdraws no answer, and it
    // bounds what one request pushes into a filter document.
    expect(() => normalizeTagFilter({ all: ['x'.repeat(MAX_TAG_LENGTH)] })).not.toThrow();
    expect(() => normalizeTagFilter({ all: ['x'.repeat(MAX_TAG_LENGTH + 1)] }))
      .toThrow(/exceeding the .*-character limit/);
  });

  test('the bare-string shorthand is checked too, so it is not a way round the bound', () => {
    // `'t'` is shorthand for `{ all: ['t'] }`; if only the object form were
    // checked, the shorthand would be an unguarded second entrance.
    expect(() => normalizeTagFilter('x'.repeat(MAX_TAG_LENGTH + 1))).toThrow(/all\[0\]/);
    expect(() => normalizeTagFilter('orders')).not.toThrow();
  });

  test('rejects an operator list that is not a list, and a filter that is neither string nor object', () => {
    // `{ all: 'orders' }` used to walk the string, asking for the tags
    // 'o', 'r', 'd', … — a wrong answer rather than an error.
    expect(() => normalizeTagFilter(asRequestData({ all: 'orders' })))
      .toThrow(/all is a string, not an array/);
    // And a filter root that is neither reads all three operators as
    // `undefined`, which is the spec that matches *every* event: a malformed
    // filter would have widened the query instead of failing it.
    expect(() => normalizeTagFilter(asRequestData(42))).toThrow(/expected a tag string or a/);
    expect(() => normalizeTagFilter(asRequestData(null))).toThrow(/got null/);
  });
});

describe('normalizeTagFilter — rules that deliberately do not transfer', () => {
  test('accepts the empty tag, because that query is how a bad bucket is found (#740)', () => {
    // `assertValidTags` rejects an empty tag on write and promises in the same
    // breath that reads stay open, precisely so a journal written before the
    // rule can be inspected.  `{ all: [''] }` is the query #740's own commit
    // message names for the `''` bucket a pre-#740 MongoDB journal indexed.
    expect(() => normalizeTagFilter({ all: [''] })).not.toThrow();
    expect(() => normalizeTagFilter('')).not.toThrow();
    expect(() => normalizeTagFilter({ any: [''], not: [''] })).not.toThrow();
    expect(normalizeTagFilter('')).toEqual({ all: [''] });
  });

  test('accepts a repeated tag, which asks the same question twice', () => {
    // Redundant, not wrong: `eventMatchesTagFilter` gets the same answer both
    // times.  Concatenating two tag lists is a normal way to reach this.
    expect(() => normalizeTagFilter({ all: ['orders', 'orders'] })).not.toThrow();
    expect(() => normalizeTagFilter({ any: ['a', 'a', 'b'] })).not.toThrow();
  });

  test('accepts commas and control characters, which corrupt nothing on the read path', () => {
    // The comma rule protects SQLite's CSV `tags` column, which the read path
    // splits rather than writes; the control-character rule protects a value
    // that is persisted and re-emitted, which a filter never is.  Both would
    // otherwise refuse a diagnostic read of a document store whose array field
    // genuinely holds such a tag.
    expect(() => normalizeTagFilter({ all: ['a,b'] })).not.toThrow();
    expect(() => normalizeTagFilter({ all: ['line1\nline2'] })).not.toThrow();
    expect(() => normalizeTagFilter({ not: ['tab\there'] })).not.toThrow();
  });

  test('accepts more tags than one event may carry', () => {
    // MAX_TAGS_PER_EVENT counts an event's tag list.  A filter's list is a
    // different population: a union over five hundred tenant tags is an
    // ordinary query even though no single event carries more than 64 tags.
    const manyTags = Array.from({ length: MAX_TAGS_PER_EVENT * 4 }, (_, index) => `tenant-${index}`);
    expect(() => normalizeTagFilter({ any: manyTags })).not.toThrow();
  });
});

describe('every backend inherits the guard', () => {
  test('InMemoryQuery refuses the filter instead of quietly matching nothing', async () => {
    // The baseline behaviour this replaces: `tags.includes(<object>)` is false
    // for every row, so the query resolved to `[]` and the caller was told
    // nothing was wrong with the filter it sent.
    const journal = new InMemoryJournal();
    await journal.append('account-1', [{ event: 'a', tags: ['ledger'] }], 0);
    const query = new InMemoryQuery(journal);

    await expect(query.currentEventsByTag(asRequestData({ all: [operatorExpression] }), offsetStart))
      .rejects.toThrow(/not a string/);
    await expect(query.currentEventsByTag(asRequestData({ any: [operatorExpression] }), offsetStart))
      .rejects.toThrow(/not a string/);
  });

  test('the live path refuses it too, before a stream is handed out', () => {
    // `eventsByTag` normalises at its own call site, so this is a second
    // entrance and not the same one twice.  It refuses synchronously: a
    // consumer gets the error at the call, not on the first `for await`.
    const query = new InMemoryQuery(new InMemoryJournal());
    expect(() => query.eventsByTag(asRequestData({ all: [operatorExpression] }), offsetStart))
      .toThrow(/not a string/);
  });

  test('SqliteQuery refuses it ahead of the prepared statement', async () => {
    const journalOptions = SqliteJournalOptions.create()
      .withPath(':memory:');
    const journal = new SqliteJournal(journalOptions);
    await journal.append('account-1', [{ event: 'a', tags: ['ledger'] }], 0);
    const query = new SqliteQuery(journal);
    await expect(query.currentEventsByTag(asRequestData({ all: [operatorExpression] }), offsetStart))
      .rejects.toThrow(/not a string/);
    // The tag it can serve still works, so the guard has not shut the door.
    const ledger = await query.currentEventsByTag<string>('ledger', offsetStart);
    expect(ledger.map((tagged) => tagged.event.event)).toEqual(['a']);
    await journal.close();
  });

  test('MongoQuery refuses it before it becomes an operator expression', async () => {
    // The one backend the finding is about.  Both assertions below have to be
    // specific, because the unguarded tree also fails here — differently, and
    // for reasons that are not a guard:
    //   - `all` reached the driver as `{ tags: { $ne: null } }` and the error
    //     came back wrapped as a `JournalError` from whatever the server made
    //     of it, which against a real MongoDB is a full collection scan first;
    //   - `any` reached it as `{ tags: { $in: [ { $gt: '' } ] } }` and simply
    //     resolved to `[]`, since no index entry equals a document.
    // So "it throws" would be satisfied by the defect. The message, and the
    // absence of a JournalError, are what distinguish the guard from it.
    const client = new FakeMongoClient();
    const journal = new MongoJournal(MongoJournalOptions.create().withClient(client));
    await journal.append('account-1', [{ event: 'a', tags: ['ledger'] }], 0);
    const query = new MongoQuery(journal);

    const allError: unknown = await query
      .currentEventsByTag(asRequestData({ all: [operatorExpression] }), offsetStart)
      .then(() => null, (error: unknown) => error);
    expect((allError as Error | null)?.message).toMatch(/all\[0\] is object, not a string/);
    // Not the driver's complaint wrapped up: the filter never reached the
    // collection, so nothing named the operator back at us.
    expect((allError as Error | null)?.message).not.toMatch(/FakeMongoClient/);
    expect(allError).not.toBeInstanceOf(JournalError);

    await expect(query.currentEventsByTag(asRequestData({ any: [{ $gt: '' }] }), offsetStart))
      .rejects.toThrow(/any\[0\] is object, not a string/);

    // And the indexed path a real caller uses is untouched.
    const ledger = await query.currentEventsByTag<string>('ledger', offsetStart);
    expect(ledger.map((tagged) => tagged.event.event)).toEqual(['a']);
    await journal.close();
  });
});

describe('the public export', () => {
  test('actor-ts/persistence re-exports assertValidFilterTags (#738)', () => {
    // Same reasoning as the `assertValidTags` barrel test: an application that
    // builds filters from request data checks one ahead of the query, and
    // nothing else in the tree compiles that import.
    expect(publiclyExportedAssertValidFilterTags).toBe(assertValidFilterTags);
    expect(() => assertValidFilterTags('all', [operatorExpression])).toThrow(/not a string/);
    expect(() => assertValidFilterTags('all', undefined)).not.toThrow();
    expect(() => assertValidFilterTags('all', ['orders', ''])).not.toThrow();
  });
});
