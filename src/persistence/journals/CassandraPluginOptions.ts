import { ConfigError, type Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { isPlainObject, type ConfigObject } from '../../config/HoconParser.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { Serializer } from '../../serialization/Serializer.js';
import { DEFAULT_CASSANDRA_REPLICATION_CLASS } from '../Constants.js';
import {
  readStoreBoolean,
  readStoreEnum,
  readStoreIdentifier,
  readStoreInt,
  readStoreString,
  readStoreStringList,
  storeLeaf,
} from '../StoreConfig.js';
import type { CassandraClientLike, CassandraConnection } from './CassandraClient.js';
import type { CassandraJournalOptions, CassandraJournalOptionsType } from './CassandraJournalOptions.js';
import type {
  CassandraSnapshotStoreOptions,
  CassandraSnapshotStoreOptionsType,
} from '../snapshot-stores/CassandraSnapshotStoreOptions.js';

export type RegisterCassandraPluginsOptionsType = {
  /**
   * Shared CQL client used by the journal AND the snapshot store.  When
   * provided, both plug-ins reuse the same connection pool (one TCP
   * connection tree per cluster node).  When omitted, each plug-in
   * constructs its own client.
   */
  readonly client?: CassandraClientLike;
  /** Shared payload serializer injected into both stores (a leaf's own `serializer` wins). */
  readonly serializer?: Serializer;
  /** Journal-specific overrides. */
  readonly journal: CassandraJournalOptions;
  /** Snapshot-store-specific overrides.  Usually shares keyspace with the journal. */
  readonly snapshotStore: CassandraSnapshotStoreOptions;
};

/**
 * Fluent builder for {@link RegisterCassandraPluginsOptionsType}.  Each store
 * takes its own leaf builder (or a plain object of its options); the
 * shared {@link CassandraClientLike} is merged onto both leaves at
 * registration time so a single connection tree serves the journal and
 * snapshot store:
 *
 *     registerCassandraPlugins(
 *       ext,
 *       RegisterCassandraPluginsOptions.create()
 *         .withClient(client)
 *         .withJournal(CassandraJournalOptions.create().withContactPoints(['fake']).withKeyspace('app'))
 *         .withSnapshotStore(CassandraSnapshotStoreOptions.create().withContactPoints(['fake']).withKeyspace('app')),
 *     )
 */
export class RegisterCassandraPluginsOptionsBuilder extends OptionsBuilder<RegisterCassandraPluginsOptionsType> {
  /** Start a fresh builder.  Equivalent to `new RegisterCassandraPluginsOptionsBuilder()`. */
  static create(): RegisterCassandraPluginsOptionsBuilder {
    return new RegisterCassandraPluginsOptionsBuilder();
  }

  /** Shared CQL client reused by both plug-ins.  When omitted, each constructs its own. */
  withClient(client: CassandraClientLike): this {
    return this.set('client', client);
  }

  /** Shared payload serializer injected into both stores (a leaf's own `serializer` wins). */
  withSerializer(serializer: Serializer): this {
    return this.set('serializer', serializer);
  }

  /** Journal-specific options builder. */
  withJournal(journal: CassandraJournalOptions): this {
    return this.set('journal', journal);
  }

  /** Snapshot-store-specific options builder. */
  withSnapshotStore(snapshotStore: CassandraSnapshotStoreOptions): this {
    return this.set('snapshotStore', snapshotStore);
  }
}

/**
 * Accepted input for {@link registerCassandraPlugins}: the fluent
 * {@link RegisterCassandraPluginsOptionsBuilder} OR a plain
 * {@link RegisterCassandraPluginsOptionsType} object.
 */
export type RegisterCassandraPluginsOptions =
  | RegisterCassandraPluginsOptionsBuilder
  | Partial<RegisterCassandraPluginsOptionsType>;
/** Value alias so `RegisterCassandraPluginsOptions.create()` / `new RegisterCassandraPluginsOptions()` resolve to the builder. */
export const RegisterCassandraPluginsOptions = RegisterCassandraPluginsOptionsBuilder;

/** The replication shape `keyspaceDdl` takes. */
type CassandraReplication = NonNullable<CassandraConnection['replication']>;

/**
 * The `replication.class` leaf's values — kebab-case, as every HOCON value is
 * — each mapped to the CQL class name `CREATE KEYSPACE` takes.  CQL's own
 * spelling written in a config file is refused with the key and these two
 * words rather than read verbatim (#1490).  `DocumentedDefaults.test.ts` pins
 * the published value through it to `DEFAULT_CASSANDRA_REPLICATION_CLASS`.
 */
export const CASSANDRA_REPLICATION_CLASSES = {
  'simple-strategy': 'SimpleStrategy',
  'network-topology-strategy': 'NetworkTopologyStrategy',
} as const satisfies Readonly<Record<string, NonNullable<CassandraReplication['class']>>>;

/**
 * The nine `ConfigKeys` paths the connection half is read through, named so
 * the one helper below serves both roots: the journal's block and the snapshot
 * store's are structurally identical here and differ only in the strings.
 */
type CassandraConnectionKeys = {
  readonly contactPoints: string;
  readonly keyspace: string;
  readonly localDataCenter: string;
  readonly port: string;
  readonly autoCreateKeyspace: string;
  readonly replicationClass: string;
  readonly replicationFactor: string;
  readonly replicationDataCenters: string;
  readonly consistency: string;
};

/**
 * Read `replication.data-centers` into the map `keyspaceDdl` takes.
 *
 * A list of `{ name, replication-factor }` entries rather than a map keyed by
 * name, because a data center's name is the operator's data, not a key: a
 * HOCON key is kebab-case by rule, and an unquoted dotted name (`eu.west`)
 * would silently nest instead of naming one data center.  As a value a name
 * is just a string.
 *
 * Each entry is taken field by field and refused, by the path of the field at
 * fault, when it is no object, carries a key other than the two, names no
 * non-empty string, repeats a name, or gives no non-negative integer factor.
 * The HOCON node itself is never handed on: verbatim, a kebab-case
 * `replication-factor` is a key `keyspaceDdl` does not read, and the keyspace
 * would be created at one copy without a word.  `[]` reads as unset, the idiom
 * `contact-points` uses.
 */
function readCassandraDataCentersFromConfig(config: Config, path: string): Record<string, number> | undefined {
  if (!config.hasPath(path)) return undefined;
  const entries = config.getList(path);
  if (entries.length === 0) return undefined;
  // A Map until the end: `Object.fromEntries` defines every name as an own
  // key, where assigning a name such as `__proto__` into an object literal
  // would set its prototype instead and drop the data center.
  const dataCenters = new Map<string, number>();
  entries.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isPlainObject(entry)) {
      throw new ConfigError(
        `${entryPath} must be an object { name, replication-factor } (got ${JSON.stringify(entry)})`,
      );
    }
    const fields: ConfigObject = entry;
    for (const field of Object.keys(fields)) {
      if (field !== 'name' && field !== 'replication-factor') {
        throw new ConfigError(
          `${entryPath}.${field} is not a data-center field: an entry takes name and replication-factor`,
        );
      }
    }
    const name = fields['name'];
    if (typeof name !== 'string' || name === '') {
      throw new ConfigError(`${entryPath}.name must be a non-empty string (got ${JSON.stringify(name)})`);
    }
    if (dataCenters.has(name)) {
      throw new ConfigError(`${entryPath}.name repeats data center ${JSON.stringify(name)}`);
    }
    const replicationFactor = fields['replication-factor'];
    if (typeof replicationFactor !== 'number' || !Number.isInteger(replicationFactor) || replicationFactor < 0) {
      throw new ConfigError(
        `${entryPath}.replication-factor must be a non-negative integer (got ${JSON.stringify(replicationFactor)})`,
      );
    }
    dataCenters.set(name, replicationFactor);
  });
  return Object.fromEntries(dataCenters);
}

