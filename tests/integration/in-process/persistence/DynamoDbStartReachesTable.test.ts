import { describe, expect, test } from 'bun:test';
import {
  DynamoDbDurableStateStore,
  DynamoDbDurableStateStoreOptions,
  DynamoDbJournal,
  DynamoDbJournalOptions,
  DynamoDbSnapshotStore,
  DynamoDbSnapshotStoreOptions,
  JournalError,
} from '../../../../src/persistence/index.js';
import type {
  DynamoDbBatchWriteResult,
  DynamoDbGetResult,
  DynamoDbOperations,
  DynamoDbQueryResult,
  DynamoDbTableDescription,
} from '../../../../src/persistence/journals/DynamoDbClient.js';

/**
 * A DynamoDB store's open reaches its table when auto-create-tables is off
 * (#1473).
 *
 * `start()` — the boot-time open a selected store runs — promises that a
 * backend the node cannot reach fails the startup rather than the first
 * persisted message.  With auto-create-tables on, `CreateTable` and the wait
 * for `ACTIVE` are that round trip.  With it off — tables provisioned by the
 * operator — the open sent nothing, so `start()` resolved against an endpoint
 * that refused every call, and against a table that did not exist.  The open
 * now describes the store's own table once, and its failure fails the open,
 * naming the store.
 *
 * The backend here is a recorder that refuses every call while it is told to,
 * so what each open attempts is visible, not just whether it failed.
 */

const REFUSED = 'connect ECONNREFUSED 127.0.0.1:8000';

/** Every call a store makes, with the table it names, refused with `refusal` while it is set. */
class RecordingOperations implements DynamoDbOperations {
  readonly calls: string[] = [];
  /** Tables `DescribeTable` and the item calls find; every other name is missing. */
  readonly tables = new Set<string>();

  constructor(public refusal: Error | null = null) {}

  private async attempt<TAnswer>(operation: string, input: Record<string, unknown>, answer: TAnswer): Promise<TAnswer> {
    this.calls.push(`${operation} ${String(input['TableName'] ?? '')}`.trim());
    if (this.refusal !== null) throw this.refusal;
    return answer;
  }

  putItem(input: Record<string, unknown>): Promise<unknown> { return this.attempt('putItem', input, {}); }
  getItem(input: Record<string, unknown>): Promise<DynamoDbGetResult> { return this.attempt('getItem', input, {}); }
  query(input: Record<string, unknown>): Promise<DynamoDbQueryResult> { return this.attempt('query', input, { Items: [] }); }
  scan(input: Record<string, unknown>): Promise<DynamoDbQueryResult> { return this.attempt('scan', input, { Items: [] }); }
  updateItem(input: Record<string, unknown>): Promise<unknown> { return this.attempt('updateItem', input, {}); }
  deleteItem(input: Record<string, unknown>): Promise<unknown> { return this.attempt('deleteItem', input, {}); }
  batchWriteItem(input: Record<string, unknown>): Promise<DynamoDbBatchWriteResult> { return this.attempt('batchWriteItem', input, {}); }
  transactWriteItems(input: Record<string, unknown>): Promise<unknown> { return this.attempt('transactWriteItems', input, {}); }

  async createTable(input: Record<string, unknown>): Promise<unknown> {
    const answer = await this.attempt('createTable', input, {});
    this.tables.add(String(input['TableName']));
    return answer;
  }

  async describeTable(input: Record<string, unknown>): Promise<DynamoDbTableDescription> {
    const answer = await this.attempt('describeTable', input, { Table: { TableStatus: 'ACTIVE' } });
    const table = String(input['TableName']);
    if (!this.tables.has(table)) throw new TableNotFound(table);
    return answer;
  }

  async close(): Promise<void> {}
}

/** What DynamoDB answers `DescribeTable` with for a table that does not exist. */
class TableNotFound extends Error {
  readonly name = 'ResourceNotFoundException';
  constructor(table: string) { super(`Requested resource not found: Table: ${table} not found`); }
}

/** What a case hands back: the store, and one read that reaches the backend through it. */
type OpenedStore = {
  readonly store: { start(): Promise<void>; close(): Promise<void> };
  readonly operate: () => Promise<unknown>;
};

type StoreCase = {
  readonly label: string;
  readonly table: string;
  readonly open: (operations: DynamoDbOperations, autoCreateTables: boolean) => OpenedStore;
};

