import { readDefaultMailboxFromConfig } from '../../src/ActorOptions.js';
import {
  readActorThroughputFromConfig,
  readAskTimeoutFromConfig,
  readDispatcherOptionsFromConfig,
  readLoggerCloseTimeoutFromConfig,
  readShutdownDrainTimeoutFromConfig,
  readSystemNameFromConfig,
} from '../../src/ActorSystem.js';
import { readInMemoryCacheOptionsFromConfig } from '../../src/cache/InMemoryCacheOptions.js';
import { readMemcachedCacheOptionsFromConfig } from '../../src/cache/MemcachedCacheOptions.js';
import { readRedisCacheOptionsFromConfig } from '../../src/cache/RedisCacheOptions.js';
import { readStableObservationOptionsFromConfig } from '../../src/cluster/bootstrap/StableObservationOptions.js';
import {
  readClusterBootstrapDefaultsFromConfig,
  readClusterBootstrapDiscoveryFromConfig,
} from '../../src/cluster/ClusterBootstrapOptions.js';
import { readClusterClientOptionsFromConfig } from '../../src/cluster/ClusterClientOptions.js';
import { readClusterClientReceptionistOptionsFromConfig } from '../../src/cluster/ClusterClientReceptionistOptions.js';
import { isRemoteTlsRequested, readClusterOptionsFromConfig } from '../../src/cluster/ClusterOptions.js';
import { readDowningFromConfig } from '../../src/cluster/downing/DowningFromConfig.js';
import { readSplitBrainResolverOptionsFromConfig } from '../../src/cluster/downing/SplitBrainResolverOptions.js';
import { readDistributedPubSubOptionsFromConfig } from '../../src/cluster/pubsub/DistributedPubSubOptions.js';
import { readShardedDaemonProcessOptionsFromConfig } from '../../src/cluster/sharding/ShardedDaemonProcessOptions.js';
import { readShardingOptionsFromConfig } from '../../src/cluster/sharding/StartShardingOptions.js';
import { readSingletonOptionsFromConfig } from '../../src/cluster/singleton/StartSingletonOptions.js';
import type { Config } from '../../src/config/Config.js';
import { ConfigKeys } from '../../src/config/ConfigKeys.js';
import type { ConfigValue } from '../../src/config/HoconParser.js';
import { readLeaseOptionsFromConfig } from '../../src/coordination/LeaseOptions.js';
import { readKubernetesLeaseOptionsFromConfig } from '../../src/coordination/leases/KubernetesLeaseOptions.js';
import { readCoordinatedShutdownOptionsFromConfig } from '../../src/CoordinatedShutdown.js';
import { readDistributedDataOptionsFromConfig } from '../../src/crdt/DistributedDataOptions.js';
import { readDeadLetterQueueOptionsFromConfig } from '../../src/deadletters/DeadLetterQueueOptions.js';
import { readConsumerControllerOptionsFromConfig } from '../../src/delivery/ConsumerControllerOptions.js';
import { readProducerControllerOptionsFromConfig } from '../../src/delivery/ProducerControllerOptions.js';
import { readDevToolsOptionsFromConfig } from '../../src/devtools/DevToolsOptions.js';
import { readDiagnosticsOptionsFromConfig } from '../../src/diagnostics/DiagnosticsOptions.js';
import { readMessageBoundaryOptionsFromConfig } from '../../src/diagnostics/MessageBoundaryOptions.js';
import { readAutoDiscoveryOptionsFromConfig } from '../../src/discovery/AutoDiscoveryOptions.js';
import { readReceptionistOptionsFromConfig } from '../../src/discovery/ReceptionistOptions.js';
import {
  readHttpBackendFromConfig,
  readHttpClientOptionsFromConfig,
  readHttpServerOptionsFromConfig,
  readHttpShutdownGracePeriodFromConfig,
} from '../../src/http/HttpExtension.js';
import { readCorsOptionsFromConfig } from '../../src/http/middleware/Cors.js';
import { readHstsOptionsFromConfig } from '../../src/http/middleware/Hsts.js';
import { readRequestTimeoutOptionsFromConfig } from '../../src/http/middleware/Timeout.js';
import { readWebsocketPolicyOptionsFromConfig } from '../../src/http/websocket/WebsocketPolicy.js';
import { readAmqpOptionsFromConfig } from '../../src/io/broker/AmqpActor.js';
import { readBrokerCommonOptionsFromConfig } from '../../src/io/broker/BrokerActor.js';
import { brokerCommonKeysUnder } from '../../src/io/broker/BrokerOptions.js';
import { readEmailBridgeOptionsFromConfig } from '../../src/io/broker/EmailBridgeActor.js';
import { readGrpcClientOptionsFromConfig } from '../../src/io/broker/GrpcClientActor.js';
import { readGrpcServerOptionsFromConfig } from '../../src/io/broker/GrpcServerActor.js';
import { readJetStreamOptionsFromConfig } from '../../src/io/broker/JetStreamActor.js';
import { readJetStreamKeyValueOptionsFromConfig } from '../../src/io/broker/JetStreamKeyValueActor.js';
import { readJetStreamObjectStoreOptionsFromConfig } from '../../src/io/broker/JetStreamObjectStoreActor.js';
import { readKafkaOptionsFromConfig } from '../../src/io/broker/KafkaActor.js';
import { readNatsOptionsFromConfig } from '../../src/io/broker/NatsActor.js';
import { readRedisStreamsOptionsFromConfig } from '../../src/io/broker/RedisStreamsActor.js';
import { readSseOptionsFromConfig } from '../../src/io/broker/SseActor.js';
import { readTcpServerOptionsFromConfig } from '../../src/io/broker/TcpServerActor.js';
import { readTcpSocketOptionsFromConfig } from '../../src/io/broker/TcpSocketActor.js';
import { readUdpSocketOptionsFromConfig } from '../../src/io/broker/UdpSocketActor.js';
import { isConsoleSinkEnabled, readConsoleSinkOptionsFromConfig } from '../../src/logging/ConsoleSinkOptions.js';
import { readDeliveryOptionsFromConfig } from '../../src/logging/DeliveryOptions.js';
import { isFileSinkEnabled, readFileSinkOptionsFromConfig } from '../../src/logging/FileSinkOptions.js';
import { isGelfSinkEnabled, readGelfSinkOptionsFromConfig } from '../../src/logging/GelfSinkOptions.js';
import { readLoggerLevelFromConfig } from '../../src/logging/LoggerFromConfig.js';
import { isLokiSinkEnabled, readLokiSinkOptionsFromConfig } from '../../src/logging/LokiSinkOptions.js';
import { isOtlpSinkEnabled, readOtlpSinkOptionsFromConfig } from '../../src/logging/OtlpHttpSinkOptions.js';
import { isParseableSinkEnabled, readParseableSinkOptionsFromConfig } from '../../src/logging/ParseableSinkOptions.js';
import { isSeqSinkEnabled, readSeqSinkOptionsFromConfig } from '../../src/logging/SeqSinkOptions.js';
import { isSplunkSinkEnabled, readSplunkSinkOptionsFromConfig } from '../../src/logging/SplunkSinkOptions.js';
import { isSyslogSinkEnabled, readSyslogSinkOptionsFromConfig } from '../../src/logging/SyslogSinkOptions.js';
import { readHealthCheckRegistryOptionsFromConfig } from '../../src/management/HealthCheckRegistryOptions.js';
import { readManagementRoutesOptionsFromConfig } from '../../src/management/ManagementRoutesOptions.js';
import { readParallelismOptionsFromConfig } from '../../src/parallelism/ParallelismOptions.js';
import { readBackoffSupervisorOptionsFromConfig } from '../../src/pattern/BackoffSupervisorOptions.js';
import { readCircuitBreakerOptionsFromConfig } from '../../src/pattern/CircuitBreakerOptions.js';
import {
  readCassandraJournalOptionsFromConfig,
  readCassandraSnapshotStoreOptionsFromConfig,
} from '../../src/persistence/journals/CassandraPluginOptions.js';
import {
  readD1DurableStateStoreOptionsFromConfig,
  readD1JournalOptionsFromConfig,
  readD1SnapshotStoreOptionsFromConfig,
} from '../../src/persistence/journals/D1PluginOptions.js';
import {
  readDynamoDbDurableStateStoreOptionsFromConfig,
  readDynamoDbJournalOptionsFromConfig,
  readDynamoDbSnapshotStoreOptionsFromConfig,
} from '../../src/persistence/journals/DynamoDbPluginOptions.js';
import {
  readLibSqlDurableStateStoreOptionsFromConfig,
  readLibSqlJournalOptionsFromConfig,
  readLibSqlSnapshotStoreOptionsFromConfig,
} from '../../src/persistence/journals/LibSqlPluginOptions.js';
import {
  readMariaDbDurableStateStoreOptionsFromConfig,
  readMariaDbJournalOptionsFromConfig,
  readMariaDbSnapshotStoreOptionsFromConfig,
} from '../../src/persistence/journals/MariaDbPluginOptions.js';
import {
  readMongoDurableStateStoreOptionsFromConfig,
  readMongoJournalOptionsFromConfig,
  readMongoSnapshotStoreOptionsFromConfig,
} from '../../src/persistence/journals/MongoPluginOptions.js';
import {
  readMsSqlDurableStateStoreOptionsFromConfig,
  readMsSqlJournalOptionsFromConfig,
  readMsSqlSnapshotStoreOptionsFromConfig,
} from '../../src/persistence/journals/MsSqlPluginOptions.js';
import {
  readPostgresDurableStateStoreOptionsFromConfig,
  readPostgresJournalOptionsFromConfig,
  readPostgresSnapshotStoreOptionsFromConfig,
} from '../../src/persistence/journals/PostgresPluginOptions.js';
import {
  readSqliteDurableStateStoreOptionsFromConfig,
  readSqliteJournalOptionsFromConfig,
  readSqliteSnapshotStoreOptionsFromConfig,
} from '../../src/persistence/journals/SqlitePluginOptions.js';
import { readObjectStoragePluginOptionsFromConfig } from '../../src/persistence/object-storage/ObjectStoragePluginOptions.js';
import { readPersistenceBehaviorOptionsFromConfig } from '../../src/persistence/PersistenceBehaviorOptions.js';
import { readPersistencePluginIdsFromConfig } from '../../src/persistence/PersistenceExtension.js';
import { readProjectionOptionsFromConfig } from '../../src/persistence/projection/ProjectionOptions.js';
import { readInMemorySnapshotStoreOptionsFromConfig } from '../../src/persistence/snapshot-stores/InMemorySnapshotStoreOptions.js';
import { readReadConstraintsOptionsFromConfig } from '../../src/serialization/ReadConstraintsOptions.js';
import { readOffloadPoolOptionsFromConfig } from '../../src/worker/OffloadPoolOptions.js';
import { readWorkerClusterOptionsFromConfig } from '../../src/worker/WorkerClusterOptions.js';
import { readWorkerMeshOptionsFromConfig } from '../../src/worker/WorkerMeshOptions.js';

