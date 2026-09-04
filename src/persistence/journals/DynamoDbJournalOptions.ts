import {
  DynamoDbOptionsBuilderBase,
  DynamoDbOptionsValidatorBase,
  assertDynamoDbTableName,
  type DynamoDbOptionsBaseType,
} from './DynamoDbOptionsBase.js';

/**
 * Table a DynamoDB event log is written to when nothing named one.
 *
 * `actor_ts_`-prefixed rather than the bare `events` the SQL family uses, and
 * that difference is DynamoDB's rather than an oversight: a table name is
 * account- and region-global there, not scoped by a database or a schema, so an
 * unqualified `events` would collide with whatever else the account owns.
 *
 * Beside the options type rather than in `src/persistence/Constants.ts` because
 * it is the built-in default of exactly one `XOptionsType` field with exactly
 * one read site.  Named at all because `reference.conf` publishes it (#872).
 */
export const DEFAULT_DYNAMODB_EVENTS_TABLE = 'actor_ts_events';

export interface DynamoDbJournalOptionsType extends DynamoDbOptionsBaseType {
  /** Events table name.  Default: `actor_ts_events`. */
  readonly eventsTable?: string;
}

/**
 * Fluent builder for {@link DynamoDbJournalOptionsType}:
 *
 *     new DynamoDbJournal(DynamoDbJournalOptions.create()
 *       .withRegion('eu-central-1')
 *       .withEventsTable('ledger_events'))
 *
 * The connection and provisioning setters come from
 * {@link DynamoDbOptionsBuilderBase}; pass a pre-built `withOperations(...)` to
 * share ONE client across the journal, snapshot and durable-state stores.
 */
export class DynamoDbJournalOptionsBuilder extends DynamoDbOptionsBuilderBase<DynamoDbJournalOptionsType> {
  /** Start a fresh builder.  Equivalent to `new DynamoDbJournalOptionsBuilder()`. */
  static create(): DynamoDbJournalOptionsBuilder {
    return new DynamoDbJournalOptionsBuilder();
  }

  /** Events table name.  Default: `actor_ts_events`. */
  withEventsTable(eventsTable: string): this {
    return this.set('eventsTable', eventsTable);
  }
}

/**
 * Accepted input for any DynamoDB journal constructor: the fluent
 * {@link DynamoDbJournalOptionsBuilder} OR a plain
 * {@link DynamoDbJournalOptionsType} object.
 */
export type DynamoDbJournalOptions =
  | DynamoDbJournalOptionsBuilder
  | Partial<DynamoDbJournalOptionsType>;
/** Value alias so `DynamoDbJournalOptions.create()` resolves to the builder. */
export const DynamoDbJournalOptions = DynamoDbJournalOptionsBuilder;

/** Connection, provisioning and table-name rules. */
export class DynamoDbJournalOptionsValidator extends DynamoDbOptionsValidatorBase<DynamoDbJournalOptionsType> {
  constructor() { super('DynamoDbJournalOptions'); }

  protected rules(s: Partial<DynamoDbJournalOptionsType>): void {
    this.checkConnectionAndProvisioning(s);
    assertDynamoDbTableName('DynamoDbJournalOptions', 'eventsTable', s.eventsTable);
  }
}
