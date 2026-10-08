import { MAX_TIMER_DELAY_MS } from '../../util/Constants.js';
import { Lazy } from '../../util/Lazy.js';
import { lazyImportModule } from '../../util/LazyImport.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import type { SqlPool, SqlResult } from '../relational/SqlPool.js';
import {
  mariaDbPlaintextParameters,
  readCaFile,
  urlKeysSetting,
  type TypedConnectionField,
} from './ConnectionStringInspection.js';

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
  /**
   * Most connections the pool holds — the connector's `connectionLimit`.
   * Unset leaves the driver's default, 10 in mariadb 3.5.  HOCON:
   * `max-pool-size`.
   *
   * This and the four fields after it are the settings an operator tunes,
   * typed so they can come from configuration and be checked when the store is
   * built; `poolConfig` stays the code-only long tail.  Each reaches the
   * driver only when set — laid over `poolConfig`, or over the url parsed the
   * way the connector parses it, so the url's host, database and options
   * survive — and setting one beside the same key in `poolConfig` or in the
   * url is refused rather than resolved by a precedence nobody would guess.
   * A pre-built `pool` bypasses all five, as it bypasses `url`.
   */
  readonly maxPoolSize?: number;
  /**
   * How long a caller may wait for a free connection, in milliseconds — the
   * connector's `acquireTimeout`.  Unset leaves the driver's 10 000.  HOCON:
   * `acquire-timeout`.
   */
  readonly acquireTimeoutMs?: number;
  /**
   * How long a connection may sit idle before the pool closes it, in
   * milliseconds — the connector's `idleTimeout`, which counts whole
   * **seconds**, so only a whole number of seconds is accepted.  Unset leaves
   * the driver's 1 800 s.  HOCON: `idle-timeout`.
   */
  readonly idleTimeoutMs?: number;
  /**
   * How long opening a connection may take, in milliseconds — the connector's
   * `connectTimeout`.  Unset leaves the driver's 1 000, which the connector
   * also caps at the acquire timeout.  HOCON: `connect-timeout`.
   */
  readonly connectTimeoutMs?: number;
  /**
   * Path of a PEM file holding the CA that signed the server's certificate.
   * The store reads it when the pool opens and hands its contents to the
   * connector as `ssl.ca`, so the server is verified against that CA — the
   * way to reach a database behind a private CA without switching
   * verification off, and the only one from configuration, since the url's
   * `ssl` is a boolean that cannot carry a CA.  A path rather than the
   * certificate, so configuration never carries PEM bytes.  HOCON: `ca-file`.
   *
   * Refused beside a url whose `ssl` switches TLS off, and beside a
   * `poolConfig.ssl` that already names a CA, switches TLS off, or switches
   * verification off.
   */
  readonly caFile?: string;
};

/**
 * The connection rules the three MariaDB stores share.  Each store's
 * validator extends this and calls {@link checkConnection} from its `rules`, so
 * the journal, the snapshot store and the durable-state store refuse the same
 * combinations; it sits beside {@link MariaDbConnection} because that is the
 * shape it checks.
 *
 * A setting may be made in one place: a typed field beside the same option in
 * `poolConfig` or in the url's query is refused rather than given a
 * precedence, and so is a CA file beside a url or a `poolConfig.ssl` that
 * says something else about TLS.  The acquire and connect timeouts are
 * bounded above by {@link MAX_TIMER_DELAY_MS}, since the connector arms both as
 * timers and a timer asked for longer fires at once; the idle timeout is not,
 * because the connector compares it against a timestamp instead.
 */