/**
 * Every function that reads `reference.conf` into what the framework runs
 * with, one entry per reader — the set the dead-key gate
 * (`tests/unit/config/NoDeadConfigKeys.test.ts`) perturbs every leaf against
 * (#1425).
 *
 * A static module rather than something each suite registers into: under
 * `bun test --parallel` every file runs isolated, so a suite cannot reach
 * another file's module state.  Each entry instead names the suite whose
 * exact-object cases bind its reader, and the gate checks that the file still
 * names it.  Adding a reader is therefore two edits that travel together: an
 * entry here, and the exact-object suite it names.  A key such a reader reads
 * that `reference.conf` does not publish goes into its section's unpublished
 * leaves, so the gate sets it at all.
 *
 * Sectioned by the top-level `actor-ts.*` block a reader serves, in
 * `reference.conf` order, so a change to one block touches one section.
 */

/** A selector overlay a reader only reads some of its leaves under. */
export type ReaderContext = {
  readonly name: string;
  /** Dotted leaf path → value: the selector, and the companion leaves the branch needs to read at all. */
  readonly overlay: Readonly<Record<string, ConfigValue>>;
};

export type ReaderEntry = {
  /** The exported function the entry runs — the name its suite has to carry. */
  readonly name: string;
  /** What tells two entries of one reader apart (the block root it is handed). */
  readonly variant?: string;
  readonly read: (config: Config) => unknown;
  /** The test file, from the repository root, whose exact-object cases bind this reader. */
  readonly suite: string;
  /** Branches the reference config does not select, each run as a probe of its own. */
  readonly contexts?: readonly ReaderContext[];
};

/**
 * A key a registered reader reads that `reference.conf` does not publish —
 * documented elsewhere, or deliberately left to code.  The gate perturbs
 * published leaves, so it would never set one of these; it introduces each at
 * `value` instead, and a reader has to answer to it as to any other leaf.
 */
export type UnpublishedLeaf = {
  readonly value: ConfigValue;
  readonly reason: string;
};

const CORE_SUITE = 'tests/unit/config/CoreConfigDefaults.test.ts';
const LOGGER_SUITE = 'tests/unit/logging/LoggerSinkConfigDefaults.test.ts';
const PERSISTENCE_SUITE = 'tests/unit/config/PersistenceConfigDefaults.test.ts';

/* ----------------------------- actor-ts.system ----------------------------- */

const systemReaders: readonly ReaderEntry[] = [
  { name: 'readSystemNameFromConfig', read: readSystemNameFromConfig, suite: CORE_SUITE },
  { name: 'readShutdownDrainTimeoutFromConfig', read: readShutdownDrainTimeoutFromConfig, suite: CORE_SUITE },
];

/* ----------------------------- actor-ts.logger ----------------------------- */

/** The sinks with a `delivery` block — every one but the console, which writes synchronously. */
const DELIVERING_SINKS = ['file', 'gelf', 'otlp', 'loki', 'parseable', 'seq', 'splunk', 'syslog'] as const;

