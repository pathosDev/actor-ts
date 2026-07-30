import {
  DynamoDbOptionsBuilderBase,
  DynamoDbOptionsValidatorBase,
  assertDynamoDbTableName,
  type DynamoDbOptionsBaseType,
} from '../journals/DynamoDbOptionsBase.js';

export type DynamoDbSnapshotStoreOptionsType = DynamoDbOptionsBaseType & {
  /** Snapshots table name.  Default: `actor_ts_snapshots`. */
  readonly snapshotsTable?: string;
  /** How many snapshots to keep per persistence id.  Default: 3; `<= 0` keeps all. */
  readonly keepN?: number;
};

/**
 * Fluent builder for {@link DynamoDbSnapshotStoreOptionsType}:
 *
 *     new DynamoDbSnapshotStore(DynamoDbSnapshotStoreOptions.create()
 *       .withRegion('eu-central-1')
 *       .withKeepN(5))
 */
export class DynamoDbSnapshotStoreOptionsBuilder
  extends DynamoDbOptionsBuilderBase<DynamoDbSnapshotStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new DynamoDbSnapshotStoreOptionsBuilder()`. */
  static create(): DynamoDbSnapshotStoreOptionsBuilder {
    return new DynamoDbSnapshotStoreOptionsBuilder();
  }

  /** Snapshots table name.  Default: `actor_ts_snapshots`. */
  withSnapshotsTable(snapshotsTable: string): this {
    return this.set('snapshotsTable', snapshotsTable);
  }

  /** How many snapshots to keep per persistence id.  Default: 3; `<= 0` keeps all. */
  withKeepN(keepN: number): this {
    return this.set('keepN', keepN);
  }
}

/**
 * Accepted input for any DynamoDB snapshot-store constructor: the fluent
 * {@link DynamoDbSnapshotStoreOptionsBuilder} OR a plain
 * {@link DynamoDbSnapshotStoreOptionsType} object.
 */
export type DynamoDbSnapshotStoreOptions =
  | DynamoDbSnapshotStoreOptionsBuilder
  | Partial<DynamoDbSnapshotStoreOptionsType>;
/** Value alias so `DynamoDbSnapshotStoreOptions.create()` resolves to the builder. */
export const DynamoDbSnapshotStoreOptions = DynamoDbSnapshotStoreOptionsBuilder;

/**
 * `keepN` is checked as an integer rather than a positive one: zero and
 * negatives are the documented way to disable pruning, so only a fractional
 * value is a mistake.
 */
export class DynamoDbSnapshotStoreOptionsValidator
  extends DynamoDbOptionsValidatorBase<DynamoDbSnapshotStoreOptionsType> {
  constructor() { super('DynamoDbSnapshotStoreOptions'); }

  protected rules(s: Partial<DynamoDbSnapshotStoreOptionsType>): void {
    this.checkConnectionAndProvisioning(s);
    assertDynamoDbTableName('DynamoDbSnapshotStoreOptions', 'snapshotsTable', s.snapshotsTable);
    if (s.keepN !== undefined && !Number.isInteger(s.keepN)) {
      this.fail('keepN', 'must be an integer (<= 0 disables pruning)', s.keepN);
    }
  }
}
