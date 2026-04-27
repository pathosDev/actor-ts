import { Lazy } from '../../util/Lazy.js';
import type { SqliteDb, SqliteDriver, SqliteStatement } from './SqliteDriver.js';

/**
 * Node.js implementation — `better-sqlite3`.  Its API maps 1:1 to
 * `bun:sqlite` (same `Database(path)`, `exec`, `prepare(sql).run/get/all`,
 * `transaction`, `close`), so the adapter is mostly a pass-through.  We
 * do wrap each `Statement` to strip better-sqlite3's `.pluck()` /
 * `.raw()` / etc. from the public `SqliteStatement` surface.
 *
 * `better-sqlite3` is an optional peer dependency: install it only if you
 * run under Node.  On Bun/Deno this module is never reached (the factory
 * dispatches elsewhere).
 */
export class BetterSqliteDriver implements SqliteDriver {
  open(path: string): SqliteDb {
    if (!ctorLazy.isEvaluated) {
      throw new Error(
        'BetterSqliteDriver: call `await BetterSqliteDriver.preload()` once before opening a database.',
      );
    }
    const db = new (ctorLazy.get())(path);
    return new BetterSqliteDb(db);
  }

  /** Load `better-sqlite3` once so subsequent `open()` calls are sync. */
  static async preload(): Promise<void> {
    if (ctorLazy.isEvaluated) return;
    try {
      const name = 'better-sqlite3';
      const mod = (await import(name)) as { default?: BetterSqliteCtor } | BetterSqliteCtor;
      const ctor: BetterSqliteCtor =
        typeof mod === 'function' ? (mod as BetterSqliteCtor)
        : (mod as { default: BetterSqliteCtor }).default;
      ctorLazy.setOverride(ctor);
    } catch (e) {
      throw new Error(
        'BetterSqliteDriver requires the "better-sqlite3" package.  Install it with: '
        + 'npm install better-sqlite3\nOriginal error: '
        + (e instanceof Error ? e.message : String(e)),
      );
    }
  }
}

/* ----------------------------- internals --------------------------------- */

interface BetterSqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface BetterSqliteNative {
  exec(sql: string): void;
  prepare(sql: string): BetterSqliteStatement;
  transaction<F extends (...args: never[]) => unknown>(fn: F): F;
  close(): void;
}

type BetterSqliteCtor = new (path: string) => BetterSqliteNative;

// Real ctor is installed by `preload()`; the thunk is only reached if
// the user forgets to call it — the open() guard catches that first,
// so in practice this error is defensive.
const ctorLazy: Lazy<BetterSqliteCtor> = Lazy.of<BetterSqliteCtor>(() => {
  throw new Error(
    'BetterSqliteDriver: call `await BetterSqliteDriver.preload()` before opening a database.',
  );
});

class BetterSqliteDb implements SqliteDb {
  constructor(private readonly native: BetterSqliteNative) {}
  exec(sql: string): void { this.native.exec(sql); }
  prepare(sql: string): SqliteStatement {
    const stmt = this.native.prepare(sql);
    return {
      run: (...p: unknown[]) => stmt.run(...p),
      get: <T = unknown>(...p: unknown[]): T | undefined => stmt.get(...p) as T | undefined,
      all: <T = unknown>(...p: unknown[]): T[] => stmt.all(...p) as T[],
    };
  }
  transaction<F extends (...args: never[]) => unknown>(fn: F): F {
    return this.native.transaction(fn);
  }
  close(): void { this.native.close(); }
}