export abstract class MariaDbOptionsValidatorBase<T extends MariaDbConnection> extends OptionsValidator<T> {
  protected checkConnection(s: Partial<T>): void {
    this.positiveInt('maxPoolSize' as never);
    this.timerDelay('acquireTimeoutMs', s.acquireTimeoutMs);
    this.timerDelay('connectTimeoutMs', s.connectTimeoutMs);
    this.positiveInt('idleTimeoutMs' as never);
    if (s.idleTimeoutMs !== undefined && s.idleTimeoutMs % 1_000 !== 0) {
      this.fail('idleTimeoutMs', 'must be a whole number of seconds: the connector counts idleTimeout in seconds', s.idleTimeoutMs);
    }
    this.nonEmptyString('caFile' as never);

    const poolConfig: Readonly<Record<string, unknown>> = s.poolConfig ?? {};
    for (const [field, leaf, option] of MARIADB_TYPED_OPTIONS) {
      if (s[field] === undefined) continue;
      if (poolConfig[option] !== undefined) {
        this.fail(field, `(the ${leaf} leaf) and poolConfig.${option} both set the connector's ${option} — set it in one place`);
      }
      const inUrl = s.url === undefined ? [] : urlKeysSetting('mariadb', s.url, field);
      if (inUrl.length > 0) {
        this.fail(field, `(the ${leaf} leaf) and the url's ${inUrl.join(', ')} both set the connector's ${option} — set it in one place`);
      }
    }

    if (s.caFile !== undefined) {
      const plaintext = s.url === undefined ? [] : mariaDbPlaintextParameters(s.url);
      if (plaintext.length > 0) {
        this.fail(
          'caFile',
          `(the ca-file leaf) is set beside the url's ${plaintext.join(', ')}, which the connector reads as false — `
          + 'TLS off, so the CA would go unused: drop one of them',
        );
      }
      this.checkCaFileAgainstPoolConfigSsl(poolConfig['ssl']);
    }
  }

  /**
   * `buildMariaDbPool` adds the CA to a `poolConfig.ssl` object, or turns
   * `ssl: true` into one; anything else would contradict `caFile` and is
   * refused instead of overridden.
   */
  private checkCaFileAgainstPoolConfigSsl(ssl: unknown): void {
    if (ssl === undefined || ssl === true) return;
    const conflict = !isPlainObject(ssl)
      ? 'poolConfig.ssl is neither an object nor true, so it switches TLS off or names a profile of its own'
      : ssl['ca'] !== undefined
        ? 'poolConfig.ssl.ca names a CA already'
        : ssl['rejectUnauthorized'] === false
          ? 'poolConfig.ssl switches certificate verification off, which leaves the CA unused'
          : undefined;
    if (conflict !== undefined) {
      this.fail('caFile', `(the ca-file leaf) contradicts poolConfig.ssl: ${conflict} — set TLS in one place`);
    }
  }

  private timerDelay(field: 'acquireTimeoutMs' | 'connectTimeoutMs', value: number | undefined): void {
    this.positiveInt(field as never);
    if (value !== undefined && value > MAX_TIMER_DELAY_MS) {
      this.fail(field, `must be at most ${MAX_TIMER_DELAY_MS} ms: the connector arms it as a timer, and a longer one fires at once`, value);
    }
  }
}

/** Each typed field, the leaf it is read from, and the connector option it becomes. */
const MARIADB_TYPED_OPTIONS: ReadonlyArray<readonly [TypedConnectionField, string, string]> = [
  ['maxPoolSize', 'max-pool-size', 'connectionLimit'],
  ['acquireTimeoutMs', 'acquire-timeout', 'acquireTimeout'],
  ['idleTimeoutMs', 'idle-timeout', 'idleTimeout'],
  ['connectTimeoutMs', 'connect-timeout', 'connectTimeout'],
];

/** A plain object — the shape the connector's TLS options take — rather than a boolean, string or array. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Options the connector's url parser turns from `'true'` into `true` and
 * anything else into `false` (mariadb 3.5.4 connection-options.js:241-275).
 */
