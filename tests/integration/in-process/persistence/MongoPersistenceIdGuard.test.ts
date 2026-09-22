/**
 * Read- and delete-side `persistenceId` guard of the MongoDB stores — the
 * read-side twin of #738, found while verifying it (#1507).
 *
 * The journal came first; the snapshot store and the durable-state store carry
 * the same hole for the same reason, and the second half of #1507 closes them
 * against the one guard rather than a second spelling of it.  The three sets of
 * cases below are deliberately parallel: same fixture shape, same
 * `expectRefusal`, same "what the unguarded tree answered" comment on every
 * case, because the finding is that this is *one* defect with three doors.
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
import { JournalError, type PersistentEvent, type Snapshot } from '../../../../src/persistence/JournalTypes.js';
import type { Option } from '../../../../src/util/Option.js';
import { MongoJournal } from '../../../../src/persistence/journals/MongoJournal.js';
import { MongoJournalOptions } from '../../../../src/persistence/journals/MongoJournalOptions.js';
import { MongoSnapshotStore } from '../../../../src/persistence/snapshot-stores/MongoSnapshotStore.js';
import { MongoSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/MongoSnapshotStoreOptions.js';
import { MongoDurableStateStore } from '../../../../src/persistence/durable-state-stores/MongoDurableStateStore.js';
import {
  MongoDurableStateStoreOptions,
} from '../../../../src/persistence/durable-state-stores/MongoDurableStateStoreOptions.js';
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

/**
 * The message the guard throws, spelled out once.
 *
 * `origin` is the qualified call site (`'MongoJournal.read'`), the same shape
 * `assertValidPersistenceId` already took on the write side.
 */
const refusalMessage = (origin: string, runtimeType: string): string =>
  `Invalid persistenceId (${origin}): must be a string, got ${runtimeType} `
  + '— a non-string value reaches MongoDB as an operator expression and would select other streams';

function expectRefusal(outcome: Outcome<unknown>, origin: string, runtimeType = 'object'): void {
  expect(outcome.kind).toBe('refused');
  if (outcome.kind !== 'refused') return;
  // Asserted whole rather than matched on a substring, for two things at once.
  // The promotion out of `MongoJournal` into `PersistenceIdValidator` claims
  // the journal's messages did not change by a character, and only a whole
  // comparison carries that claim — a `toMatch` would pass over a reworded
  // tail.  It also pins that this is the guard's refusal and not the driver's
  // complaint wrapped up: the value never reached the collection, so nothing
  // could have named the operator back at us.
  expect(outcome.error.message).toBe(refusalMessage(origin, runtimeType));
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
    expectRefusal(outcome, 'MongoJournal.read');
    await journal.close();
  });

  test('delete: refused, rather than every stream emptied and another mark raised', async () => {
    const { client, journal } = await twoStreams();
    // A legitimate compaction first, so `account-2` has a high-water mark a
    // broadened `$max` upsert could reach.
    await journal.delete('account-2', 1);
    const issuedBefore = client.log.length;

    expectRefusal(await outcomeOf(journal.delete(everyStream, 99)), 'MongoJournal.delete');

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
    expectRefusal(await outcomeOf(journal.highestSeq(everyStream)), 'MongoJournal.highestSeq');
    // Unguarded, this raised `account-2`'s mark to 50 through the same
    // `{ _id: <operator> }` upsert `delete` ends with.
    expectRefusal(await outcomeOf(journal.raiseCompactionMark(everyStream, 50)), 'MongoJournal.raiseCompactionMark');
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
    expectRefusal(outcome, 'MongoJournal.read');
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
    expectRefusal(first, 'MongoJournal.read');
    await journal.close();
  });
});

/* ------------------------- the sibling stores ------------------------- */

/**
 * Two snapshot streams, so a broadened filter has a neighbour to reach.
 * `account-1` is two snapshots deep and `account-2` one, which is what makes
 * the unguarded `loadLatest` answer *wrong* rather than merely over-broad:
 * sorted descending across every stream, the collection's head belongs to
 * whoever wrote highest.  Three saves stay under the default `keepN`, so
 * pruning never removes a document an assertion below is counting on.
 */
async function twoSnapshotStreams(): Promise<{ client: FakeMongoClient; store: MongoSnapshotStore }> {
  const client = new FakeMongoClient();
  const store = new MongoSnapshotStore(MongoSnapshotStoreOptions.create().withClient(client));
  await store.save('account-1', 1, { balance: 10 });
  await store.save('account-1', 2, { balance: 20 });
  await store.save('account-2', 1, { balance: 99 });
  return { client, store };
}