const loggerReaders: readonly ReaderEntry[] = [
  { name: 'readLoggerLevelFromConfig', read: readLoggerLevelFromConfig, suite: LOGGER_SUITE },
  { name: 'readLoggerCloseTimeoutFromConfig', read: readLoggerCloseTimeoutFromConfig, suite: CORE_SUITE },
  { name: 'isConsoleSinkEnabled', read: isConsoleSinkEnabled, suite: LOGGER_SUITE },
  { name: 'readConsoleSinkOptionsFromConfig', read: readConsoleSinkOptionsFromConfig, suite: LOGGER_SUITE },
  { name: 'isFileSinkEnabled', read: isFileSinkEnabled, suite: LOGGER_SUITE },
  { name: 'readFileSinkOptionsFromConfig', read: readFileSinkOptionsFromConfig, suite: LOGGER_SUITE },
  { name: 'isGelfSinkEnabled', read: isGelfSinkEnabled, suite: LOGGER_SUITE },
  { name: 'readGelfSinkOptionsFromConfig', read: readGelfSinkOptionsFromConfig, suite: LOGGER_SUITE },
  { name: 'isOtlpSinkEnabled', read: isOtlpSinkEnabled, suite: LOGGER_SUITE },
  { name: 'readOtlpSinkOptionsFromConfig', read: readOtlpSinkOptionsFromConfig, suite: LOGGER_SUITE },
  { name: 'isLokiSinkEnabled', read: isLokiSinkEnabled, suite: LOGGER_SUITE },
  { name: 'readLokiSinkOptionsFromConfig', read: readLokiSinkOptionsFromConfig, suite: LOGGER_SUITE },
  { name: 'isParseableSinkEnabled', read: isParseableSinkEnabled, suite: LOGGER_SUITE },
  { name: 'readParseableSinkOptionsFromConfig', read: readParseableSinkOptionsFromConfig, suite: LOGGER_SUITE },
  { name: 'isSeqSinkEnabled', read: isSeqSinkEnabled, suite: LOGGER_SUITE },
  { name: 'readSeqSinkOptionsFromConfig', read: readSeqSinkOptionsFromConfig, suite: LOGGER_SUITE },
  { name: 'isSplunkSinkEnabled', read: isSplunkSinkEnabled, suite: LOGGER_SUITE },
  { name: 'readSplunkSinkOptionsFromConfig', read: readSplunkSinkOptionsFromConfig, suite: LOGGER_SUITE },
  { name: 'isSyslogSinkEnabled', read: isSyslogSinkEnabled, suite: LOGGER_SUITE },
  { name: 'readSyslogSinkOptionsFromConfig', read: readSyslogSinkOptionsFromConfig, suite: LOGGER_SUITE },
  // One shared reader, handed each sink's block root by that sink's reader.
  ...DELIVERING_SINKS.map((sink): ReaderEntry => ({
    name: 'readDeliveryOptionsFromConfig',
    variant: sink,
    read: (config) => readDeliveryOptionsFromConfig(config, `actor-ts.logger.sinks.${sink}`),
    suite: LOGGER_SUITE,
  })),
];

const RETRY_TEMPLATE = 'the retry and backoff tunables of a sink\'s delivery block are documented as a template '
  + '(observability/logging/multi-sink) rather than shipped in every sink\'s block';

const loggerUnpublishedLeaves: ReadonlyArray<readonly [string, UnpublishedLeaf]> = DELIVERING_SINKS.flatMap((sink) => {
  const delivery = `actor-ts.logger.sinks.${sink}.delivery`;
  const leaves: Array<readonly [string, UnpublishedLeaf]> = [
    [`${delivery}.max-retries`, { value: 3, reason: RETRY_TEMPLATE }],
    [`${delivery}.min-backoff`, { value: '250ms', reason: RETRY_TEMPLATE }],
    [`${delivery}.max-backoff`, { value: '10s', reason: RETRY_TEMPLATE }],
    [`${delivery}.random-factor`, { value: 0.3, reason: RETRY_TEMPLATE }],
  ];
  if (sink !== 'file') {
    leaves.push([`${delivery}.overflow`, {
      value: 'drop-head',
      reason: 'only the file sink ships overflow; a network sink keeps the built-in drop-new unless one is written',
    }]);
  }
  return leaves;
});

/* ------------------- actor-ts.actor / mailbox / dispatcher ------------------- */

const actorReaders: readonly ReaderEntry[] = [
  { name: 'readActorThroughputFromConfig', read: readActorThroughputFromConfig, suite: CORE_SUITE },
  { name: 'readAskTimeoutFromConfig', read: readAskTimeoutFromConfig, suite: CORE_SUITE },
  { name: 'readDefaultMailboxFromConfig', read: readDefaultMailboxFromConfig, suite: CORE_SUITE },
  {
    name: 'readDispatcherOptionsFromConfig',
    read: readDispatcherOptionsFromConfig,
    suite: CORE_SUITE,
    // `throughput` is read under the throughput dispatcher only.
    contexts: [{ name: 'throughput', overlay: { 'actor-ts.dispatcher.default': 'throughput' } }],
  },
];

/* ---------------------- actor-ts.dead-letters / diagnostics ---------------------- */

const diagnosticsReaders: readonly ReaderEntry[] = [
  {
    name: 'readDeadLetterQueueOptionsFromConfig',
    read: readDeadLetterQueueOptionsFromConfig,
    suite: 'tests/unit/deadletters/DeadLetterQueueOptions.test.ts',
  },
  {
    name: 'readDiagnosticsOptionsFromConfig',
    read: readDiagnosticsOptionsFromConfig,
    suite: 'tests/unit/diagnostics/DiagnosticsConfigDefaults.test.ts',
  },
  {
    name: 'readMessageBoundaryOptionsFromConfig',
    read: readMessageBoundaryOptionsFromConfig,
    suite: 'tests/unit/diagnostics/MessageBoundary.test.ts',
  },
];

/* ----------------------------- actor-ts.cluster ----------------------------- */

