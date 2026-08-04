import { StoreSerializerOptionsBuilder, type StoreSerializerOptionsBase } from '../storage/StoreSerializerOptions.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import type { MsSqlConnection, MsSqlPoolLike } from '../journals/MsSqlClient.js';

export interface MsSqlSnapshotStoreOptionsType extends MsSqlConnection, StoreSerializerOptionsBase {
  /** Snapshots table name.  Default: `snapshots`. */
  readonly snapshotsTable?: string;
  /** How many snapshots to keep per persistence id.  Default: 3; `<= 0` keeps all. */
  readonly keepN?: number;
  /** Run the guarded `CREATE TABLE` statement on first use.  Default: true. */
  readonly autoCreateTables?: boolean;
}

/**
 * Fluent builder for {@link MsSqlSnapshotStoreOptionsType}:
 *
 *     new MsSqlSnapshotStore(MsSqlSnapshotStoreOptions.create()
 *       .withPoolConfig(config)
 *       .withKeepN(5))
 */
export class MsSqlSnapshotStoreOptionsBuilder extends StoreSerializerOptionsBuilder<MsSqlSnapshotStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new MsSqlSnapshotStoreOptionsBuilder()`. */
  static create(): MsSqlSnapshotStoreOptionsBuilder {
    return new MsSqlSnapshotStoreOptionsBuilder();
  }

  /** Connection string — either the `Server=…;Database=…` or `mssql://` form. */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /** `mssql` config object (server/port/user/password/database/options/pool). */
  withPoolConfig(poolConfig: Record<string, unknown>): this {
    return this.set('poolConfig', poolConfig);
  }

  /** Pre-built pool — bypasses the lazy `mssql` import; share it across stores. */
  withPool(pool: MsSqlPoolLike): this {
    return this.set('pool', pool);
  }

  /** Snapshots table name.  Default: `snapshots`. */
  withSnapshotsTable(snapshotsTable: string): this {
    return this.set('snapshotsTable', snapshotsTable);
  }

  /** How many snapshots to keep per persistence id.  Default: 3; `<= 0` keeps all. */
  withKeepN(keepN: number): this {
    return this.set('keepN', keepN);
  }

  /** Run the guarded `CREATE TABLE` statement on first use.  Default: true. */
  withAutoCreateTables(autoCreateTables: boolean): this {
    return this.set('autoCreateTables', autoCreateTables);
  }
}

/**
 * Accepted input for any SQL Server snapshot-store constructor: the fluent
 * {@link MsSqlSnapshotStoreOptionsBuilder} OR a plain
 * {@link MsSqlSnapshotStoreOptionsType} object.
 */
export type MsSqlSnapshotStoreOptions =
  | MsSqlSnapshotStoreOptionsBuilder
  | Partial<MsSqlSnapshotStoreOptionsType>;
/** Value alias so `MsSqlSnapshotStoreOptions.create()` resolves to the builder. */
export const MsSqlSnapshotStoreOptions = MsSqlSnapshotStoreOptionsBuilder;

/**
 * `keepN` is checked as an integer rather than a positive one: zero and
 * negatives are the documented way to disable pruning, so only a fractional
 * value is a mistake.
 */
export class MsSqlSnapshotStoreOptionsValidator extends OptionsValidator<MsSqlSnapshotStoreOptionsType> {
  constructor() { super('MsSqlSnapshotStoreOptions'); }

  protected rules(s: Partial<MsSqlSnapshotStoreOptionsType>): void {
    this.nonEmptyString('url');
    this.nonEmptyString('snapshotsTable');
    if (s.keepN !== undefined && !Number.isInteger(s.keepN)) {
      this.fail('keepN', 'must be an integer (<= 0 disables pruning)', s.keepN);
    }
  }
}
