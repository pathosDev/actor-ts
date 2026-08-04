import type { Serializer } from '../../serialization/Serializer.js';
import { LazyStore, type LazyStoreConfig } from '../LazyStore.js';
import type { SqlDialect } from './SqlDialect.js';
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
  private readonly autoCreate: boolean;

  protected constructor(config: RelationalStoreConfig) {
    super({
      storeName: config.storeName,
      ownsResource: config.ownsPool,
      openResource: () => config.openPool(),
    });
    this.dialect = config.dialect;
    this.serializer = config.serializer;
    this.autoCreate = config.autoCreateTables ?? true;
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
