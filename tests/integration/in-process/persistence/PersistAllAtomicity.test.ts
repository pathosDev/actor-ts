/**
 * `persistAll` against a journal that cannot append a batch atomically (#959).
 *
 * `persistAll` used to be documented as atomic on every backend.  On D1 (one
 * statement per HTTP request, no transaction), MongoDB (no transaction, so a
 * standalone `mongod` works) and Cassandra (an unlogged batch per partition)
 * it is not: a transport failure partway through commits a prefix, the caller
 * is told the whole batch failed, the callback never runs, the actor's state
 * stays *behind* the journal, and the next recovery adopts the half-batch as
 * history.  Nothing exposed which kind of journal an actor was talking to.
 *
 * Journals now declare `atomicBatchAppend`, and a multi-event `persistAll`
 * against one that declares `false` is refused before anything is written —
 * unless the system opts into the prefix risk with
 * `actor-ts.persistence.allow-non-atomic-batch-append`.  These cases pin both
 * halves on D1, staging the mid-batch failure the issue reproduced, and the
 * paths that must stay untouched: a single event, and a journal that declares
 * nothing.
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import type { D1QueryResult } from '../../../../src/persistence/journals/D1Client.js';
import {
  CassandraJournal,
  CassandraJournalOptions,
  D1Journal,
  D1JournalOptions,
  DynamoDbJournal,
  DynamoDbJournalOptions,
  InMemoryJournal,
  InMemorySnapshotStore,
  LibSqlJournal,
  LibSqlJournalOptions,
  MariaDbJournal,
  MariaDbJournalOptions,
  MongoJournal,
  MongoJournalOptions,
  MsSqlJournal,
  MsSqlJournalOptions,
  NonAtomicBatchAppendError,
  PersistenceBehaviorOptions,
  PersistenceExtensionId,
  PersistentActor,
  PostgresJournal,
  PostgresJournalOptions,
  SqliteJournal,
  SqliteJournalOptions,
  type Journal,
  type JournalEntry,
  type PersistentEvent,
} from '../../../../src/persistence/index.js';
import { FaultInjectingJournal } from '../../../../src/testkit/index.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';
import { FakeCassandraClient } from './FakeCassandraClient.js';
import { FakeD1Client } from './FakeD1Client.js';
import { FakeDynamoDb } from './FakeDynamoDb.js';
import { FakeLibSqlClient } from './FakeLibSqlClient.js';
import { FakeMariaDbPool } from './FakeMariaDbPool.js';
import { FakeMongoClient } from './FakeMongoClient.js';
import { FakeMsSqlPool } from './FakeMsSqlPool.js';
import { FakePgPool } from './FakePgPool.js';

type AddAllCommand = { readonly kind: 'addAll'; readonly values: ReadonlyArray<number> };
type ReportCommand = { readonly kind: 'report' };
type Command = AddAllCommand | ReportCommand;

type AddedEvent = { readonly kind: 'added'; readonly value: number };
type State = { readonly items: ReadonlyArray<number> };

type PersistedReport = { readonly kind: 'persisted'; readonly items: ReadonlyArray<number> };
type FailedReport = { readonly kind: 'failed'; readonly error: unknown };
type StateReport = { readonly kind: 'state'; readonly items: ReadonlyArray<number>; readonly sequenceNr: number };
type Report = PersistedReport | FailedReport | StateReport;

class Basket extends PersistentActor<Command, AddedEvent, State> {
  constructor(readonly persistenceId: string, private readonly reports: Report[]) { super(); }

  initialState(): State { return { items: [] }; }
  onEvent(state: State, event: AddedEvent): State { return { items: [...state.items, event.value] }; }

  async onCommand(state: State, command: Command): Promise<void> {
    if (command.kind === 'report') {
      this.reports.push({ kind: 'state', items: state.items, sequenceNr: this.lastSequenceNr });
      return;
    }
    const events = command.values.map((value): AddedEvent => ({ kind: 'added', value }));
    try {
      await this.persistAll(events, (next) => { this.reports.push({ kind: 'persisted', items: next.items }); });
    } catch (error) {
      this.reports.push({ kind: 'failed', error });
    }
  }
}

/** Drops the connection on the `failOnEventInsert`-th event INSERT, as the issue's reproduction did. */
class DroppingD1Client extends FakeD1Client {
  private eventInserts = 0;
  constructor(private readonly failOnEventInsert: number) { super(); }

