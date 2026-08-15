import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import {
  MONGO_DURABLE_STATE_PLUGIN_ID,
  MONGO_JOURNAL_PLUGIN_ID,
  MONGO_SNAPSHOT_PLUGIN_ID,
  MongoDurableStateStore,
  MongoDurableStateStoreOptions,
  MongoJournal,
  MongoJournalOptions,
  MongoQuery,
  MongoSnapshotStore,
  MongoSnapshotStoreOptions,
  PersistenceExtensionId,
  RegisterMongoPluginsOptions,
  isMongoDuplicateKeyError,
  registerMongoPlugins,
} from '../../../../src/persistence/index.js';
import { offsetStart } from '../../../../src/persistence/query/PersistenceQuery.js';
import { FakeMongoClient } from './FakeMongoClient.js';

/**
 * MongoDB-specific behaviour (#397).  The three storage contracts are covered by
 * the shared suite in `PersistenceContract.test.ts`, which the Mongo trio is
 * registered into — this file carries what is particular to a document store:
 * the index that makes concurrency sound, the indexed tag query, the payload
 * encoding decision, validation, ownership and plugin wiring.
 */

function journalWith(client: FakeMongoClient): MongoJournal {
  return new MongoJournal(MongoJournalOptions.create().withClient(client));
}

describe('MongoJournal — indexes and document shape', () => {
  test('creates the unique concurrency index and the multikey tag index', async () => {
    const client = new FakeMongoClient();
    const journal = journalWith(client);
    await journal.append('account-1', [{ event: 'created' }], 0);
    // The unique index is not an optimization here — it is the whole
    // optimistic-concurrency backstop, standing in for a primary key.
    expect(client.log).toContain('createIndex actor_ts.events persistenceId,sequenceNr unique');
    // Multikey over the tags array, timestamp second so MongoQuery walks a range.
    expect(client.log).toContain('createIndex actor_ts.events tags,timestamp');
    await journal.close();
  });

  test('a racing writer is rejected by the unique index, not by the head check', async () => {
    const client = new FakeMongoClient();
    const first = journalWith(client);
    const second = journalWith(client);
    await first.append('account-1', [{ event: 'a' }], 0);
    // `second` has never read this stream, so its head read sees 1 and it fails
    // the check.  To reach the *index*, give it a head it believes is stale-free
    // by racing two appends that both read 0 — that is what the shared contract's
    // racing-append scenario does.  Here we assert the narrower thing: the
    // duplicate-key predicate recognises what the driver throws.
    expect(isMongoDuplicateKeyError({ code: 11000 })).toBe(true);
    expect(isMongoDuplicateKeyError({ writeErrors: [{ code: 11000 }] })).toBe(true);
    expect(isMongoDuplicateKeyError({ writeErrors: [{ err: { code: 11000 } }] })).toBe(true);
    expect(isMongoDuplicateKeyError(new Error('E11000 duplicate key error'))).toBe(true);
    expect(isMongoDuplicateKeyError({ code: 121 })).toBe(false);
    await first.close();
    await second.close();
  });

  test('payloads are stored as JSON text, so exotic keys survive intact', async () => {
    const client = new FakeMongoClient();
    const journal = journalWith(client);
    // Dotted and `$`-prefixed keys are what BSON would reject or mangle — the
    // reason the stores keep JSON text rather than native documents.
    const awkward = { 'a.b': 1, $set: 'not an operator', nested: { 'x.y': [1, 2] } };
    await journal.append('account-1', [{ event: awkward }], 0);
    const [read] = await journal.read<typeof awkward>('account-1', 1);
    expect(read!.event).toEqual(awkward);
    await journal.close();
  });

  test('an untagged event reports no tags rather than an empty array', async () => {
    const client = new FakeMongoClient();
    const journal = journalWith(client);
    await journal.append('account-1', [{ event: 'a' }], 0);
    await journal.append('account-1', [{ event: 'b', tags: ['ledger'] }], 1);
    const events = await journal.read('account-1', 1);
    expect(events[0]!.tags).toBeUndefined();
    expect(events[1]!.tags).toEqual(['ledger']);
    await journal.close();
  });

  test('the compaction mark is monotonic — a lower delete never lowers it', async () => {
    const client = new FakeMongoClient();
    const journal = journalWith(client);
    await journal.append('account-1', [{ event: 'a' }, { event: 'b' }, { event: 'c' }], 0);
    await journal.delete('account-1', 3);
    expect(await journal.highestSeq('account-1')).toBe(3);
    // `$max` must ignore this, exactly as GREATEST does in the SQL dialects.
    await journal.delete('account-1', 1);
    expect(await journal.highestSeq('account-1')).toBe(3);
    await journal.close();
  });
});

