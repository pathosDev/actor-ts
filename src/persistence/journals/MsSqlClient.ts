import { MAX_TIMER_DELAY_MS } from '../../util/Constants.js';
import { Lazy } from '../../util/Lazy.js';
import { lazyImportModule } from '../../util/LazyImport.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import type { SqlPool, SqlResult } from '../relational/SqlPool.js';
import {
  findVerificationOffSwitches,
  isUrlShaped,
  msSqlPlaintextKeys,
  readCaFile,
  urlKeysSetting,
} from './ConnectionStringInspection.js';

/**
 * Minimal shapes of the `mssql` API the SQL Server backends use.  Own
 * interfaces (no `@types/mssql`) so the framework stays dependency-free and
 * tests can inject a fake that satisfies just these methods.
 *
 * A real `mssql.ConnectionPool` satisfies `MsSqlPoolLike` structurally —
 * `request()`, `transaction()` and `close()` are all on it — so injecting one
 * needs no wrapper.
 *
 * Two shape details worth knowing: `mssql` binds **named** parameters
 * (`request.input('p1', value)`, referenced as `@p1` in the SQL, and a name may
 * be referenced more than once), and it reports `rowsAffected` as an **array**,
 * one entry per statement in the batch.
 */
export type MsSqlResult = {
  /** Rows of the first result set; absent for statements that return none. */
  readonly recordset?: ReadonlyArray<Record<string, unknown>>;
  /** One entry per statement — summed when normalizing. */
  readonly rowsAffected?: ReadonlyArray<number>;
};

export interface MsSqlRequestLike {
  /** Bind a named parameter.  `@p1` in the SQL refers to `input('p1', …)`. */
  input(name: string, value: unknown): unknown;
  query(sql: string): Promise<MsSqlResult>;
}

export interface MsSqlTransactionLike {
  begin(): Promise<unknown>;
  commit(): Promise<unknown>;
  rollback(): Promise<unknown>;
  request(): MsSqlRequestLike;
}

export interface MsSqlPoolLike {
  request(): MsSqlRequestLike;
  transaction(): MsSqlTransactionLike;
  close(): Promise<unknown>;
}

/** The `ConnectionPool` class as far as the stores reach into it: constructed, and its static parser. */
interface MsSqlConnectionPoolClass {
  new (config: Record<string, unknown> | string): MsSqlPoolLike & {
    connect(): Promise<MsSqlPoolLike>;
  };
  /**
   * node-mssql's own connection-string parser (mssql 12.7
   * connection-pool.js:106-107) — what the constructor runs on a string,
   * giving `{ options: {…}, pool: {…}, server, database, … }`.
   */
  parseConnectionString(connectionString: string): Record<string, unknown>;
}

type MsSqlModule = {
  ConnectionPool: MsSqlConnectionPoolClass;
};

const msSqlLazy: Lazy<Promise<MsSqlModule>> = Lazy.of(
  () => lazyImportModule<MsSqlModule>('mssql', {
    context: 'The SQL Server persistence backends',
    installHint: 'npm install mssql',
  }),
);

