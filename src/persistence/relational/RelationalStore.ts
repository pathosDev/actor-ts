import { JournalError } from '../JournalTypes.js';
import type { SqlDialect } from './SqlDialect.js';
import type { SqlPool } from './SqlPool.js';

/** Wiring every relational store needs, independent of which contract it implements. */
export interface RelationalStoreConfig {
  /**
   * Concrete store name (`'PostgresJournal'`), used to prefix every error
   * message.  Errors name the store the caller actually constructed rather
   * than the shared base, which is what makes a stack-free log line useful.
   */
  readonly storeName: string;
  readonly dialect: SqlDialect;
  /** Create tables on first use.  Default `true`. */
  readonly autoCreateTables?: boolean;
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
 * Lifecycle shared by the relational journal / snapshot / durable-state
 * bases: lazy first-use initialization, optional DDL bootstrap, and
 * ownership-aware teardown.
 *
 * Construction stays synchronous and side-effect-free — `new PostgresJournal(…)`
 * must not connect — so the pool opens on the first operation and the
 * in-flight promise is memoized to keep concurrent first calls to one init.
 */
export abstract class RelationalStore {
  protected readonly dialect: SqlDialect;
  /** Concrete store name — subclasses prefix their own argument errors with it. */
  protected readonly storeName: string;
  private readonly autoCreate: boolean;
  private readonly ownsPool: boolean;
  private readonly openPool: () => Promise<SqlPool>;

  private pool: SqlPool | null = null;
  private initPromise: Promise<void> | null = null;
  private closed = false;

  protected constructor(config: RelationalStoreConfig) {
    this.storeName = config.storeName;
    this.dialect = config.dialect;
    this.autoCreate = config.autoCreateTables ?? true;
    this.ownsPool = config.ownsPool;
    this.openPool = () => config.openPool();
  }

  /** Statements that create this store's tables, run once when `autoCreateTables`. */
  protected abstract ddl(): string[];

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsPool) {
      try { await this.pool?.end(); } catch { /* teardown is best-effort */ }
    }
    this.pool = null;
  }

  protected async ensureOpen(): Promise<SqlPool> {
    if (this.closed) throw new JournalError(`${this.storeName} is closed`);
    if (this.pool) return this.pool;
    if (!this.initPromise) this.initPromise = this.init();
    await this.initPromise;
    return this.pool!;
  }

  /** Wrap a driver error as `JournalError`, naming the concrete store and method. */
  protected fail(method: string, error: unknown): never {
    throw new JournalError(`${this.storeName}.${method} failed: ${(error as Error).message}`, error);
  }

  private async init(): Promise<void> {
    const pool = await this.openPool();
    if (this.autoCreate) {
      for (const statement of this.ddl()) await pool.query(statement);
    }
    this.pool = pool;
  }
}
