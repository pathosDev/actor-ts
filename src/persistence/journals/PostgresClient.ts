import { Lazy } from '../../util/Lazy.js';
import { lazyImportModule } from '../../util/LazyImport.js';
import type { SqlPool, SqlResult } from '../relational/SqlPool.js';

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
export type PgQueryResult = {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  /** Rows affected by INSERT/UPDATE/DELETE — `null` for some statements. */
  readonly rowCount: number | null;
};

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

type PgModule = {
  Pool: new (config: Record<string, unknown>) => PgPoolLike;
};

const pgLazy: Lazy<Promise<PgModule>> = Lazy.of(
  () => lazyImportModule<PgModule>('pg', {
    context: 'The Postgres persistence backends',
    installHint: 'npm install pg',
  }),
);

/** Connection options shared by all three Postgres stores. */
export type PostgresConnection = {
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
};

/** Build (or pass through) the connection pool for a store. */
export async function buildPgPool(connection: PostgresConnection): Promise<PgPoolLike> {
  if (connection.pool) return connection.pool;
  const pg = await pgLazy.get();
  const config: Record<string, unknown> = { ...connection.poolConfig };
  if (connection.url !== undefined) config.connectionString = connection.url;
  return new pg.Pool(config);
}

/**
 * Adapt a node-postgres pool to the uniform `SqlPool` the relational stores
 * use.  `rowCount` is `null` for some statements, so it is normalized here
 * rather than at every call site.
 */
export function adaptPgPool(pool: PgPoolLike): SqlPool {
  const normalize = (result: PgQueryResult): SqlResult => ({
    rows: result.rows,
    affectedRows: result.rowCount ?? 0,
  });
  return {
    async query(sql, params) {
      return normalize(await pool.query(sql, params));
    },
    async withTransaction(body) {
      // A transaction needs a dedicated connection: `BEGIN` on a pool would
      // land on an arbitrary member and the following statements on others.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await body({
          query: async (sql, params) => normalize(await client.query(sql, params)),
        });
        await client.query('COMMIT');
        return result;
      } catch (e) {
        // Best-effort: the server may have aborted the transaction already,
        // and that failure must not mask the original error.
        try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      } finally {
        client.release();
      }
    },
    end: () => pool.end(),
  };
}

/** Test hook — reset the cached lazy `pg` import. */
export function resetPgModuleCache(): void {
  pgLazy.reset();
}
