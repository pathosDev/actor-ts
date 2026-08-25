/**
 * Narrow interface over the subset of the DataStax `cassandra-driver` API
 * that the journal / snapshot-store plug-ins actually use.  Kept separate
 * so tests can supply an in-memory stand-in without pulling in the real
 * driver, and so the driver itself stays an *optional* peer dependency.
 */
import { lazyImportModule } from '../../util/LazyImport.js';
import { assertSafeIdentifier } from '../storage/SqlIdentifier.js';

export type CassandraRowResult = {
  readonly rows: Array<Record<string, unknown>>;
};

export type CassandraBatchQuery = {
  readonly query: string;
  readonly params?: ReadonlyArray<unknown>;
};

export interface CassandraClientLike {
  connect(): Promise<void>;
  shutdown(): Promise<void>;
  execute(
    query: string,
    params?: ReadonlyArray<unknown>,
    options?: { prepare?: boolean; consistency?: number; serialConsistency?: number },
  ): Promise<CassandraRowResult>;
  batch(
    queries: ReadonlyArray<CassandraBatchQuery>,
    options?: { prepare?: boolean; logged?: boolean; consistency?: number },
  ): Promise<void>;
}

export type CassandraConnection = {
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
  /** Replication options used by autoCreateKeyspace.  Ignored otherwise. */
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
};

/**
 * DDL for the `events_by_tag` side table populated by `CassandraJournal`
 * when `useTagIndex` is set (#44).  Returned as a runnable CQL string
 * so operators applying the schema by hand (or running migrations on
 * pre-existing keyspaces) can reuse the journal's exact shape.
 *
 * `keyspace` and `tagIndexTable` default to the journal's own defaults
 * — pass them explicitly if you've customised either.
 *
 * Both are interpolated as CQL identifiers, which cannot be bound, so both
 * are validated first (security audit #616) — the guard the journal's own
 * `qualified()` has always applied, now also on the exported helper.
 */
export function tagIndexDdl(args: {
  readonly keyspace: string;
  readonly tagIndexTable?: string;
}): string {
  const table = args.tagIndexTable ?? 'events_by_tag';
  return `CREATE TABLE IF NOT EXISTS ${assertSafeIdentifier(args.keyspace, 'keyspace')}`
    + `.${assertSafeIdentifier(table, 'tag index table')} (`
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
 * Escape a CQL string literal by doubling every single quote — the only
 * escape CQL defines inside `'…'`.
 *
 * Data-center names land in the replication map as `text` *values*, not as
 * identifiers, so {@link assertSafeIdentifier} is the wrong guard for them:
 * its charset rejects the hyphen that `Ec2Snitch`-derived names carry by
 * default (`us-east`, `eu-west-1`).  Escaping keeps those working while
 * closing the injection path a name containing a quote would open.
 */
function escapeCqlStringLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

/**
 * Narrow a replication factor to an integer before it is spliced into CQL.
 *
 * Numbers are not bindable in DDL either, so the factor is concatenated in
 * verbatim.  TypeScript types both `dataCenters` values and
 * `replicationFactor` as `number`, which makes this look like dead code — it
 * is not: the connection object is routinely assembled from environment
 * variables or a parsed JSON/values file, where nothing enforces the declared
 * type.  Hence the check is written over `unknown`.  Zero is accepted on
 * purpose — a `NetworkTopologyStrategy` map may legitimately list a data
 * center with no replicas.
 */
function assertReplicationFactor(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`invalid ${what} ${JSON.stringify(value)} — must be a non-negative integer`);
  }
  return value;
}

/**
 * Build the default keyspace-bootstrap statement — used by autoCreateKeyspace.
 *
 * Runs *before* the store's own `qualified()` guard (CassandraJournal and
 * CassandraSnapshotStore both call this from `doStart()` ahead of
 * `ensureTables()`), and `CassandraRememberEntitiesStore.start()` calls it
 * with no guard of its own at all — so a hostile keyspace would otherwise
 * reach the cluster inside one `CREATE KEYSPACE` before anything rejected it
 * (security audit #616).  Validate here, at the choke point.
 */
export function keyspaceDdl(connection: CassandraConnection): string {
  const keyspace = assertSafeIdentifier(connection.keyspace, 'keyspace');
  const replicationClass = connection.replication?.class ?? 'SimpleStrategy';
  if (replicationClass === 'NetworkTopologyStrategy') {
    const dataCenters = connection.replication?.dataCenters ?? {};
    const pairs = Object.entries(dataCenters).map(([dataCenter, replicationFactor]) => {
      const replicas = assertReplicationFactor(
        replicationFactor, `replication factor for data center ${JSON.stringify(dataCenter)}`,
      );
      return `'${escapeCqlStringLiteral(dataCenter)}': ${replicas}`;
    }).join(', ');
    return `CREATE KEYSPACE IF NOT EXISTS ${keyspace} WITH replication = { 'class': 'NetworkTopologyStrategy', ${pairs} }`;
  }
  const replicationFactor = assertReplicationFactor(
    connection.replication?.replicationFactor ?? 1, 'replicationFactor',
  );
  return `CREATE KEYSPACE IF NOT EXISTS ${keyspace} WITH replication = { 'class': 'SimpleStrategy', 'replication_factor': ${replicationFactor} }`;
}

/**
 * Dynamically import the official DataStax driver and construct a client.
 * Kept behind `await` so the import only happens when the user actually
 * creates a Cassandra journal.  If the user constructs their own client
 * elsewhere they can bypass this entirely.
 */
export async function createCassandraClient(connection: CassandraConnection): Promise<CassandraClientLike> {
  /**
   * The one structural stub in this repository that is checked against
   * nothing, and knowingly so.
   *
   * Every other optional peer is installed in one of the two dependency
   * contexts, so its stub is verified either by a real-module import
   * (`tests/unit/ci/OptionalPeerModuleShapes.test.ts`) or against a live
   * server in Docker. `cassandra-driver` is in neither: its newest release
   * hard-pins `adm-zip: ~0.5.10` and GHSA-xcpc-8h2w-3j85 is fixed only in
   * 0.6.0, so declaring it turns `bun run lint:audit` red. `FakeCassandraClient`
   * satisfies this shape by construction, which means a renamed `Client`
   * export upstream breaks on first connect with every suite still green.
   *
   * The standing decision and the four ways out of it live in
   * `DELIBERATELY_UNDECLARED` in
   * `tests/unit/ci/OptionalPeerDeclarations.test.ts`, which fails if the gap
   * is ever closed without the note going with it. #676.
   */
  type CassandraDriver = {
    Client: new (options: unknown) => CassandraClientLike & {
      connect(): Promise<void>;
    };
  };
  // `cassandra-driver` is an OPTIONAL peer dependency — lazy-imported through
  // the shared helper so the missing-dependency message matches the other
  // backends (Postgres/MariaDB) instead of hand-rolling its own wording.
  const driver = await lazyImportModule<CassandraDriver>('cassandra-driver', {
    context: 'The Cassandra/ScyllaDB persistence backends',
    installHint: 'npm install cassandra-driver',
  });
  const options: Record<string, unknown> = {
    contactPoints: connection.contactPoints,
    localDataCenter: connection.localDataCenter ?? 'datacenter1',
    protocolOptions: { port: connection.port ?? 9042 },
  };
  if (connection.credentials) options.credentials = connection.credentials;
  // We deliberately don't set `keyspace` here — we may need to CREATE it first.
  const client = new driver.Client(options);
  return client;
}