/** Two entities in the state collection, so a broadened `_id` has a neighbour to reach. */
async function twoStates(): Promise<{ client: FakeMongoClient; store: MongoDurableStateStore }> {
  const client = new FakeMongoClient();
  const store = new MongoDurableStateStore(MongoDurableStateStoreOptions.create().withClient(client));
  await store.upsert('cart-1', 0, { items: 1 });
  await store.upsert('cart-2', 0, { items: 2 });
  return { client, store };
}

/** The ids an answered snapshot `Option` handed over; `[]` for a refusal. */
const snapshotIdsOf = (outcome: Outcome<Option<Snapshot<unknown>>>): string[] =>
  outcome.kind === 'answered' ? outcome.value.toArray().map((snapshot) => snapshot.persistenceId) : [];

describe('MongoSnapshotStore refuses a non-string persistenceId on the same doors', () => {
  test('loadLatest: refused, rather than the newest snapshot of whichever stream sorted highest', async () => {
    const { store } = await twoSnapshotStreams();
    const outcome = await outcomeOf(store.loadLatest<{ balance: number }>(everyStream));

    // Unguarded, this answered `account-1`'s seq-2 snapshot: the filter selects
    // every stream, the descending sort puts the collection's head first, and
    // `limit(1)` hands it to the caller as if it were their own.  A snapshot is
    // a whole aggregate state, so one document is the entire disclosure.
    expect(snapshotIdsOf(outcome)).toEqual([]);
    expectRefusal(outcome, 'MongoSnapshotStore.loadLatest');
    await store.close();
  });

  test('loadBefore: refused, rather than a neighbour stream from below the cutoff', async () => {
    const { store } = await twoSnapshotStreams();
    const outcome = await outcomeOf(store.loadBefore<{ balance: number }>(everyStream, 2));

    // `{ sequenceNr: { $lt: 2 } }` narrows the sequence and not the stream, so
    // unguarded this reached across ids exactly as `loadLatest` did.
    expect(snapshotIdsOf(outcome)).toEqual([]);
    expectRefusal(outcome, 'MongoSnapshotStore.loadBefore');
    await store.close();
  });

  test('delete: refused, rather than every snapshot in the collection removed at once', async () => {
    const { client, store } = await twoSnapshotStreams();
    const issuedBefore = client.log.length;

    expectRefusal(await outcomeOf(store.delete(everyStream, 99)), 'MongoSnapshotStore.delete');

    // Nothing left the guard: no `deleteMany` reached the collection.
    expect(client.log.slice(issuedBefore)).toEqual([]);
    // The unguarded tree emptied both streams — `{ $lte: 99 }` over every id
    // is the whole collection, and a snapshot store has no compaction mark to
    // record that it happened.
    expect((await store.loadLatest<{ balance: number }>('account-1')).toArray()).toHaveLength(1);
    expect((await store.loadLatest<{ balance: number }>('account-2')).toArray()).toHaveLength(1);
    await store.close();
  });

  test('save: refused, rather than a neighbour snapshot overwritten in place', async () => {
    // `save` sits with the reads rather than with `append`, because the id
    // reaches MongoDB in the *filter* of an upsert.  An operator expression
    // there matches an existing document of another stream and `$set` rewrites
    // its payload — and the caller is told the save succeeded, so the damage
    // surfaces later, as the victim recovering someone else's state.
    const { client, store } = await twoSnapshotStreams();
    const issuedBefore = client.log.length;

    expectRefusal(await outcomeOf(store.save(everyStream, 1, { balance: -1 })), 'MongoSnapshotStore.save');

    expect(client.log.slice(issuedBefore)).toEqual([]);
    // Unguarded, this rewrote `account-1`'s seq-1 snapshot to `{ balance: -1 }`.
    const victim = (await store.loadBefore<{ balance: number }>('account-1', 2)).toArray();
    expect(victim.map((snapshot) => snapshot.state.balance)).toEqual([10]);
    await store.close();
  });
});