/** Connection options shared by all three SQL Server stores. */
export type MsSqlConnection = {
  /**
   * Connection string, e.g.
   * `Server=host,1433;Database=app;User Id=sa;Password=…;Encrypt=true`.  A URL
   * such as `mssql://user:pass@host:1433/db` is refused when the store is
   * built: node-mssql has parsed only this ADO.NET form since its 8.0, and
   * reads a URL as one unknown key — no server, no database.
   *
   * A connection string carries the switch `poolConfig` warns about too,
   * spelled `TrustServerCertificate=`, and has no key for a CA — so a server
   * behind a private CA is named beside it, with `caFile`.
   */
  readonly url?: string;
  /**
   * `mssql` config object — `{ server, port, user, password, database,
   * options: { encrypt: true, cryptoCredentialsDetails: { ca: fs.readFileSync('rds-ca.pem') } },
   * pool: { max } }`.  Takes precedence over `url`.
   *
   * That `options` shape is the one to copy, and the illustration is
   * load-bearing: this doc comment is what an editor shows the moment someone
   * asks how to wire TLS here, which makes it guidance at the point of
   * decision.  The driver encrypts by default and verifies the server's
   * certificate against `cryptoCredentialsDetails`, which tedious hands to
   * `tls.createSecureContext`; `serverName` is the name that certificate has
   * to carry when it differs from `server`.  Supply the signing CA — a managed
   * instance publishes one — rather than telling the driver to trust the
   * server certificate to make a self-signed peer stop complaining: that
   * switch turns verification off, and encryption without verification
   * authenticates nobody, so anything on the path to the database can present
   * its own certificate and read or rewrite the journal, which is the
   * application's system of record.  The object lands in
   * `new mssql.ConnectionPool(...)` verbatim; nothing filters it.
   * See https://actor-ts.dev/operations/security/tls-everywhere/.
   */
  readonly poolConfig?: Record<string, unknown>;
  /**
   * Pre-built pool — bypasses the lazy `mssql` import entirely.  Use to share
   * ONE pool across the journal + snapshot + durable-state stores (see
   * `registerMsSqlPlugins`), or to inject a fake in tests.
   */
  readonly pool?: MsSqlPoolLike;
  /**
   * Most connections the pool holds — node-mssql's `pool.max`.  Unset leaves
   * the driver's default, 10 in mssql 12.7.  HOCON: `max-pool-size`.
   *
   * This and the four fields after it are the settings an operator tunes,
   * typed so they can come from configuration and be checked when the store is
   * built; `poolConfig` stays the code-only long tail.  Each reaches the
   * driver only when set — laid over `poolConfig`, or over the url as
   * node-mssql's own `parseConnectionString` reads it, so the url's server,
   * database and credentials survive — and setting one beside the same key in
   * `poolConfig` or in the url is refused rather than resolved by a
   * precedence nobody would guess.  A pre-built `pool` bypasses all five, as
   * it bypasses `url`.
   */
  readonly maxPoolSize?: number;
  /**
   * How long a connection may sit idle before the pool closes it, in
   * milliseconds — `pool.idleTimeoutMillis`.  Unset leaves the driver's
   * 30 000.  HOCON: `idle-timeout`.
   */
  readonly idleTimeoutMs?: number;
  /**
   * How long opening a connection may take, in milliseconds — node-mssql's
   * `connectionTimeout`.  Unset leaves the driver's 15 000.  HOCON:
   * `connect-timeout`.
   */
  readonly connectTimeoutMs?: number;
  /**
   * How long one request may run, in milliseconds — node-mssql's
   * `requestTimeout`.  Unset leaves the driver's 15 000.  HOCON:
   * `request-timeout`.
   */
  readonly requestTimeoutMs?: number;
  /**
   * Path of a PEM file holding the CA that signed the server's certificate.
   * The store reads it when the pool opens and hands its contents to tedious
   * as `options.cryptoCredentialsDetails.ca`, so the server is verified
   * against that CA — the way to reach a database behind a private CA without
   * trusting the server certificate blindly, and the only one from
   * configuration, since a connection string has no key for a CA.  A path
   * rather than the certificate, so configuration never carries PEM bytes.
   * HOCON: `ca-file`.
   *
   * Refused beside a url whose `Encrypt` switches TLS off or whose
   * `TrustServerCertificate` switches verification off, and beside a
   * `poolConfig` whose options already name a CA or say either.
   */
  readonly caFile?: string;
};