  override async query(sql: string, params: ReadonlyArray<unknown>): Promise<D1QueryResult> {
    if (/^\s*INSERT INTO \w+\s*\(persistence_id, sequence_nr, payload, tags, timestamp\)/i.test(sql)) {
      this.eventInserts++;
      if (this.eventInserts === this.failOnEventInsert) throw new Error('connection reset by peer');
    }
    return super.query(sql, params);
  }
}

/** A third-party journal that declares nothing about batch atomicity. */
class UndeclaredJournal implements Journal {
  readonly inner = new InMemoryJournal();
  append<E = unknown>(id: string, entries: ReadonlyArray<JournalEntry<E>>, expectedSeq: number): Promise<PersistentEvent<E>[]> {
    return this.inner.append(id, entries, expectedSeq);
  }
  read<E = unknown>(id: string, fromSeq: number, toSeq?: number): Promise<PersistentEvent<E>[]> {
    return this.inner.read<E>(id, fromSeq, toSeq);
  }
  highestSeq(id: string): Promise<number> { return this.inner.highestSeq(id); }
  delete(id: string, toSeq: number): Promise<void> { return this.inner.delete(id, toSeq); }
  persistenceIds(): Promise<string[]> { return this.inner.persistenceIds(); }
}

function makeSystem(name: string, journal: Journal, behavior?: PersistenceBehaviorOptions): ActorSystem {
  const quiet = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const options = behavior === undefined ? quiet : quiet.withPersistence({ behavior });
  const system = ActorSystem.create(name, options);
  const extension = system.extension(PersistenceExtensionId);
  extension.setJournal(journal);
  extension.setSnapshotStore(new InMemorySnapshotStore());
  return system;
}

function d1Journal(client: FakeD1Client): D1Journal {
  const journalOptions = D1JournalOptions.create().withClient(client);
  return new D1Journal(journalOptions);
}

const waitFor = (reports: ReadonlyArray<Report>, count: number, label: string): Promise<void> =>
  awaitCondition(() => reports.length === count, { timeoutMs: 4_000, label });