const storeCases: StoreCase[] = [
  {
    label: 'DynamoDbJournal',
    table: 'ledger_events',
    open: (operations, autoCreateTables) => {
      const journalOptions = DynamoDbJournalOptions.create()
        .withOperations(operations)
        .withEventsTable('ledger_events')
        .withAutoCreateTables(autoCreateTables);
      const store = new DynamoDbJournal(journalOptions);
      return { store, operate: () => store.highestSeq('p-1') };
    },
  },
  {
    label: 'DynamoDbSnapshotStore',
    table: 'ledger_snapshots',
    open: (operations, autoCreateTables) => {
      const snapshotStoreOptions = DynamoDbSnapshotStoreOptions.create()
        .withOperations(operations)
        .withSnapshotsTable('ledger_snapshots')
        .withAutoCreateTables(autoCreateTables);
      const store = new DynamoDbSnapshotStore(snapshotStoreOptions);
      return { store, operate: () => store.loadLatest('p-1') };
    },
  },
  {
    label: 'DynamoDbDurableStateStore',
    table: 'ledger_state',
    open: (operations, autoCreateTables) => {
      const durableStateStoreOptions = DynamoDbDurableStateStoreOptions.create()
        .withOperations(operations)
        .withTable('ledger_state')
        .withAutoCreateTables(autoCreateTables);
      const store = new DynamoDbDurableStateStore(durableStateStoreOptions);
      return { store, operate: () => store.load('p-1') };
    },
  },
];

async function rejectionOf(operation: Promise<unknown>): Promise<Error | undefined> {
  try {
    await operation;
    return undefined;
  } catch (error) {
    return error as Error;
  }
}

const countOf = (calls: ReadonlyArray<string>, call: string): number => calls.filter((each) => each === call).length;

describe('a DynamoDB store reaches its table when it opens with auto-create-tables off (#1473)', () => {
  test.each(storeCases)(
    '$label: over an endpoint that refuses every call, start() rejects, naming the store',
    async ({ label, table, open }) => {
      const operations = new RecordingOperations(new Error(REFUSED));
      const { store } = open(operations, false);

      const error = await rejectionOf(store.start());

      expect(error?.message ?? 'resolved').toBe(`${label}.open failed: ${REFUSED}`);
      expect(error).toBeInstanceOf(JournalError);
      expect((error as JournalError).cause).toBe(operations.refusal);
      // One call was attempted: the description of the store's own table.
      expect(operations.calls).toEqual([`describeTable ${table}`]);
      await store.close();
    },
  );

  test.each(storeCases)(
    '$label: a table that does not exist fails start(), naming the store and the table',
    async ({ label, table, open }) => {
      const operations = new RecordingOperations();
      const { store } = open(operations, false);

      const error = await rejectionOf(store.start());

      expect(error).toBeInstanceOf(JournalError);
      expect(error?.message ?? 'resolved').toStartWith(`${label}.open failed: `);
      expect(error?.message).toContain(table);
      expect(error?.message).toContain('autoCreateTables');
      expect(operations.calls).toEqual([`describeTable ${table}`]);
      await store.close();
    },
  );

  test.each(storeCases)(
    '$label: the open costs one DescribeTable, and neither a second start() nor an operation repeats it',
    async ({ table, open }) => {
      const operations = new RecordingOperations();
      operations.tables.add(table);
      const { store, operate } = open(operations, false);

      await store.start();
      expect(operations.calls).toEqual([`describeTable ${table}`]);

      await store.start();
      expect(operations.calls).toEqual([`describeTable ${table}`]);

      await operate();
      // The read reached the backend, so "no further description" is measured
      // against real traffic rather than against silence.
      expect(operations.calls.length).toBeGreaterThan(1);
      expect(countOf(operations.calls, `describeTable ${table}`)).toBe(1);
      await store.close();
    },
  );

  test.each(storeCases)(
    '$label: a refused open is not remembered — once the endpoint answers, the next start() describes the table again',
    async ({ label, table, open }) => {
      const operations = new RecordingOperations(new Error(REFUSED));
      operations.tables.add(table);
      const { store } = open(operations, false);

      expect((await rejectionOf(store.start()))?.message).toBe(`${label}.open failed: ${REFUSED}`);
      operations.refusal = null;
      await store.start();

      expect(operations.calls).toEqual([`describeTable ${table}`, `describeTable ${table}`]);
      await store.close();
    },
  );

  test.each(storeCases)(
    '$label: with auto-create-tables on, CreateTable and the wait for ACTIVE are the round trip, and nothing is added',
    async ({ table, open }) => {
      const operations = new RecordingOperations();
      const { store } = open(operations, true);

      await store.start();

      expect(operations.calls).toEqual([`createTable ${table}`, `describeTable ${table}`]);
      await store.close();
    },
  );
});
