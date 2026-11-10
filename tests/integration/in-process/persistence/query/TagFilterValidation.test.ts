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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { MAX_TAGS_PER_EVENT, MAX_TAG_LENGTH } from '../../../../../src/persistence/Constants.js';
import { JournalError, type PersistentEvent } from '../../../../../src/persistence/JournalTypes.js';
import { InMemoryJournal } from '../../../../../src/persistence/journals/InMemoryJournal.js';
import { MongoJournal } from '../../../../../src/persistence/journals/MongoJournal.js';
import { MongoJournalOptions } from '../../../../../src/persistence/journals/MongoJournalOptions.js';
import { SqliteJournal } from '../../../../../src/persistence/journals/SqliteJournal.js';
import { SqliteJournalOptions } from '../../../../../src/persistence/journals/SqliteJournalOptions.js';
import { CassandraJournal } from '../../../../../src/persistence/journals/CassandraJournal.js';
import { CassandraJournalOptions } from '../../../../../src/persistence/journals/CassandraJournalOptions.js';
import { PostgresJournal } from '../../../../../src/persistence/journals/PostgresJournal.js';
import { PostgresJournalOptions } from '../../../../../src/persistence/journals/PostgresJournalOptions.js';
import { MariaDbJournal } from '../../../../../src/persistence/journals/MariaDbJournal.js';
import { MariaDbJournalOptions } from '../../../../../src/persistence/journals/MariaDbJournalOptions.js';
import { CassandraQuery } from '../../../../../src/persistence/query/CassandraQuery.js';
import { InMemoryQuery } from '../../../../../src/persistence/query/InMemoryQuery.js';
import { MariaDbQuery } from '../../../../../src/persistence/query/MariaDbQuery.js';
import { MongoQuery } from '../../../../../src/persistence/query/MongoQuery.js';
import { RelationalQuery } from '../../../../../src/persistence/query/RelationalQuery.js';
import { SqliteQuery } from '../../../../../src/persistence/query/SqliteQuery.js';
import {
  eventMatchesTagFilter,
  normalizeTagFilter,
  offsetStart,
  type TagFilter,
} from '../../../../../src/persistence/query/PersistenceQuery.js';
import { assertValidFilterTags as publiclyExportedAssertValidFilterTags } from '../../../../../src/persistence/index.js';
import { assertValidFilterTags, assertValidTags } from '../../../../../src/persistence/storage/TagValidator.js';
import { FakeCassandraClient } from '../FakeCassandraClient.js';
import { FakeMariaDbPool } from '../FakeMariaDbPool.js';
import { FakeMongoClient } from '../FakeMongoClient.js';
import { FakePgPool } from '../FakePgPool.js';

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

