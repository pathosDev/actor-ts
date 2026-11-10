import { describe, expect, spyOn, test } from 'bun:test';
import {
  DEFAULT_AUTO_CREATE_TABLES,
  DEFAULT_DYNAMODB_BILLING_MODE,
  DEFAULT_DYNAMODB_PROVISIONED_CAPACITY_UNITS,
  DEFAULT_DYNAMODB_TABLE_READY_TIMEOUT_MS,
} from '../../../../src/persistence/Constants.js';
import {
  DynamoDbJournal,
  DynamoDbJournalOptions,
  type DynamoDbJournalOptionsBuilder,
} from '../../../../src/persistence/index.js';
import type { DynamoDbTableDescription } from '../../../../src/persistence/journals/DynamoDbClient.js';
import { FakeDynamoDb } from './FakeDynamoDb.js';

/**
 * The provisioning a DynamoDB store applies when its options name none is the
 * provisioning the named defaults state (#1490).
 *
 * `DynamoDbStore` used to spell all four as literals — `?? true`,
 * `?? 'PAY_PER_REQUEST'`, `?? 30_000` and a capacity pair of `?? 5` — and the
 * validator spelled the billing mode a second time.  A literal of the same
 * value passes every case here too; what the cases pin is that the applied
 * value follows the constant, so a published leaf has one number to agree
 * with and a moved constant cannot leave a stale copy in force.  Each case
 * ends with the value the literal carried, which is what keeps the move from
 * being a behaviour change.
 *
 * `DynamoDbBackends.test.ts` pins the billing mode by its literal name in the
 * operation log; this file reads the whole `CreateTable` request instead,
 * because the log records neither the capacity pair nor its absence.
 */

/** `FakeDynamoDb` keeping every `CreateTable` request whole. */
class RecordingDynamoDb extends FakeDynamoDb {
  readonly created: Array<Record<string, unknown>> = [];

  override async createTable(input: Record<string, unknown>): Promise<unknown> {
    this.created.push(input);
    return super.createTable(input);
  }
}

/** `FakeDynamoDb` whose tables never leave `CREATING`; the test moves the clock on every poll. */
class NeverActiveDynamoDb extends FakeDynamoDb {
  polls = 0;

  constructor(private readonly onPoll: (poll: number) => void) {
    super();
  }

  override async describeTable(): Promise<DynamoDbTableDescription> {
    this.polls++;
    this.onPoll(this.polls);
    return { Table: { TableStatus: 'CREATING' } };
  }
}

/**
 * Open the journal's table and return what `CreateTable` was asked for.  The
 * read is only there to make the store prepare itself; with auto-create off it
 * fails on the missing table, which is the outcome that case asserts on.
 */
async function createdBy(
  operations: RecordingDynamoDb,
  journalOptions: DynamoDbJournalOptions,
): Promise<Array<Record<string, unknown>>> {
  const journal = new DynamoDbJournal(journalOptions);
  await journal.highestSeq('account-1').catch(() => undefined);
  await journal.close();
  return operations.created;
}

/**
 * The message the store gives up with, and how many times it polled first,
 * against a clock that sits one millisecond short of `timeoutMs` after the
 * first poll and exactly on it after the second.
 *
 * Exactly two polls is therefore what a deadline of `timeoutMs` produces: a
 * shorter one stops after the first, a longer one polls a third time.  The
 * third poll moves the clock past every deadline there can be, so a wrong one
 * ends the loop there instead of polling against a clock that has stopped —
 * the cap has to live here, because bun's per-test timeout fails the case and
 * leaves the poll running.  A jump to ten times `timeoutMs` was not enough:
 * an explicit 1 234 ms against a store that kept its 30 s default spun until
 * that timeout.
 */
async function giveUpAfter(
  timeoutMs: number,
  configure: (options: DynamoDbJournalOptionsBuilder) => DynamoDbJournalOptionsBuilder,
): Promise<{ message: string; polls: number }> {
  const epoch = 1_000_000;
  let now = epoch;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const operations = new NeverActiveDynamoDb((poll) => {
      if (poll === 1) now = epoch + timeoutMs - 1;
      else if (poll === 2) now = epoch + timeoutMs;
      else now = Number.MAX_SAFE_INTEGER;
    });
    const baseOptions = DynamoDbJournalOptions.create().withOperations(operations);
    const journalOptions = configure(baseOptions);
    const journal = new DynamoDbJournal(journalOptions);
    const failure = await journal.highestSeq('account-1').then(() => undefined, (e: unknown) => e);
    await journal.close();
    return { message: failure instanceof Error ? failure.message : String(failure), polls: operations.polls };
  } finally {
    clock.mockRestore();
  }
}