/**
 * Read `replication { … }` — what `auto-create-keyspace` creates the keyspace
 * with (#1490).  Leaf by leaf, never as the HOCON object: the class through
 * {@link CASSANDRA_REPLICATION_CLASSES}, the factor as an int, the data
 * centers through {@link readCassandraDataCentersFromConfig}.
 *
 * Data centers are refused unless the class is `network-topology-strategy`.
 * `keyspaceDdl` reads them under no other class, so under the published
 * `simple-strategy` they would vanish and the keyspace be created in one ring
 * with `replication-factor` copies — the outcome the list was written to
 * avoid.  The class judged is the one this block resolves to, the published
 * default included; a `withReplication(...)` in code replaces the whole
 * object, so a class set there could not have rescued them either.
 */
function readCassandraReplicationFromConfig(
  config: Config,
  at: (canonicalLeafPath: string) => string,
  keys: CassandraConnectionKeys,
): CassandraReplication | undefined {
  const replicationClass = readStoreEnum(config, at(keys.replicationClass), CASSANDRA_REPLICATION_CLASSES);
  const replicationFactor = readStoreInt(config, at(keys.replicationFactor));
  const dataCenters = readCassandraDataCentersFromConfig(config, at(keys.replicationDataCenters));
  if (dataCenters !== undefined && (replicationClass ?? DEFAULT_CASSANDRA_REPLICATION_CLASS) !== 'NetworkTopologyStrategy') {
    throw new ConfigError(
      `${at(keys.replicationDataCenters)} is only used when ${at(keys.replicationClass)} is network-topology-strategy: `
      + 'under simple-strategy every data center would be ignored and the keyspace created in one ring',
    );
  }
  if (replicationClass === undefined && replicationFactor === undefined && dataCenters === undefined) return undefined;
  const replication: { -readonly [K in keyof CassandraReplication]?: CassandraReplication[K] } = {};
  if (replicationClass !== undefined) replication.class = replicationClass;
  if (replicationFactor !== undefined) replication.replicationFactor = replicationFactor;
  if (dataCenters !== undefined) replication.dataCenters = dataCenters;
  return replication;
}

