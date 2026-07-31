import { Lazy } from '../../util/Lazy.js';
import { lazyImportModule } from '../../util/LazyImport.js';
import type { SqlPool, SqlResult } from '../relational/SqlPool.js';

/**
 * Minimal shapes of the `mssql` API the SQL Server backends use.  Own
 * interfaces (no `@types/mssql`) so the framework stays dependency-free and
 * tests can inject a fake that satisfies just these methods.
 *
 * A real `mssql.ConnectionPool` satisfies `MsSqlPoolLike` structurally —
 * `request()`, `transaction()` and `close()` are all on it — so injecting one
 * needs no wrapper.
 *
 * Two shape details worth knowing: `mssql` binds **named** parameters
 * (`request.input('p1', value)`, referenced as `@p1` in the SQL, and a name may
 * be referenced more than once), and it reports `rowsAffected` as an **array**,
 * one entry per statement in the batch.
 */
export type MsSqlResult = {
  /** Rows of the first result set; absent for statements that return none. */
  readonly recordset?: ReadonlyArray<Record<string, unknown>>;
  /** One entry per statement — summed when normalizing. */
  readonly rowsAffected?: ReadonlyArray<number>;
};

export interface MsSqlRequestLike {
  /** Bind a named parameter.  `@p1` in the SQL refers to `input('p1', …)`. */
  input(name: string, value: unknown): unknown;
  query(sql: string): Promise<MsSqlResult>;
}

export interface MsSqlTransactionLike {
  begin(): Promise<unknown>;
  commit(): Promise<unknown>;
  rollback(): Promise<unknown>;
  request(): MsSqlRequestLike;
}

export interface MsSqlPoolLike {
  request(): MsSqlRequestLike;
  transaction(): MsSqlTransactionLike;
  close(): Promise<unknown>;
}

type MsSqlModule = {
  ConnectionPool: new (config: Record<string, unknown> | string) => MsSqlPoolLike & {
    connect(): Promise<MsSqlPoolLike>;
  };
};

const msSqlLazy: Lazy<Promise<MsSqlModule>> = Lazy.of(
  () => lazyImportModule<MsSqlModule>('mssql', {
    context: 'The SQL Server persistence backends',
    installHint: 'npm install mssql',
  }),
);

/** Connection options shared by all three SQL Server stores. */
export type MsSqlConnection = {
  /**
   * Connection string, e.g.
   * `Server=host,1433;Database=app;User Id=sa;Password=…;Encrypt=true`, or the
   * `mssql://user:pass@host:1433/db` URL form.
   */
  readonly url?: string;
  /**
   * `mssql` config object — `{ server, port, user, password, database,
   * options: { encrypt, trustServerCertificate }, pool: { max } }`.  Takes
   * precedence over `url`.
   */
  readonly poolConfig?: Record<string, unknown>;
  /**
   * Pre-built pool — bypasses the lazy `mssql` import entirely.  Use to share
   * ONE pool across the journal + snapshot + durable-state stores (see
   * `registerMsSqlPlugins`), or to inject a fake in tests.
   */
  readonly pool?: MsSqlPoolLike;
};

/** Build (or pass through) the connection pool for a store. */
export async function buildMsSqlPool(connection: MsSqlConnection): Promise<MsSqlPoolLike> {
  if (connection.pool) return connection.pool;
  if (connection.poolConfig === undefined && connection.url === undefined) {
    throw new Error('SQL Server persistence requires `poolConfig`, `url`, or a pre-built `pool`.');
  }
  const msSql = await msSqlLazy.get();
  const pool = new msSql.ConnectionPool(connection.poolConfig ?? connection.url!);
  // `connect()` resolves to the pool itself; awaiting it is what opens the
  // sockets, so a store's first operation fails loudly rather than hanging.
  await pool.connect();
  return pool;
}

/**
 * Adapt an `mssql` pool to the uniform `SqlPool` the relational stores use.
 *
 * The interesting part is parameter binding: every other driver takes an
 * ordered array, while `mssql` wants one `input('pN', value)` call per
 * parameter.  Mapping the array to `p1…pN` here is what lets the dialect emit
 * `@pN` and the shared statements stay unchanged — and it is also why a T-SQL
 * statement may reference the same parameter twice (the `keepN` prune and both
 * merges rely on that).
 */
export function adaptMsSqlPool(pool: MsSqlPoolLike): SqlPool {
  const run = async (request: MsSqlRequestLike, sql: string, params?: ReadonlyArray<unknown>): Promise<SqlResult> => {
    (params ?? []).forEach((value, index) => request.input(`p${index + 1}`, value));
    const result = await request.query(sql);
    return {
      rows: result.recordset ?? [],
      // `rowsAffected` is per-statement; the stores issue one statement at a
      // time, but summing is correct either way.
      affectedRows: (result.rowsAffected ?? []).reduce((total, count) => total + Number(count), 0),
    };
  };
  return {
    async query(sql, params) {
      return run(pool.request(), sql, params);
    },
    async withTransaction(body) {
      const transaction = pool.transaction();
      await transaction.begin();
      try {
        const result = await body({
          // A fresh Request per statement: `mssql` rejects re-binding a
          // parameter name on a Request that has already run.
          query: (sql, params) => run(transaction.request(), sql, params),
        });
        await transaction.commit();
        return result;
      } catch (e) {
        // Best-effort: the server may have aborted the transaction already, and
        // that failure must not mask the original error.
        try { await transaction.rollback(); } catch { /* already rolled back */ }
        throw e;
      }
    },
    async end() { await pool.close(); },
  };
}

/** Test hook — reset the cached lazy `mssql` import. */
export function resetMsSqlModuleCache(): void {
  msSqlLazy.reset();
}
