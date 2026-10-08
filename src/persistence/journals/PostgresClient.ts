import { MAX_TIMER_DELAY_MS } from '../../util/Constants.js';
import { Lazy } from '../../util/Lazy.js';
import { lazyImportModule } from '../../util/LazyImport.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import type { SqlPool, SqlResult } from '../relational/SqlPool.js';
import { postgresSslParameters, readCaFile } from './ConnectionStringInspection.js';

/**
 * Minimal shapes of the `pg` (node-postgres) API the Postgres backends
 * use.  We deliberately define our own interfaces rather than depend on
 * `@types/pg` — the framework stays dependency-free, `pg` is an OPTIONAL
 * peer-dep loaded lazily, and tests can inject a fake pool that satisfies
 * just these methods.
 *
 * Note: node-postgres returns `BIGINT` columns as **strings** (to avoid
 * precision loss), so every numeric column the backends read is coerced
 * with `Number(...)` at the mapping boundary.
 */
export type PgQueryResult = {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  /** Rows affected by INSERT/UPDATE/DELETE — `null` for some statements. */
  readonly rowCount: number | null;
};

/** A single pooled connection — `query` + `release` back to the pool. */
export interface PgClientLike {
  query(text: string, values?: ReadonlyArray<unknown>): Promise<PgQueryResult>;
  release(): void;
}