const clusterReaders: readonly ReaderEntry[] = [
  {
    name: 'readClusterOptionsFromConfig',
    read: readClusterOptionsFromConfig,
    suite: 'tests/unit/cluster/ClusterConfigDefaults.test.ts',
  },
  { name: 'isRemoteTlsRequested', read: isRemoteTlsRequested, suite: 'tests/unit/cluster/ClusterConfigDefaults.test.ts' },
  {
    name: 'readDowningFromConfig',
    read: readDowningFromConfig,
    suite: 'tests/unit/cluster/downing/DowningFromConfig.test.ts',
    // reference.conf ships `active-strategy = off`, under which no strategy's
    // own leaves are read at all.
    contexts: [
      { name: 'keep-majority', overlay: { 'actor-ts.cluster.split-brain-resolver.active-strategy': 'keep-majority' } },
      { name: 'keep-oldest', overlay: { 'actor-ts.cluster.split-brain-resolver.active-strategy': 'keep-oldest' } },
      {
        name: 'static-quorum',
        overlay: {
          'actor-ts.cluster.split-brain-resolver.active-strategy': 'static-quorum',
          // Comment-only in reference.conf, and required: without it the
          // strategy refuses to build and the context reads nothing.
          'actor-ts.cluster.split-brain-resolver.static-quorum.quorum-size': 3,
        },
      },
    ],
  },
  {
    name: 'readSplitBrainResolverOptionsFromConfig',
    read: readSplitBrainResolverOptionsFromConfig,
    suite: 'tests/unit/cluster/SplitBrainStabilityWindow.test.ts',
  },
  {
    name: 'readClusterBootstrapDefaultsFromConfig',
    read: readClusterBootstrapDefaultsFromConfig,
    suite: 'tests/unit/cluster/ClusterReadiness.test.ts',
  },
  {
    name: 'readClusterBootstrapDiscoveryFromConfig',
    read: readClusterBootstrapDiscoveryFromConfig,
    suite: 'tests/unit/discovery/DiscoveryConfigDefaults.test.ts',
  },
  {
    name: 'readStableObservationOptionsFromConfig',
    read: readStableObservationOptionsFromConfig,
    suite: 'tests/unit/cluster/StableObservation.test.ts',
  },
  {
    name: 'readClusterClientOptionsFromConfig',
    read: readClusterClientOptionsFromConfig,
    suite: 'tests/unit/config/ClusterClientConfigDefaults.test.ts',
  },
  {
    name: 'readClusterClientReceptionistOptionsFromConfig',
    read: readClusterClientReceptionistOptionsFromConfig,
    suite: 'tests/unit/config/ClusterClientConfigDefaults.test.ts',
  },
  {
    name: 'readDistributedPubSubOptionsFromConfig',
    read: readDistributedPubSubOptionsFromConfig,
    suite: 'tests/unit/config/PubSubAndReceptionistConfigDefaults.test.ts',
  },
  {
    name: 'readReceptionistOptionsFromConfig',
    read: readReceptionistOptionsFromConfig,
    suite: 'tests/unit/config/PubSubAndReceptionistConfigDefaults.test.ts',
  },
  {
    name: 'readSingletonOptionsFromConfig',
    read: readSingletonOptionsFromConfig,
    suite: 'tests/unit/cluster/singleton/SingletonConfigDefaults.test.ts',
  },
];

/* ------------------------ actor-ts.distributed-data ------------------------ */

const distributedDataReaders: readonly ReaderEntry[] = [
  {
    name: 'readDistributedDataOptionsFromConfig',
    read: readDistributedDataOptionsFromConfig,
    suite: 'tests/unit/config/DistributedDataConfigDefaults.test.ts',
  },
];

/* ---------------------------- actor-ts.discovery ---------------------------- */

const discoveryReaders: readonly ReaderEntry[] = [
  {
    name: 'readAutoDiscoveryOptionsFromConfig',
    read: readAutoDiscoveryOptionsFromConfig,
    suite: 'tests/unit/discovery/DiscoveryConfigDefaults.test.ts',
  },
];

/* --------------------------- actor-ts.coordination --------------------------- */

const coordinationReaders: readonly ReaderEntry[] = [
  {
    name: 'readLeaseOptionsFromConfig',
    read: readLeaseOptionsFromConfig,
    suite: 'tests/unit/coordination/LeaseConfigDefaults.test.ts',
  },
  {
    name: 'readKubernetesLeaseOptionsFromConfig',
    read: readKubernetesLeaseOptionsFromConfig,
    suite: 'tests/unit/coordination/LeaseConfigDefaults.test.ts',
  },
];

const LEASE_TIMING = 'deliberately comment-only: an unset ttl is what keeps "ttlMs is required" (#596) reachable, '
  + 'and an unset renewal-interval is derived from the ttl';

const coordinationUnpublishedLeaves: ReadonlyArray<readonly [string, UnpublishedLeaf]> = [
  ['actor-ts.coordination.lease.ttl', { value: '30s', reason: LEASE_TIMING }],
  ['actor-ts.coordination.lease.renewal-interval', { value: '10s', reason: LEASE_TIMING }],
];

/* ------------------------- actor-ts.reliable-delivery ------------------------- */

const reliableDeliveryReaders: readonly ReaderEntry[] = [
  {
    name: 'readProducerControllerOptionsFromConfig',
    read: readProducerControllerOptionsFromConfig,
    suite: 'tests/unit/config/ReliableDeliveryConfigDefaults.test.ts',
  },
  {
    name: 'readConsumerControllerOptionsFromConfig',
    read: readConsumerControllerOptionsFromConfig,
    suite: 'tests/unit/config/ReliableDeliveryConfigDefaults.test.ts',
  },
];

/* --------------------------- actor-ts.serialization --------------------------- */

const serializationReaders: readonly ReaderEntry[] = [
  {
    name: 'readReadConstraintsOptionsFromConfig',
    read: readReadConstraintsOptionsFromConfig,
    suite: 'tests/unit/serialization/ReadConstraints.test.ts',
  },
];

/* ------------------------------ actor-ts.http ------------------------------ */

const HTTP_SUITE = 'tests/unit/http/HttpConfigDefaults.test.ts';

const httpReaders: readonly ReaderEntry[] = [
  { name: 'readHttpBackendFromConfig', read: readHttpBackendFromConfig, suite: HTTP_SUITE },
  { name: 'readHttpShutdownGracePeriodFromConfig', read: readHttpShutdownGracePeriodFromConfig, suite: HTTP_SUITE },
  { name: 'readHttpServerOptionsFromConfig', read: readHttpServerOptionsFromConfig, suite: HTTP_SUITE },
  { name: 'readHttpClientOptionsFromConfig', read: readHttpClientOptionsFromConfig, suite: HTTP_SUITE },
  { name: 'readCorsOptionsFromConfig', read: readCorsOptionsFromConfig, suite: HTTP_SUITE },
  { name: 'readHstsOptionsFromConfig', read: readHstsOptionsFromConfig, suite: HTTP_SUITE },
  { name: 'readRequestTimeoutOptionsFromConfig', read: readRequestTimeoutOptionsFromConfig, suite: HTTP_SUITE },
  {
    name: 'readWebsocketPolicyOptionsFromConfig',
    read: readWebsocketPolicyOptionsFromConfig,
    suite: 'tests/unit/http/websocket/WebsocketPolicy.test.ts',
  },
];

/* ------------------------- actor-ts.circuit-breaker ------------------------- */

const circuitBreakerReaders: readonly ReaderEntry[] = [
  {
    name: 'readCircuitBreakerOptionsFromConfig',
    read: readCircuitBreakerOptionsFromConfig,
    suite: 'tests/unit/pattern/CircuitBreakerConfig.test.ts',
  },
];

/* --------------------------- actor-ts.projection --------------------------- */

const projectionReaders: readonly ReaderEntry[] = [
  {
    name: 'readProjectionOptionsFromConfig',
    read: readProjectionOptionsFromConfig,
    suite: 'tests/unit/persistence/ProjectionConfig.test.ts',
  },
];

/* ------------------------ actor-ts.backoff-supervisor ------------------------ */

const backoffSupervisorReaders: readonly ReaderEntry[] = [
  {
    name: 'readBackoffSupervisorOptionsFromConfig',
    read: readBackoffSupervisorOptionsFromConfig,
    suite: 'tests/unit/pattern/BackoffSupervisorConfig.test.ts',
  },
];

/* ------------------------------ actor-ts.cache ------------------------------ */

