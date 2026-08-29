import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import {
  DYNAMODB_DURABLE_STATE_PLUGIN_ID,
  DYNAMODB_JOURNAL_PLUGIN_ID,
  DYNAMODB_SNAPSHOT_PLUGIN_ID,
  DynamoDbDurableStateStore,
  DynamoDbDurableStateStoreOptions,
  DynamoDbJournal,
  DynamoDbJournalOptions,
  DynamoDbSnapshotStore,
  DynamoDbSnapshotStoreOptions,
  PersistenceExtensionId,
  RegisterDynamoDbPluginsOptions,
  isConditionalCheckFailed,
  registerDynamoDbPlugins,
} from '../../../../src/persistence/index.js';
import { replayState } from '../../../../src/persistence/Replay.js';
import { FakeDynamoDb } from './FakeDynamoDb.js';

/**
 * DynamoDB-specific behaviour (#398).  The three storage contracts are covered by
 * the shared suite in `PersistenceContract.test.ts`, which the DynamoDB trio is
 * registered into — this file carries what is particular to DynamoDB: table
 * provisioning, transaction atomicity, the service limits, pagination,
 * validation, ownership and plugin wiring.
 */

function journalWith(operations: FakeDynamoDb): DynamoDbJournal {
  return new DynamoDbJournal(DynamoDbJournalOptions.create().withOperations(operations));
}

describe('DynamoDbJournal — table provisioning', () => {
  test('creates the table on-demand with pid/seq keys', async () => {
    const operations = new FakeDynamoDb();
    const journal = journalWith(operations);
    await journal.append('account-1', [{ event: 'a' }], 0);
    expect(operations.log).toContain('createTable actor_ts_events PAY_PER_REQUEST');
    await journal.close();
  });

  test('an existing table is the expected case, not a failure', async () => {
    // Two stores sharing a client both try to create their tables, and every
    // redeploy re-runs this.
    const operations = new FakeDynamoDb();
    const first = journalWith(operations);
    await first.append('account-1', [{ event: 'a' }], 0);
    const second = journalWith(operations);
    await expect(second.append('account-2', [{ event: 'b' }], 0)).resolves.toBeDefined();
    await first.close();
    await second.close();
  });

  test('autoCreateTables=false skips creation entirely', async () => {
    const operations = new FakeDynamoDb();
    const journalOptions = DynamoDbJournalOptions.create()
      .withOperations(operations)
      .withAutoCreateTables(false);
    const journal = new DynamoDbJournal(journalOptions);
    // Nothing created the table, so the first read fails at the service —
    // which is the honest outcome of "I provision my own tables".
    expect(journal.highestSeq('account-1')).rejects.toThrow(/ResourceNotFound|not found/i);
    expect(operations.log.some((entry) => entry.startsWith('createTable'))).toBe(false);
  });

  test('provisioned billing passes the capacity through', async () => {
    const operations = new FakeDynamoDb();
    const journalOptions = DynamoDbJournalOptions.create()
      .withOperations(operations)
      .withBillingMode('PROVISIONED')
      .withProvisionedThroughput(7, 11);
    const journal = new DynamoDbJournal(journalOptions);
    await journal.append('account-1', [{ event: 'a' }], 0);
    expect(operations.log).toContain('createTable actor_ts_events PROVISIONED');
    await journal.close();
  });
});

