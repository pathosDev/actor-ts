import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import { assertRemoteLibSqlUrl } from '../journals/LibSqlJournalOptions.js';
import type { LibSqlClientLike, LibSqlConnection } from '../journals/LibSqlClient.js';

export interface LibSqlSnapshotStoreOptionsType extends LibSqlConnection {
  /** Snapshots table name.  Default: `snapshots`. */
  readonly snapshotsTable?: string;
  /** How many snapshots to keep per persistence id.  Default: 3; `<= 0` keeps all. */
  readonly keepN?: number;
  /** Run `CREATE TABLE IF NOT EXISTS` on first use.  Default: true. */
  readonly autoCreateTables?: boolean;
}

/**
 * Fluent builder for {@link LibSqlSnapshotStoreOptionsType}:
 *
 *     new LibSqlSnapshotStore(LibSqlSnapshotStoreOptions.create()
 *       .withUrl('libsql://my-db.turso.io')
 *       .withAuthToken(process.env.TURSO_AUTH_TOKEN))
 */
export class LibSqlSnapshotStoreOptionsBuilder extends OptionsBuilder<LibSqlSnapshotStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new LibSqlSnapshotStoreOptionsBuilder()`. */
  static create(): LibSqlSnapshotStoreOptionsBuilder {
    return new LibSqlSnapshotStoreOptionsBuilder();
  }

  /** Database URL — `libsql://…` (Turso) or `http(s)://` / `ws(s)://` (self-hosted `sqld`). */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /** Turso auth token.  Omit for an unauthenticated local `sqld`. */
  withAuthToken(authToken: string): this {
    return this.set('authToken', authToken);
  }

  /** Pre-built client — bypasses the lazy `@libsql/client` import; share it across stores. */
  withClient(client: LibSqlClientLike): this {
    return this.set('client', client);
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
 * Accepted input for any libSQL-snapshot-store constructor: the fluent
 * {@link LibSqlSnapshotStoreOptionsBuilder} OR a plain
 * {@link LibSqlSnapshotStoreOptionsType} object.
 */
export type LibSqlSnapshotStoreOptions =
  | LibSqlSnapshotStoreOptionsBuilder
  | Partial<LibSqlSnapshotStoreOptionsType>;
/** Value alias so `LibSqlSnapshotStoreOptions.create()` resolves to the builder. */
export const LibSqlSnapshotStoreOptions = LibSqlSnapshotStoreOptionsBuilder;

/**
 * Same URL rule as the journal (remote schemes only), plus `keepN`.
 *
 * `keepN` is checked as an integer rather than a positive one: zero and
 * negatives are the documented way to disable pruning, so only a fractional
 * value is a mistake.
 */
export class LibSqlSnapshotStoreOptionsValidator extends OptionsValidator<LibSqlSnapshotStoreOptionsType> {
  constructor() { super('LibSqlSnapshotStoreOptions'); }

  protected rules(s: Partial<LibSqlSnapshotStoreOptionsType>): void {
    assertRemoteLibSqlUrl('LibSqlSnapshotStoreOptions', s.url);
    this.nonEmptyString('authToken');
    this.nonEmptyString('snapshotsTable');
    if (s.keepN !== undefined && !Number.isInteger(s.keepN)) {
      this.fail('keepN', 'must be an integer (<= 0 disables pruning)', s.keepN);
    }
  }
}