const cacheReaders: readonly ReaderEntry[] = [
  {
    name: 'readInMemoryCacheOptionsFromConfig',
    read: (config) => readInMemoryCacheOptionsFromConfig(config),
    suite: 'tests/unit/cache/CacheExtension.test.ts',
  },
  {
    name: 'readRedisCacheOptionsFromConfig',
    read: (config) => readRedisCacheOptionsFromConfig(config),
    suite: 'tests/unit/cache/RedisCache.test.ts',
  },
  {
    name: 'readMemcachedCacheOptionsFromConfig',
    read: (config) => readMemcachedCacheOptionsFromConfig(config),
    suite: 'tests/unit/cache/MemcachedCache.test.ts',
  },
];

/* --------------------------- actor-ts.management --------------------------- */

const managementReaders: readonly ReaderEntry[] = [
  {
    name: 'readManagementRoutesOptionsFromConfig',
    read: readManagementRoutesOptionsFromConfig,
    suite: 'tests/unit/config/ManagementConfigDefaults.test.ts',
  },
  {
    name: 'readHealthCheckRegistryOptionsFromConfig',
    read: readHealthCheckRegistryOptionsFromConfig,
    suite: 'tests/unit/config/ManagementConfigDefaults.test.ts',
  },
];

/* --------------------------- actor-ts.persistence --------------------------- */

/** The object-storage block the reference config leaves to code (`backend = ""`, `mode = "none"`). */
const OBJECT_STORAGE = 'actor-ts.persistence.snapshot-store.object-storage';

const persistenceReaders: readonly ReaderEntry[] = [
  { name: 'readPersistencePluginIdsFromConfig', read: readPersistencePluginIdsFromConfig, suite: PERSISTENCE_SUITE },
  {
    name: 'readPersistenceBehaviorOptionsFromConfig',
    read: readPersistenceBehaviorOptionsFromConfig,
    suite: 'tests/unit/config/PersistenceBehaviorConfigDefaults.test.ts',
  },
  {
    name: 'readInMemorySnapshotStoreOptionsFromConfig',
    read: (config) => readInMemorySnapshotStoreOptionsFromConfig(config),
    suite: PERSISTENCE_SUITE,
  },
  { name: 'readSqliteJournalOptionsFromConfig', read: (config) => readSqliteJournalOptionsFromConfig(config), suite: PERSISTENCE_SUITE },
  { name: 'readSqliteSnapshotStoreOptionsFromConfig', read: (config) => readSqliteSnapshotStoreOptionsFromConfig(config), suite: PERSISTENCE_SUITE },
  { name: 'readSqliteDurableStateStoreOptionsFromConfig', read: (config) => readSqliteDurableStateStoreOptionsFromConfig(config), suite: PERSISTENCE_SUITE },
  { name: 'readPostgresJournalOptionsFromConfig', read: (config) => readPostgresJournalOptionsFromConfig(config), suite: PERSISTENCE_SUITE },
  { name: 'readPostgresSnapshotStoreOptionsFromConfig', read: (config) => readPostgresSnapshotStoreOptionsFromConfig(config), suite: PERSISTENCE_SUITE },
  { name: 'readPostgresDurableStateStoreOptionsFromConfig', read: (config) => readPostgresDurableStateStoreOptionsFromConfig(config), suite: PERSISTENCE_SUITE },
  { name: 'readMariaDbJournalOptionsFromConfig', read: (config) => readMariaDbJournalOptionsFromConfig(config), suite: PERSISTENCE_SUITE },
  { name: 'readMariaDbSnapshotStoreOptionsFromConfig', read: (config) => readMariaDbSnapshotStoreOptionsFromConfig(config), suite: PERSISTENCE_SUITE },
  { name: 'readMariaDbDurableStateStoreOptionsFromConfig', read: (config) => readMariaDbDurableStateStoreOptionsFromConfig(config), suite: PERSISTENCE_SUITE },
  { name: 'readMsSqlJournalOptionsFromConfig', read: (config) => readMsSqlJournalOptionsFromConfig(config), suite: PERSISTENCE_SUITE },
  { name: 'readMsSqlSnapshotStoreOptionsFromConfig', read: (config) => readMsSqlSnapshotStoreOptionsFromConfig(config), suite: PERSISTENCE_SUITE },
  { name: 'readMsSqlDurableStateStoreOptionsFromConfig', read: (config) => readMsSqlDurableStateStoreOptionsFromConfig(config), suite: PERSISTENCE_SUITE },
  { name: 'readLibSqlJournalOptionsFromConfig', read: (config) => readLibSqlJournalOptionsFromConfig(config), suite: PERSISTENCE_SUITE },
  { name: 'readLibSqlSnapshotStoreOptionsFromConfig', read: (config) => readLibSqlSnapshotStoreOptionsFromConfig(config), suite: PERSISTENCE_SUITE },
  { name: 'readLibSqlDurableStateStoreOptionsFromConfig', read: (config) => readLibSqlDurableStateStoreOptionsFromConfig(config), suite: PERSISTENCE_SUITE },
  { name: 'readD1JournalOptionsFromConfig', read: (config) => readD1JournalOptionsFromConfig(config), suite: PERSISTENCE_SUITE },
  { name: 'readD1SnapshotStoreOptionsFromConfig', read: (config) => readD1SnapshotStoreOptionsFromConfig(config), suite: PERSISTENCE_SUITE },
  { name: 'readD1DurableStateStoreOptionsFromConfig', read: (config) => readD1DurableStateStoreOptionsFromConfig(config), suite: PERSISTENCE_SUITE },
  { name: 'readMongoJournalOptionsFromConfig', read: (config) => readMongoJournalOptionsFromConfig(config), suite: PERSISTENCE_SUITE },
  { name: 'readMongoSnapshotStoreOptionsFromConfig', read: (config) => readMongoSnapshotStoreOptionsFromConfig(config), suite: PERSISTENCE_SUITE },
  { name: 'readMongoDurableStateStoreOptionsFromConfig', read: (config) => readMongoDurableStateStoreOptionsFromConfig(config), suite: PERSISTENCE_SUITE },
  { name: 'readDynamoDbJournalOptionsFromConfig', read: (config) => readDynamoDbJournalOptionsFromConfig(config), suite: PERSISTENCE_SUITE },
  { name: 'readDynamoDbSnapshotStoreOptionsFromConfig', read: (config) => readDynamoDbSnapshotStoreOptionsFromConfig(config), suite: PERSISTENCE_SUITE },
  { name: 'readDynamoDbDurableStateStoreOptionsFromConfig', read: (config) => readDynamoDbDurableStateStoreOptionsFromConfig(config), suite: PERSISTENCE_SUITE },
  { name: 'readCassandraJournalOptionsFromConfig', read: (config) => readCassandraJournalOptionsFromConfig(config), suite: PERSISTENCE_SUITE },
  { name: 'readCassandraSnapshotStoreOptionsFromConfig', read: (config) => readCassandraSnapshotStoreOptionsFromConfig(config), suite: PERSISTENCE_SUITE },
  {
    name: 'readObjectStoragePluginOptionsFromConfig',
    read: readObjectStoragePluginOptionsFromConfig,
    suite: 'tests/unit/config/ObjectStorageConfigDefaults.test.ts',
    // reference.conf leaves the backend to code and encryption off, so the
    // leaves of both backends and the KMS key id are read only once selected.
    contexts: [
      { name: 's3', overlay: { [`${OBJECT_STORAGE}.backend`]: 's3' } },
      { name: 'filesystem', overlay: { [`${OBJECT_STORAGE}.backend`]: 'filesystem' } },
      { name: 'sse-kms', overlay: { [`${OBJECT_STORAGE}.encryption.mode`]: 'sse-kms' } },
    ],
  },
];

