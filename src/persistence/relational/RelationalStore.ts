import type { Serializer } from '../../serialization/Serializer.js';
import { DEFAULT_AUTO_CREATE_TABLES, STORAGE_IDENTITY_TABLE } from '../Constants.js';
import { JournalError } from '../JournalTypes.js';
import { LazyStore, type LazyStoreConfig } from '../LazyStore.js';
import type { StorageLocality } from '../StorageLocality.js';
import {
  COLLATION_SENSITIVE_COLUMNS,
  expandPlaceholders,
  isBinaryCollation,
  type SqlDialect,
} from './SqlDialect.js';
import type { SqlPool } from './SqlPool.js';

/**
 * The advisory logged once per store when the catalogue reports a
 * collation-sensitive column on a case-folding collation (#1412).
 *
 * `console.warn` for the reason `ObjectStoragePlugin.assertMasterKeyRings`
 * and `CachedSnapshotStore` give: a relational store is constructed by the
 * operator and holds no `ActorSystem`, so there is no system logger to reach,
 * and an operator-built store that is never handed to `PersistenceExtension`
 * would not be observed at all.  The stable needle is
 * `on a case-folding collation` — the live broker scenarios in
 * `tests/integration/brokers/{mariadb,mssql}/Runner.ts` filter on it, so keep
 * that phrase when the sentence around it changes.
 *
 * `offenders` is per column, deliberately: half a migration leaves `events`
 * converted and `events_tags` not, which is a different problem from "nothing
 * was ever migrated" and the only thing that tells them apart is which
 * columns came back folding (#1507).
 *
 * The error-468 clause **states its precondition rather than asserting the
 * failure**, and that is not hedging.  `someColumnsAreBinary` is true of any
 * split across this store's owned tables, and only one of those splits can
 * break a query: the one running through `RelationalQuery`'s `tags t JOIN
 * events e ON e.persistence_id = t.persistence_id`.  A schema whose `events`
 * and `events_tags` were both converted and whose `events_meta` was forgotten
 * — the realistic hand-migration miss, and one `events_meta` cannot cause,
 * since no statement in `RelationalJournal` joins two tables at all — was
 * being told flatly that its tag queries fail with 468 when they cannot.
 * Deciding that here would need to know which two owned tables a query joins,
 * which is `RelationalJournal`'s knowledge and not this base's; naming the
 * condition costs the reader one clause and is true in every case the probe
 * can produce.
 */
function foldingCollationWarning(
  storeName: string,
  dialectName: string,
  offenders: ReadonlyArray<string>,
  someColumnsAreBinary: boolean,
): string {
  return `persistence: ${storeName} found ${offenders.join(', ')} on a case-folding collation (#1412). `
    + 'Two persistence ids differing only in case or accent are one row there and two on every '
    + "other backend, so an actor started as `Alice` recovers `alice`'s events and appends into "
    + "`alice`'s stream. "
    + (someColumnsAreBinary
      ? 'Other collation-sensitive columns of this store are already binary, so the schema is '
        + 'half migrated. That matters where the split runs through a join: the tag query '
        + 'matches `persistence_id` across the events and tag tables, and there SQL Server '
        + 'refuses the query outright (error 468) while MariaDB cannot use the un-migrated '
        + 'index (#1507). '
      : '')
    + 'Run the migration on '
    + `https://actor-ts.dev/persistence/journals/${dialectName}/#migrating-an-existing-schema `
    + '— and check for already-merged streams first.  This probe is a read-only catalogue query; '
    + 'the store is working and stays working.';
}

/** Wiring every relational store needs, independent of which contract it implements. */
export interface RelationalStoreConfig extends Omit<LazyStoreConfig<SqlPool>, 'ownsResource' | 'openResource'> {
  readonly dialect: SqlDialect;
  /** Create tables on first use.  Default `true`. */
  readonly autoCreateTables?: boolean;
  /** Custom payload serializer — see `storage/StoreSerializerOptions.ts`. */
  readonly serializer?: Serializer;
  /**
   * Whether this store built the pool itself.  An injected pool — shared
   * across the journal, snapshot and durable-state stores by the register
   * helpers, or a fake in tests — is owned by the caller, and closing it here
   * would tear it out from under the siblings.
   */
  readonly ownsPool: boolean;
  /** Open the pool.  Called once, lazily, on first use. */
  openPool(): Promise<SqlPool>;
}

/**
 * The relational half of the store lifecycle: `LazyStore` handles lazy
 * connection, one-shot preparation and ownership-aware teardown, and this layer
 * adds what is specific to SQL — a dialect, and DDL as the preparation step.
 */
export abstract class RelationalStore extends LazyStore<SqlPool> {
  protected readonly dialect: SqlDialect;
  protected readonly serializer?: Serializer;
  /**
   * Every relational backend in the tree speaks to a database server any node
   * can reach — `'shared'` is the family default.  The one local-file member,
   * `SqliteDurableStateStore`, overrides it (#1356).
   */
  readonly storageLocality: StorageLocality = 'shared';
  private readonly autoCreate: boolean;

  protected constructor(config: RelationalStoreConfig) {
    super({
      storeName: config.storeName,
      ownsResource: config.ownsPool,
      openResource: () => config.openPool(),
    });
    this.dialect = config.dialect;
    this.serializer = config.serializer;
    this.autoCreate = config.autoCreateTables ?? DEFAULT_AUTO_CREATE_TABLES;
  }

  private mintedStorageIdentity: string | null = null;

