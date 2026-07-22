import { describe, expect, test } from 'bun:test';
import {
  CassandraJournal,
  CassandraJournalOptions,
  type CassandraBatchQuery,
  type CassandraRowResult,
} from '../../../../src/persistence/index.js';
import { FakeCassandraClient } from './FakeCassandraClient.js';

type ExecuteOptions = { prepare?: boolean; consistency?: number };
type BatchOptions = { prepare?: boolean; logged?: boolean; consistency?: number };

/** Records connect() calls and the options passed to execute()/batch(). */
class SpyCassandraClient extends FakeCassandraClient {
  connectCount = 0;
  readonly executeOptions: Array<ExecuteOptions | undefined> = [];
  readonly batchOptions: Array<BatchOptions | undefined> = [];

  override async connect(): Promise<void> {
    this.connectCount++;
    await super.connect();
  }

  override async execute(
    query: string,
    params: ReadonlyArray<unknown> = [],
    options?: ExecuteOptions,
  ): Promise<CassandraRowResult> {
    this.executeOptions.push(options);
    return super.execute(query, params, options);
  }

  override async batch(queries: ReadonlyArray<CassandraBatchQuery>, options?: BatchOptions): Promise<void> {
    this.batchOptions.push(options);
    return super.batch(queries, options);
  }
}

function journalWith(client: SpyCassandraClient, consistency?: number): CassandraJournal {
  let options = CassandraJournalOptions.create()
    .withContactPoints(['fake'])
    .withKeyspace('app')
    .withClient(client);
  if (consistency !== undefined) options = options.withConsistency(consistency);
  return new CassandraJournal(options);
}

describe('CassandraJournal — start() single-flight', () => {
  test('two concurrent starts connect the client only once', async () => {
    const client = new SpyCassandraClient();
    const journal = journalWith(client);
    await Promise.all([journal.start(), journal.start(), journal.start()]);
    expect(client.connectCount).toBe(1);
  });
});

describe('CassandraJournal — consistency level is honoured', () => {
  test('configured consistency is forwarded to data-path execute() and batch() calls', async () => {
    const client = new SpyCassandraClient();
    const journal = journalWith(client, 6);
    await journal.append('acct-1', ['e1', 'e2'], 0);

    // The batch that writes the events carries the configured consistency.
    expect(client.batchOptions.length).toBeGreaterThan(0);
    for (const options of client.batchOptions) {
      expect(options?.consistency).toBe(6);
    }

    // Data-path executes (metadata upsert, all-ids index, the highest-seq read)
    // that pass options carry it too.  DDL executes pass no options and are skipped.
    const dataPathExecutes = client.executeOptions.filter((o) => o !== undefined);
    expect(dataPathExecutes.length).toBeGreaterThan(0);
    for (const options of dataPathExecutes) {
      expect(options?.consistency).toBe(6);
    }
  });

  test('without a configured consistency, no consistency option is sent', async () => {
    const client = new SpyCassandraClient();
    const journal = journalWith(client);
    await journal.append('acct-2', ['e1'], 0);
    for (const options of client.executeOptions) {
      expect(options?.consistency).toBeUndefined();
    }
    for (const options of client.batchOptions) {
      expect(options?.consistency).toBeUndefined();
    }
  });
});
