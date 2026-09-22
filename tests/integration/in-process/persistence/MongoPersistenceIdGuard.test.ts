/**
 * Read- and delete-side `persistenceId` guard of the MongoDB journal — the
 * read-side twin of #738, found while verifying it (#1507).
 *
 * `Journal.read(persistenceId: string, …)` is a compile-time promise only.  An
 * application that serves a per-entity feed straight from request data
 * (`query.currentEventsByPersistenceId(request.params.id, 1)`) hands the query
 * whatever the body parser produced, and `?id[$gte]=` is an object by the time
 * Express, Fastify or Hono is done with it.  Every other backend binds the id
 * as a driver parameter and refuses a non-string there; `MongoJournal` puts it
 * into the query document, where an object is an operator expression —
 * `{ $gte: '' }` selects every stream.  `assertValidPersistenceId` guards only
 * the six `append` sites, and unlike the tag path there is no JS refinement
 * downstream: `read` returned other actors' events and `delete` emptied them.
 *
 * Every case below uses `$gte`, an operator the in-repo fake implements, so a
 * refusal is the guard's and not the fake's — the unguarded tree does not
 * throw here, it *answers*, which is the defect.  The last describe pins the
 * other half: the guard checks the type and nothing else, because the
 * validator's own contract is that only writes are held to the id rules and a
 * stream stored under a legacy id stays readable.
 */
import { describe, expect, test } from 'bun:test';
import { JournalError, type PersistentEvent } from '../../../../src/persistence/JournalTypes.js';
import { MongoJournal } from '../../../../src/persistence/journals/MongoJournal.js';
import { MongoJournalOptions } from '../../../../src/persistence/journals/MongoJournalOptions.js';
import { MongoQuery } from '../../../../src/persistence/query/MongoQuery.js';
import { encodePayload } from '../../../../src/persistence/storage/PayloadCodec.js';
import { assertCompletesWithin } from '../../../util/AsyncAssertions.js';
import { FakeMongoClient } from './FakeMongoClient.js';

/**
 * An id as it actually arrives from an HTTP body parser.  Casting is the whole
 * premise — a test that could write the bad id in typed TypeScript would not
 * be testing a runtime guard.
 */
const asRequestData = (value: unknown): string => value as string;

/** Matches every stored id: every string compares `>= ''`. */
const everyStream = asRequestData({ $gte: '' });

type Outcome<T> =
  | { readonly kind: 'answered'; readonly value: T }
  | { readonly kind: 'refused'; readonly error: Error };

/** What a call did — the answer it handed out, or the error it refused with. */
async function outcomeOf<T>(call: Promise<T>): Promise<Outcome<T>> {
  return call.then(
    (value) => ({ kind: 'answered', value }),
    (error: unknown) => ({ kind: 'refused', error: error as Error }),
  );
}

/** Two streams, so a broadened filter has something to disclose across. */
async function twoStreams(): Promise<{ client: FakeMongoClient; journal: MongoJournal }> {
  const client = new FakeMongoClient();
  const journal = new MongoJournal(MongoJournalOptions.create().withClient(client));
  await journal.append('account-1', [{ event: 'a1' }, { event: 'a2' }], 0);
  await journal.append('account-2', [{ event: 'b1' }], 0);
  return { client, journal };
}

function expectRefusal(outcome: Outcome<unknown>, operation: string): void {
  expect(outcome.kind).toBe('refused');
  if (outcome.kind !== 'refused') return;
  expect(outcome.error.message).toMatch(new RegExp(`MongoJournal\\.${operation}\\)`));
  expect(outcome.error.message).toMatch(/must be a string, got object/);
  // Not the driver's complaint wrapped up: the value never reached the
  // collection, so nothing named the operator back at us.
  expect(outcome.error.message).not.toMatch(/FakeMongoClient/);
  expect(outcome.error).not.toBeInstanceOf(JournalError);
}