describe('MongoDurableStateStore refuses a non-string persistenceId on load, delete and the upsert filter', () => {
  test('load: refused, rather than a neighbour state returned under the caller own id', async () => {
    const { store } = await twoStates();
    const outcome = await outcomeOf(store.load<{ items: number }>(everyStream));

    // The assertion is on the STATE and not on the id, and that is the finding:
    // `load` builds its record from the caller's `persistenceId` *argument* and
    // the found document's other fields, so the unguarded tree answered
    // `cart-1`'s state wearing the caller's own label.  An assertion on
    // `record.persistenceId` would have passed over the disclosure, and so
    // would any caller-side sanity check written the obvious way.
    const disclosed = outcome.kind === 'answered' ? outcome.value.toArray().map((record) => record.state) : [];
    expect(disclosed).toEqual([]);
    expectRefusal(outcome, 'MongoDurableStateStore.load');
    await store.close();
  });

  test('delete: refused, rather than whichever entity the broadened _id reached first', async () => {
    const { client, store } = await twoStates();
    const issuedBefore = client.log.length;

    expectRefusal(await outcomeOf(store.delete(everyStream)), 'MongoDurableStateStore.delete');

    expect(client.log.slice(issuedBefore)).toEqual([]);
    // Unguarded, `deleteOne` took `cart-1`.  One document rather than the
    // collection, which makes it quieter than the journal's `deleteMany` and
    // no less final: durable state keeps no event history to rebuild from.
    expect((await store.load<{ items: number }>('cart-1')).toArray()).toHaveLength(1);
    await store.close();
  });

  test('upsert: refused, rather than a neighbour rewritten through the compare-and-swap filter', async () => {
    // The revision rides in the *filter* here — that is the compare-and-swap.
    // It also means `{ _id: <operator>, revision: 1 }` matches any entity that
    // merely happens to sit at revision 1, and `$set` then replaces its payload
    // and bumps its revision.  The caller is told the write succeeded.
    const { client, store } = await twoStates();
    const issuedBefore = client.log.length;

    expectRefusal(await outcomeOf(store.upsert(everyStream, 1, { items: -1 })), 'MongoDurableStateStore.upsert');

    expect(client.log.slice(issuedBefore)).toEqual([]);
    // Unguarded, `cart-1` came back as revision 2 carrying `{ items: -1 }`.
    const victim = (await store.load<{ items: number }>('cart-1')).toArray();
    expect(victim.map((record) => ({ revision: record.revision, items: record.state.items })))
      .toEqual([{ revision: 1, items: 1 }]);
    await store.close();
  });

  test('the id is checked before the revision, so a bad id is never reported as a bad revision', async () => {
    // Both arguments are wrong here, and the order of the two checks decides
    // the diagnosis the caller gets.  `upsert` already refuses a negative
    // revision with a `JournalError` naming the revision, which would send
    // someone hunting a concurrency bug that does not exist while the id is
    // the argument that actually arrived as an object.
    const { store } = await twoStates();
    expectRefusal(await outcomeOf(store.upsert(everyStream, -1, { items: 0 })), 'MongoDurableStateStore.upsert');
    await store.close();
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

  test('the sibling stores stay open to a legacy id on every door, including their writes', async () => {
    // Same contract, and for these two it reaches further than it does for the
    // journal: neither store runs the full validator at all — the write rules
    // live one layer up, in `PersistentActor` and the durable-state options
    // validator — so promoting the type check must not quietly become the
    // store's first id validation.  `save` and `upsert` are guarded here
    // because their filters carry the id, not because writes were tightened.
    const client = new FakeMongoClient();
    const snapshots = new MongoSnapshotStore(MongoSnapshotStoreOptions.create().withClient(client));
    const states = new MongoDurableStateStore(MongoDurableStateStoreOptions.create().withClient(client));
    const legacyId = 'legacy/stream';   // a path separator — refused on append since #133

    await snapshots.save(legacyId, 1, { balance: 7 });
    expect((await snapshots.loadLatest<{ balance: number }>(legacyId)).toArray()).toHaveLength(1);
    expect((await snapshots.loadBefore<{ balance: number }>(legacyId, 2)).toArray()).toHaveLength(1);
    await snapshots.delete(legacyId, 1);
    expect((await snapshots.loadLatest<{ balance: number }>(legacyId)).toArray()).toEqual([]);

    await states.upsert(legacyId, 0, { items: 3 });
    expect((await states.load<{ items: number }>(legacyId)).toArray()).toHaveLength(1);
    await states.upsert(legacyId, 1, { items: 4 });
    await states.delete(legacyId);
    expect((await states.load<{ items: number }>(legacyId)).toArray()).toEqual([]);

    await snapshots.close();
    await states.close();
  });
});