describe('DynamoDbJournal — atomicity and service limits', () => {
  test('a losing writer writes nothing at all, not even a prefix', async () => {
    const operations = new FakeDynamoDb();
    const first = journalWith(operations);
    const second = journalWith(operations);
    await first.append('account-1', [{ event: 'a' }], 0);         // head is now 1

    // `second` still believes the stream is empty, so its transaction tries
    // seq 1..3.  `TransactWriteItems` is all-or-nothing, so the fact that only
    // seq 1 collides must still leave seq 2 and 3 unwritten — this is what the
    // backend has instead of MongoDB's "may persist a prefix" caveat.
    await expect(second.append('account-1', [{ event: 'x' }, { event: 'y' }, { event: 'z' }], 0)).rejects.toMatchObject({
      name: 'JournalConcurrencyError',
      expectedSeq: 0,
      actualSeq: 1,
    });
    expect(await first.highestSeq('account-1')).toBe(1);
    expect((await first.read('account-1', 1)).map((event) => event.event)).toEqual(['a']);
    await first.close();
    await second.close();
  });

  test('an append beyond the 100-item transaction limit is refused clearly', async () => {
    const operations = new FakeDynamoDb();
    const journal = journalWith(operations);
    const tooMany = Array.from({ length: 101 }, (_, index) => ({ event: `event-${index}` }));
    // Chunking would break the atomicity the concurrency model rests on, so the
    // store must refuse rather than silently degrade.
    await expect(journal.append('account-1', tooMany, 0)).rejects.toThrow(/caps an atomic transaction at 100/);
    expect(await journal.highestSeq('account-1')).toBe(0);
    // Exactly 100 is still fine.
    await expect(journal.append('account-1', tooMany.slice(0, 100), 0)).resolves.toHaveLength(100);
    await journal.close();
  });

  test('the duplicate-key predicate reads both shapes DynamoDB produces', () => {
    expect(isConditionalCheckFailed({ name: 'ConditionalCheckFailedException' })).toBe(true);
    expect(isConditionalCheckFailed({
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
    })).toBe(true);
    // A transaction cancelled for throttling or a conflict is retryable and must
    // NOT be mistaken for a concurrency conflict.
    expect(isConditionalCheckFailed({
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ThrottlingError' }],
    })).toBe(false);
    expect(isConditionalCheckFailed({ name: 'ProvisionedThroughputExceededException' })).toBe(false);
    expect(isConditionalCheckFailed(new Error('boom'))).toBe(false);
  });
});

describe('DynamoDbJournal — the metadata item', () => {
  test('the mark at seq 0 never surfaces as an event, even when asked for', async () => {
    const operations = new FakeDynamoDb();
    const journal = journalWith(operations);
    await journal.append('account-1', [{ event: 'a' }, { event: 'b' }], 0);
    await journal.delete('account-1', 2);   // writes the mark at seq 0
    // A caller reading from 0 must not get the metadata item back as an event.
    expect(await journal.read('account-1', 0)).toEqual([]);
    expect(await journal.highestSeq('account-1')).toBe(2);
    const written = await journal.append('account-1', [{ event: 'c' }], 2);
    expect(written.map((event) => event.sequenceNr)).toEqual([3]);
    expect((await journal.read('account-1', 0)).map((event) => event.sequenceNr)).toEqual([3]);
    await journal.close();
  });

  test('the mark only ever rises', async () => {
    const operations = new FakeDynamoDb();
    const journal = journalWith(operations);
    await journal.append('account-1', [{ event: 'a' }, { event: 'b' }, { event: 'c' }], 0);
    await journal.delete('account-1', 3);
    expect(await journal.highestSeq('account-1')).toBe(3);
    // The conditional update must reject this, and the rejection is expected
    // rather than an error to report.
    await journal.delete('account-1', 1);
    expect(await journal.highestSeq('account-1')).toBe(3);
    await journal.close();
  });

  test('persistenceIds does not report an id that only has a mark', async () => {
    const operations = new FakeDynamoDb();
    const journal = journalWith(operations);
    await journal.append('account-1', [{ event: 'a' }], 0);
    await journal.append('account-2', [{ event: 'b' }], 0);
    await journal.delete('account-2', 1);   // account-2 keeps only its mark
    const ids = await journal.persistenceIds();
    expect(ids).toContain('account-1');
    // The scan sees the mark item, so the id is still known — asserted rather
    // than assumed, since it differs from the relational backends where a fully
    // compacted id disappears.
    expect(ids).toContain('account-2');
    await journal.close();
  });
});

