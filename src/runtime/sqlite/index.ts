import { detectRuntime, type RuntimeKind } from '../detect.js';
import type { SqliteDriver } from './SqliteDriver.js';

export type { SqliteDriver, SqliteDb, SqliteStatement } from './SqliteDriver.js';
export { BunSqliteDriver } from './BunSqliteDriver.js';
export { BetterSqliteDriver } from './BetterSqliteDriver.js';

let cached: SqliteDriver | null = null;
let cachedFor: RuntimeKind | null = null;

/**
 * Get the appropriate `SqliteDriver` for the current runtime.  Cached
 * across calls.  On Bun the first call lazy-imports `bun:sqlite`; on Node
 * it lazy-imports `better-sqlite3`.  Deno is intentionally not supported
 * yet — throws with a clear pointer to `InMemoryJournal` or
 * `CassandraJournal`.
 */
export async function getSqliteDriver(): Promise<SqliteDriver> {
  const runtime = detectRuntime();
  if (cached && cachedFor === runtime) return cached;
  switch (runtime) {
    case 'bun': {
      const { BunSqliteDriver } = await import('./BunSqliteDriver.js');
      await BunSqliteDriver.preload();
      cached = new BunSqliteDriver();
      break;
    }
    case 'node': {
      const { BetterSqliteDriver } = await import('./BetterSqliteDriver.js');
      await BetterSqliteDriver.preload();
      cached = new BetterSqliteDriver();
      break;
    }
    case 'deno':
      throw new Error(
        'SQLite persistence is not yet supported on Deno.  Use `InMemoryJournal`, '
        + '`CassandraJournal`, or run on Bun / Node.js in the meantime.',
      );
  }
  cachedFor = runtime;
  return cached!;
}

export function resetSqliteDriverCache(): void {
  cached = null;
  cachedFor = null;
}