export interface PgPoolLike {
  query(text: string, values?: ReadonlyArray<unknown>): Promise<PgQueryResult>;
  /** Check out a dedicated connection — required for multi-statement transactions. */
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

type PgModule = {
  Pool: new (config: Record<string, unknown>) => PgPoolLike;
};

const pgLazy: Lazy<Promise<PgModule>> = Lazy.of(
  () => lazyImportModule<PgModule>('pg', {
    context: 'The Postgres persistence backends',
    installHint: 'npm install pg',
  }),
);

/** Connection options shared by all three Postgres stores. */
export type PostgresConnection = {
  /** Connection string, e.g. `postgres://user:pass@host:5432/db`. */
  readonly url?: string;
  /**
   * Extra node-postgres `Pool` config, merged over `{ connectionString:
   * url }` — e.g.
   * `{ max: 10, ssl: { rejectUnauthorized: true, ca: fs.readFileSync('rds-ca.pem') } }`.
   *
   * That `ssl` shape is the one to copy, and the illustration is load-bearing:
   * this doc comment is what an editor shows the moment someone asks how to
   * wire TLS here, which makes it guidance at the point of decision.  Supply
   * the signing CA — a managed instance publishes one — rather than switching
   * certificate verification off to make a self-signed peer stop complaining.
   * Encryption without verification authenticates nobody, so anything on the
   * path to the database can present its own certificate and read or rewrite
   * the journal, which is the application's system of record.  The object
   * lands in `new pg.Pool(...)` verbatim; nothing filters it.
   * See https://actor-ts.dev/operations/security/tls-everywhere/.
   */
  readonly poolConfig?: Record<string, unknown>;
  /**
   * Pre-built pool — bypasses the lazy `pg` import entirely.  Use to
   * share ONE pool across the journal + snapshot + durable-state stores
   * (see `registerPostgresPlugins`), or to inject a fake in tests.
   */
  readonly pool?: PgPoolLike;
  /**
   * Most connections the pool holds — pg-pool's `max`.  Unset leaves the
   * driver's default, 10 in pg-pool 3.14.  HOCON: `max-pool-size`.
   *
   * This and the three fields after it are the settings an operator tunes,
   * typed so they can come from configuration and be checked when the store is
   * built; `poolConfig` stays the code-only long tail.  Each reaches the
   * driver only when set, and setting one beside the same key in `poolConfig`
   * is refused rather than resolved by a precedence nobody would guess.  A
   * pre-built `pool` bypasses all four, as it bypasses `url`.
   */
  readonly maxPoolSize?: number;
  /**
   * How long a connection may sit idle before the pool closes it, in
   * milliseconds — pg-pool's `idleTimeoutMillis`.  Unset leaves the driver's
   * 10 000.  HOCON: `idle-timeout`.
   */
  readonly idleTimeoutMs?: number;
  /**
   * How long opening a connection may take, in milliseconds — pg's
   * `connectionTimeoutMillis`.  Unset leaves the driver's default, which is no
   * limit at all.  HOCON: `connect-timeout`.
   */
  readonly connectTimeoutMs?: number;
  /**
   * Path of a PEM file holding the CA that signed the server's certificate.
   * The store reads it when the pool opens and hands its contents to pg as
   * `ssl.ca`, so the server is verified against that CA — the way to reach a
   * database behind a private CA without switching verification off.  A path
   * rather than the certificate, so configuration never carries PEM bytes.
   * HOCON: `ca-file`.
   *
   * Refused beside a url ssl parameter, which pg would put in its place (the
   * url names a CA file itself with `sslrootcert`), and beside a `poolConfig.ssl`
   * that already names a CA, switches TLS off, or switches verification off.
   */
  readonly caFile?: string;
};

/**
 * The connection string `buildPgPool` hands the driver: `url` when set,
 * otherwise a `connectionString` written into `poolConfig`.
 */
function effectiveConnectionString(connection: Partial<PostgresConnection>): string | undefined {
  if (connection.url !== undefined) return connection.url;
  const fromPoolConfig = connection.poolConfig?.['connectionString'];
  return typeof fromPoolConfig === 'string' ? fromPoolConfig : undefined;
}

/**
 * The connection rules the three Postgres stores share.  Each store's
 * validator extends this and calls {@link checkConnection} from its `rules`, so
 * the journal, the snapshot store and the durable-state store refuse the same
 * combinations; it sits beside {@link PostgresConnection} because that is the
 * shape it checks.
 *
 * A setting may be made in one place.  A typed field beside the same key in
 * `poolConfig` is refused rather than given a precedence, and so is TLS
 * configured twice: node-postgres assigns the `ssl` it parses out of the
 * connection string over the one in the config object, so a `poolConfig.ssl`
 * or a `caFile` beside a url carrying an ssl parameter is not a merge but a
 * silent loss — the CA goes with it (see `postgresSslParameters`).
 *
 * The two timeouts are bounded above by {@link MAX_TIMER_DELAY_MS}: pg-pool
 * and pg arm each as a timer, and a timer asked for longer fires at once.
 */
export abstract class PostgresOptionsValidatorBase<T extends PostgresConnection> extends OptionsValidator<T> {
  protected checkConnection(s: Partial<T>): void {
    this.positiveInt('maxPoolSize' as never);
    this.timerDelay('idleTimeoutMs', s.idleTimeoutMs);
    this.timerDelay('connectTimeoutMs', s.connectTimeoutMs);
    this.nonEmptyString('caFile' as never);

    const poolConfig: Readonly<Record<string, unknown>> = s.poolConfig ?? {};
    this.notAlsoInPoolConfig('maxPoolSize', 'max-pool-size', s.maxPoolSize, poolConfig, ['max', 'poolSize'], 'the pool size');
    this.notAlsoInPoolConfig('idleTimeoutMs', 'idle-timeout', s.idleTimeoutMs, poolConfig, ['idleTimeoutMillis'], 'the idle timeout');
    this.notAlsoInPoolConfig(
      'connectTimeoutMs', 'connect-timeout', s.connectTimeoutMs, poolConfig, ['connectionTimeoutMillis'], 'the connect timeout',
    );

    const connectionString = effectiveConnectionString(s);
    const parameters = connectionString === undefined ? [] : postgresSslParameters(connectionString);
    const named = `${s.url !== undefined ? "the url's" : "poolConfig.connectionString's"} ssl `
      + `parameter${parameters.length === 1 ? '' : 's'} (${parameters.join(', ')})`;
    if (s.caFile !== undefined) {
      if (parameters.length > 0) {
        this.fail(
          'caFile',
          `(the ca-file leaf) is set beside ${named}, and node-postgres assigns the TLS settings it parses from `
          + 'the connection string over the config object, so the CA would be dropped — name the CA in one place: '
          + 'caFile, or sslrootcert in the url',
        );
      }
      this.checkCaFileAgainstPoolConfigSsl(poolConfig['ssl']);
    }
    if (poolConfig['ssl'] !== undefined && parameters.length > 0) {
      this.fail(
        'poolConfig.ssl',
        `is set beside ${named}, and node-postgres assigns the TLS settings it parses from the connection string `
        + 'over the config object, so poolConfig.ssl would be dropped — configure TLS in one of the two places',
      );
    }
  }