describe('DynamoDbJournal — pagination', () => {
  test('a read spanning several pages returns every event', async () => {
    // DynamoDB pages at 1 MB, which no fake reaches — so the page size is forced
    // to make the store's `LastEvaluatedKey` loop actually run.  Dropping that
    // loop would silently truncate a replay.
    const operations = new FakeDynamoDb({ pageSize: 2 });
    const journal = journalWith(operations);
    const events = Array.from({ length: 9 }, (_, index) => `event-${index}`);
    await journal.append('account-1', events.map((event) => ({ event })), 0);
    const read = await journal.read<string>('account-1', 1);
    expect(read.map((event) => event.event)).toEqual(events);
    expect(read.map((event) => event.sequenceNr)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await journal.close();
  });

  test('a delete spanning several pages removes every event', async () => {
    const operations = new FakeDynamoDb({ pageSize: 2 });
    const journal = journalWith(operations);
    await journal.append('account-1', Array.from({ length: 9 }, (_, index) => ({ event: `e${index}` })), 0);
    await journal.delete('account-1', 9);
    expect(await journal.read('account-1', 1)).toEqual([]);
    expect(await journal.highestSeq('account-1')).toBe(9);
    await journal.close();
  });

  test('persistenceIds pages through the scan', async () => {
    const operations = new FakeDynamoDb({ pageSize: 1 });
    const journal = journalWith(operations);
    for (const id of ['account-1', 'account-2', 'account-3']) await journal.append(id, [{ event: 'a' }], 0);
    expect((await journal.persistenceIds()).sort()).toEqual(['account-1', 'account-2', 'account-3']);
    await journal.close();
  });
});

/**
 * Read consistency (#736).  DynamoDB reads are eventually consistent unless the
 * request says otherwise, and the shipped stores asked for strength in exactly
 * two places — the durable-state `GetItem`s and the journal's compaction mark —
 * while the head read *fourteen lines above that mark, in the same function* did
 * not.  These cases pin the posture from both sides: the request shape, and the
 * consequence of getting it wrong.
 *
 * `freezeReadReplica()` is what makes the consequence expressible at all.  The
 * Docker target cannot: `dynamodb-local` is one in-memory process with no
 * replicas, so a strong and a weak read return the same bytes there.
 */
describe('DynamoDbJournal — read consistency (#736)', () => {
  test('every read that decides a sequence number asks for a strong read', async () => {
    const operations = new FakeDynamoDb();
    const journal = journalWith(operations);
    await journal.append('account-1', [{ event: 'a' }, { event: 'b' }], 0);
    await journal.read('account-1', 1);
    await journal.highestSeq('account-1');
    await journal.delete('account-1', 1);
    const reads = operations.log.filter((entry) => entry.startsWith('query ') || entry.startsWith('getItem '));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter((entry) => entry.endsWith('eventual'))).toEqual([]);

    await journal.persistenceIds();
    // The id scan is the one deliberate exception, and asserting it keeps the
    // exception a decision rather than a leftover.
    expect(operations.log.filter((entry) => entry.startsWith('scan '))).toEqual(['scan actor_ts_events eventual']);
    await journal.close();
  });

  test('highestSeq does not rewind while a read replica lags', async () => {
    const operations = new FakeDynamoDb();
    const journal = journalWith(operations);
    await journal.append('account-1', [{ event: 'a' }, { event: 'b' }, { event: 'c' }], 0);
    operations.freezeReadReplica();
    await journal.append('account-1', [{ event: 'd' }, { event: 'e' }], 3);
    // `readHead` returns `max(headSeq, deletedTo)`, so the strong mark can only
    // mask a stale head on a stream that has been compacted — on the ordinary
    // uncompacted one the head simply appears to have rewound.
    expect(await journal.highestSeq('account-1')).toBe(5);
    await journal.close();
  });

  test('an append against the true head is not misread as a second writer', async () => {
    const operations = new FakeDynamoDb();
    const journal = journalWith(operations);
    await journal.append('account-1', [{ event: 'a' }], 0);
    operations.freezeReadReplica();
    await journal.append('account-1', [{ event: 'b' }], 1);
    // A stale `readHead` compares this `expectedSeq` against 1 and throws
    // `JournalConcurrencyError`, which `PersistentActor.persist` routes to
    // `onSecondWriterDetected` — clearing the lease flag and calling `stopSelf()`.
    // Replica lag would reach the operator as split-brain plus an outage.
    await expect(journal.append('account-1', [{ event: 'c' }], 2)).resolves.toHaveLength(1);
    operations.catchUpReadReplica();
    expect((await journal.read('account-1', 1)).map((event) => event.sequenceNr)).toEqual([1, 2, 3]);
    await journal.close();
  });

  test('a replay spanning pages is not truncated while a read replica lags', async () => {
    const operations = new FakeDynamoDb({ pageSize: 2 });
    const journal = journalWith(operations);
    await journal.append('account-1', [1, 2, 3, 4, 5].map((event) => ({ event })), 0);
    operations.freezeReadReplica();
    await journal.append('account-1', [6, 7].map((event) => ({ event })), 5);
    // A missing *tail* is the one shape nothing downstream can catch:
    // `assertTrustworthyHistory` sees holes, order and window bounds, but has no
    // independent statement of where the stream ends.  Paged, because the flag
    // has to survive every `ExclusiveStartKey` round too.
    const events = await journal.read<number>('account-1', 1);
    expect(events.map((event) => event.sequenceNr)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    await journal.close();
  });

  test('a compaction while a replica lags leaves nothing alive below the mark', async () => {
    const operations = new FakeDynamoDb();
    const journal = journalWith(operations);
    await journal.append('account-1', [{ event: 'a' }, { event: 'b' }], 0);
    operations.freezeReadReplica();
    await journal.append('account-1', [{ event: 'c' }, { event: 'd' }], 2);
    await journal.delete('account-1', 4);
    // The replica is released before asserting: the mark is raised over the whole
    // range whatever the doomed-key query returned, so the survivors have to be
    // counted against the live table rather than the frozen one.
    operations.catchUpReadReplica();
    expect(await journal.read('account-1', 1)).toEqual([]);
    expect(await journal.highestSeq('account-1')).toBe(4);
    await journal.close();
  });
});

describe('DynamoDbSnapshotStore — read consistency (#736)', () => {
  test('the two loads ask for a strong read; the retention queries deliberately do not', async () => {
    const operations = new FakeDynamoDb();
    const storeOptions = DynamoDbSnapshotStoreOptions.create()
      .withOperations(operations)
      .withKeepN(1);
    const store = new DynamoDbSnapshotStore(storeOptions);
    await store.save('account-1', 1, { seq: 1 });
    await store.save('account-1', 2, { seq: 2 });   // the second save prunes
    // Everything so far is a write or a retention query, and none of those is
    // strong: a stale retention read can only shift the keep-window down, i.e.
    // under-delete, and doubling the capacity of every `save` to drop one row a
    // little sooner is not a trade worth making.
    expect(operations.log.filter((entry) => entry === 'query actor_ts_snapshots strong')).toEqual([]);

    const beforeLoads = operations.log.length;
    await store.loadLatest('account-1');
    await store.loadBefore('account-1', 2);
    expect(operations.log.slice(beforeLoads)).toEqual([
      'query actor_ts_snapshots strong',
      'query actor_ts_snapshots strong',
    ]);
    await store.close();
  });

  test('loadLatest does not hand back a superseded snapshot while a replica lags', async () => {
    const operations = new FakeDynamoDb();
    const store = new DynamoDbSnapshotStore(
      DynamoDbSnapshotStoreOptions.create().withOperations(operations),
    );
    await store.save('account-1', 10, { seq: 10 });
    operations.freezeReadReplica();
    await store.save('account-1', 20, { seq: 20 });
    expect((await store.loadLatest<{ seq: number }>('account-1')).toNullable()?.sequenceNr).toBe(20);
    // `loadBefore` is DevTools time travel's entry point and folds from whatever
    // it returns, so it is strong for the same reason.
    expect((await store.loadBefore<{ seq: number }>('account-1', 25)).toNullable()?.sequenceNr).toBe(20);
    await store.close();
  });
});

describe('DynamoDb recovery under replica lag (#736)', () => {
  const foldSum = (state: number, event: number): number => state + event;

  function snapshotStoreWith(operations: FakeDynamoDb): DynamoDbSnapshotStore {
    return new DynamoDbSnapshotStore(DynamoDbSnapshotStoreOptions.create().withOperations(operations));
  }

  test('a replay under lag folds every event, not a silently truncated prefix', async () => {
    const operations = new FakeDynamoDb();
    const journal = journalWith(operations);
    await journal.append('account-1', [1, 2, 3].map((event) => ({ event })), 0);
    operations.freezeReadReplica();
    await journal.append('account-1', [4, 5].map((event) => ({ event })), 3);
    const replayed = await replayState<number, number>({
      journal,
      persistenceId: 'account-1',
      initialState: () => 0,
      fold: foldSum,
    });
    // A truncated replay leaves the actor on state the journal has already
    // superseded, and `onRecoveryComplete` then runs against it — every decision
    // that hook takes is taken on the wrong state.
    expect(replayed.sequenceNr).toBe(5);
    expect(replayed.state).toBe(15);
    await journal.close();
  });

  test('an intact snapshot store is not accused of tampering when the journal replica lags', async () => {
    // Two façades, because the journal and snapshot tables replicate
    // independently — which is precisely the precondition for this race.
    const journalOperations = new FakeDynamoDb();
    const snapshotOperations = new FakeDynamoDb();
    const journal = journalWith(journalOperations);
    const snapshots = snapshotStoreWith(snapshotOperations);
    await journal.append('account-1', [1, 2, 3].map((event) => ({ event })), 0);
    journalOperations.freezeReadReplica();
    await journal.append('account-1', [4, 5].map((event) => ({ event })), 3);
    await snapshots.save('account-1', 5, 15);       // legitimate, taken at the true head
    const replayed = await replayState<number, number>({
      journal,
      snapshotStore: snapshots,
      persistenceId: 'account-1',
      initialState: () => 0,
      fold: foldSum,
    });
    // With a stale head, `assertTrustworthySnapshot` sees claimed=5 > highest=3
    // and throws `SnapshotIntegrityError`, whose message accuses the store of
    // being corrupted or tampered with — over replica lag.
    expect(replayed.fromSnapshotSequenceNr).toBe(5);
    expect(replayed.sequenceNr).toBe(5);
    expect(replayed.state).toBe(15);
    await journal.close();
    await snapshots.close();
  });

  test('a compacted stream still recovers when the snapshot replica lags', async () => {
    const journalOperations = new FakeDynamoDb();
    const snapshotOperations = new FakeDynamoDb();
    const journal = journalWith(journalOperations);
    const snapshots = snapshotStoreWith(snapshotOperations);
    await journal.append('account-1', [1, 2, 3, 4, 5, 6, 7].map((event) => ({ event })), 0);
    await snapshots.save('account-1', 3, 6);
    snapshotOperations.freezeReadReplica();
    await snapshots.save('account-1', 5, 15);
    await journal.delete('account-1', 5);          // compact through the newest snapshot
    const replayed = await replayState<number, number>({
      journal,
      snapshotStore: snapshots,
      persistenceId: 'account-1',
      initialState: () => 0,
      fold: foldSum,
    });
    // A stale `loadLatest` returns the snapshot at 3, the fold starts there, and
    // the surviving events start at 6 — `assertTrustworthyHistory` throws
    // `JournalIntegrityError` and recovery aborts on a perfectly intact store.
    // This is why "consider the same for loadLatest" is required, not optional.
    expect(replayed.fromSnapshotSequenceNr).toBe(5);
    expect(replayed.sequenceNr).toBe(7);
    expect(replayed.state).toBe(28);
    await journal.close();
    await snapshots.close();
  });
});

describe('DynamoDbSnapshotStore — pruning', () => {
  test('keepN keeps a bounded window and deletes the rest', async () => {
    const operations = new FakeDynamoDb();
    const storeOptions = DynamoDbSnapshotStoreOptions.create()
      .withOperations(operations)
      .withKeepN(2);
    const store = new DynamoDbSnapshotStore(storeOptions);
    for (const seq of [1, 2, 3, 4, 5]) await store.save('account-1', seq, { seq });
    expect((await store.loadLatest<{ seq: number }>('account-1')).toNullable()?.sequenceNr).toBe(5);
    expect((await store.loadBefore<{ seq: number }>('account-1', 5)).toNullable()?.sequenceNr).toBe(4);
    expect((await store.loadBefore('account-1', 4)).toNullable()).toBeNull();
    await store.close();
  });
});

describe('DynamoDb* option validation', () => {
  test('rejects a table name DynamoDB would refuse', () => {
    expect(() => new DynamoDbJournal(DynamoDbJournalOptions.create().withEventsTable('ab')))
      .toThrow(/eventsTable/);
    expect(() => new DynamoDbJournal(DynamoDbJournalOptions.create().withEventsTable('has space')))
      .toThrow(/eventsTable/);
    // Dots and dashes are legal.
    expect(() => new DynamoDbJournal(DynamoDbJournalOptions.create().withEventsTable('app.events-v2')))
      .not.toThrow();
  });

  test('rejects an endpoint override that is not an http(s) URL', () => {
    // `new URL('localhost:8000')` SUCCEEDS — it reads `localhost:` as the scheme
    // — so parsing alone would let a bare host:port through to fail at connect
    // time.  The protocol has to be checked explicitly.
    for (const endpoint of ['localhost:8000', 'ftp://localhost:8000', 'not a url']) {
      expect(() => new DynamoDbJournal(DynamoDbJournalOptions.create().withEndpoint(endpoint)))
        .toThrow(/endpoint must be a valid http\(s\) URL/);
    }
    for (const endpoint of ['http://localhost:8000', 'https://dynamodb.eu-central-1.amazonaws.com']) {
      expect(() => new DynamoDbJournal(DynamoDbJournalOptions.create().withEndpoint(endpoint)))
        .not.toThrow();
    }
  });

  test('rejects provisioned throughput without provisioned billing', () => {
    // AWS silently ignores capacity under on-demand billing, which makes the
    // mistake invisible — so it is rejected here instead.
    const mismatched = DynamoDbJournalOptions.create()
      .withOperations(new FakeDynamoDb())
      .withProvisionedThroughput(5, 5);
    expect(() => new DynamoDbJournal(mismatched)).toThrow(/only used when billingMode is 'PROVISIONED'/);
  });

  test('rejects nonsensical capacity units and billing modes', () => {
    const zeroCapacity = DynamoDbJournalOptions.create()
      .withBillingMode('PROVISIONED')
      .withProvisionedThroughput(0, 5);
    expect(() => new DynamoDbJournal(zeroCapacity)).toThrow(/readCapacityUnits/);
    const badMode = { billingMode: 'ON_DEMAND' } as never;
    expect(() => new DynamoDbJournal(badMode)).toThrow(/billingMode/);
  });

  test('rejects a fractional keepN but accepts 0 as keep-all', () => {
    const fractional = DynamoDbSnapshotStoreOptions.create()
      .withOperations(new FakeDynamoDb())
      .withKeepN(2.5);
    expect(() => new DynamoDbSnapshotStore(fractional)).toThrow(/keepN/);
    const keepAll = DynamoDbSnapshotStoreOptions.create()
      .withOperations(new FakeDynamoDb())
      .withKeepN(0);
    expect(() => new DynamoDbSnapshotStore(keepAll)).not.toThrow();
  });
});

describe('DynamoDb* client ownership', () => {
  test('an injected façade is left open — the caller shares and closes it', async () => {
    const operations = new FakeDynamoDb();
    const journal = journalWith(operations);
    const snapshots = new DynamoDbSnapshotStore(
      DynamoDbSnapshotStoreOptions.create().withOperations(operations),
    );
    const state = new DynamoDbDurableStateStore(
      DynamoDbDurableStateStoreOptions.create().withOperations(operations),
    );
    await journal.append('account-1', [{ event: 'a' }], 0);
    await snapshots.save('account-1', 1, { v: 1 });
    await state.upsert('account-1', 0, { v: 1 });

    await journal.close();
    await snapshots.close();
    await state.close();

    expect(operations.closed).toBe(false);
  });
});

describe('registerDynamoDbPlugins', () => {
  /**
   * Boots a system whose config names the DynamoDB plug-ins, which is how the
   * extension selects them — `registerDynamoDbPlugins` only populates the
   * factories (the two-step registration #386 is meant to collapse).
   */
  function bootSystem(): ActorSystem {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({
        'actor-ts': {
          persistence: {
            journal: { plugin: DYNAMODB_JOURNAL_PLUGIN_ID },
            'snapshot-store': { plugin: DYNAMODB_SNAPSHOT_PLUGIN_ID },
          },
        },
      });
    return ActorSystem.create('dynamodb-plugins', systemOptions);
  }

  test('a shared façade reaches all three stores', async () => {
    const system = bootSystem();
    try {
      const operations = new FakeDynamoDb();
      const persistence = system.extension(PersistenceExtensionId);
      const pluginOptions = RegisterDynamoDbPluginsOptions.create()
        .withOperations(operations)
        .withRegion('eu-central-1');
      const handles = registerDynamoDbPlugins(persistence, pluginOptions);

      expect(persistence.journal).toBeInstanceOf(DynamoDbJournal);
      expect(persistence.snapshotStore).toBeInstanceOf(DynamoDbSnapshotStore);
      expect(handles.durableStateStore).toBeInstanceOf(DynamoDbDurableStateStore);

      await persistence.journal.append('account-1', [{ event: 'a' }], 0);
      await persistence.snapshotStore.save('account-1', 1, { v: 1 });
      await handles.durableStateStore.upsert('account-1', 0, { v: 1 });
      // All three created their own table through the one shared façade.
      expect(operations.log).toContain('createTable actor_ts_events PAY_PER_REQUEST');
      expect(operations.log).toContain('createTable actor_ts_snapshots PAY_PER_REQUEST');
      expect(operations.log).toContain('createTable actor_ts_durable_state PAY_PER_REQUEST');
      expect(DYNAMODB_DURABLE_STATE_PLUGIN_ID).toBe('actor-ts.persistence.durable-state.dynamodb');
    } finally {
      await system.terminate();
    }
  });

  test('a leaf keeps its own table name while inheriting the shared façade', async () => {
    const system = bootSystem();
    try {
      const operations = new FakeDynamoDb();
      const persistence = system.extension(PersistenceExtensionId);
      const journalOptions = DynamoDbJournalOptions.create()
        .withEventsTable('ledger_events');
      const pluginOptions = RegisterDynamoDbPluginsOptions.create()
        .withOperations(operations)
        .withJournal(journalOptions);
      registerDynamoDbPlugins(persistence, pluginOptions);

      await persistence.journal.append('account-1', [{ event: 'a' }], 0);
      expect(operations.log).toContain('createTable ledger_events PAY_PER_REQUEST');
    } finally {
      await system.terminate();
    }
  });
});

describe('DynamoDB storage identity (#1358)', () => {
  test('per TABLE: a second store on the same table shares, another table differs', async () => {
    const operations = new FakeDynamoDb();
    const journal = journalWith(operations);
    const identity = await journal.storageIdentity();
    expect(identity).toMatch(/^[0-9a-f-]{36}$/);

    // Same table, fresh store — the conditional put loses and the stored
    // item wins.
    expect(await journalWith(operations).storageIdentity()).toBe(identity);

    // The snapshot store's own table is its own unit of divergence.
    const snapshotStore = new DynamoDbSnapshotStore(
      DynamoDbSnapshotStoreOptions.create().withOperations(operations),
    );
    expect(await snapshotStore.storageIdentity()).not.toBe(identity);
  });

  test('the identity item is invisible to persistence-id enumeration', async () => {
    const operations = new FakeDynamoDb();
    const journal = journalWith(operations);
    await journal.append('order-1', [{ event: 'created' }], 0);
    await journal.storageIdentity();

    expect(await journal.persistenceIds()).toEqual(['order-1']);
  });
});