/**
 * The connection half both Cassandra readers share — `CassandraConnection` is
 * the base of both option families, so the seed list, the keyspace, the
 * topology coordinates and the keyspace's replication are the same nine leaves
 * under either root.
 *
 * Written as one helper rather than copied into two readers because it is the
 * only place in the family where the two blocks are genuinely identical: the
 * relational readers differ field by field, so a shared helper there would have
 * been a parameter list longer than the code it saved.
 *
 * `contact-points` and `keyspace` use the empty-is-unset idiom for the same
 * reason `url` does elsewhere — both ship as published placeholders, and an
 * empty seed list or an empty keyspace name reaching the driver is a failure
 * far from its cause.  `credentials` has no leaf at all: it is key material.
 * `replication` is not free-form driver config but the typed shape
 * `keyspaceDdl` validates, read leaf by leaf by
 * {@link readCassandraReplicationFromConfig}.
 */
function readCassandraConnectionFromConfig(
  config: Config,
  at: (canonicalLeafPath: string) => string,
  keys: CassandraConnectionKeys,
): Partial<CassandraConnection> {
  const out: {
    -readonly [K in keyof CassandraConnection]?: CassandraConnection[K]
  } = {};
  const contactPoints = readStoreStringList(config, at(keys.contactPoints));
  if (contactPoints !== undefined) out.contactPoints = contactPoints;
  const keyspace = readStoreString(config, at(keys.keyspace));
  if (keyspace !== undefined) out.keyspace = keyspace;
  const localDataCenter = readStoreString(config, at(keys.localDataCenter));
  if (localDataCenter !== undefined) out.localDataCenter = localDataCenter;
  const port = readStoreInt(config, at(keys.port));
  if (port !== undefined) out.port = port;
  const autoCreateKeyspace = readStoreBoolean(config, at(keys.autoCreateKeyspace));
  if (autoCreateKeyspace !== undefined) out.autoCreateKeyspace = autoCreateKeyspace;
  const replication = readCassandraReplicationFromConfig(config, at, keys);
  if (replication !== undefined) out.replication = replication;
  const consistency = readStoreInt(config, at(keys.consistency));
  if (consistency !== undefined) out.consistency = consistency;
  return out;
}