/* ---------------------- actor-ts.sharding / sharded-daemon-process ---------------------- */

const shardingReaders: readonly ReaderEntry[] = [
  {
    name: 'readShardingOptionsFromConfig',
    read: readShardingOptionsFromConfig,
    suite: 'tests/unit/cluster/sharding/ShardingConfigDefaults.test.ts',
  },
  {
    name: 'readShardedDaemonProcessOptionsFromConfig',
    read: readShardedDaemonProcessOptionsFromConfig,
    suite: 'tests/unit/cluster/sharding/ShardedDaemonProcessConfigDefaults.test.ts',
  },
];

/* ----------------------------- actor-ts.devtools ----------------------------- */

const devToolsReaders: readonly ReaderEntry[] = [
  {
    name: 'readDevToolsOptionsFromConfig',
    read: readDevToolsOptionsFromConfig,
    suite: 'tests/unit/config/DevToolsConfigDefaults.test.ts',
  },
];

/* ---------------- actor-ts.parallelism / offload-pool / worker-* ---------------- */

const workerReaders: readonly ReaderEntry[] = [
  {
    name: 'readParallelismOptionsFromConfig',
    read: readParallelismOptionsFromConfig,
    suite: 'tests/unit/parallelism/ParallelismOptions.test.ts',
  },
  {
    name: 'readOffloadPoolOptionsFromConfig',
    read: readOffloadPoolOptionsFromConfig,
    suite: 'tests/unit/worker/OffloadPool.test.ts',
  },
  {
    name: 'readWorkerClusterOptionsFromConfig',
    read: readWorkerClusterOptionsFromConfig,
    suite: 'tests/unit/config/SystemShutdownWorkerConfig.test.ts',
  },
  {
    name: 'readWorkerMeshOptionsFromConfig',
    read: readWorkerMeshOptionsFromConfig,
    suite: 'tests/unit/config/SystemShutdownWorkerConfig.test.ts',
  },
];

/* ------------------------ actor-ts.coordinated-shutdown ------------------------ */

const coordinatedShutdownReaders: readonly ReaderEntry[] = [
  { name: 'readCoordinatedShutdownOptionsFromConfig', read: readCoordinatedShutdownOptionsFromConfig, suite: CORE_SUITE },
];

/* ----------------------------- actor-ts.io.broker ----------------------------- */

/*
 * No `actor-ts.io` block ships in `reference.conf` (#871): a broker key is
 * required or unset, with no default worth publishing.  So every broker leaf
 * the gate sees is introduced, never perturbed — which is also why each
 * reader needs at least one leaf listed here, or it would observe nothing.
 */

const BROKER_SUITE = 'tests/unit/io/broker/BrokerConfigReaders.test.ts';

const BROKER_BLOCK = 'reference.conf publishes no actor-ts.io block: every broker key is required or unset (#871)';

/**
 * The shared leaves under one broker's root.  One root stands for all of them:
 * the reader composes the same paths under whichever root it is handed.
 */
const kafkaCommonKeys = brokerCommonKeysUnder(ConfigKeys.io.broker.kafka.root);

const brokerReaders: readonly ReaderEntry[] = [
  {
    name: 'readBrokerCommonOptionsFromConfig',
    read: (config) => readBrokerCommonOptionsFromConfig(config, kafkaCommonKeys),
    suite: BROKER_SUITE,
  },
  { name: 'readAmqpOptionsFromConfig', read: (config) => readAmqpOptionsFromConfig(config), suite: BROKER_SUITE },
  {
    name: 'readEmailBridgeOptionsFromConfig',
    read: (config) => readEmailBridgeOptionsFromConfig(config),
    suite: BROKER_SUITE,
  },
  { name: 'readGrpcClientOptionsFromConfig', read: (config) => readGrpcClientOptionsFromConfig(config), suite: BROKER_SUITE },
  { name: 'readGrpcServerOptionsFromConfig', read: (config) => readGrpcServerOptionsFromConfig(config), suite: BROKER_SUITE },
  { name: 'readJetStreamOptionsFromConfig', read: (config) => readJetStreamOptionsFromConfig(config), suite: BROKER_SUITE },
  {
    name: 'readJetStreamKeyValueOptionsFromConfig',
    read: (config) => readJetStreamKeyValueOptionsFromConfig(config),
    suite: BROKER_SUITE,
  },
  {
    name: 'readJetStreamObjectStoreOptionsFromConfig',
    read: (config) => readJetStreamObjectStoreOptionsFromConfig(config),
    suite: BROKER_SUITE,
  },
  {
    name: 'readKafkaOptionsFromConfig',
    read: (config) => readKafkaOptionsFromConfig(config),
    suite: BROKER_SUITE,
    // SASL is read whole and needs all three leaves, so they are only read
    // beside each other.
    contexts: [{
      name: 'sasl',
      overlay: {
        [ConfigKeys.io.broker.kafka.sasl.mechanism]: 'plain',
        [ConfigKeys.io.broker.kafka.sasl.username]: 'svc',
        [ConfigKeys.io.broker.kafka.sasl.password]: 'pw',
      },
    }],
  },
  { name: 'readNatsOptionsFromConfig', read: (config) => readNatsOptionsFromConfig(config), suite: BROKER_SUITE },
  {
    name: 'readRedisStreamsOptionsFromConfig',
    read: (config) => readRedisStreamsOptionsFromConfig(config),
    suite: BROKER_SUITE,
    // A consumer group is read whole and needs both names, so its leaves are
    // only read beside each other.
    contexts: [{
      name: 'consumer-group',
      overlay: {
        [ConfigKeys.io.broker.redisStreams.consumerGroup.group]: 'orders',
        [ConfigKeys.io.broker.redisStreams.consumerGroup.consumer]: 'worker-1',
      },
    }],
  },
  { name: 'readSseOptionsFromConfig', read: (config) => readSseOptionsFromConfig(config), suite: BROKER_SUITE },
  { name: 'readTcpSocketOptionsFromConfig', read: (config) => readTcpSocketOptionsFromConfig(config), suite: BROKER_SUITE },
  { name: 'readTcpServerOptionsFromConfig', read: (config) => readTcpServerOptionsFromConfig(config), suite: BROKER_SUITE },
  { name: 'readUdpSocketOptionsFromConfig', read: (config) => readUdpSocketOptionsFromConfig(config), suite: BROKER_SUITE },
];