  /**
   * Identity of the database behind the pool — per **database**, not per
   * store: the journal, snapshot and durable-state stores over one pool read
   * the same `storage_identity` row, which is the point (#1358).  Two nodes
   * on two databases of the same engine mint two identities, and the cluster
   * says so.  A dialect without {@link SqlDialect.storageIdentityDdl}, or an
   * operator-managed schema without the table, surfaces as a rejection the
   * caller treats as unknown.
   */
  async storageIdentity(): Promise<string> {
    if (this.mintedStorageIdentity !== null) return this.mintedStorageIdentity;
    const pool = await this.ensureOpen();
    const identityDdl = this.dialect.storageIdentityDdl;
    if (identityDdl === undefined) {
      throw new JournalError(
        `${this.storeName}.storageIdentity: dialect '${this.dialect.name}' declares no ${STORAGE_IDENTITY_TABLE} table`,
      );
    }
    if (this.autoCreate) {
      for (const statement of identityDdl(STORAGE_IDENTITY_TABLE)) await pool.query(statement);
    }
    try {
      await pool.query(
        expandPlaceholders(`INSERT INTO ${STORAGE_IDENTITY_TABLE} (singleton, identity) VALUES (?, ?)`, this.dialect),
        [1, crypto.randomUUID()],
      );
    } catch (e) {
      // Losing the insert race to a sibling store on the same database is the
      // expected path — the winner's row is the identity.
      if (!this.dialect.isDuplicateKeyError(e)) this.fail('storageIdentity', e);
    }
    const result = await pool.query(
      expandPlaceholders(`SELECT identity FROM ${STORAGE_IDENTITY_TABLE} WHERE singleton = ?`, this.dialect),
      [1],
    );
    const identity = result.rows[0]?.['identity'];
    if (typeof identity !== 'string' || identity.length === 0) {
      throw new JournalError(`${this.storeName}.storageIdentity: identity row missing after insert`);
    }
    this.mintedStorageIdentity = identity;
    return identity;
  }

  /** Statements that create this store's tables, run once when `autoCreateTables`. */
  protected abstract ddl(): string[];

  /**
   * The tables this store owns — what {@link ddl} creates, as names.
   *
   * Read by the collation probe and nothing else.  Scoping it to the store's
   * own tables is what keeps the probe cheap: the journal, snapshot and
   * durable-state stores own disjoint tables, so opening all three over one
   * database reads each table exactly once, and a probe over the whole schema
   * would read every table three times instead.
   */
  protected abstract ownedTables(): ReadonlyArray<string>;

  protected async prepare(pool: SqlPool): Promise<void> {
    if (this.autoCreate) {
      for (const statement of this.ddl()) await pool.query(statement);
    }
    await this.reportFoldingCollations(pool);
  }

  /**
   * Read this store's own tables out of the catalogue and warn when a column
   * whose comparison is load-bearing came back on a case-folding collation
   * (#1412).
   *
   * Runs inside `prepare`, which `LazyStore` calls exactly once per store
   * inside its memoized init — so this is one catalogue read per table per
   * store open, never one per operation, and it costs nothing after the first
   * call.  There is no per-pool memoisation to hang it on: `storageIdentity`'s
   * cache is an instance field too, and the broker runners build a pool per
   * store, so a `WeakMap<SqlPool, …>` would dedupe nothing a real deployment
   * does.
   *
   * **Not gated on `autoCreateTables`.**  It is a read-only catalogue query
   * that needs no DDL rights, and the population most likely to still be on
   * the server's folding default is precisely the one that manages its own
   * schema — a schema copied from the DDL this project shipped before #707.
   * The `ALTER TABLE` is run outside the framework either way, so the warning
   * is just as actionable there.
   *
   * **Unknown is not evidence.**  A catalogue that cannot be read — no
   * permission on `information_schema`, a dialect whose transport rejects the
   * statement, a table that does not exist yet — stays silent.  An advisory
   * must never be the thing that turns a working store into an outage.
   *
   * Per table, though, not per store: a denial skips the row it could not
   * read and keeps what the readable tables already said.  A grant covering
   * `events` and not `events_tags` is an ordinary shape, and returning from
   * the whole probe on the first denial discarded a finding it had already
   * made — which is the same silence #1412 exists to end, arrived at from the
   * other side.
   */
  private async reportFoldingCollations(pool: SqlPool): Promise<void> {
    const catalogueSql = this.dialect.columnCollationsSql;
    if (catalogueSql === undefined) return;
    const statement = catalogueSql();
    const folding: string[] = [];
    let someColumnsAreBinary = false;
    for (const table of this.ownedTables()) {
      let rows: ReadonlyArray<Record<string, unknown>>;
      try {
        rows = (await pool.query(statement, [table])).rows;
      } catch {
        continue;
      }
      for (const row of rows) {
        const column = row['column_name'];
        const collation = row['collation_name'];
        if (typeof column !== 'string' || !COLLATION_SENSITIVE_COLUMNS.has(column)) continue;
        if (typeof collation !== 'string' || collation.length === 0) continue;
        if (isBinaryCollation(collation)) someColumnsAreBinary = true;
        else folding.push(`${table}.${column} (${collation})`);
      }
    }
    if (folding.length === 0) return;
    console.warn(foldingCollationWarning(this.storeName, this.dialect.name, folding, someColumnsAreBinary));
  }

  protected async release(pool: SqlPool): Promise<void> {
    await pool.end();
  }
}
