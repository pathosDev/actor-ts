import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { Serializer } from '../../serialization/Serializer.js';
import {
  readStoreBoolean,
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

/**
 * The six `ConfigKeys` paths the connection half is read through, named so the
 * one helper below serves both roots: the journal's block and the snapshot
 * store's are structurally identical here and differ only in the strings.
 */
type CassandraConnectionKeys = {
  readonly contactPoints: string;
  readonly keyspace: string;
  readonly localDataCenter: string;
  readonly port: string;
  readonly autoCreateKeyspace: string;
  readonly consistency: string;
};

/**
 * The connection half both Cassandra readers share — `CassandraConnection` is
 * the base of both option families, so the seed list, the keyspace and the
 * topology coordinates are the same six leaves under either root.
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
 * `replication` has none either, being a free-form map with no enumerable leaf
 * set — the same reason `pool-config` has none.
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
 * This is the block `NoDeadConfigKeys` was already green over with nothing
 * reading it — `CassandraPlugin.ts` contains the root literal as its plugin id,
 * which is all the guard's `isReferencedInSource` ever asked for.  Every leaf
 * is now addressed through a full dotted `ConfigKeys` constant, so the guard
 * checks the leaf rather than the root, and the exact-object assertions in
 * `PersistenceConfigDefaults.test.ts` are what pin the values.
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