/**
 * The connection rules the three SQL Server stores share.  Each store's
 * validator extends this and calls {@link checkConnection} from its `rules`, so
 * the journal, the snapshot store and the durable-state store refuse the same
 * shapes; it sits beside {@link MsSqlConnection} because that is the shape it
 * checks.
 *
 * Deliberately no URL rule for `url`: the native connection string
 * (`Server=host,1433;Database=…`) is not a URL, so parsing it as one would
 * reject the form most users paste in.  The opposite is checked instead — a
 * `url` that *is* a URL names nothing node-mssql can reach.
 *
 * A setting may be made in one place: a typed field beside the same key in
 * `poolConfig` (any of the spellings node-mssql reads it from) or in the
 * connection string is refused rather than given a precedence, and so is a CA
 * file beside a url or a `poolConfig` that switches TLS or verification off.
 * The connect and request timeouts are bounded above by
 * {@link MAX_TIMER_DELAY_MS}, since tedious arms both as timers and a timer
 * asked for longer fires at once; the idle timeout is not, because tarn
 * compares it against a timestamp instead.
 */
export abstract class MsSqlOptionsValidatorBase<T extends MsSqlConnection> extends OptionsValidator<T> {
  protected checkConnection(s: Partial<T>): void {
    this.nonEmptyString('url' as never);
    if (s.url !== undefined && isUrlShaped(s.url)) {
      // Never the url itself: it carries the password as often as not.
      this.fail(
        'url',
        'is a URL, which node-mssql has not parsed since its 8.0 — it reads the whole string as one unknown '
        + 'key and connects nowhere.  Write the connection string instead: '
        + 'Server=<host>,<port>;Database=<database>;User Id=<user>;Password=<password>;Encrypt=true',
      );
    }
    this.positiveInt('maxPoolSize' as never);
    this.positiveInt('idleTimeoutMs' as never);
    this.timerDelay('connectTimeoutMs', s.connectTimeoutMs);
    this.timerDelay('requestTimeoutMs', s.requestTimeoutMs);
    this.nonEmptyString('caFile' as never);

    const poolConfig: Readonly<Record<string, unknown>> = s.poolConfig ?? {};
    for (const [field, leaf, setting, poolConfigPaths] of MSSQL_TYPED_SETTINGS) {
      if (s[field] === undefined) continue;
      const clash = poolConfigPaths.find((path) => valueAt(poolConfig, path) !== undefined);
      if (clash !== undefined) {
        this.fail(field, `(the ${leaf} leaf) and poolConfig.${clash.join('.')} both set ${setting} — set it in one place`);
      }
      const inUrl = s.url === undefined ? [] : urlKeysSetting('mssql', s.url, field);
      if (inUrl.length > 0) {
        this.fail(field, `(the ${leaf} leaf) and the url's ${inUrl.join(', ')} both set ${setting} — set it in one place`);
      }
    }

    if (s.caFile !== undefined) this.checkCaFile(s.url, poolConfig);
  }

  /**
   * A CA file means *verify the server against this CA*; refused beside
   * anything that says otherwise — another CA, TLS off, or verification off —
   * rather than one side silently winning.  The url's switches are read the
   * way `ConnectionStringInspection.ts` reads them for the HOCON refusal.
   */
  private checkCaFile(url: string | undefined, poolConfig: Readonly<Record<string, unknown>>): void {
    const contradictions: string[] = [];
    if (url !== undefined) {
      for (const key of msSqlPlaintextKeys(url)) contradictions.push(`the url's ${key}, which node-mssql reads as false (TLS off)`);
      for (const found of findVerificationOffSwitches('mssql', url)) {
        contradictions.push(`the url's ${found.spelling} (certificate verification off)`);
      }
    }
    const options = valueAt(poolConfig, ['options']);
    const optionsOf = (key: string): unknown => (isPlainObject(options) ? options[key] : undefined);
    if (valueAt(poolConfig, ['options', 'cryptoCredentialsDetails', 'ca']) !== undefined) {
      contradictions.push('poolConfig.options.cryptoCredentialsDetails.ca, a CA already');
    }
    // node-mssql takes options.encrypt over a top-level encrypt, and the same
    // for trustServerCertificate (tedious connection-pool.js:15-18).
    const encrypt = optionsOf('encrypt') ?? poolConfig['encrypt'];
    if (encrypt === false) contradictions.push('poolConfig encrypt: false (TLS off)');
    const trustServerCertificate = optionsOf('trustServerCertificate') ?? poolConfig['trustServerCertificate'];
    if (trustServerCertificate === true) contradictions.push('poolConfig trustServerCertificate (certificate verification off)');
    if (contradictions.length > 0) {
      this.fail('caFile', `(the ca-file leaf) contradicts ${contradictions.join('; ')} — set TLS in one place`);
    }
  }

