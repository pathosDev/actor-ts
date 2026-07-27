import {
  D1OptionsBuilderBase,
  D1OptionsValidatorBase,
  type D1OptionsBaseType,
} from '../journals/D1OptionsBase.js';
import { assertSafeIdentifier } from '../storage/SqlIdentifier.js';

export interface D1SnapshotStoreOptionsType extends D1OptionsBaseType {
  /** Snapshots table name.  Default: `snapshots`. */
  readonly snapshotsTable?: string;
  /** How many snapshots to keep per persistence id.  Default: 3; `<= 0` keeps all. */
  readonly keepN?: number;
  /** Run `CREATE TABLE IF NOT EXISTS` on first use.  Default: true. */
  readonly autoCreateTables?: boolean;
}

/**
 * Fluent builder for {@link D1SnapshotStoreOptionsType}:
 *
 *     new D1SnapshotStore(D1SnapshotStoreOptions.create()
 *       .withClient(sharedTransport)
 *       .withKeepN(5))
 */
export class D1SnapshotStoreOptionsBuilder extends D1OptionsBuilderBase<D1SnapshotStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new D1SnapshotStoreOptionsBuilder()`. */
  static create(): D1SnapshotStoreOptionsBuilder {
    return new D1SnapshotStoreOptionsBuilder();
  }

  /** Snapshots table name.  Default: `snapshots`. */
  withSnapshotsTable(snapshotsTable: string): this {
    return this.set('snapshotsTable', snapshotsTable);
  }

  /** How many snapshots to keep per persistence id.  Default: 3; `<= 0` keeps all. */
  withKeepN(keepN: number): this {
    return this.set('keepN', keepN);
  }

  /** Run `CREATE TABLE IF NOT EXISTS` on first use.  Default: true. */
  withAutoCreateTables(autoCreateTables: boolean): this {
    return this.set('autoCreateTables', autoCreateTables);
  }
}

/**
 * Accepted input for any D1 snapshot-store constructor: the fluent
 * {@link D1SnapshotStoreOptionsBuilder} OR a plain
 * {@link D1SnapshotStoreOptionsType} object.
 */
export type D1SnapshotStoreOptions =
  | D1SnapshotStoreOptionsBuilder
  | Partial<D1SnapshotStoreOptionsType>;
/** Value alias so `D1SnapshotStoreOptions.create()` resolves to the builder. */
export const D1SnapshotStoreOptions = D1SnapshotStoreOptionsBuilder;

/**
 * `keepN` is checked as an integer rather than a positive one: zero and negatives
 * are the documented way to disable pruning, so only a fractional value is a
 * mistake.
 */
export class D1SnapshotStoreOptionsValidator extends D1OptionsValidatorBase<D1SnapshotStoreOptionsType> {
  constructor() { super('D1SnapshotStoreOptions'); }

  protected rules(s: Partial<D1SnapshotStoreOptionsType>): void {
    this.checkConnection(s);
    if (s.snapshotsTable !== undefined) assertSafeIdentifier(s.snapshotsTable, 'snapshots table');
    if (s.keepN !== undefined && !Number.isInteger(s.keepN)) {
      this.fail('keepN', 'must be an integer (<= 0 disables pruning)', s.keepN);
    }
  }
}
