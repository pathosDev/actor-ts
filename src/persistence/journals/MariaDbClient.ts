import { Lazy } from '../../util/Lazy.js';
import { lazyImportModule } from '../../util/LazyImport.js';

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
export interface MariaDbOkPacket {
  readonly affectedRows: number | bigint;
  readonly insertId?: number | bigint;
  readonly warningStatus?: number;
}
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
    context: 'The MariaDB persistence backends require',
    installHint: 'npm install mariadb',
  }),
);

/** Connection options shared by the three MariaDB stores. */
export interface MariaDbConnection {
  /** Connection URI passed straight to `createPool`, e.g. `mariadb://user:pass@host:3306/db`. */
  readonly url?: string;
  /** `createPool` config object (host/user/password/database/…); takes precedence over `url`. */
  readonly poolConfig?: Record<string, unknown>;
  /** Pre-built pool — shares one pool across the three stores, or injects a fake in tests. */
  readonly pool?: MariaDbPoolLike;
}

/** Build (or pass through) the connection pool for a store. */
export async function buildMariaDbPool(conn: MariaDbConnection): Promise<MariaDbPoolLike> {
  if (conn.pool) return conn.pool;
  const mod = await mariadbLazy.get();
  const arg: Record<string, unknown> | string = conn.poolConfig ?? conn.url ?? {};
  return mod.createPool(arg);
}

/** Rows from a SELECT result (OK-packets yield `[]`). */
export function rowsOf(res: MariaDbResult): MariaDbRow[] {
  return Array.isArray(res) ? res : [];
}

/** `affectedRows` from a DML OK-packet (arrays yield 0). */
export function affectedRowsOf(res: MariaDbResult): number {
  return Array.isArray(res) ? 0 : Number(res.affectedRows ?? 0);
}

/** MariaDB/MySQL duplicate-key error (errno 1062 / `ER_DUP_ENTRY`). */
export function isDuplicateKeyError(e: unknown): boolean {
  const err = e as { errno?: number; code?: string };
  return err.errno === 1062 || err.code === 'ER_DUP_ENTRY';
}

/** Guard configurable table names against injection (see PostgresClient). */
export function assertSafeIdentifier(name: string, what: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `MariaDB: unsafe ${what} identifier ${JSON.stringify(name)} — `
      + 'must match /^[A-Za-z_][A-Za-z0-9_]*$/.',
    );
  }
  return name;
}

/** Test hook — reset the cached lazy `mariadb` import. */
export function resetMariaDbModuleCache(): void {
  mariadbLazy.reset();
}