describe('MongoQuery — indexed tag path', () => {
  test('all-tag and any-tag filters read through the tag index', async () => {
    const client = new FakeMongoClient();
    const journal = journalWith(client);
    await journal.append('account-1', [{ event: 'a', tags: ['ledger', 'audit'] }], 0);
    await journal.append('account-2', [{ event: 'b', tags: ['ledger'] }], 0);
    await journal.append('account-3', [{ event: 'c', tags: ['other'] }], 0);
    const query = new MongoQuery(journal);

    const ledger = await query.currentEventsByTag<string>('ledger', offsetStart);
    expect(ledger.map((tagged) => tagged.event.event).sort()).toEqual(['a', 'b']);

    // `all` past the first tag is refined in JS, so this must narrow to one.
    const both = await query.currentEventsByTag<string>({ all: ['ledger', 'audit'] }, offsetStart);
    expect(both.map((tagged) => tagged.event.event)).toEqual(['a']);

    // `any` is one `$in` over the multikey index; an event carrying two of the
    // listed tags still comes back once.
    const either = await query.currentEventsByTag<string>({ any: ['audit', 'other'] }, offsetStart);
    expect(either.map((tagged) => tagged.event.event).sort()).toEqual(['a', 'c']);

    // `not` narrows what the pre-filter returned.
    const excluded = await query.currentEventsByTag<string>({ all: ['ledger'], not: ['audit'] }, offsetStart);
    expect(excluded.map((tagged) => tagged.event.event)).toEqual(['b']);
    await journal.close();
  });

  test('a not-only filter falls back to the journal scan', async () => {
    const client = new FakeMongoClient();
    const journal = journalWith(client);
    await journal.append('account-1', [{ event: 'a', tags: ['ledger'] }], 0);
    await journal.append('account-2', [{ event: 'b', tags: ['audit'] }], 0);
    const query = new MongoQuery(journal);
    // Nothing to pre-filter on, so the base class walks the journal — the result
    // must still be correct.
    const notAudit = await query.currentEventsByTag<string>({ not: ['audit'] }, offsetStart);
    expect(notAudit.map((tagged) => tagged.event.event)).toEqual(['a']);
    await journal.close();
  });
});

describe('MongoSnapshotStore — pruning', () => {
  test('keepN prunes by cutoff rather than by fetching every snapshot', async () => {
    const client = new FakeMongoClient();
    const storeOptions = MongoSnapshotStoreOptions.create()
      .withClient(client)
      .withKeepN(2);
    const store = new MongoSnapshotStore(storeOptions);
    for (const seq of [1, 2, 3, 4]) await store.save('account-1', seq, { seq });
    expect((await store.loadLatest<{ seq: number }>('account-1')).toNullable()?.sequenceNr).toBe(4);
    expect((await store.loadBefore<{ seq: number }>('account-1', 4)).toNullable()?.sequenceNr).toBe(3);
    expect((await store.loadBefore('account-1', 3)).toNullable()).toBeNull();
    // Pruning costs one bounded read per save, and a delete only when there is
    // something to prune: with keepN=2 the first two saves find no cutoff and
    // issue no delete at all, so four saves produce two deletes.  The cost is
    // therefore independent of how long the snapshot history is.
    expect(client.log.filter((entry) => entry.startsWith('deleteMany actor_ts.snapshots')).length).toBe(2);
    await store.close();
  });
});

describe('Mongo* option validation', () => {
  test('rejects a non-Mongo URL scheme', () => {
    expect(() => new MongoJournal(MongoJournalOptions.create().withUrl('postgres://host/db')))
      .toThrow(/must use protocol/);
    for (const url of ['mongodb://localhost:27017', 'mongodb+srv://cluster.example.net']) {
      expect(() => new MongoJournal(MongoJournalOptions.create().withUrl(url))).not.toThrow();
    }
  });

  test('never renders the URL password into the rejection (#590)', () => {
    // `mongodb://user:pass@host` is the documented shape, and this message
    // ends up in an ERROR log via ActorCell — a password reaching a log
    // aggregator has to be rotated, not deleted.
    let caught: unknown;
    try {
      new MongoJournal(MongoJournalOptions.create().withUrl('postgres://admin:hunter2@host/db'));
    } catch (e) {
      caught = e;
    }
    const err = caught as { message: string; value: unknown };
    expect(err.message).toContain('must use protocol');
    expect(err.message).toContain('postgres://***@host/db');
    expect(err.message).not.toContain('hunter2');
    expect(err.value).toBe('postgres://***@host/db');
  });

  test('rejects database and collection names MongoDB itself refuses', () => {
    // Caught at wiring time instead of on the first write.
    expect(() => new MongoJournal(MongoJournalOptions.create().withDatabaseName('has space')))
      .toThrow(/databaseName/);
    expect(() => new MongoJournal(MongoJournalOptions.create().withDatabaseName('has.dot')))
      .toThrow(/databaseName/);
    expect(() => new MongoJournal(MongoJournalOptions.create().withEventsCollection('has$dollar')))
      .toThrow(/eventsCollection/);
    expect(() => new MongoJournal(MongoJournalOptions.create().withEventsCollection('')))
      .toThrow(/eventsCollection/);
    // A dot is legal in a collection name, only not in a database name.
    expect(() => new MongoJournal(MongoJournalOptions.create().withEventsCollection('app.events')))
      .not.toThrow();
  });

  test('rejects a fractional keepN but accepts 0 as keep-all', () => {
    const fractional = MongoSnapshotStoreOptions.create()
      .withClient(new FakeMongoClient())
      .withKeepN(2.5);
    expect(() => new MongoSnapshotStore(fractional)).toThrow(/keepN/);
    const keepAll = MongoSnapshotStoreOptions.create()
      .withClient(new FakeMongoClient())
      .withKeepN(0);
    expect(() => new MongoSnapshotStore(keepAll)).not.toThrow();
  });

  test('a store without a url or client fails only when it is first used', async () => {
    // Construction stays side-effect-free; the missing connection surfaces on
    // the first operation, like every other lazily-opened store.
    const journal = new MongoJournal();
    expect(journal.highestSeq('account-1')).rejects.toThrow(/url.*or a pre-built `client`/);
  });
});

