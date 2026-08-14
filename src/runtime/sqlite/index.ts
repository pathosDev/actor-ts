import { detectRuntime, type RuntimeKind } from '../Detect.js';
import type { SqliteDriver } from './SqliteDriver.js';

export type { SqliteDriver, SqliteDb, SqliteStatement } from './SqliteDriver.js';
export { BunSqliteDriver } from './BunSqliteDriver.js';
export { BetterSqliteDriver } from './BetterSqliteDriver.js';
export { NodeSqliteDriver } from './NodeSqliteDriver.js';

let cached: SqliteDriver | null = null;
let cachedFor: RuntimeKind | null = null;

/**
 * Get the appropriate `SqliteDriver` for the current runtime.  Cached across
 * calls.
 *
 *   - **Bun** — `bun:sqlite`, built in.
 *   - **Node** — `better-sqlite3` when it is installed, otherwise the built-in
 *     `node:sqlite`.  Preferring the peer dependency keeps existing
 *     deployments on exactly the driver they have been running, while a fresh
 *     install needs no native build step at all.
 *   - **Deno** — `node:sqlite` (Deno ≥ 2.2).
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
      cached = await nodeDriver();
      break;
    }
    case 'deno': {
      const { NodeSqliteDriver } = await import('./NodeSqliteDriver.js');
      await NodeSqliteDriver.preload();
      cached = new NodeSqliteDriver();
      break;
    }
  }
  cachedFor = runtime;
  return cached!;
}

export function resetSqliteDriverCache(): void {
  cached = null;
  cachedFor = null;
}

/**
 * `better-sqlite3` first, `node:sqlite` as the fallback.
 *
 * If neither is usable the `better-sqlite3` failure is the one reported: on
 * Node the install hint is the actionable advice, whereas "upgrade your
 * runtime" is not, since `engines` already requires Node >= 24 and every such
 * version ships `node:sqlite`.
 */
async function nodeDriver(): Promise<SqliteDriver> {
  const { BetterSqliteDriver } = await import('./BetterSqliteDriver.js');
  try {
    await BetterSqliteDriver.preload();
    return new BetterSqliteDriver();
  } catch (betterSqliteError) {
    const { NodeSqliteDriver } = await import('./NodeSqliteDriver.js');
    try {
      await NodeSqliteDriver.preload();
      return new NodeSqliteDriver();
    } catch {
      throw betterSqliteError;
    }
  }
}