  private timerDelay(field: 'connectTimeoutMs' | 'requestTimeoutMs', value: number | undefined): void {
    this.positiveInt(field as never);
    if (value !== undefined && value > MAX_TIMER_DELAY_MS) {
      this.fail(field, `must be at most ${MAX_TIMER_DELAY_MS} ms: tedious arms it as a timer, and a longer one fires at once`, value);
    }
  }
}

/**
 * Each typed field, the leaf it is read from, what it sets, and every place in
 * a `poolConfig` node-mssql reads the same setting from: its own key, the
 * tedious option it falls back from, and `timeout`, which node-mssql reads for
 * both timeouts (tedious connection-pool.js:42-43).
 */
const MSSQL_TYPED_SETTINGS: ReadonlyArray<readonly [
  'maxPoolSize' | 'idleTimeoutMs' | 'connectTimeoutMs' | 'requestTimeoutMs',
  string,
  string,
  ReadonlyArray<ReadonlyArray<string>>,
]> = [
  ['maxPoolSize', 'max-pool-size', 'the pool size', [['pool', 'max']]],
  ['idleTimeoutMs', 'idle-timeout', 'the idle timeout', [['pool', 'idleTimeoutMillis']]],
  ['connectTimeoutMs', 'connect-timeout', 'the connect timeout', [['connectionTimeout'], ['options', 'connectTimeout'], ['timeout']]],
  ['requestTimeoutMs', 'request-timeout', 'the request timeout', [['requestTimeout'], ['options', 'requestTimeout'], ['timeout']]],
];

/** The value at `path` inside nested plain objects, or `undefined`. */
function valueAt(root: Readonly<Record<string, unknown>>, path: ReadonlyArray<string>): unknown {
  let node: unknown = root;
  for (const key of path) {
    if (!isPlainObject(node)) return undefined;
    node = node[key];
  }
  return node;
}

/** A plain object — the shape a driver's options take — rather than a boolean, string or array. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build (or pass through) the connection pool for a store.
 *
 * With no typed field set the driver is handed `poolConfig` or the url,
 * exactly as before.  With one set, its value is laid under node-mssql's own
 * name over a copy of `poolConfig` — or over the url as node-mssql's own
 * `parseConnectionString` reads it, so the server, database and credentials
 * it names survive — and only when set, so an unset field leaves the driver's
 * default in force.  The caller's `poolConfig` object is never written to.
 */
export async function buildMsSqlPool(connection: MsSqlConnection): Promise<MsSqlPoolLike> {
  if (connection.pool) return connection.pool;
  if (connection.poolConfig === undefined && connection.url === undefined) {
    throw new Error('SQL Server persistence requires `poolConfig`, `url`, or a pre-built `pool`.');
  }
  const ca = connection.caFile === undefined ? undefined : await readCaFile(connection.caFile, 'MsSqlConnection');
  const msSql = await msSqlLazy.get();
  const typed = connection.maxPoolSize !== undefined || connection.idleTimeoutMs !== undefined
    || connection.connectTimeoutMs !== undefined || connection.requestTimeoutMs !== undefined || ca !== undefined;
  const config: Record<string, unknown> | string = typed
    ? withTypedFields(
      connection.poolConfig !== undefined
        ? { ...connection.poolConfig }
        : msSql.ConnectionPool.parseConnectionString(connection.url!),
      connection,
      ca,
    )
    : connection.poolConfig ?? connection.url!;
  const pool = new msSql.ConnectionPool(config);
  // `connect()` resolves to the pool itself; awaiting it is what opens the
  // sockets, so a store's first operation fails loudly rather than hanging.
  await pool.connect();
  return pool;
}

