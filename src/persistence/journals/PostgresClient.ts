import { Lazy } from '../../util/Lazy.js';
import { lazyImportModule } from '../../util/LazyImport.js';

/**
 * Minimal shapes of the `pg` (node-postgres) API the Postgres backends
 * use.  We deliberately define our own interfaces rather than depend on
 * `@types/pg` — the framework stays dependency-free, `pg` is an OPTIONAL
 * peer-dep loaded lazily, and tests can inject a fake pool that satisfies
 * just these methods.
 *
 * Note: node-postgres returns `BIGINT` columns as **strings** (to avoid
 * precision loss), so every numeric column the backends read is coerced
 * with `Number(...)` at the mapping boundary.
 */
export interface PgQueryResult {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  /** Rows affected by INSERT/UPDATE/DELETE — `null` for some statements. */
  readonly rowCount: number | null;
}

/** A single pooled connection — `query` + `release` back to the pool. */
export interface PgClientLike {
  query(text: string, values?: ReadonlyArray<unknown>): Promise<PgQueryResult>;
  release(): void;
}

export interface PgPoolLike {
  query(text: string, values?: ReadonlyArray<unknown>): Promise<PgQueryResult>;
  /** Check out a dedicated connection — required for multi-statement transactions. */
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

interface PgModule {
  Pool: new (config: Record<string, unknown>) => PgPoolLike;
}

const pgLazy: Lazy<Promise<PgModule>> = Lazy.of(
  () => lazyImportModule<PgModule>('pg', {
    context: 'The Postgres persistence backends require',
    installHint: 'npm install pg',
  }),
);

/** Connection options shared by all three Postgres stores. */
export interface PostgresConnection {
  /** Connection string, e.g. `postgres://user:pass@host:5432/db`. */
  readonly url?: string;
  /**
   * Extra node-postgres `Pool` config, merged over `{ connectionString:
   * url }` — e.g. `{ max: 10, ssl: { rejectUnauthorized: false } }`.
   */
  readonly poolConfig?: Record<string, unknown>;
  /**
   * Pre-built pool — bypasses the lazy `pg` import entirely.  Use to
   * share ONE pool across the journal + snapshot + durable-state stores
   * (see `registerPostgresPlugins`), or to inject a fake in tests.
   */
  readonly pool?: PgPoolLike;
}

/** Build (or pass through) the connection pool for a store. */
export async function buildPgPool(conn: PostgresConnection): Promise<PgPoolLike> {
  if (conn.pool) return conn.pool;
  const pg = await pgLazy.get();
  const config: Record<string, unknown> = { ...conn.poolConfig };
  if (conn.url !== undefined) config.connectionString = conn.url;
  return new pg.Pool(config);
}

/**
 * Guard configurable table names against SQL injection (#136).  Table
 * names come from trusted config, not user input — but a parameter bind
 * (`$1`) cannot stand in for an *identifier*, so the name is interpolated
 * into the DDL/DML string directly.  Constrain it to a safe charset so a
 * hostile/typo'd config can't smuggle SQL through the table name.
 */
export function assertSafeIdentifier(name: string, what: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `Postgres: unsafe ${what} identifier ${JSON.stringify(name)} — `
      + 'must match /^[A-Za-z_][A-Za-z0-9_]*$/.',
    );
  }
  return name;
}

/** Test hook — reset the cached lazy `pg` import. */
export function resetPgModuleCache(): void {
  pgLazy.reset();
}