/** Broker leaves, each introduced at its value for the reason every one of them shares. */
function brokerLeaves(...leaves: ReadonlyArray<readonly [string, ConfigValue]>): Array<readonly [string, UnpublishedLeaf]> {
  return leaves.map(([leaf, value]) => [leaf, { value, reason: BROKER_BLOCK }] as const);
}

/*
 * Every leaf a broker reader can be shown to read on its own.  What is left
 * out stays bound by the exact-object cases in BROKER_SUITE alone, because the
 * gate cannot introduce it as the readers stand: a block read whole (SSE's
 * `headers`), which has no kind to perturb; the counts read with `getNumber`,
 * which takes 7.5 for one — `reconnect.max-attempts`, JetStream's
 * `stream.max-age` and its deliver-policy `start-seq` / `start-time`, without
 * which that policy's `kind` cannot be read either; and the two `circuit-breaker`
 * leaves, read as a pair — set alone, either one is refused for want of the
 * other, and the context that would set both needs keys `ConfigKeys` names,
 * which a composed path is not.
 */
const brokerUnpublishedLeaves: ReadonlyArray<readonly [string, UnpublishedLeaf]> = [
  ...brokerLeaves(
    [kafkaCommonKeys.reconnect.initialDelay, '250ms'],
    [kafkaCommonKeys.reconnect.maxDelay, '20s'],
    [kafkaCommonKeys.reconnect.factor, 1.5],
    [kafkaCommonKeys.reconnect.randomFactor, 0.25],
    [kafkaCommonKeys.outboundBuffer, 42],
  ),
  ...brokerLeaves(
    [ConfigKeys.io.broker.amqp.url, 'amqp://mq.local:5672'],
    [ConfigKeys.io.broker.amqp.prefetch, 16],
    [ConfigKeys.io.broker.amqp.autoAcknowledge, false],
  ),
  ...brokerLeaves(
    [ConfigKeys.io.broker.emailBridge.imap.host, 'imap.local'],
    [ConfigKeys.io.broker.emailBridge.imap.port, 993],
    [ConfigKeys.io.broker.emailBridge.imap.secure, false],
    [ConfigKeys.io.broker.emailBridge.imap.user, 'reader'],
    [ConfigKeys.io.broker.emailBridge.imap.password, 'pw'],
    [ConfigKeys.io.broker.emailBridge.imap.mailbox, 'Watched'],
    [ConfigKeys.io.broker.emailBridge.imap.onProcessed, 'move'],
    [ConfigKeys.io.broker.emailBridge.imap.moveToMailbox, 'Archive'],
    [ConfigKeys.io.broker.emailBridge.imap.disableIdle, true],
    [ConfigKeys.io.broker.emailBridge.imap.maxIdleTime, '5m'],
    [ConfigKeys.io.broker.emailBridge.imap.pollInterval, '30s'],
    [ConfigKeys.io.broker.emailBridge.imap.maxMessageBytes, '25M'],
    [ConfigKeys.io.broker.emailBridge.imap.acknowledgmentTimeout, '45s'],
    [ConfigKeys.io.broker.emailBridge.smtp.host, 'smtp.local'],
    [ConfigKeys.io.broker.emailBridge.smtp.port, 587],
    [ConfigKeys.io.broker.emailBridge.smtp.secure, true],
    [ConfigKeys.io.broker.emailBridge.smtp.user, 'sender'],
    [ConfigKeys.io.broker.emailBridge.smtp.password, 'pw2'],
    [ConfigKeys.io.broker.emailBridge.smtp.from, 'alerts@example.test'],
    [ConfigKeys.io.broker.emailBridge.smtp.maxConnections, 5],
    [ConfigKeys.io.broker.emailBridge.smtp.maxMessages, 100],
  ),
  // `proto-path` takes a string or a list, so it is introduced as the string
  // the docs write: as a list, the string the gate offers to tell a list
  // reader apart would be taken too.
  ...brokerLeaves(
    [ConfigKeys.io.broker.grpc.client.protoPath, './service.proto'],
    [ConfigKeys.io.broker.grpc.client.packageName, 'orders.v1'],
    [ConfigKeys.io.broker.grpc.client.serviceName, 'Orders'],
    [ConfigKeys.io.broker.grpc.client.endpoint, 'orders.local:50051'],
    [ConfigKeys.io.broker.grpc.client.deadline, '2s'],
    [ConfigKeys.io.broker.grpc.server.protoPath, './service.proto'],
    [ConfigKeys.io.broker.grpc.server.packageName, 'orders.v1'],
    [ConfigKeys.io.broker.grpc.server.serviceName, 'Orders'],
    [ConfigKeys.io.broker.grpc.server.bind, '0.0.0.0:50051'],
  ),
  ...brokerLeaves(
    [ConfigKeys.io.broker.jetstream.servers, ['nats://a:4222']],
    [ConfigKeys.io.broker.jetstream.token, 't0k3n'],
    [ConfigKeys.io.broker.jetstream.user, 'bridge'],
    [ConfigKeys.io.broker.jetstream.password, 's3cret'],
    [ConfigKeys.io.broker.jetstream.name, 'orders-bridge'],
    [ConfigKeys.io.broker.jetstream.stream.name, 'ORDERS'],
    [ConfigKeys.io.broker.jetstream.stream.subjects, ['orders.>']],
    [ConfigKeys.io.broker.jetstream.stream.retention, 'workqueue'],
    [ConfigKeys.io.broker.jetstream.stream.storage, 'file'],
    [ConfigKeys.io.broker.jetstream.stream.maxMessages, 1000],
    [ConfigKeys.io.broker.jetstream.stream.maxBytes, '1G'],
    [ConfigKeys.io.broker.jetstream.stream.create, false],
    [ConfigKeys.io.broker.jetstream.consumer.durable, 'order-processor'],
    [ConfigKeys.io.broker.jetstream.consumer.mode, 'pull'],
    [ConfigKeys.io.broker.jetstream.consumer.deliverPolicy.root, 'last'],
    [ConfigKeys.io.broker.jetstream.consumer.ackPolicy, 'explicit'],
    [ConfigKeys.io.broker.jetstream.consumer.ackWait, '45s'],
    [ConfigKeys.io.broker.jetstream.consumer.filterSubject, 'orders.new'],
    [ConfigKeys.io.broker.jetstream.consumer.maxAcknowledgmentPending, 64],
    [ConfigKeys.io.broker.jetstream.consumer.create, false],
    [ConfigKeys.io.broker.jetstream.acknowledgmentTimeout, '2m'],
  ),
  ...brokerLeaves(
    [ConfigKeys.io.broker.jetstreamKeyValue.servers, ['nats://a:4222']],
    [ConfigKeys.io.broker.jetstreamKeyValue.token, 't0k3n'],
    [ConfigKeys.io.broker.jetstreamKeyValue.user, 'bridge'],
    [ConfigKeys.io.broker.jetstreamKeyValue.password, 's3cret'],
    [ConfigKeys.io.broker.jetstreamKeyValue.name, 'sessions-bridge'],
    [ConfigKeys.io.broker.jetstreamKeyValue.bucket, 'sessions'],
    [ConfigKeys.io.broker.jetstreamKeyValue.history, 5],
    [ConfigKeys.io.broker.jetstreamKeyValue.timeToLive, '1h'],
    [ConfigKeys.io.broker.jetstreamKeyValue.storage, 'memory'],
    [ConfigKeys.io.broker.jetstreamKeyValue.replicas, 3],
    [ConfigKeys.io.broker.jetstreamKeyValue.maxValueBytes, '64K'],
    [ConfigKeys.io.broker.jetstreamKeyValue.create, false],
  ),
  ...brokerLeaves(
    [ConfigKeys.io.broker.jetstreamObjectStore.servers, ['nats://a:4222']],
    [ConfigKeys.io.broker.jetstreamObjectStore.token, 't0k3n'],
    [ConfigKeys.io.broker.jetstreamObjectStore.user, 'bridge'],
    [ConfigKeys.io.broker.jetstreamObjectStore.password, 's3cret'],
    [ConfigKeys.io.broker.jetstreamObjectStore.name, 'assets-bridge'],
    [ConfigKeys.io.broker.jetstreamObjectStore.bucket, 'assets'],
    [ConfigKeys.io.broker.jetstreamObjectStore.description, 'build artefacts'],
    [ConfigKeys.io.broker.jetstreamObjectStore.storage, 'file'],
    [ConfigKeys.io.broker.jetstreamObjectStore.replicas, 3],
    [ConfigKeys.io.broker.jetstreamObjectStore.maxObjectBytes, '4M'],
    [ConfigKeys.io.broker.jetstreamObjectStore.create, false],
  ),
  ...brokerLeaves(
    [ConfigKeys.io.broker.kafka.brokers, ['kafka.local:9092']],
    [ConfigKeys.io.broker.kafka.clientId, 'orders-service'],
    [ConfigKeys.io.broker.kafka.ssl, true],
    [ConfigKeys.io.broker.kafka.sasl.mechanism, 'scram-sha-256'],
    [ConfigKeys.io.broker.kafka.sasl.username, 'orders'],
    [ConfigKeys.io.broker.kafka.sasl.password, 's3cret'],
    [ConfigKeys.io.broker.kafka.producer.idempotent, true],
    [ConfigKeys.io.broker.kafka.producer.allowAutoTopicCreation, true],
    [ConfigKeys.io.broker.kafka.consumer.groupId, 'orders'],
    [ConfigKeys.io.broker.kafka.consumer.fromBeginning, true],
    [ConfigKeys.io.broker.kafka.consumer.commitMode, 'manual'],
    [ConfigKeys.io.broker.kafka.consumer.commitTimeout, '5s'],
    [ConfigKeys.io.broker.kafka.topics, ['orders']],
  ),
  ...brokerLeaves(
    [ConfigKeys.io.broker.nats.servers, ['nats://a:4222']],
    [ConfigKeys.io.broker.nats.token, 't0k3n'],
    [ConfigKeys.io.broker.nats.user, 'bridge'],
    [ConfigKeys.io.broker.nats.password, 's3cret'],
    [ConfigKeys.io.broker.nats.name, 'orders-bridge'],
  ),
  ...brokerLeaves(
    [ConfigKeys.io.broker.redisStreams.url, 'redis://cache.local:6379'],
    [ConfigKeys.io.broker.redisStreams.streams, ['orders']],
    [ConfigKeys.io.broker.redisStreams.block, '2s'],
    [ConfigKeys.io.broker.redisStreams.consumerGroup.group, 'payments'],
    [ConfigKeys.io.broker.redisStreams.consumerGroup.consumer, 'worker-2'],
    [ConfigKeys.io.broker.redisStreams.consumerGroup.createIfMissing, false],
  ),
  ...brokerLeaves(
    [ConfigKeys.io.broker.sse.url, 'https://events.local/stream'],
    [ConfigKeys.io.broker.sse.idleTimeout, '90s'],
    [ConfigKeys.io.broker.sse.connectTimeout, '5s'],
  ),
  // A framing block's own leaves need its `kind` beside them, and a context
  // cannot set one: the framing leaves are read relative to the block, so no
  // `ConfigKeys` entry names them.  `kind` alone stands for the block.
  ...brokerLeaves(
    [ConfigKeys.io.broker.tcp.host, 'peer.local'],
    [ConfigKeys.io.broker.tcp.port, 7000],
    [`${ConfigKeys.io.broker.tcp.framing}.kind`, 'lines'],
    [ConfigKeys.io.broker.tcp.idleTimeout, '90s'],
    [ConfigKeys.io.broker.tcp.connectTimeout, '5s'],
    [ConfigKeys.io.broker.tcp.keepAlive, '30s'],
  ),
  ...brokerLeaves(
    [ConfigKeys.io.broker.tcpServer.bindHost, '127.0.0.1'],
    [ConfigKeys.io.broker.tcpServer.bindPort, 7001],
    [ConfigKeys.io.broker.tcpServer.maxConnections, 64],
    [`${ConfigKeys.io.broker.tcpServer.framing}.kind`, 'lines'],
  ),
  ...brokerLeaves(
    [ConfigKeys.io.broker.udp.bindHost, '127.0.0.1'],
    [ConfigKeys.io.broker.udp.bindPort, 5005],
    [ConfigKeys.io.broker.udp.type, 'udp6'],
  ),
];

