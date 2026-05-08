/**
 * Narrow interface over the subset of the DataStax `cassandra-driver` API
 * that the journal / snapshot-store plug-ins actually use.  Kept separate
 * so tests can supply an in-memory stand-in without pulling in the real
 * driver, and so the driver itself stays an *optional* peer dependency.
 */
export interface CassandraRowResult {
  readonly rows: Array<Record<string, unknown>>;
}

export interface CassandraBatchQuery {
  readonly query: string;
  readonly params?: ReadonlyArray<unknown>;
}

export interface CassandraClientLike {
  connect(): Promise<void>;
  shutdown(): Promise<void>;
  execute(
    query: string,
    params?: ReadonlyArray<unknown>,
    options?: { prepare?: boolean; consistency?: number },
  ): Promise<CassandraRowResult>;
  batch(
    queries: ReadonlyArray<CassandraBatchQuery>,
    options?: { prepare?: boolean; logged?: boolean; consistency?: number },
  ): Promise<void>;
}

export interface CassandraConnection {
  /** Node(s) to seed the cluster topology from. */
  readonly contactPoints: ReadonlyArray<string>;
  /** Local DC — required for DCAwareRoundRobinPolicy.  Defaults to `datacenter1`. */
  readonly localDataCenter?: string;
  /** Keyspace to `USE` after connect.  Must already exist, or pass `autoCreateKeyspace: true`. */
  readonly keyspace: string;
  /** Optional username/password for PLAIN auth. */
  readonly credentials?: { username: string; password: string };
  /** Port — defaults to 9042. */
  readonly port?: number;
  /** If true, create the keyspace on startup (simple strategy, rf=1).  Dev-friendly default. */
  readonly autoCreateKeyspace?: boolean;
  /** Replication settings used by autoCreateKeyspace.  Ignored otherwise. */
  readonly replication?: {
    readonly class?: 'SimpleStrategy' | 'NetworkTopologyStrategy';
    readonly replicationFactor?: number;
    /** For NetworkTopologyStrategy, map of DC → replication factor. */
    readonly dataCenters?: Readonly<Record<string, number>>;
  };
  /**
   * CQL consistency level to use for all reads and writes.  Default:
   * `LOCAL_QUORUM` (value 6 in the driver).  Pass the numeric value from
   * `cassandra-driver`'s `types.consistencies`.
   */
  readonly consistency?: number;
}

/**
 * DDL for the `events_by_tag` side table populated by `CassandraJournal`
 * when `useTagIndex` is set (#44).  Returned as a runnable CQL string
 * so operators applying the schema by hand (or running migrations on
 * pre-existing keyspaces) can reuse the journal's exact shape.
 *
 * `keyspace` and `tagIndexTable` default to the journal's own defaults
 * — pass them explicitly if you've customised either.
 */
export function tagIndexDdl(args: {
  readonly keyspace: string;
  readonly tagIndexTable?: string;
}): string {
  const table = args.tagIndexTable ?? 'events_by_tag';
  return `CREATE TABLE IF NOT EXISTS ${args.keyspace}.${table} (`
    + ` tag text,`
    + ` timestamp bigint,`
    + ` persistence_id text,`
    + ` sequence_nr bigint,`
    + ` payload text,`
    + ` tags set<text>,`
    + ` PRIMARY KEY ((tag), timestamp, persistence_id, sequence_nr)`
    + ` ) WITH CLUSTERING ORDER BY (timestamp ASC, persistence_id ASC, sequence_nr ASC)`;
}

/**
 * Build the default keyspace-bootstrap statement — used by autoCreateKeyspace.
 */
export function keyspaceDdl(conn: CassandraConnection): string {
  const cls = conn.replication?.class ?? 'SimpleStrategy';
  if (cls === 'NetworkTopologyStrategy') {
    const dcs = conn.replication?.dataCenters ?? {};
    const pairs = Object.entries(dcs).map(([dc, rf]) => `'${dc}': ${rf}`).join(', ');
    return `CREATE KEYSPACE IF NOT EXISTS ${conn.keyspace} WITH replication = { 'class': 'NetworkTopologyStrategy', ${pairs} }`;
  }
  const rf = conn.replication?.replicationFactor ?? 1;
  return `CREATE KEYSPACE IF NOT EXISTS ${conn.keyspace} WITH replication = { 'class': 'SimpleStrategy', 'replication_factor': ${rf} }`;
}

/**
 * Dynamically import the official DataStax driver and construct a client.
 * Kept behind `await` so the import only happens when the user actually
 * creates a Cassandra journal.  If the user constructs their own client
 * elsewhere they can bypass this entirely.
 */
export async function createCassandraClient(conn: CassandraConnection): Promise<CassandraClientLike> {
  type CassandraDriver = {
    Client: new (options: unknown) => CassandraClientLike & {
      connect(): Promise<void>;
    };
  };
  let driver: CassandraDriver;
  try {
    // `cassandra-driver` is an OPTIONAL peer dependency.  We indirect
    // through a runtime-built specifier to avoid the compile-time
    // module-not-found error when users haven't installed it.
    const moduleName = 'cassandra-driver';
    driver = (await import(moduleName)) as unknown as CassandraDriver;
  } catch (e) {
    throw new Error(
      'CassandraJournal requires the "cassandra-driver" package. Install it with: '
      + 'bun add cassandra-driver\nOriginal error: ' + (e instanceof Error ? e.message : String(e)),
    );
  }
  const options: Record<string, unknown> = {
    contactPoints: conn.contactPoints,
    localDataCenter: conn.localDataCenter ?? 'datacenter1',
    protocolOptions: { port: conn.port ?? 9042 },
  };
  if (conn.credentials) options.credentials = conn.credentials;
  // We deliberately don't set `keyspace` here — we may need to CREATE it first.
  const client = new driver.Client(options);
  return client;
}