/** The message of a rejected call, or `null` when it did not reject at all. */
async function rejectionMessage(run: Promise<unknown>): Promise<string | null> {
  return run.then(() => null, (error: unknown) => (error as Error).message);
}

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

  test('the member-type message says why the filter was refused, not only that it was', () => {
    // The tail is the only place a caller is told *why* a filter member that
    // reads perfectly well as a value is not one: it matches no stored tag,
    // and on MongoDB it is worse than useless because the driver reads an
    // object as an operator expression.  Without it the message reports a
    // type mismatch against a signature the caller believes it satisfied —
    // `TagFilter`'s `string` is erased, so the value came from request data
    // and looks like a legitimate filter from the call site.
    //
    // Asserted separately from the shape assertions above deliberately: those
    // match on `all[0] is object, not a string` and stay green with the
    // explanation deleted, which is how it came to be droppable in the first
    // place.
    const message = (() => {
      try { normalizeTagFilter(asRequestData({ all: [operatorExpression] })); return ''; }
      catch (e) { return (e as Error).message; }
    })();
    expect(message).toContain('matches no stored tag');
    expect(message).toContain('operator expression');
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

describe('normalizeTagFilter — the spec it returns is detached from the caller', () => {
  /**
   * The JSDoc above `normalizeTagFilter` has always promised that "an object is
   * shallow-copied so callers can't mutate it after the fact".  Copying the
   * *object* is not copying the operator *arrays*, and the arrays are what a
   * backend carries: `MongoQuery.currentEventsByTag` puts `spec.any` straight
   * into `{ tags: { $in: anyTags } }` and hands that to `fetchAndRefine`, which
   * awaits `openForQuery()` before `.find()` reads it.  So a caller that
   * mutates its own filter array during that await changes the query that runs
   * — past the validation that just approved it.
   *
   * Narrow in practice and exactly the sentence sitting above a security
   * guard, which is why it is bound rather than reworded.
   */
  test('each operator list is copied, so a post-validation mutation cannot reach the query', () => {
    const callerOwnedAll = ['orders'];
    const callerOwnedAny = ['debit'];
    const callerOwnedNot = ['archived'];
    const spec = normalizeTagFilter({
      all: callerOwnedAll,
      any: callerOwnedAny,
      not: callerOwnedNot,
    });

    expect(spec.all).not.toBe(callerOwnedAll);
    expect(spec.any).not.toBe(callerOwnedAny);
    expect(spec.not).not.toBe(callerOwnedNot);

    // The payload from the issue, written into the caller's array *after* the
    // filter passed validation — the shape the guard exists to refuse.
    callerOwnedAll[0] = operatorExpression as unknown as string;
    callerOwnedAny[0] = operatorExpression as unknown as string;
    callerOwnedNot[0] = operatorExpression as unknown as string;

    expect(spec.all).toEqual(['orders']);
    expect(spec.any).toEqual(['debit']);
    expect(spec.not).toEqual(['archived']);
  });

  test('an absent operator stays absent rather than becoming an empty list', () => {
    // `any: []` matches nothing and `not: undefined` imposes no constraint, so
    // a copy that turned one into the other would change what the filter means
    // — the plausible way to write the copy wrong.
    const spec = normalizeTagFilter({ all: ['orders'] });
    expect(spec.any).toBeUndefined();
    expect(spec.not).toBeUndefined();
    expect(spec).toEqual({ all: ['orders'], any: undefined, not: undefined });
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

  test('RelationalQuery refuses it, so every dialect it serves inherits the guard', async () => {
    // The describe above says "every backend", and until this case it meant
    // three of them.  `RelationalQuery` is the one class behind five shipped
    // journals — Postgres, MariaDB, MsSQL, libSQL and D1 all extend
    // `RelationalJournal`, and none of their query paths overrides
    // `currentEventsByTag` — so this is where the claim is either true for all
    // five or true for none.  It is exercised through the base class itself
    // (its dialect-neutral form, which is what an MsSQL / libSQL / D1 caller
    // constructs) rather than only through a named subclass.
    const pool = new FakePgPool();
    const journal = new PostgresJournal(PostgresJournalOptions.create().withPool(pool));
    await journal.append('account-1', [{ event: 'a', tags: ['ledger'] }], 0);
    const query = new RelationalQuery(journal, 'PostgresQuery');

    // Specific, for the Mongo test's reason: the unguarded tree also fails to
    // return the event, but by binding the object as a statement parameter and
    // resolving to `[]` — a wrong answer, not a refusal.  The message is what
    // tells the two apart.
    const allMessage = await rejectionMessage(
      query.currentEventsByTag(asRequestData({ all: [operatorExpression] }), offsetStart),
    );
    expect(allMessage).toMatch(/all\[0\] is object, not a string/);
    const anyMessage = await rejectionMessage(
      query.currentEventsByTag(asRequestData({ any: [{ $gt: '' }] }), offsetStart),
    );
    expect(anyMessage).toMatch(/any\[0\] is object, not a string/);

    // The indexed path a real caller uses is untouched.
    const ledger = await query.currentEventsByTag<string>('ledger', offsetStart);
    expect(ledger.map((tagged) => tagged.event.event)).toEqual(['a']);
    await journal.close();
  });

  test('a named relational subclass does not lose it on the way down', async () => {
    // `MariaDbQuery` and `PostgresQuery` add only a name; a subclass that
    // shadowed `currentEventsByTag` would be the way the base's guard stops
    // reaching a shipped backend, and nothing else in the tree would notice.
    const pool = new FakeMariaDbPool();
    const journal = new MariaDbJournal(MariaDbJournalOptions.create().withPool(pool));
    await journal.append('account-1', [{ event: 'a', tags: ['ledger'] }], 0);
    const query = new MariaDbQuery(journal);

    const message = await rejectionMessage(
      query.currentEventsByTag(asRequestData({ all: [operatorExpression] }), offsetStart),
    );
    expect(message).toMatch(/all\[0\] is object, not a string/);
    await journal.close();
  });

  test('CassandraQuery refuses it on the side-table path, which is its own entrance', async () => {
    // `useTagIndex: true` is load-bearing here.  With the index off,
    // `CassandraQuery` delegates straight to the inherited journal scan, which
    // normalises at `InMemoryQuery`'s own call site — so a test written with
    // the index off would pass with this class's `normalizeTagFilter` deleted
    // and would prove nothing about the override that actually ships.
    const client = new FakeCassandraClient();
    const journalOptions = CassandraJournalOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withAutoCreateKeyspace(true)
      .withClient(client)
      .withUseTagIndex(true);
    const journal = new CassandraJournal(journalOptions);
    await journal.append('account-1', [{ event: 'a', tags: ['ledger'] }], 0);
    const query = new CassandraQuery(journal);

    const allMessage = await rejectionMessage(
      query.currentEventsByTag(asRequestData({ all: [operatorExpression] }), offsetStart),
    );
    expect(allMessage).toMatch(/all\[0\] is object, not a string/);
    // Not the driver's complaint about an unbindable parameter, wrapped: the
    // filter never reached a partition scan.
    expect(allMessage).not.toMatch(/CassandraQuery\.currentEventsByTag failed/);
    const anyMessage = await rejectionMessage(
      query.currentEventsByTag(asRequestData({ any: [{ $gt: '' }] }), offsetStart),
    );
    expect(anyMessage).toMatch(/any\[0\] is object, not a string/);

    const ledger = await query.currentEventsByTag<string>('ledger', offsetStart);
    expect(ledger.map((tagged) => tagged.event.event)).toEqual(['a']);
    await journal.close();
  });
});

/**
 * The Length rule is the one read-side rule that can take an answer away, and
 * the file justifies transferring it with "since every write has been held to
 * the same cap since #136 a longer filter member can only ever match nothing".
 * #136 landed on 2026-07-22, between v0.11.0 and v0.12.0 — so a journal this
 * library wrote before that, or one a foreign writer filled, really can hold a
 * tag longer than `MAX_TAG_LENGTH`, and for those rows the premise is false.
 *
 * The rule stays (dropping it re-opens the #738 query surface).  What this
 * describe pins is the population it strands and the route that is left, so
 * the caveat beside the rule is a statement about the tree rather than a note.
 */
describe('over-long tags written before the cap: the population the Length rule strands', () => {
  const legacyTag = 'x'.repeat(MAX_TAG_LENGTH + 1);

  test('no supported write can produce one, so the population is closed', () => {
    // Which is what makes it a *legacy* population rather than a live hazard:
    // the only sources are actor-ts <= 0.11.0 and a writer that is not this
    // library at all — the same population the comma rule is kept off the read
    // side for.
    expect(() => assertValidTags([legacyTag])).toThrow(/tag too long/);
    expect(() => assertValidTags(['x'.repeat(MAX_TAG_LENGTH)])).not.toThrow();
  });

  test('the refinement step would match it, and the filter never reaches it', () => {
    // `eventMatchesTagFilter` is the final in-memory step of every backend's
    // tag query and is perfectly willing to match the row.  So the answer is
    // withdrawn by the guard, not by the storage layer — which is the whole
    // reason the exception is worth writing down.
    expect(eventMatchesTagFilter([legacyTag], { all: [legacyTag] })).toBe(true);
    expect(() => normalizeTagFilter({ all: [legacyTag] }))
      .toThrow(/exceeding the .*-character limit/);
  });

  test('both tag entrances refuse it, so there is no escape hatch on that path', async () => {
    const journal = new InMemoryJournal();
    await journal.append('account-1', [{ event: 'a', tags: ['ledger'] }], 0);
    // Forging the row rather than appending it is the point: `assertValidTags`
    // has refused this shape since #136, so a journal cannot be brought into
    // this state through any supported call — only by predating the rule.
    const streams = (journal as unknown as {
      readonly streams: Map<string, PersistentEvent<unknown>[]>;
    }).streams;
    const stored = streams.get('account-1')!;
    stored[0] = { ...stored[0]!, tags: [legacyTag] };
    const query = new InMemoryQuery(journal);

    await expect(query.currentEventsByTag(legacyTag, offsetStart))
      .rejects.toThrow(/exceeding the .*-character limit/);
    expect(() => query.eventsByTag(legacyTag, offsetStart))
      .toThrow(/exceeding the .*-character limit/);
    expect(() => normalizeTagFilter({ any: [legacyTag] })).toThrow();
    expect(() => normalizeTagFilter({ not: [legacyTag] })).toThrow();
  });

  test('reading by persistence id still returns it — the route the caveat names', async () => {
    const journal = new InMemoryJournal();
    await journal.append('account-1', [{ event: 'a', tags: ['ledger'] }], 0);
    const streams = (journal as unknown as {
      readonly streams: Map<string, PersistentEvent<unknown>[]>;
    }).streams;
    const stored = streams.get('account-1')!;
    stored[0] = { ...stored[0]!, tags: [legacyTag] };
    const query = new InMemoryQuery(journal);

    const byId = await query.currentEventsByPersistenceId<string>('account-1', 1);
    expect(byId.map((event) => event.event)).toEqual(['a']);
    expect(byId[0]?.tags).toEqual([legacyTag]);
  });

  test('the exception is recorded beside the rule it qualifies', () => {
    // A caveat in the module header would be a caveat nobody reads while
    // deciding whether the Length rule may transfer, and the transfer decision
    // is made bullet by bullet in `assertValidFilterTags`'s JSDoc. So this
    // scopes to that one bullet rather than to the file.
    const source = readFileSync(
      join(import.meta.dir, '..', '..', '..', '..', '..',
        'src', 'persistence', 'storage', 'TagValidator.ts'),
      'utf8',
    );
    const lengthBullet = source.slice(
      source.indexOf('**Length**'),
      source.indexOf('**Comma**'),
    );
    expect(lengthBullet.length).toBeGreaterThan(0);
    expect(lengthBullet).toContain('0.12.0');
    expect(lengthBullet).toContain('persistenceId');
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
