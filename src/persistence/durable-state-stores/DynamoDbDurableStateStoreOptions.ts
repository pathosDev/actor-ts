import {
  DynamoDbOptionsBuilderBase,
  DynamoDbOptionsValidatorBase,
  assertDynamoDbTableName,
  type DynamoDbOptionsBaseType,
} from '../journals/DynamoDbOptionsBase.js';

/** The durable-state table — see `DEFAULT_DYNAMODB_EVENTS_TABLE` for why it is prefixed. */
export const DEFAULT_DYNAMODB_DURABLE_STATE_TABLE = 'actor_ts_durable_state';

export interface DynamoDbDurableStateStoreOptionsType extends DynamoDbOptionsBaseType {
  /** Durable-state table name.  Default: `actor_ts_durable_state`. */
  readonly table?: string;
}

/**
 * Fluent builder for {@link DynamoDbDurableStateStoreOptionsType}:
 *
 *     new DynamoDbDurableStateStore(DynamoDbDurableStateStoreOptions.create()
 *       .withRegion('eu-central-1'))
 */
export class DynamoDbDurableStateStoreOptionsBuilder
  extends DynamoDbOptionsBuilderBase<DynamoDbDurableStateStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new DynamoDbDurableStateStoreOptionsBuilder()`. */
  static create(): DynamoDbDurableStateStoreOptionsBuilder {
    return new DynamoDbDurableStateStoreOptionsBuilder();
  }

  /** Durable-state table name.  Default: `actor_ts_durable_state`. */
  withTable(table: string): this {
    return this.set('table', table);
  }
}

/**
 * Accepted input for any DynamoDB durable-state constructor: the fluent
 * {@link DynamoDbDurableStateStoreOptionsBuilder} OR a plain
 * {@link DynamoDbDurableStateStoreOptionsType} object.
 */
export type DynamoDbDurableStateStoreOptions =
  | DynamoDbDurableStateStoreOptionsBuilder
  | Partial<DynamoDbDurableStateStoreOptionsType>;
/** Value alias so `DynamoDbDurableStateStoreOptions.create()` resolves to the builder. */
export const DynamoDbDurableStateStoreOptions = DynamoDbDurableStateStoreOptionsBuilder;

/** Connection, provisioning and table-name rules. */
export class DynamoDbDurableStateStoreOptionsValidator
  extends DynamoDbOptionsValidatorBase<DynamoDbDurableStateStoreOptionsType> {
  constructor() { super('DynamoDbDurableStateStoreOptions'); }

  protected rules(s: Partial<DynamoDbDurableStateStoreOptionsType>): void {
    this.checkConnectionAndProvisioning(s);
    assertDynamoDbTableName('DynamoDbDurableStateStoreOptions', 'table', s.table);
  }
}
