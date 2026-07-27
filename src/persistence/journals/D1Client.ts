import { HttpClient } from '../../http/HttpClient.js';
import type { SqlPool, SqlResult } from '../relational/SqlPool.js';

/**
 * Cloudflare D1 over its REST API — **no SDK, no new dependency.**
 *
 * D1 has no official Node client: inside a Worker you get a binding, and from
 * anywhere else you use the HTTP API.  That makes it the one backend the
 * framework can talk to with nothing but the built-in `HttpClient`, which is what
 * the umbrella issue asked for.
 *
 * The API is a single endpoint that takes `{ sql, params }` and returns rows plus
 * a `meta.changes` count — enough for the whole relational base, since the SQL
 * itself is `sqliteDialect`'s and identical to what libSQL and local SQLite run.
 */

/** One statement's result, as D1 reports it. */
export interface D1QueryResult {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  /** `meta.changes` — rows written by an INSERT / UPDATE / DELETE. */
  readonly changes: number;
}

/** The minimal surface a D1 transport must offer. */
export interface D1ClientLike {
  query(sql: string, params: ReadonlyArray<unknown>): Promise<D1QueryResult>;
  close(): Promise<void>;
}

/**
 * A failed D1 statement.
 *
 * The message deliberately carries D1's own text, because that is what the
 * SQLite dialect's duplicate-key predicate matches on: the REST API reports a
 * constraint violation as a message (`UNIQUE constraint failed: …`) and does not
 * forward SQLite's extended result code.  That fallback was written into
 * `sqliteDialect` for exactly this transport.
 */
export class D1RequestError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = 'D1RequestError';
  }
}

/** Connection options shared by all three D1 stores. */
export interface D1Connection {
  /** Cloudflare account id.  Required unless `client` is supplied. */
  readonly accountId?: string;
  /** D1 database id (the UUID, not the database name). */
  readonly databaseId?: string;
  /**
   * API token with the `D1:Edit` permission.  Sent as a bearer token, so treat
   * it like any other secret — read it from the environment rather than
   * committing it.
   */
  readonly apiToken?: string;
  /** API base URL.  Override only for a proxy or a test double. */
  readonly baseUrl?: string;
  /** Per-request timeout in milliseconds.  Default 30 000. */
  readonly timeoutMs?: number;
  /**
   * Pre-built transport — bypasses the HTTP client entirely.  Use to share ONE
   * transport across the journal, snapshot and durable-state stores (see
   * `registerD1Plugins`), or to inject a fake in tests.
   */
  readonly client?: D1ClientLike;
}

/** Cloudflare's API root. */
export const DEFAULT_D1_BASE_URL = 'https://api.cloudflare.com/client/v4';

/** Build (or pass through) the transport for a store. */
export function buildD1Client(connection: D1Connection): D1ClientLike {
  if (connection.client) return connection.client;
  const { accountId, databaseId, apiToken } = connection;
  if (accountId === undefined || databaseId === undefined || apiToken === undefined) {
    throw new Error(
      'Cloudflare D1 persistence requires `accountId`, `databaseId` and `apiToken`, '
      + 'or a pre-built `client`.',
    );
  }
  const baseUrl = (connection.baseUrl ?? DEFAULT_D1_BASE_URL).replace(/\/+$/, '');
  const endpoint = `${baseUrl}/accounts/${accountId}/d1/database/${databaseId}/query`;
  const httpClient = new HttpClient();
  const timeoutMs = connection.timeoutMs ?? 30_000;

  return {
    async query(sql, params) {
      const response = await httpClient.post(endpoint, {
        headers: { authorization: `Bearer ${apiToken}` },
        body: { sql, params },
        timeoutMs,
      });
      if (response.status < 200 || response.status >= 300) {
        // A non-2xx carries the reason in the body, so surface that rather than a
        // bare status code — an expired token and a bad SQL statement look
        // identical otherwise.
        throw new D1RequestError(`D1 request failed with HTTP ${response.status}: ${response.text()}`);
      }
      return readD1Envelope(response.json<D1Envelope>());
    },
    // Nothing to close: `fetch` owns its connection pool.
    async close() { /* no-op */ },
  };
}

/** D1's response envelope — a per-statement result array plus API-level errors. */
interface D1Envelope {
  readonly success?: boolean;
  readonly errors?: ReadonlyArray<{ code?: number; message?: string }>;
  readonly result?: ReadonlyArray<{
    readonly results?: ReadonlyArray<Record<string, unknown>>;
    readonly success?: boolean;
    readonly meta?: { readonly changes?: number };
  }>;
}

/**
 * Unwrap D1's envelope.
 *
 * D1 answers a rejected statement with **HTTP 200** and `success: false`, so the
 * status code alone is not a health check — the envelope has to be inspected or a
 * constraint violation would look like an empty result set, and the journal's
 * concurrency backstop would never fire.
 */
function readD1Envelope(envelope: D1Envelope): D1QueryResult {
  if (envelope.success === false || (envelope.errors && envelope.errors.length > 0)) {
    const first = envelope.errors?.[0];
    throw new D1RequestError(first?.message ?? 'D1 reported an unspecified error', first?.code);
  }
  const statement = envelope.result?.[0];
  if (statement?.success === false) {
    throw new D1RequestError('D1 statement did not succeed');
  }
  return {
    rows: statement?.results ?? [],
    changes: Number(statement?.meta?.changes ?? 0),
  };
}

/**
 * Adapt a D1 transport to the uniform `SqlPool` the relational stores use.
 *
 * **`withTransaction` provides no isolation, and that is not a shortcut.**  D1's
 * REST API exposes one statement per request: there is no `BEGIN`, and no
 * parameterized batch either (the Workers binding has `db.batch`, the HTTP API
 * does not).  So the callback runs against the plain executor.
 *
 * The journal is still correct, because its optimistic concurrency never rested
 * on the transaction: the events primary key rejects a racing writer and
 * `sqliteDialect` turns that into `JournalConcurrencyError`.  `SqlPool` documents
 * isolation as adapter-defined precisely so this transport could exist.  What the
 * missing transaction *does* cost is spelled out in the store's docs: a
 * multi-event append can persist a prefix if the connection fails midway.
 */
export function adaptD1Client(client: D1ClientLike): SqlPool {
  const executor = {
    async query(sql: string, params?: ReadonlyArray<unknown>): Promise<SqlResult> {
      const result = await client.query(sql, params ?? []);
      return { rows: result.rows, affectedRows: result.changes };
    },
  };
  return {
    query: executor.query,
    async withTransaction(body) {
      return body(executor);
    },
    async end() { await client.close(); },
  };
}