  /**
   * `buildPgPool` adds the CA to a `poolConfig.ssl` object, or turns
   * `ssl: true` into one; anything else would contradict `caFile` and is
   * refused instead of overridden.
   */
  private checkCaFileAgainstPoolConfigSsl(ssl: unknown): void {
    if (ssl === undefined || ssl === true) return;
    const conflict = !isPlainObject(ssl)
      ? 'poolConfig.ssl is neither an object nor true, so it switches TLS off or names a mode of its own'
      : ssl['ca'] !== undefined
        ? 'poolConfig.ssl.ca names a CA already'
        : ssl['rejectUnauthorized'] === false
          ? 'poolConfig.ssl switches certificate verification off, which leaves the CA unused'
          : undefined;
    if (conflict !== undefined) {
      this.fail('caFile', `(the ca-file leaf) contradicts poolConfig.ssl: ${conflict} — set TLS in one place`);
    }
  }

  private timerDelay(field: 'idleTimeoutMs' | 'connectTimeoutMs', value: number | undefined): void {
    this.positiveInt(field as never);
    if (value !== undefined && value > MAX_TIMER_DELAY_MS) {
      this.fail(field, `must be at most ${MAX_TIMER_DELAY_MS} ms: the driver arms it as a timer, and a longer one fires at once`, value);
    }
  }

  private notAlsoInPoolConfig(
    field: string,
    leaf: string,
    value: unknown,
    poolConfig: Readonly<Record<string, unknown>>,
    poolConfigKeys: ReadonlyArray<string>,
    setting: string,
  ): void {
    if (value === undefined) return;
    const clash = poolConfigKeys.find((key) => poolConfig[key] !== undefined);
    if (clash !== undefined) {
      this.fail(field, `(the ${leaf} leaf) and poolConfig.${clash} both set ${setting} — set it in one place`);
    }
  }
}

/** A plain object — the shape a driver's TLS options take — rather than a boolean, string or array. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build (or pass through) the connection pool for a store.
 *
 * The typed connection fields are laid over a copy of `poolConfig` under the
 * driver's own names, each only when set, so an unset field leaves the
 * driver's default in force rather than one this module would have to keep in
 * step with it.  The caller's `poolConfig` object is never written to.
 */
export async function buildPgPool(connection: PostgresConnection): Promise<PgPoolLike> {
  if (connection.pool) return connection.pool;
  const ca = connection.caFile === undefined ? undefined : await readCaFile(connection.caFile, 'PostgresConnection');
  const pg = await pgLazy.get();
  const config: Record<string, unknown> = { ...connection.poolConfig };
  if (connection.url !== undefined) config.connectionString = connection.url;
  if (connection.maxPoolSize !== undefined) config.max = connection.maxPoolSize;
  if (connection.idleTimeoutMs !== undefined) config.idleTimeoutMillis = connection.idleTimeoutMs;
  if (connection.connectTimeoutMs !== undefined) config.connectionTimeoutMillis = connection.connectTimeoutMs;
  if (ca !== undefined) {
    // Every store runs its validator before this, which refuses each `ssl` the
    // CA could contradict: what is left is none, `true`, or an object to add to.
    const ssl = connection.poolConfig?.['ssl'];
    config.ssl = { ...(isPlainObject(ssl) ? ssl : {}), ca };
  }
  return new pg.Pool(config);
}

/**
 * Adapt a node-postgres pool to the uniform `SqlPool` the relational stores
 * use.  `rowCount` is `null` for some statements, so it is normalized here
 * rather than at every call site.
 */
export function adaptPgPool(pool: PgPoolLike): SqlPool {
  const normalize = (result: PgQueryResult): SqlResult => ({
    rows: result.rows,
    affectedRows: result.rowCount ?? 0,
  });
  return {
    async query(sql, params) {
      return normalize(await pool.query(sql, params));
    },
    async withTransaction(body) {
      // A transaction needs a dedicated connection: `BEGIN` on a pool would
      // land on an arbitrary member and the following statements on others.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await body({
          query: async (sql, params) => normalize(await client.query(sql, params)),
        });
        await client.query('COMMIT');
        return result;
      } catch (e) {
        // Best-effort: the server may have aborted the transaction already,
        // and that failure must not mask the original error.
        try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      } finally {
        client.release();
      }
    },
    end: () => pool.end(),
  };
}

/** Test hook — reset the cached lazy `pg` import. */
export function resetPgModuleCache(): void {
  pgLazy.reset();
}