const MARIADB_URL_BOOLEAN_OPTIONS: ReadonlyArray<string> = [
  'bulk', 'allowPublicKeyRetrieval', 'insertIdAsNumber', 'decimalAsNumber', 'bigIntAsNumber', 'permitRedirect',
  'logParam', 'compress', 'dateStrings', 'debug', 'autoJsonMap', 'arrayParenthesis', 'checkDuplicate',
  'debugCompress', 'foundRows', 'metaAsArray', 'metaEnumerable', 'multipleStatements', 'namedPlaceholders',
  'nestTables', 'permitSetMultiParamEntries', 'pipelining', 'forceVersionCheck', 'rowsAsArray', 'trace',
  'bitOneIsBoolean', 'jsonStrings', 'enableKeepAlive', 'supportBigNumbers', 'bigNumberStrings', 'keepEof',
  'permitLocalInfile', 'permitConnectionWhenExpired',
];

/** Options the connector's url parser reads with `parseInt`, keeping the string when it is not a number (284-305). */
const MARIADB_URL_NUMERIC_OPTIONS: ReadonlyArray<string> = [
  'charsetNumber', 'connectTimeout', 'keepAliveDelay', 'socketTimeout', 'debugLen', 'prepareCacheLength',
  'queryTimeout', 'maxAllowedPacket', 'maxAllowedColumns', 'keepAliveInitialDelay', 'port',
];

/** Pool options `PoolOptions` reads with a bare `parseInt` when it was handed a string (pool-options.js:15-21, 24). */
const MARIADB_POOL_NUMERIC_OPTIONS: ReadonlyArray<string> = [
  'acquireTimeout', 'connectionLimit', 'idleTimeout', 'leakDetectionTimeout', 'initializationTimeout',
  'minDelayValidation', 'minimumIdle', 'pingTimeout',
];

/** Pool options `PoolOptions` reads as `=== 'true'` when it was handed a string (pool-options.js:22-23). */
const MARIADB_POOL_BOOLEAN_OPTIONS: ReadonlyArray<string> = ['noControlAfterUse', 'resetAfterUse'];

/**
 * The options object the connector builds from a url — what `createPool(url)`
 * works from — so typed fields can be laid over an object without losing a
 * thing the url said: its credentials, host, port and database, and every
 * query option, coerced as the connector coerces them.
 *
 * A port of mariadb 3.5.4's `ConnectionOptions.parse` with its
 * `parseOptionDataType` (connection-options.js:239-394) and of the coercions
 * `PoolOptions` applies to a string before anything else (pool-options.js:
 * 10-25), checked against the connector itself when it was written by handing
 * `PoolOptions` the url and the parsed object in turn.  A re-read is due when
 * the peer range moves.  Two deliberate departures: a url the connector would
 * reject is refused with a message that does not quote it (the connector's
 * own quotes the url, password included), and a `__proto__` key is skipped,
 * where the connector's assignment of a string to it is a no-op anyway.
 */