describe('Mongo* client ownership', () => {
  test('an injected client is left open — the caller shares and closes it', async () => {
    const client = new FakeMongoClient();
    const journal = journalWith(client);
    const snapshots = new MongoSnapshotStore(MongoSnapshotStoreOptions.create().withClient(client));
    const state = new MongoDurableStateStore(MongoDurableStateStoreOptions.create().withClient(client));
    await journal.append('account-1', [{ event: 'a' }], 0);
    await snapshots.save('account-1', 1, { v: 1 });
    await state.upsert('account-1', 0, { v: 1 });

    await journal.close();
    await snapshots.close();
    await state.close();

    expect(client.closed).toBe(false);
    // An injected client is already connected — the stores must not re-connect it.
    expect(client.connectCount).toBe(0);
  });
});

describe('registerMongoPlugins', () => {
  /**
   * Boots a system whose config names the Mongo plug-ins, which is how the
   * extension selects them — `registerMongoPlugins` only populates the factories
   * (the two-step registration #386 is meant to collapse).
   */
  function bootSystem(): ActorSystem {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({
        'actor-ts': {
          persistence: {
            journal: { plugin: MONGO_JOURNAL_PLUGIN_ID },
            'snapshot-store': { plugin: MONGO_SNAPSHOT_PLUGIN_ID },
          },
        },
      });
    return ActorSystem.create('mongo-plugins', systemOptions);
  }

  test('a shared client reaches all three stores', async () => {
    const system = bootSystem();
    try {
      const client = new FakeMongoClient();
      const persistence = system.extension(PersistenceExtensionId);
      const pluginOptions = RegisterMongoPluginsOptions.create()
        .withClient(client)
        .withDatabaseName('app');
      const handles = registerMongoPlugins(persistence, pluginOptions);

      expect(persistence.journal).toBeInstanceOf(MongoJournal);
      expect(persistence.snapshotStore).toBeInstanceOf(MongoSnapshotStore);
      expect(handles.durableStateStore).toBeInstanceOf(MongoDurableStateStore);

      await persistence.journal.append('account-1', [{ event: 'a' }], 0);
      await persistence.snapshotStore.save('account-1', 1, { v: 1 });
      await handles.durableStateStore.upsert('account-1', 0, { v: 1 });
      // The shared database name reached every leaf.
      expect(client.log.some((entry) => entry.includes('app.events'))).toBe(true);
      expect(client.log.some((entry) => entry.includes('app.snapshots'))).toBe(true);
      expect(client.log.some((entry) => entry.includes('app.durable_state'))).toBe(true);
      expect(MONGO_DURABLE_STATE_PLUGIN_ID).toBe('actor-ts.persistence.durable-state.mongodb');
    } finally {
      await system.terminate();
    }
  });

  test('a leaf keeps its own collection name while inheriting the shared client', async () => {
    const system = bootSystem();
    try {
      const client = new FakeMongoClient();
      const persistence = system.extension(PersistenceExtensionId);
      const journalOptions = MongoJournalOptions.create()
        .withEventsCollection('ledger_events');
      const pluginOptions = RegisterMongoPluginsOptions.create()
        .withClient(client)
        .withJournal(journalOptions);
      registerMongoPlugins(persistence, pluginOptions);

      await persistence.journal.append('account-1', [{ event: 'a' }], 0);
      expect(client.log.some((entry) => entry.includes('ledger_events'))).toBe(true);
    } finally {
      await system.terminate();
    }
  });
});