/**
 * Read the Cassandra journal's block — `actor-ts.persistence.journal.cassandra`
 * by default, or whichever id the plug-in was registered under (#872).
 *
 * Placed beside the plug-in's own options for the reason
 * `PostgresPluginOptions.ts` places its readers the same way: the *plug-in* is
 * what reads configuration, so `new CassandraJournal({...})` stays a pure
 * function of its argument in a test.
 *
 * `NoDeadConfigKeys` binds this reader leaf by leaf: it changes each leaf the
 * block publishes, introduces the comment-only `consistency` and
 * `serial-consistency` at one value and changes them to a second, and this
 * reader has to answer differently each time (#1425) — the root literal
 * `CassandraPlugin.ts` registers as its plugin id counts for nothing.  The
 * exact-object assertions in `PersistenceConfigDefaults.test.ts` pin the
 * values.  `replication.data-centers` is the one leaf outside the gate: a
 * list of `{ name, replication-factor }` objects, read only under
 * `network-topology-strategy`, where the gate's list kind perturbs a list of
 * strings; the data-center cases in that same suite bind it.
 */
export function readCassandraJournalOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.journal.cassandra.root,
): Partial<CassandraJournalOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.journal.cassandra;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: { -readonly [K in keyof CassandraJournalOptionsType]?: CassandraJournalOptionsType[K] } = {
    ...readCassandraConnectionFromConfig(config, at, keys),
  };
  const eventsTable = readStoreIdentifier(config, at(keys.eventsTable));
  if (eventsTable !== undefined) out.eventsTable = eventsTable;
  const metadataTable = readStoreIdentifier(config, at(keys.metadataTable));
  if (metadataTable !== undefined) out.metadataTable = metadataTable;
  const allIdsTable = readStoreIdentifier(config, at(keys.allIdsTable));
  if (allIdsTable !== undefined) out.allIdsTable = allIdsTable;
  const tagIndexTable = readStoreIdentifier(config, at(keys.tagIndexTable));
  if (tagIndexTable !== undefined) out.tagIndexTable = tagIndexTable;
  const partitionSize = readStoreInt(config, at(keys.partitionSize));
  if (partitionSize !== undefined) out.partitionSize = partitionSize;
  const autoCreateTables = readStoreBoolean(config, at(keys.autoCreateTables));
  if (autoCreateTables !== undefined) out.autoCreateTables = autoCreateTables;
  const useTagIndex = readStoreBoolean(config, at(keys.useTagIndex));
  if (useTagIndex !== undefined) out.useTagIndex = useTagIndex;
  const lightweightTransactions = readStoreBoolean(config, at(keys.lightweightTransactions));
  if (lightweightTransactions !== undefined) out.lightweightTransactions = lightweightTransactions;
  const serialConsistency = readStoreInt(config, at(keys.serialConsistency));
  if (serialConsistency !== undefined) out.serialConsistency = serialConsistency;
  return out;
}

/** Read the Cassandra snapshot store's block — see {@link readCassandraJournalOptionsFromConfig}. */
export function readCassandraSnapshotStoreOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.snapshotStore.cassandra.root,
): Partial<CassandraSnapshotStoreOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.snapshotStore.cassandra;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: {
    -readonly [K in keyof CassandraSnapshotStoreOptionsType]?: CassandraSnapshotStoreOptionsType[K]
  } = { ...readCassandraConnectionFromConfig(config, at, keys) };
  const snapshotsTable = readStoreIdentifier(config, at(keys.snapshotsTable));
  if (snapshotsTable !== undefined) out.snapshotsTable = snapshotsTable;
  const keepN = readStoreInt(config, at(keys.keepN));
  if (keepN !== undefined) out.keepN = keepN;
  const autoCreateTables = readStoreBoolean(config, at(keys.autoCreateTables));
  if (autoCreateTables !== undefined) out.autoCreateTables = autoCreateTables;
  return out;
}