export const CONFIG_READER_REGISTRY: readonly ReaderEntry[] = [
  ...systemReaders,
  ...loggerReaders,
  ...actorReaders,
  ...diagnosticsReaders,
  ...clusterReaders,
  ...distributedDataReaders,
  ...discoveryReaders,
  ...coordinationReaders,
  ...reliableDeliveryReaders,
  ...serializationReaders,
  ...httpReaders,
  ...circuitBreakerReaders,
  ...projectionReaders,
  ...backoffSupervisorReaders,
  ...cacheReaders,
  ...managementReaders,
  ...persistenceReaders,
  ...shardingReaders,
  ...devToolsReaders,
  ...workerReaders,
  ...coordinatedShutdownReaders,
  ...brokerReaders,
];

/**
 * Exported readers that are deliberately not entries, with the reason.  The
 * gate fails on any other exported `read…FromConfig`, `is…SinkEnabled` or
 * `isRemoteTlsRequested` the registry does not list, so a new reader cannot
 * be added without deciding whether the gate runs it.
 */
export const READERS_OUTSIDE_THE_REGISTRY: ReadonlyMap<string, string> = new Map([
  ['readFramingFromConfig', 'the shared framing reader the tcp and tcp-server readers hand their own framing block; those two are entries'],
  ['isSinkEnabled', 'the shared helper each per-sink is…SinkEnabled calls with its own block root; those nine are entries'],
]);

/** Every unpublished key a registered reader is known to read, by section. */
export const UNPUBLISHED_LEAVES: ReadonlyMap<string, UnpublishedLeaf> = new Map([
  ...loggerUnpublishedLeaves,
  ...coordinationUnpublishedLeaves,
  ...brokerUnpublishedLeaves,
]);

/** `readDeliveryOptionsFromConfig (otlp)` — the label a probe of `entry` reports under. */
export function entryLabel(entry: ReaderEntry): string {
  return entry.variant === undefined ? entry.name : `${entry.name} (${entry.variant})`;
}
