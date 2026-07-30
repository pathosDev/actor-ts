import { Lazy } from '../../util/Lazy.js';
import { lazyImportModule } from '../../util/LazyImport.js';
import type { SqlPool, SqlResult } from '../relational/SqlPool.js';

/**
 * Minimal shape of the `@libsql/client` API the libSQL backends use.  Our own
 * interfaces rather than a dependency on the package's types, so the framework
 * stays dependency-free and tests can inject a fake that satisfies just these
 * methods.
 *
 * The import target is the **`@libsql/client/web`** entry point: it speaks only
 * HTTP and WebSocket, so nothing native is loaded at runtime even though the
 * package ships platform binaries for its embedded-replica mode.  That entry
 * point deliberately cannot open `file:` or `:memory:` URLs — a local database
 * is `SqliteJournal`'s job (see `LibSqlJournalOptions`).
 */
export type LibSqlStatement = {
  readonly sql: string;
  readonly args: ReadonlyArray<unknown>;
};

export type LibSqlResultSet = {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly rowsAffected: number;
};

/** An open interactive transaction (hrana baton over HTTP). */
export type LibSqlTransactionLike = {
  execute(statement: LibSqlStatement): Promise<LibSqlResultSet>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): void;
};

export type LibSqlClientLike = {
  execute(statement: LibSqlStatement): Promise<LibSqlResultSet>;
  /** `'write'` takes the write lock for the life of the transaction. */
  transaction(mode?: 'write' | 'read' | 'deferred'): Promise<LibSqlTransactionLike>;
  close(): void;
};

type LibSqlModule = {
  createClient(config: { url: string; authToken?: string }): LibSqlClientLike;
};

const libSqlLazy: Lazy<Promise<LibSqlModule>> = Lazy.of(
  () => lazyImportModule<LibSqlModule>('@libsql/client/web', {
    context: 'The libSQL / Turso persistence backends',
    installHint: 'npm install @libsql/client',
  }),
);

/** Connection options shared by all three libSQL stores. */
export type LibSqlConnection = {
  /**
   * Database URL — `libsql://…` (Turso), or `http(s)://` / `ws(s)://` for a
   * self-hosted `sqld`.  Required unless `client` is supplied.
   */
  readonly url?: string;
  /** Turso auth token.  Omit for an unauthenticated local `sqld`. */
  readonly authToken?: string;
  /**
   * Pre-built client — bypasses the lazy `@libsql/client` import entirely.
   * Use to share ONE client across the journal, snapshot and durable-state
   * stores (see `registerLibSqlPlugins`), to inject a fake in tests, or to
   * supply a client built with options this connection shape does not model.
   */
  readonly client?: LibSqlClientLike;
};

/** Build (or pass through) the client for a store. */
export async function buildLibSqlClient(connection: LibSqlConnection): Promise<LibSqlClientLike> {
  if (connection.client) return connection.client;
  if (connection.url === undefined) {
    throw new Error('libSQL persistence requires either `url` or a pre-built `client`.');
  }
  const libSql = await libSqlLazy.get();
  return libSql.createClient({
    url: connection.url,
    ...(connection.authToken === undefined ? {} : { authToken: connection.authToken }),
  });
}

/**
 * Adapt a libSQL client to the uniform `SqlPool` the relational stores use.
 *
 * `withTransaction` maps to an **interactive** transaction rather than to
 * `client.batch(…, 'write')`.  A batch is one round-trip and takes no lasting
 * lock, so it looks like the better fit — but it requires every statement up
 * front, and the journal's append reads the head before deciding what to
 * write.  Faking that with an executor that buffers writes and flushes them at
 * commit would work only as long as nobody ever reads after writing inside the
 * callback, and would have to return an invented `affectedRows` in the
 * meantime.  An interactive transaction is a few more round-trips and is
 * simply correct.
 *
 * The cost to know about: a `'write'` transaction holds the database's write
 * lock until it commits, and the server drops it after about five seconds, so
 * a stalled connection mid-append surfaces as a failed append rather than a
 * silently half-written stream.  Appends are a handful of statements, which
 * keeps that window small.
 */
export function adaptLibSqlClient(client: LibSqlClientLike): SqlPool {
  const normalize = (result: LibSqlResultSet): SqlResult => ({
    rows: result.rows,
    affectedRows: Number(result.rowsAffected ?? 0),
  });
  return {
    async query(sql, params) {
      return normalize(await client.execute({ sql, args: params ?? [] }));
    },
    async withTransaction(body) {
      const transaction = await client.transaction('write');
      try {
        const result = await body({
          query: async (sql, params) => normalize(await transaction.execute({ sql, args: params ?? [] })),
        });
        await transaction.commit();
        return result;
      } catch (e) {
        // Best-effort: a rollback failure must not mask the original error.
        try { await transaction.rollback(); } catch { /* already rolled back */ }
        throw e;
      } finally {
        transaction.close();
      }
    },
    async end() { client.close(); },
  };
}

/** Test hook — reset the cached lazy `@libsql/client` import. */
export function resetLibSqlModuleCache(): void {
  libSqlLazy.reset();
}