const throws = (construct: () => unknown): boolean => {
  try {
    construct();
    return false;
  } catch {
    return true;
  }
};

describe('DynamoDbStore — the provisioning it applies when the options name none', () => {
  test('no billing mode creates the table under the named default mode', async () => {
    const operations = new RecordingDynamoDb();
    const journalOptions = DynamoDbJournalOptions.create().withOperations(operations);
    const created = await createdBy(operations, journalOptions);
    expect(created.map((input) => input.BillingMode)).toEqual([DEFAULT_DYNAMODB_BILLING_MODE]);
    expect(DEFAULT_DYNAMODB_BILLING_MODE).toBe('PAY_PER_REQUEST');
  });

  test('PROVISIONED with no capacity pair creates the table at the named fallback, both halves', async () => {
    const operations = new RecordingDynamoDb();
    const journalOptions = DynamoDbJournalOptions.create()
      .withOperations(operations)
      .withBillingMode('PROVISIONED');
    const created = await createdBy(operations, journalOptions);
    expect(created.map((input) => input.ProvisionedThroughput)).toEqual([{
      ReadCapacityUnits: DEFAULT_DYNAMODB_PROVISIONED_CAPACITY_UNITS,
      WriteCapacityUnits: DEFAULT_DYNAMODB_PROVISIONED_CAPACITY_UNITS,
    }]);
    expect(DEFAULT_DYNAMODB_PROVISIONED_CAPACITY_UNITS).toBe(5);
  });

  test('a stated capacity pair is created as stated, not replaced by the fallback', async () => {
    const operations = new RecordingDynamoDb();
    const journalOptions = DynamoDbJournalOptions.create()
      .withOperations(operations)
      .withBillingMode('PROVISIONED')
      .withProvisionedThroughput(7, 11);
    const created = await createdBy(operations, journalOptions);
    expect(created.map((input) => input.ProvisionedThroughput))
      .toEqual([{ ReadCapacityUnits: 7, WriteCapacityUnits: 11 }]);
  });

  test('no auto-create switch creates the table exactly when the shared default says so', async () => {
    const operations = new RecordingDynamoDb();
    const journalOptions = DynamoDbJournalOptions.create().withOperations(operations);
    const created = await createdBy(operations, journalOptions);
    expect(created.length > 0).toBe(DEFAULT_AUTO_CREATE_TABLES);
    expect(DEFAULT_AUTO_CREATE_TABLES).toBe(true);
  });

  test('no table-ready timeout waits out the named default before giving up', async () => {
    const outcome = await giveUpAfter(DEFAULT_DYNAMODB_TABLE_READY_TIMEOUT_MS, (options) => options);
    expect(outcome.message).toContain(`within ${DEFAULT_DYNAMODB_TABLE_READY_TIMEOUT_MS}ms`);
    expect(outcome.polls).toBe(2);
    expect(DEFAULT_DYNAMODB_TABLE_READY_TIMEOUT_MS).toBe(30_000);
  });

  test('a stated table-ready timeout is the deadline instead of the default', async () => {
    const outcome = await giveUpAfter(1_234, (options) => options.withTableReadyTimeoutMs(1_234));
    expect(outcome.message).toContain('within 1234ms');
    expect(outcome.polls).toBe(2);
  });
});

describe('DynamoDbOptionsValidatorBase — the billing mode it assumes when none is named', () => {
  test('a capacity pair with no billing mode is refused exactly when the default mode would ignore it', () => {
    const journalOptions = DynamoDbJournalOptions.create()
      .withOperations(new RecordingDynamoDb())
      .withProvisionedThroughput(7, 11);
    // Widened on purpose: the refusal has to follow whatever the constant says,
    // and a comparison against its literal type would not compile.
    const defaultMode: string = DEFAULT_DYNAMODB_BILLING_MODE;
    expect(throws(() => new DynamoDbJournal(journalOptions))).toBe(defaultMode !== 'PROVISIONED');
  });
});
