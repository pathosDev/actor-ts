import { Lazy } from '../../util/Lazy.js';
import { lazyImportModule } from '../../util/LazyImport.js';
import type { SqlPool, SqlResult } from '../relational/SqlPool.js';

/**
 * Minimal shapes of the `mariadb` connector API the MariaDB backends use.
 * Own interfaces (no `@types`) so the framework stays dependency-free and
 * tests can inject a fake.  The official `mariadb` connector speaks both
 * MariaDB and MySQL.
 *
 * `query()` returns **either** an array of row objects (SELECT) **or** an
 * OK-packet `{ affectedRows, insertId, warningStatus }` (INSERT/UPDATE/
 * DELETE) — use `rowsOf` / `affectedRowsOf` to read each shape.  BIGINT
 * columns may surface as `bigint`; every numeric read is `Number(...)`-
 * coerced at the mapping boundary.
 */
export type MariaDbRow = Record<string, unknown>;
export type MariaDbOkPacket = {
  readonly affectedRows: number | bigint;
  readonly insertId?: number | bigint;
  readonly warningStatus?: number;
};
export type MariaDbResult = MariaDbRow[] | MariaDbOkPacket;

export interface MariaDbConnectionLike {
  query(sql: string, values?: ReadonlyArray<unknown>): Promise<MariaDbResult>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export interface MariaDbPoolLike {
  query(sql: string, values?: ReadonlyArray<unknown>): Promise<MariaDbResult>;
  /** Check out a dedicated connection for a multi-statement transaction. */
  getConnection(): Promise<MariaDbConnectionLike>;
  end(): Promise<void>;
}

interface MariaDbModule {
  createPool(config: Record<string, unknown> | string): MariaDbPoolLike;
}

const mariadbLazy: Lazy<Promise<MariaDbModule>> = Lazy.of(
  () => lazyImportModule<MariaDbModule>('mariadb', {
    context: 'The MariaDB persistence backends',
    installHint: 'npm install mariadb',
  }),
);

/** Connection options shared by the three MariaDB stores. */
export type MariaDbConnection = {
  /** Connection URI passed straight to `createPool`, e.g. `mariadb://user:pass@host:3306/db`. */
  readonly url?: string;
  /**
   * `createPool` config object — e.g. `{ host, port, user, password, database,
   * ssl: { rejectUnauthorized: true, ca: fs.readFileSync('rds-ca.pem') } }`;
   * takes precedence over `url`.
   *
   * That `ssl` shape is the one to copy, and the illustration is load-bearing:
   * this doc comment is what an editor shows the moment someone asks how to
   * wire TLS here, which makes it guidance at the point of decision.  The
   * connector's `ssl` takes Node's own TLS options, so this is the same knob
   * as on Postgres.  Supply the signing CA — a managed instance publishes one
   * — rather than switching certificate verification off to make a
   * self-signed peer stop complaining.  Encryption without verification
   * authenticates nobody, so anything on the path to the database can present
   * its own certificate and read or rewrite the journal, which is the
   * application's system of record.  The object lands in
   * `mariadb.createPool(...)` verbatim; nothing filters it.
   * See https://actor-ts.dev/operations/security/tls-everywhere/.
   */
  readonly poolConfig?: Record<string, unknown>;
  /** Pre-built pool — shares one pool across the three stores, or injects a fake in tests. */
  readonly pool?: MariaDbPoolLike;
};

/** Build (or pass through) the connection pool for a store. */
export async function buildMariaDbPool(connection: MariaDbConnection): Promise<MariaDbPoolLike> {
  if (connection.pool) return connection.pool;
  const mod = await mariadbLazy.get();
  const arg: Record<string, unknown> | string = connection.poolConfig ?? connection.url ?? {};
  return mod.createPool(arg);
}

/** Rows from a SELECT result (OK-packets yield `[]`). */
export function rowsOf(response: MariaDbResult): MariaDbRow[] {
  return Array.isArray(response) ? response : [];
}

/** `affectedRows` from a DML OK-packet (arrays yield 0). */
export function affectedRowsOf(response: MariaDbResult): number {
  return Array.isArray(response) ? 0 : Number(response.affectedRows ?? 0);
}

/**
 * Adapt a `mariadb` pool to the uniform `SqlPool` the relational stores use,
 * collapsing the connector's dual result shape (row array vs OK-packet) into
 * one `SqlResult`.
 */
export function adaptMariaDbPool(pool: MariaDbPoolLike): SqlPool {
  const normalize = (response: MariaDbResult): SqlResult => ({
    rows: rowsOf(response),
    affectedRows: affectedRowsOf(response),
  });
  return {
    async query(sql, params) {
      return normalize(await pool.query(sql, params));
    },
    async withTransaction(body) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const result = await body({
          query: async (sql, params) => normalize(await connection.query(sql, params)),
        });
        await connection.commit();
        return result;
      } catch (e) {
        // Best-effort: a rollback failure must not mask the original error.
        try { await connection.rollback(); } catch { /* already rolled back */ }
        throw e;
      } finally {
        connection.release();
      }
    },
    end: () => pool.end(),
  };
}

/** Test hook — reset the cached lazy `mariadb` import. */
export function resetMariaDbModuleCache(): void {
  mariadbLazy.reset();
}
