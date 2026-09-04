import type { Serializer } from '../../serialization/Serializer.js';
import { DEFAULT_AUTO_CREATE_TABLES, STORAGE_IDENTITY_TABLE } from '../Constants.js';
import { JournalError } from '../JournalTypes.js';
import { LazyStore, type LazyStoreConfig } from '../LazyStore.js';
import type { StorageLocality } from '../StorageLocality.js';
import { expandPlaceholders, type SqlDialect } from './SqlDialect.js';
import type { SqlPool } from './SqlPool.js';

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

  protected async prepare(pool: SqlPool): Promise<void> {
    if (!this.autoCreate) return;
    for (const statement of this.ddl()) await pool.query(statement);
  }

  protected async release(pool: SqlPool): Promise<void> {
    await pool.end();
  }
}
