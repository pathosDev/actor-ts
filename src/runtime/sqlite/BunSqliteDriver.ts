import { Lazy } from '../../util/Lazy.js';
import type { SqliteDb, SqliteDriver, SqliteStatement } from './SqliteDriver.js';

/**
 * Bun implementation — `bun:sqlite`.  `bun:sqlite`'s own `Database` type
 * already matches `SqliteDb` structurally, so this wrapper is essentially
 * an identity cast.
 *
 * `bun:sqlite` is imported lazily so the module is only loaded when the
 * driver is actually used (keeps non-Bun runtimes happy — they'd never
 * reach this code, but importing `'bun:sqlite'` at top level would still
 * fail on Node).
 */
export class BunSqliteDriver implements SqliteDriver {
  open(path: string): SqliteDb {
    if (!ctorLazy.isEvaluated) {
      throw new Error(
        'BunSqliteDriver: call `await BunSqliteDriver.preload()` once before opening a database.',
      );
    }
    return new (ctorLazy.get())(path) as unknown as SqliteDb;
  }

  /** Load `bun:sqlite` once so subsequent `open()` calls are sync. */
  static async preload(): Promise<void> {
    if (ctorLazy.isEvaluated) return;
    const mod = (await import('bun:sqlite' as string)) as unknown as {
      Database: new (path: string) => SqliteDb & { prepare(sql: string): SqliteStatement };
    };
    // Seed the Lazy with the resolved ctor via setOverride — next `get()`
    // returns it without re-running the (stub) thunk.
    ctorLazy.setOverride(mod.Database as unknown as SqliteConstructor);
  }
}

type SqliteConstructor = new (path: string) => SqliteDb;

// The real ctor is installed by `preload()`; the thunk only runs if a
// caller forgets to preload and we need a clear error message.
const ctorLazy: Lazy<SqliteConstructor> = Lazy.of<SqliteConstructor>(() => {
  throw new Error(
    'BunSqliteDriver: call `await BunSqliteDriver.preload()` before opening a database.',
  );
});
