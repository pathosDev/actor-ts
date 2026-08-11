import { Lazy } from '../../util/Lazy.js';
import type { SqliteDb, SqliteDriver, SqliteStatement } from './SqliteDriver.js';

/**
 * `node:sqlite` implementation — the built-in SQLite that ships with the
 * runtime, so it needs no package and no native build step.
 *
 * This is what closes the Deno gap: `@libsql/client` and the like are async,
 * and `SqliteDriver` is deliberately synchronous, so no npm SQLite package
 * could serve Deno without either a native binding it does not support or an
 * API mismatch.  Deno has shipped `node:sqlite` since 2.2, Node since 22.13,
 * and recent Bun implements it too — one module, three runtimes.
 *
 * Availability is a *runtime version* question rather than an install
 * question, which is why the failure message names versions instead of an
 * `npm install` hint.
 *
 * One genuine gap versus `bun:sqlite` / `better-sqlite3`: `node:sqlite` has no
 * `transaction(body)` helper, so it is synthesized from `BEGIN` / `COMMIT` /
 * `ROLLBACK`.  See `transaction` below for the caveat that implies.
 */
export class NodeSqliteDriver implements SqliteDriver {
  open(path: string): SqliteDb {
    if (!constructorLazy.isEvaluated) {
      throw new Error(
        'NodeSqliteDriver: call `await NodeSqliteDriver.preload()` once before opening a database.',
      );
    }
    return new NodeSqliteDb(new (constructorLazy.get())(path));
  }

  /** Load `node:sqlite` once so subsequent `open()` calls are sync. */
  static async preload(): Promise<void> {
    if (constructorLazy.isEvaluated) return;
    try {
      // Not routed through `lazyImportModule`: that helper's job is to turn a
      // missing optional *package* into an install hint, and a built-in module
      // has nothing to install.
      const name = 'node:sqlite';
      const module = (await import(name)) as { DatabaseSync?: NodeSqliteConstructor };
      if (typeof module.DatabaseSync !== 'function') {
        throw new Error('the module exports no DatabaseSync constructor');
      }
      constructorLazy.setOverride(module.DatabaseSync);
    } catch (e) {
      throw new Error(
        'NodeSqliteDriver requires the built-in "node:sqlite" module, which needs '
        + 'Node.js >= 22.13, Deno >= 2.2, or a recent Bun.\nOriginal error: '
        + (e instanceof Error ? e.message : String(e)),
      );
    }
  }

  /** True when `node:sqlite` is importable on this runtime. */
  static async isAvailable(): Promise<boolean> {
    try {
      await NodeSqliteDriver.preload();
      return true;
    } catch {
      return false;
    }
  }
}

/* ----------------------------- internals --------------------------------- */

interface NodeSqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface NodeSqliteNative {
  exec(sql: string): void;
  prepare(sql: string): NodeSqliteStatement;
  close(): void;
}

type NodeSqliteConstructor = new (path: string) => NodeSqliteNative;

// The real constructor is installed by `preload()`; `open()` guards on
// `isEvaluated`, so this thunk is only reached defensively.
const constructorLazy: Lazy<NodeSqliteConstructor> = Lazy.of<NodeSqliteConstructor>(() => {
  throw new Error(
    'NodeSqliteDriver: call `await NodeSqliteDriver.preload()` before opening a database.',
  );
});

class NodeSqliteDb implements SqliteDb {
  constructor(private readonly native: NodeSqliteNative) {}

  exec(sql: string): void { this.native.exec(sql); }

  prepare(sql: string): SqliteStatement {
    const statement = this.native.prepare(sql);
    return {
      // `changes` may arrive as a bigint; the callers treat it as a number.
      run: (...params: unknown[]) => {
        const result = statement.run(...params);
        return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
      },
      get: <T = unknown>(...params: unknown[]): T | undefined => statement.get(...params) as T | undefined,
      all: <T = unknown>(...params: unknown[]): T[] => statement.all(...params) as T[],
    };
  }

  /**
   * Synthesized transaction — `node:sqlite` exposes no `transaction(body)`
   * wrapper, so the statements are issued directly.
   *
   * **Not re-entrant**: a nested call would emit a second `BEGIN` and fail.
   * That matches how the SQLite stores use it (one flat transaction per
   * `append`), and matching the built-in helpers' behaviour any more closely
   * would mean tracking savepoints for a case the callers do not have.
   */
  transaction<F extends (...args: never[]) => unknown>(body: F): F {
    const native = this.native;
    return ((...args: never[]) => {
      native.exec('BEGIN');
      try {
        const result = body(...args);
        native.exec('COMMIT');
        return result;
      } catch (e) {
        // Best-effort: if the rollback itself fails, the original error is the
        // one worth reporting.
        try { native.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      }
    }) as F;
  }

  close(): void { this.native.close(); }
}