describe('MongoJournal refuses a non-string persistenceId before it becomes an operator expression', () => {
  test('read: refused, rather than every stream disclosed', async () => {
    const { journal } = await twoStreams();
    const outcome = await outcomeOf(journal.read(everyStream, 1));

    // The unguarded tree answers this with three events from two ids.
    const disclosed = outcome.kind === 'answered' ? outcome.value.map((event) => event.persistenceId) : [];
    expect(disclosed).toEqual([]);
    // …and "nothing disclosed" alone would also be satisfied by a fix that
    // quietly matched nothing.  A wrong id is an error, not an empty stream.
    expectRefusal(outcome, 'read');
    await journal.close();
  });

  test('delete: refused, rather than every stream emptied and another mark raised', async () => {
    const { client, journal } = await twoStreams();
    // A legitimate compaction first, so `account-2` has a high-water mark a
    // broadened `$max` upsert could reach.
    await journal.delete('account-2', 1);
    const issuedBefore = client.log.length;

    expectRefusal(await outcomeOf(journal.delete(everyStream, 99)), 'delete');

    // Nothing left the guard: no `deleteMany`, no `updateOne` on the mark.
    expect(client.log.slice(issuedBefore)).toEqual([]);
    // The unguarded tree emptied both streams here…
    expect((await journal.read<string>('account-1', 1)).map((event) => event.event)).toEqual(['a1', 'a2']);
    // …and its `{ _id: { $gte: '' } }` upsert matched `account-2`'s mark and
    // raised it to 99, which is the second destruction: every later append
    // to that stream would fail its concurrency check.
    expect(await journal.highestSeq('account-2')).toBe(1);
    await journal.close();
  });

  test('highestSeq and raiseCompactionMark: the two other id-taking paths refuse it too', async () => {
    const { journal } = await twoStreams();
    await journal.delete('account-2', 1);

    // Unguarded, `highestSeq` answered 2 — the head of *some* stream.
    expectRefusal(await outcomeOf(journal.highestSeq(everyStream)), 'highestSeq');
    // Unguarded, this raised `account-2`'s mark to 50 through the same
    // `{ _id: <operator> }` upsert `delete` ends with.
    expectRefusal(await outcomeOf(journal.raiseCompactionMark(everyStream, 50)), 'raiseCompactionMark');
    expect(await journal.highestSeq('account-2')).toBe(1);
    await journal.close();
  });

  test('every non-string is refused, with its runtime type named', async () => {
    // `{ $gte: '' }` is the dangerous shape, but the contract is the type: an
    // `undefined` id (the "forgot to fill it in" case the validator names)
    // reads as an empty stream on the unguarded tree, which is a wrong answer
    // dressed as a fact.
    const { journal } = await twoStreams();
    const messageFor = async (value: unknown): Promise<string> => {
      const outcome = await outcomeOf(journal.read(asRequestData(value), 1));
      return outcome.kind === 'refused' ? outcome.error.message : `answered ${JSON.stringify(outcome.value)}`;
    };
    expect(await messageFor(undefined)).toMatch(/must be a string, got undefined/);
    expect(await messageFor(null)).toMatch(/must be a string, got null/);
    expect(await messageFor(42)).toMatch(/must be a string, got number/);
    expect(await messageFor(['account-1'])).toMatch(/must be a string, got array/);
    expect(await messageFor({ $in: ['account-1', 'account-2'] })).toMatch(/must be a string, got object/);
    await journal.close();
  });
});

describe('MongoQuery inherits the guard through the journal', () => {
  // `MongoQuery` overrides only the tag path; its per-id path is
  // `InMemoryQuery`'s, which bottoms out in `MongoJournal.read`.  These cases
  // hold that delegation down: an override that went to the collection
  // directly would step around the guard with every journal test still green.

  test('currentEventsByPersistenceId: refused, nothing disclosed', async () => {
    const { journal } = await twoStreams();
    const query = new MongoQuery(journal);
    const outcome = await outcomeOf(query.currentEventsByPersistenceId(everyStream, 1));
    const disclosed = outcome.kind === 'answered' ? outcome.value.map((event) => event.persistenceId) : [];
    expect(disclosed).toEqual([]);
    expectRefusal(outcome, 'read');
    // The id it can serve still works, so the guard has not shut the door.
    const own = await query.currentEventsByPersistenceId<string>('account-1', 1);
    expect(own.map((event) => event.event)).toEqual(['a1', 'a2']);
    await journal.close();
  });

  test('eventsByPersistenceId: the first pull is refused, and the stream is released', async () => {
    // One `next()` and then `return()`, deliberately: on the unguarded tree
    // the stream yields the other stream's events and then polls forever, and
    // a bare `for await` would sit on bun's per-test cap instead of failing.
    // The pull is capped inside the fixture for the other wrong shape — a
    // guard that answered "no events" instead of refusing leaves it polling
    // an empty stream, and the cap has to name that rather than time out.
    const { journal } = await twoStreams();
    const query = new MongoQuery(journal);
    const stream = query.eventsByPersistenceId<string>(everyStream, 1)[Symbol.asyncIterator]();
    let first: Outcome<IteratorResult<PersistentEvent<string>>>;
    try {
      first = await assertCompletesWithin(
        outcomeOf(stream.next()),
        1_000,
        'the first pull settles — refused, not polling an empty answer',
      );
    } finally {
      await stream.return?.();
    }

    const disclosed = first.kind === 'answered' && !first.value.done ? [first.value.value.persistenceId] : [];
    expect(disclosed).toEqual([]);
    expectRefusal(first, 'read');
    await journal.close();
  });
});

describe('the guard checks the type and nothing else', () => {
  test('a stream stored under a legacy id stays readable and compactable', async () => {
    // `assertValidPersistenceId` promises that only writes are held to the id
    // rules, so data stored under an id those rules would refuse today is
    // still reachable.  A read-side call of the full validator would honour
    // the letter of "guard the read path" and break that promise.
    const client = new FakeMongoClient();
    const journal = new MongoJournal(MongoJournalOptions.create().withClient(client));
    const legacyId = 'legacy/stream';   // a path separator — refused on append since #133
    const { events } = await journal.openForQuery();
    await events.insertOne({ persistenceId: legacyId, sequenceNr: 1, payload: encodePayload('old'), timestamp: 1 });
    await events.insertOne({ persistenceId: legacyId, sequenceNr: 2, payload: encodePayload('older'), timestamp: 2 });

    expect((await journal.read<string>(legacyId, 1)).map((event) => event.event)).toEqual(['old', 'older']);
    expect(await journal.highestSeq(legacyId)).toBe(2);
    await journal.delete(legacyId, 1);
    expect((await journal.read<string>(legacyId, 1)).map((event) => event.event)).toEqual(['older']);
    await journal.raiseCompactionMark(legacyId, 2);
    expect(await journal.highestSeq(legacyId)).toBe(2);
    // The write side is untouched: the same id is still refused there.
    await expect(journal.append(legacyId, [{ event: 'new' }], 2)).rejects.toThrow(/path separator/);
    await journal.close();
  });
});