/**
 * `config` with the typed fields laid over it under node-mssql's names.  The
 * nested `pool` and `options` objects are copied before they are written to,
 * so a caller's `poolConfig` is never mutated through a shallow copy.
 */
function withTypedFields(
  config: Record<string, unknown>,
  connection: MsSqlConnection,
  ca: string | undefined,
): Record<string, unknown> {
  const pool = isPlainObject(config['pool']) ? { ...config['pool'] } : {};
  if (connection.maxPoolSize !== undefined) pool['max'] = connection.maxPoolSize;
  if (connection.idleTimeoutMs !== undefined) pool['idleTimeoutMillis'] = connection.idleTimeoutMs;
  if (connection.maxPoolSize !== undefined || connection.idleTimeoutMs !== undefined) config['pool'] = pool;
  if (connection.connectTimeoutMs !== undefined) config['connectionTimeout'] = connection.connectTimeoutMs;
  if (connection.requestTimeoutMs !== undefined) config['requestTimeout'] = connection.requestTimeoutMs;
  if (ca !== undefined) {
    // Every store runs its validator before this, which refuses each CA,
    // encrypt or trust setting the file could contradict.
    const options = isPlainObject(config['options']) ? config['options'] : {};
    const credentials = isPlainObject(options['cryptoCredentialsDetails']) ? options['cryptoCredentialsDetails'] : {};
    config['options'] = { ...options, cryptoCredentialsDetails: { ...credentials, ca } };
  }
  return config;
}

/**
 * Adapt an `mssql` pool to the uniform `SqlPool` the relational stores use.
 *
 * The interesting part is parameter binding: every other driver takes an
 * ordered array, while `mssql` wants one `input('pN', value)` call per
 * parameter.  Mapping the array to `p1…pN` here is what lets the dialect emit
 * `@pN` and the shared statements stay unchanged — and it is also why a T-SQL
 * statement may reference the same parameter twice (the `keepN` prune and both
 * merges rely on that).
 */
export function adaptMsSqlPool(pool: MsSqlPoolLike): SqlPool {
  const run = async (request: MsSqlRequestLike, sql: string, params?: ReadonlyArray<unknown>): Promise<SqlResult> => {
    (params ?? []).forEach((value, index) => request.input(`p${index + 1}`, value));
    const result = await request.query(sql);
    return {
      rows: result.recordset ?? [],
      // `rowsAffected` is per-statement; the stores issue one statement at a
      // time, but summing is correct either way.
      affectedRows: (result.rowsAffected ?? []).reduce((total, count) => total + Number(count), 0),
    };
  };
  return {
    async query(sql, params) {
      return run(pool.request(), sql, params);
    },
    async withTransaction(body) {
      const transaction = pool.transaction();
      await transaction.begin();
      try {
        const result = await body({
          // A fresh Request per statement: `mssql` rejects re-binding a
          // parameter name on a Request that has already run.
          query: (sql, params) => run(transaction.request(), sql, params),
        });
        await transaction.commit();
        return result;
      } catch (e) {
        // Best-effort: the server may have aborted the transaction already, and
        // that failure must not mask the original error.
        try { await transaction.rollback(); } catch { /* already rolled back */ }
        throw e;
      }
    },
    async end() { await pool.close(); },
  };
}

/** Test hook — reset the cached lazy `mssql` import. */
export function resetMsSqlModuleCache(): void {
  msSqlLazy.reset();
}