export function parseMariaDbUrl(url: string): Record<string, unknown> {
  const malformed = (): Error => new Error(
    'MariaDB persistence: url is not a connection string the mariadb connector reads — '
    + 'mariadb://[<user>[:<password>]@]<host>[:<port>]/<database>[?<option>=<value>[&…]]',
  );
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw malformed();
  }
  if (parsed.protocol !== 'mariadb:') throw malformed();
  const database = parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname;
  if (database === '') throw malformed();

  const options: Record<string, unknown> = {
    user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    host: unwrapIpv6(parsed.hostname),
    port: parsed.port ? Number.parseInt(parsed.port, 10) : undefined,
    database: decodeURIComponent(database),
  };
  // Split by hand rather than with URLSearchParams, as the connector does: only
  // values are decoded, `+` stays a plus, and a one-character key is skipped.
  const query = parsed.search ? parsed.search.slice(1) : '';
  if (query !== '') {
    for (const keyValue of query.split('&')) {
      const equalIndex = keyValue.indexOf('=');
      if (equalIndex === 1) continue;
      const key = keyValue.substring(0, equalIndex);
      if (key === '__proto__') continue;
      const value = keyValue.substring(equalIndex + 1);
      options[key] = value ? decodeURIComponent(value) : undefined;
    }
  }

  for (const option of MARIADB_URL_BOOLEAN_OPTIONS) {
    if (typeof options[option] === 'string') options[option] = options[option] === 'true';
  }
  for (const option of MARIADB_URL_NUMERIC_OPTIONS) {
    const value = options[option];
    if (typeof value === 'string') {
      const number = Number.parseInt(value, 10);
      if (!Number.isNaN(number)) options[option] = number;
    }
  }
  if (typeof options['ssl'] === 'string') options['ssl'] = options['ssl'] === 'true';
  if (typeof options['connectAttributes'] === 'string') {
    try {
      options['connectAttributes'] = JSON.parse(options['connectAttributes']);
    } catch (error) {
      throw new Error(`Failed to parse connectAttributes as JSON: ${(error as Error).message}`);
    }
  }
  const sessionVariables = options['sessionVariables'];
  if (typeof sessionVariables === 'string' && sessionVariables.trim().startsWith('{')) {
    try {
      options['sessionVariables'] = JSON.parse(sessionVariables);
    } catch {
      // The connector keeps a string that does not parse.
    }
  }

  for (const option of MARIADB_POOL_NUMERIC_OPTIONS) {
    // A parseInt without a radix, as the connector writes it: `0x10` reads as 16.
    if (options[option]) options[option] = Number.parseInt(String(options[option]));
  }
  for (const option of MARIADB_POOL_BOOLEAN_OPTIONS) {
    if (options[option]) options[option] = options[option] === 'true';
  }
  return options;
}

/** WHATWG URL keeps the brackets around an IPv6 literal; the socket layer wants the bare address. */
function unwrapIpv6(hostname: string): string {
  return hostname.length > 1 && hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * Build (or pass through) the connection pool for a store.
 *
 * With no typed field set the connector is handed `poolConfig`, the url or
 * nothing, exactly as before.  With one set, its value is laid under the
 * connector's own name over a copy of `poolConfig` — or over the url parsed as
 * the connector parses it, so nothing the url said is lost — and only when
 * set, so an unset field leaves the driver's default in force.  The caller's
 * `poolConfig` object is never written to.
 */
export async function buildMariaDbPool(connection: MariaDbConnection): Promise<MariaDbPoolLike> {
  if (connection.pool) return connection.pool;
  const ca = connection.caFile === undefined ? undefined : await readCaFile(connection.caFile, 'MariaDbConnection');
  const mod = await mariadbLazy.get();
  const typed = connection.maxPoolSize !== undefined || connection.acquireTimeoutMs !== undefined
    || connection.idleTimeoutMs !== undefined || connection.connectTimeoutMs !== undefined || ca !== undefined;
  if (!typed) {
    const arg: Record<string, unknown> | string = connection.poolConfig ?? connection.url ?? {};
    return mod.createPool(arg);
  }
  const options: Record<string, unknown> = connection.poolConfig !== undefined
    ? { ...connection.poolConfig }
    : connection.url !== undefined ? parseMariaDbUrl(connection.url) : {};
  if (connection.maxPoolSize !== undefined) options['connectionLimit'] = connection.maxPoolSize;
  if (connection.acquireTimeoutMs !== undefined) options['acquireTimeout'] = connection.acquireTimeoutMs;
  if (connection.idleTimeoutMs !== undefined) options['idleTimeout'] = connection.idleTimeoutMs / 1_000;
  if (connection.connectTimeoutMs !== undefined) options['connectTimeout'] = connection.connectTimeoutMs;
  if (ca !== undefined) {
    // Every store runs its validator before this, which refuses each `ssl` the
    // CA could contradict: what is left is none, `true`, or an object to add to.
    const ssl = options['ssl'];
    options['ssl'] = { ...(isPlainObject(ssl) ? ssl : {}), ca };
  }
  return mod.createPool(options);
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