describe('persistAll on a journal without atomic batch appends (#959)', () => {
  // Every shipped journal, declared truthfully — the capability is only worth
  // something if the three that cannot do it say so and the rest say so too.
  const declarations: ReadonlyArray<readonly [string, () => Journal, boolean]> = [
    ['InMemoryJournal', () => new InMemoryJournal(), true],
    ['SqliteJournal', () => {
      const journalOptions = SqliteJournalOptions.create().withPath(':memory:');
      return new SqliteJournal(journalOptions);
    }, true],
    ['PostgresJournal', () => {
      const journalOptions = PostgresJournalOptions.create().withPool(new FakePgPool());
      return new PostgresJournal(journalOptions);
    }, true],
    ['MariaDbJournal', () => {
      const journalOptions = MariaDbJournalOptions.create().withPool(new FakeMariaDbPool());
      return new MariaDbJournal(journalOptions);
    }, true],
    ['MsSqlJournal', () => {
      const journalOptions = MsSqlJournalOptions.create().withPool(new FakeMsSqlPool());
      return new MsSqlJournal(journalOptions);
    }, true],
    ['LibSqlJournal', () => {
      const journalOptions = LibSqlJournalOptions.create().withClient(new FakeLibSqlClient());
      return new LibSqlJournal(journalOptions);
    }, true],
    ['DynamoDbJournal', () => {
      const journalOptions = DynamoDbJournalOptions.create().withOperations(new FakeDynamoDb());
      return new DynamoDbJournal(journalOptions);
    }, true],
    ['D1Journal', () => d1Journal(new FakeD1Client()), false],
    ['MongoJournal', () => {
      const journalOptions = MongoJournalOptions.create().withClient(new FakeMongoClient());
      return new MongoJournal(journalOptions);
    }, false],
    [
      'CassandraJournal',
      () => {
        const journalOptions = CassandraJournalOptions.create()
          .withContactPoints(['fake'])
          .withKeyspace('ks')
          .withClient(new FakeCassandraClient());
        return new CassandraJournal(journalOptions);
      },
      false,
    ],
  ];

  test.each(declarations)('%s declares atomicBatchAppend truthfully', async (_name, make, expected) => {
    const journal = make();
    try {
      expect(journal.atomicBatchAppend).toBe(expected);
    } finally {
      await journal.close?.();
    }
  });

  test('the fault-injecting decorator reads the wrapped declaration through', () => {
    expect(new FaultInjectingJournal(d1Journal(new FakeD1Client())).atomicBatchAppend).toBe(false);
    expect(new FaultInjectingJournal(new InMemoryJournal()).atomicBatchAppend).toBe(true);
    expect(new FaultInjectingJournal(new UndeclaredJournal()).atomicBatchAppend).toBeUndefined();
  });

  test('a multi-event persistAll is refused before anything is written', async () => {
    const client = new FakeD1Client();
    const journal = d1Journal(client);
    const system = makeSystem('persist-all-refused', journal);
    try {
      const reports: Report[] = [];
      const basket = system.spawn(() => new Basket('basket-refused', reports), 'basket');
      basket.tell({ kind: 'addAll', values: [1, 2, 3] });
      await waitFor(reports, 1, 'the refused persistAll answered');

      const failure = reports[0] as FailedReport;
      expect(failure.kind).toBe('failed');
      expect(failure.error).toBeInstanceOf(NonAtomicBatchAppendError);
      expect((failure.error as Error).message).toContain('D1Journal');
      expect((failure.error as Error).message).toContain('allow-non-atomic-batch-append');
      expect(await journal.highestSeq('basket-refused')).toBe(0);
      expect(client.log.some((sql) => /^INSERT INTO events/i.test(sql))).toBe(false);
    } finally {
      await system.terminate();
    }
  });

  test('a batch of exactly two events is refused too — the smallest batch that can leave a prefix', async () => {
    const client = new FakeD1Client();
    const journal = d1Journal(client);
    const system = makeSystem('persist-two-refused', journal);
    try {
      const reports: Report[] = [];
      const basket = system.spawn(() => new Basket('basket-two', reports), 'basket');
      basket.tell({ kind: 'addAll', values: [1, 2] });
      await waitFor(reports, 1, 'the refused two-event persistAll answered');

      const failure = reports[0] as FailedReport;
      expect(failure.kind).toBe('failed');
      expect(failure.error).toBeInstanceOf(NonAtomicBatchAppendError);
      expect((failure.error as NonAtomicBatchAppendError).eventCount).toBe(2);
      expect(await journal.highestSeq('basket-two')).toBe(0);
    } finally {
      await system.terminate();
    }
  });

  test('a single-event persist is unaffected — it is atomic on every backend', async () => {
    const journal = d1Journal(new FakeD1Client());
    const system = makeSystem('persist-one-on-d1', journal);
    try {
      const reports: Report[] = [];
      const basket = system.spawn(() => new Basket('basket-one', reports), 'basket');
      basket.tell({ kind: 'addAll', values: [7] });
      await waitFor(reports, 1, 'the single-event persist answered');
      expect(reports[0]).toEqual({ kind: 'persisted', items: [7] });
      expect(await journal.highestSeq('basket-one')).toBe(1);
    } finally {
      await system.terminate();
    }
  });

  test('a journal that declares nothing is unknown, and unknown is never refused', async () => {
    const journal = new UndeclaredJournal();
    const system = makeSystem('persist-all-undeclared', journal);
    try {
      const reports: Report[] = [];
      const basket = system.spawn(() => new Basket('basket-undeclared', reports), 'basket');
      basket.tell({ kind: 'addAll', values: [1, 2] });
      await waitFor(reports, 1, 'the persistAll on an undeclared journal answered');
      expect(reports[0]).toEqual({ kind: 'persisted', items: [1, 2] });
    } finally {
      await system.terminate();
    }
  });

  test('opted in, a mid-batch failure commits a prefix the actor is behind — the documented outcome', async () => {
    const client = new DroppingD1Client(3);
    const journal = d1Journal(client);
    const persistenceBehavior = PersistenceBehaviorOptions.create().withAllowNonAtomicBatchAppend(true);
    const system = makeSystem('persist-all-prefix', journal, persistenceBehavior);
    try {
      const reports: Report[] = [];
      const basket = system.spawn(() => new Basket('basket-prefix', reports), 'basket');
      basket.tell({ kind: 'addAll', values: [1, 2, 3, 4, 5] });
      basket.tell({ kind: 'report' });
      await waitFor(reports, 2, 'the failed persistAll and the report answered');

      // The batch threw and its callback never ran…
      expect(reports[0]!.kind).toBe('failed');
      expect(reports.some((report) => report.kind === 'persisted')).toBe(false);
      // …the actor's state did not take the prefix…
      expect(reports[1]).toEqual({ kind: 'state', items: [], sequenceNr: 0 });
      // …while the journal committed it.
      expect((await journal.read<AddedEvent>('basket-prefix', 1)).map((event) => event.event.value)).toEqual([1, 2]);
    } finally {
      await system.terminate();
    }
  });
});
