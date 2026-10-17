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
import { readShardingHealthCheckNamesFromConfig } from '../../src/cluster/ClusterHealthChecks.js';
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
import { readLeaseBackendFromConfig } from '../../src/coordination/LeaseFromConfig.js';
import { readLeaseOptionsFromConfig } from '../../src/coordination/LeaseOptions.js';
import { readKubernetesLeaseOptionsFromConfig } from '../../src/coordination/leases/KubernetesLeaseOptions.js';
import { readCoordinatedShutdownOptionsFromConfig } from '../../src/CoordinatedShutdown.js';
import { readCoordinatedStartupOptionsFromConfig } from '../../src/CoordinatedStartupOptions.js';
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
import { readWebsocketClientOptionsFromConfig } from '../../src/http/websocket/WebsocketClientActor.js';
import { readWebsocketPolicyOptionsFromConfig } from '../../src/http/websocket/WebsocketPolicy.js';
import { readDeploymentFromConfig } from '../../src/internal/Deployment.js';
import { readAmqpOptionsFromConfig } from '../../src/io/broker/AmqpActor.js';
import { brokerCommonKeysUnder, readBrokerCommonOptionsFromConfig } from '../../src/io/broker/BrokerOptions.js';
import { readEmailBridgeOptionsFromConfig } from '../../src/io/broker/EmailBridgeActor.js';
import { readGrpcClientOptionsFromConfig } from '../../src/io/broker/GrpcClientActor.js';
import { readGrpcServerOptionsFromConfig } from '../../src/io/broker/GrpcServerActor.js';
import { readJetStreamOptionsFromConfig } from '../../src/io/broker/JetStreamActor.js';
import { readJetStreamKeyValueOptionsFromConfig } from '../../src/io/broker/JetStreamKeyValueActor.js';
import { readJetStreamObjectStoreOptionsFromConfig } from '../../src/io/broker/JetStreamObjectStoreActor.js';
import { readKafkaOptionsFromConfig } from '../../src/io/broker/KafkaActor.js';
import { readMqttOptionsFromConfig } from '../../src/io/broker/MqttActor.js';
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
import { readMetricsRegistryOptionsFromConfig } from '../../src/metrics/MetricsRegistryOptions.js';
import { readPromClientAdapterOptionsFromConfig } from '../../src/metrics/PromClientAdapterOptions.js';
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
import { readOtelAdapterOptionsFromConfig } from '../../src/tracing/OtelAdapterOptions.js';
import { readOtelLogsAdapterOptionsFromConfig } from '../../src/tracing/OtelLogsAdapterOptions.js';
import { readOffloadPoolOptionsFromConfig } from '../../src/worker/OffloadPoolOptions.js';
import { readWorkerClusterOptionsFromConfig } from '../../src/worker/WorkerClusterOptions.js';
import { readWorkerMeshOptionsFromConfig } from '../../src/worker/WorkerMeshOptions.js';
import type { PerturbationOverride } from './ConfigPerturbation.js';

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
 * `value` instead, changes it to another value of that kind, and a reader has
 * to answer the two differently, as it would a published leaf's literal and
 * its perturbation.
 */
export type UnpublishedLeaf = {
  readonly value: ConfigValue;
  readonly reason: string;
  /**
   * The second value, where none inferred from `value` is one the reader can
   * answer to — what `PERTURBATION_OVERRIDES` is to a published leaf.
   */
  readonly override?: PerturbationOverride;
};

const CORE_SUITE = 'tests/unit/config/CoreConfigDefaults.test.ts';
const LOGGER_SUITE = 'tests/unit/logging/LoggerSinkConfigDefaults.test.ts';
const PERSISTENCE_SUITE = 'tests/unit/config/PersistenceConfigDefaults.test.ts';

/** The reason most comment-only keys share; an entry with a reason of its own gives it instead. */
const COMMENT_ONLY = 'comment-only in reference.conf: unset is the default';

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

/* ----------------------------- actor-ts.deployment ----------------------------- */

const deploymentReaders: readonly ReaderEntry[] = [
  {
    name: 'readDeploymentFromConfig',
    read: readDeploymentFromConfig,
    suite: 'tests/unit/config/DeploymentConfigDefaults.test.ts',
  },
];

/*
 * The block ships comment-only, so it is introduced as an object: one path
 * with one leaf, changed to another value.  The reader keeps each key and
 * answers with its entry, so the second throughput is an answer of its own.
 * Without this entry no reference leaf exists for the gate to perturb, and a
 * reader that ignored the block would pass it.
 */
const deploymentUnpublishedLeaves: ReadonlyArray<readonly [string, UnpublishedLeaf]> = [
  [ConfigKeys.deployment.root, {
    value: { '/user/ingest': { throughput: 7 } },
    reason: 'comment-only in reference.conf: its keys are the application\'s actor paths, so there is no fixed set '
      + 'of leaves to publish, and a shipped entry would be a live default in every deployment',
  }],
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
      {
        name: 'keep-referee',
        overlay: {
          'actor-ts.cluster.split-brain-resolver.active-strategy': 'keep-referee',
          // Required as quorum-size is above, and another address than the
          // unpublished leaf's own, so setting that leaf changes the answer.
          'actor-ts.cluster.split-brain-resolver.keep-referee.referee-address': 'sys@h:2',
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

const ADVERTISED = 'comment-only in reference.conf: unset advertises the bind host and port themselves, '
  + 'and a value always present would shadow the host it falls back to';
const BIND_PAIR = 'comment-only in reference.conf: a shipped value would sit above the bootstrap\'s environment '
  + 'stage (CLUSTER_HOST / POD_IP / HOSTNAME, CLUSTER_PORT) and shadow it on every node';

const clusterUnpublishedLeaves: ReadonlyArray<readonly [string, UnpublishedLeaf]> = [
  // The root itself, as one role's block: the role name is the deployment's,
  // so the leaf beneath it has no path of its own to introduce.
  [ConfigKeys.cluster.role, {
    value: { backend: { 'minimum-members-before-up': 2 } },
    reason: 'comment-only in reference.conf: the role names belong to the deployment, so no leaf under the root '
      + 'could name one',
  }],
  [ConfigKeys.cluster.splitBrainResolver.keepReferee.refereeAddress, {
    value: 'sys@h:3',
    reason: 'comment-only in reference.conf: the referee is one node\'s address, and no default could stand for one',
  }],
  [ConfigKeys.cluster.splitBrainResolver.keepReferee.downAllIfBelowQuorum, { value: 2, reason: COMMENT_ONLY }],
  [ConfigKeys.cluster.splitBrainResolver.staticQuorum.quorumSize, {
    value: 5,
    reason: 'comment-only in reference.conf: the quorum is the size a deployment refuses to run below, '
      + 'which no default can guess',
  }],
  [ConfigKeys.cluster.bootstrap.awaitReady, {
    value: '30s',
    reason: 'comment-only in reference.conf: unset selects the grace-aware computed default',
  }],
  [ConfigKeys.cluster.client.contactPoints, {
    value: ['sys@10.0.0.1:2552'],
    reason: 'comment-only in reference.conf: contact points are per-deployment, and [] is refused rather than '
      + 'read as unset',
  }],
  [ConfigKeys.cluster.appVersion, {
    value: '2.4.0',
    reason: 'comment-only in reference.conf: unset states no version and puts nothing on the wire',
  }],
  [ConfigKeys.remote.tcp.advertisedHost, { value: 'node-1.example', reason: ADVERTISED }],
  [ConfigKeys.remote.tcp.advertisedPort, { value: 2553, reason: ADVERTISED }],
  [ConfigKeys.remote.tcp.host, { value: '10.0.0.7', reason: BIND_PAIR }],
  [ConfigKeys.remote.tcp.port, { value: 2554, reason: BIND_PAIR }],
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

const DISCOVERY_LAYER = 'comment-only in reference.conf: a published value would occupy the config layer on every '
  + 'node and shadow the environment variable beneath it';

const discoveryUnpublishedLeaves: ReadonlyArray<readonly [string, UnpublishedLeaf]> = [
  [ConfigKeys.discovery.dns.dnsPinnedAddresses, { value: ['svc.cluster.local'], reason: DISCOVERY_LAYER }],
  [ConfigKeys.discovery.kubernetes.namespace, { value: 'actors', reason: DISCOVERY_LAYER }],
  [ConfigKeys.discovery.kubernetes.kubernetesPinnedAddresses, { value: ['10.0.0.0/8'], reason: DISCOVERY_LAYER }],
  [ConfigKeys.discovery.config.seeds, { value: ['10.0.0.1:2552'], reason: DISCOVERY_LAYER }],
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
  {
    // The selector alone: the switches that ask for a lease are their own
    // blocks' readers' (sharding, singleton, split-brain-resolver), and none
    // of them refuses on its own value, so no context is needed to read them.
    name: 'readLeaseBackendFromConfig',
    read: readLeaseBackendFromConfig,
    suite: 'tests/unit/coordination/LeaseFromConfig.test.ts',
  },
];

const LEASE_TIMING = 'deliberately comment-only: an unset ttl is what keeps "ttlMs is required" (#596) reachable, '
  + 'and an unset renewal-interval is derived from the ttl';

const coordinationUnpublishedLeaves: ReadonlyArray<readonly [string, UnpublishedLeaf]> = [
  ['actor-ts.coordination.lease.ttl', { value: '30s', reason: LEASE_TIMING }],
  ['actor-ts.coordination.lease.renewal-interval', { value: '10s', reason: LEASE_TIMING }],
  [ConfigKeys.coordination.lease.kubernetes.namespace, {
    value: 'leases',
    reason: 'comment-only in reference.conf: unset reads the namespace from the service-account file',
  }],
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

/**
 * Real PEM files, because the reader opens every `*-file` leaf it is given:
 * a path to nothing is refused, and a refusal is not a read.
 */
const TLS_FIXTURES = `${import.meta.dir}/../fixtures/tls`;

const httpReaders: readonly ReaderEntry[] = [
  { name: 'readHttpBackendFromConfig', read: readHttpBackendFromConfig, suite: HTTP_SUITE },
  { name: 'readHttpShutdownGracePeriodFromConfig', read: readHttpShutdownGracePeriodFromConfig, suite: HTTP_SUITE },
  {
    name: 'readHttpServerOptionsFromConfig',
    read: readHttpServerOptionsFromConfig,
    suite: HTTP_SUITE,
    // The tls block is read only once it names a certificate or a key, so
    // `ca-file` and the two client-certificate switches need the pair beside them.
    contexts: [{
      name: 'tls',
      overlay: {
        [ConfigKeys.http.server.tls.certFile]: `${TLS_FIXTURES}/localhost-cert.pem`,
        [ConfigKeys.http.server.tls.keyFile]: `${TLS_FIXTURES}/localhost-key.pem`,
      },
    }],
  },
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

const PLAIN_HTTP = 'comment-only in reference.conf: a block naming no certificate serves plain HTTP';
const CORS_OFF = 'comment-only in reference.conf: unset leaves the CORS policy to code';

/** A `*-file` leaf changes to another real PEM file, since a path to nothing is refused rather than read. */
function anotherPemFile(name: string): PerturbationOverride {
  return {
    value: `${TLS_FIXTURES}/${name}`,
    reason: 'the reader opens the file it is given and refuses a path to nothing, so the second value is '
      + 'another fixture rather than the first one suffixed',
  };
}

const httpUnpublishedLeaves: ReadonlyArray<readonly [string, UnpublishedLeaf]> = [
  [ConfigKeys.http.server.idleTimeout, { value: '7s', reason: COMMENT_ONLY }],
  [ConfigKeys.http.server.maxConnections, { value: 100, reason: COMMENT_ONLY }],
  [ConfigKeys.http.server.maxContentLength, { value: '2M', reason: COMMENT_ONLY }],
  [ConfigKeys.http.server.maxHeaderBytes, { value: '16K', reason: COMMENT_ONLY }],
  [ConfigKeys.http.server.tls.certFile, {
    value: `${TLS_FIXTURES}/localhost-cert.pem`,
    reason: PLAIN_HTTP,
    override: anotherPemFile('test-ca.pem'),
  }],
  [ConfigKeys.http.server.tls.keyFile, {
    value: `${TLS_FIXTURES}/localhost-key.pem`,
    reason: PLAIN_HTTP,
    override: anotherPemFile('localhost-cert.pem'),
  }],
  [ConfigKeys.http.server.tls.caFile, {
    value: `${TLS_FIXTURES}/test-ca.pem`,
    reason: PLAIN_HTTP,
    override: anotherPemFile('localhost-cert.pem'),
  }],
  [ConfigKeys.http.server.tls.requestClientCert, { value: true, reason: PLAIN_HTTP }],
  [ConfigKeys.http.server.tls.rejectUnauthorized, { value: false, reason: PLAIN_HTTP }],
  [ConfigKeys.http.cors.origins, { value: ['https://app.example'], reason: CORS_OFF }],
  [ConfigKeys.http.cors.methods, { value: ['GET', 'POST'], reason: CORS_OFF }],
  [ConfigKeys.http.cors.allowedHeaders, { value: ['x-trace-id'], reason: CORS_OFF }],
  [ConfigKeys.http.cors.maxAge, { value: 600, reason: CORS_OFF }],
  [ConfigKeys.http.websocket.maxConnections, { value: 10, reason: COMMENT_ONLY }],
  [ConfigKeys.http.websocket.connectionMailboxCapacity, { value: 3, reason: COMMENT_ONLY }],
  [ConfigKeys.http.websocket.connectionMailboxOverflow, { value: 'drop-new', reason: COMMENT_ONLY }],
];

/* ------------------------- actor-ts.circuit-breaker ------------------------- */

const circuitBreakerReaders: readonly ReaderEntry[] = [
  {
    name: 'readCircuitBreakerOptionsFromConfig',
    read: readCircuitBreakerOptionsFromConfig,
    suite: 'tests/unit/pattern/CircuitBreakerConfig.test.ts',
  },
];

const circuitBreakerUnpublishedLeaves: ReadonlyArray<readonly [string, UnpublishedLeaf]> = [
  [ConfigKeys.circuitBreaker.default.callTimeout, {
    value: '3s',
    reason: 'comment-only in reference.conf: omitting it is what disables the per-call deadline, and the '
      + 'validator refuses 0',
  }],
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

const cacheUnpublishedLeaves: ReadonlyArray<readonly [string, UnpublishedLeaf]> = [
  [ConfigKeys.cache.inMemoryOptions.prefixQuotas, {
    value: { 'rsp:': 7000 },
    reason: 'comment-only in reference.conf: unset is one undivided map, and the prefixes are the application\'s own',
  }],
  [ConfigKeys.cache.redisOptions.host, { value: 'cache.local', reason: COMMENT_ONLY }],
  [ConfigKeys.cache.redisOptions.port, { value: 6380, reason: COMMENT_ONLY }],
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

/* ----------------------------- actor-ts.metrics ----------------------------- */

const metricsReaders: readonly ReaderEntry[] = [
  {
    name: 'readMetricsRegistryOptionsFromConfig',
    read: readMetricsRegistryOptionsFromConfig,
    suite: 'tests/unit/config/MetricsConfigDefaults.test.ts',
  },
  {
    name: 'readPromClientAdapterOptionsFromConfig',
    read: readPromClientAdapterOptionsFromConfig,
    suite: 'tests/unit/config/MetricsConfigDefaults.test.ts',
  },
];

/* ----------------------------- actor-ts.tracing ----------------------------- */

const TRACING_SUITE = 'tests/unit/config/TracingConfigDefaults.test.ts';

const tracingReaders: readonly ReaderEntry[] = [
  { name: 'readOtelAdapterOptionsFromConfig', read: readOtelAdapterOptionsFromConfig, suite: TRACING_SUITE },
  { name: 'readOtelLogsAdapterOptionsFromConfig', read: readOtelLogsAdapterOptionsFromConfig, suite: TRACING_SUITE },
];

const tracingUnpublishedLeaves: ReadonlyArray<readonly [string, UnpublishedLeaf]> = [
  [ConfigKeys.tracing.tracerVersion, {
    value: '2.4.0',
    reason: 'comment-only in reference.conf: unset passes no version to getTracer, and no default could stand '
      + 'for the version of whatever is being traced',
  }],
  [ConfigKeys.tracing.loggerVersion, {
    value: '2.4.0',
    reason: 'comment-only in reference.conf: unset passes no version to getLogger, and no default could stand '
      + 'for the version of whatever is logging',
  }],
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

const TAGS_TABLE = 'comment-only in reference.conf: unset derives the name from the events table '
  + '(<events-table>_tags)';
const POOL_DEFAULT = 'comment-only in reference.conf: unset keeps the driver\'s own default';
const DRIVER_CONSISTENCY = 'comment-only in reference.conf: unset leaves the consistency level to the driver';
const PROVISIONED_PAIR = 'comment-only in reference.conf: published, the pair would be refused under the default '
  + 'billing mode, pay-per-request';

/** The pool leaves every relational backend documents, and the one each adds. */
const POOL_LEAVES = [['ca-file', '/etc/ssl/db-ca.pem'], ['connect-timeout', '7s'], ['idle-timeout', '45s'], ['max-pool-size', 7]] as const;
const POOL_EXTRAS = { postgres: [], mariadb: [['acquire-timeout', '9s']], mssql: [['request-timeout', '11s']] } as const;
/**
 * The MongoDB client leaves every block documents.  `ca-file` is a path the
 * store reads when the client opens, not the reader, so like the SQL pools'
 * it needs no real file here.
 */
const MONGO_CLIENT_LEAVES = [
  ['ca-file', '/etc/ssl/mongo-ca.pem'],
  ['connect-timeout', '7s'],
  ['max-pool-size', 7],
  ['min-pool-size', 2],
  ['server-selection-timeout', '9s'],
] as const;
const SDK_RESOLUTION = 'comment-only in reference.conf: unset leaves the AWS SDK its own resolution (an AWS_* '
  + 'environment variable, then the shared config file, then its default), which a shipped value would overrule';
/** The DynamoDB client leaves every block documents, `retry-mode` aside: an enum, it needs a second member. */
const DYNAMODB_CLIENT_LEAVES = [
  ['connection-timeout', '3s', POOL_DEFAULT],
  ['max-attempts', 5, SDK_RESOLUTION],
  ['request-timeout', '9s', POOL_DEFAULT],
] as const;

const persistenceUnpublishedLeaves: ReadonlyArray<readonly [string, UnpublishedLeaf]> = [
  ...(['postgres', 'mariadb', 'mssql', 'libsql', 'cloudflare-d1'] as const).map((backend) =>
    [`actor-ts.persistence.journal.${backend}.tags-table`, { value: 'event_tags', reason: TAGS_TABLE }] as const),
  ...(['journal', 'snapshot-store', 'durable-state'] as const).flatMap((store) =>
    (['postgres', 'mariadb', 'mssql'] as const).flatMap((backend) =>
      [...POOL_LEAVES, ...POOL_EXTRAS[backend]].map(([leaf, value]) =>
        [`actor-ts.persistence.${store}.${backend}.${leaf}`, { value, reason: POOL_DEFAULT }] as const))),
  ...(['journal', 'snapshot-store', 'durable-state'] as const).flatMap((store) =>
    MONGO_CLIENT_LEAVES.map(([leaf, value]) =>
      [`actor-ts.persistence.${store}.mongodb.${leaf}`, { value, reason: POOL_DEFAULT }] as const)),
  ...(['journal', 'snapshot-store', 'durable-state'] as const).flatMap((store) => [
    ...DYNAMODB_CLIENT_LEAVES.map(([leaf, value, reason]) =>
      [`actor-ts.persistence.${store}.dynamodb.${leaf}`, { value, reason }] as const),
    [`actor-ts.persistence.${store}.dynamodb.retry-mode`, {
      value: 'standard',
      reason: SDK_RESOLUTION,
      override: {
        value: 'adaptive',
        reason: 'the reader refuses any word outside standard | adaptive, and a refusal alone is not a read, '
          + 'so only the other mode gives an answer to compare',
      },
    }] as const,
  ]),
  [ConfigKeys.persistence.journal.cassandra.consistency, { value: 6, reason: DRIVER_CONSISTENCY }],
  [ConfigKeys.persistence.journal.cassandra.serialConsistency, { value: 9, reason: DRIVER_CONSISTENCY }],
  [ConfigKeys.persistence.snapshotStore.cassandra.consistency, { value: 6, reason: DRIVER_CONSISTENCY }],
  // `replication.data-centers` under both Cassandra blocks stays outside: a list
  // of `{ name, replication-factor }` objects, read only when `replication.class`
  // is network-topology-strategy. The gate's list kind perturbs a list of
  // strings, so there is no value to introduce, and a context would also have to
  // select the class, because the reader refuses data centers under
  // simple-strategy and a refusal is not a read.
  ...(['journal', 'snapshot-store', 'durable-state'] as const).flatMap((store) =>
    (['read-capacity-units', 'write-capacity-units'] as const).map((leaf) =>
      [`actor-ts.persistence.${store}.dynamodb.provisioned-throughput.${leaf}`, {
        value: 7,
        reason: PROVISIONED_PAIR,
      }] as const)),
  [ConfigKeys.persistence.snapshotStore.objectStorage.compressionLevel, {
    value: 3,
    reason: 'comment-only in reference.conf: unset keeps the algorithm\'s own default level',
  }],
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
  {
    // No start option: the `Cluster` constructor reads it once per `join`, for
    // the readiness checks `registerClusterHealthChecks` installs (#1465).
    name: 'readShardingHealthCheckNamesFromConfig',
    read: readShardingHealthCheckNamesFromConfig,
    suite: 'tests/unit/cluster/sharding/ShardingConfigDefaults.test.ts',
  },
];

const shardingUnpublishedLeaves: ReadonlyArray<readonly [string, UnpublishedLeaf]> = [
  [ConfigKeys.sharding.shardPassivationIdle, { value: '90s', reason: COMMENT_ONLY }],
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

/* ------------------------ actor-ts.coordinated-startup ------------------------ */

const coordinatedStartupReaders: readonly ReaderEntry[] = [
  {
    name: 'readCoordinatedStartupOptionsFromConfig',
    read: readCoordinatedStartupOptionsFromConfig,
    suite: 'tests/unit/config/CoordinatedStartupConfigDefaults.test.ts',
  },
];

/*
 * `phases` ships comment-only, so it is introduced as an object: one child
 * retiming a seeded phase, changed to another budget.  The reader keeps the
 * children's names and answers with their values, so the second budget is an
 * answer of its own.
 */
const coordinatedStartupUnpublishedLeaves: ReadonlyArray<readonly [string, UnpublishedLeaf]> = [
  [ConfigKeys.coordinatedStartup.phases, {
    value: { 'persistence-start': { timeout: '7s' } },
    reason: 'comment-only in reference.conf: its children are named after the phases a deployment retimes or adds, '
      + 'so there is no fixed set of leaves to publish',
  }],
];

/* ------------------------ actor-ts.coordinated-shutdown ------------------------ */

/*
 * `phases` is outside the gate, and not for want of a kind: the extension's
 * constructor folds the block into its phase graph through readPhaseOverrides,
 * and readCoordinatedShutdownOptionsFromConfig leaves the block out by design,
 * so no registered reader answers to it.  readPhaseOverrides is exported now —
 * the startup block's reader parses its own phases through it, which is how
 * that block's phases are in the gate above — but exporting it is not enough
 * for this block to join: an entry runs an exported read…FromConfig, which
 * readPhaseOverrides(config, path) is not.  A reader of this block's phases
 * under that name, beside readCoordinatedShutdownOptionsFromConfig, is what
 * would let the gate introduce it as an object; until then the phase cases in
 * tests/unit/config/SystemShutdownWorkerConfig.test.ts are what bind it.
 */
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

/**
 * A TCP framing block's leaves are read only beside the `kind` that selects
 * them — the delimiter and the line cap under `lines`, the frame cap under
 * `length-prefixed` — so each TCP reader runs once under each of those kinds
 * as well.
 */
function framingContexts(framingKeys: { readonly kind: string }): ReaderContext[] {
  return [
    { name: 'lines framing', overlay: { [framingKeys.kind]: 'lines' } },
    { name: 'length-prefixed framing', overlay: { [framingKeys.kind]: 'length-prefixed' } },
  ];
}

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
  {
    name: 'readJetStreamOptionsFromConfig',
    read: (config) => readJetStreamOptionsFromConfig(config),
    suite: BROKER_SUITE,
    // A deliver-policy `kind` is read only beside the leaf its arm reads; both
    // arms' leaves are set, so the kind can move from one arm to the other.
    // Each arm is selected once, so each arm's own leaf is read in one of them.
    contexts: [
      {
        name: 'deliver-policy object arm',
        overlay: {
          [ConfigKeys.io.broker.jetstream.consumer.deliverPolicy.kind]: 'by-start-sequence',
          [ConfigKeys.io.broker.jetstream.consumer.deliverPolicy.startSeq]: 5,
          [ConfigKeys.io.broker.jetstream.consumer.deliverPolicy.startTime]: 1700000000000,
        },
      },
      {
        name: 'deliver-policy by-start-time arm',
        overlay: {
          [ConfigKeys.io.broker.jetstream.consumer.deliverPolicy.kind]: 'by-start-time',
          [ConfigKeys.io.broker.jetstream.consumer.deliverPolicy.startSeq]: 5,
          [ConfigKeys.io.broker.jetstream.consumer.deliverPolicy.startTime]: 1700000000000,
        },
      },
    ],
  },
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
    contexts: [
      {
        name: 'sasl',
        overlay: {
          [ConfigKeys.io.broker.kafka.sasl.mechanism]: 'plain',
          [ConfigKeys.io.broker.kafka.sasl.username]: 'svc',
          [ConfigKeys.io.broker.kafka.sasl.password]: 'pw',
        },
      },
    ],
  },
  { name: 'readMqttOptionsFromConfig', read: (config) => readMqttOptionsFromConfig(config), suite: BROKER_SUITE },
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
  {
    name: 'readTcpSocketOptionsFromConfig',
    read: (config) => readTcpSocketOptionsFromConfig(config),
    suite: BROKER_SUITE,
    contexts: framingContexts(ConfigKeys.io.broker.tcp.framing),
  },
  {
    name: 'readTcpServerOptionsFromConfig',
    read: (config) => readTcpServerOptionsFromConfig(config),
    suite: BROKER_SUITE,
    contexts: framingContexts(ConfigKeys.io.broker.tcpServer.framing),
  },
  { name: 'readUdpSocketOptionsFromConfig', read: (config) => readUdpSocketOptionsFromConfig(config), suite: BROKER_SUITE },
  {
    name: 'readWebsocketClientOptionsFromConfig',
    read: (config) => readWebsocketClientOptionsFromConfig(config),
    suite: BROKER_SUITE,
  },
];

/**
 * Broker leaves, each introduced at its value for the reason every one of
 * them shares — with an override where one is needed.
 */
function brokerLeaves(
  ...leaves: ReadonlyArray<readonly [string, ConfigValue] | readonly [string, ConfigValue, PerturbationOverride]>
): Array<readonly [string, UnpublishedLeaf]> {
  return leaves.map(([leaf, value, override]) =>
    [leaf, { value, reason: BROKER_BLOCK, ...(override === undefined ? {} : { override }) }] as const);
}

/*
 * Every leaf a broker reader reads.  The four counts — `reconnect.max-attempts`,
 * JetStream's `stream.max-age` and its deliver-policy `start-seq` /
 * `start-time` — were left out while their readers took them with `getNumber`,
 * which takes 7.5 as readily as 7, so introduced here they failed the gate's
 * accessor check; read with `getInt` now, they are introduced like the rest.
 * The deliver-policy arm leaves are read only beside the `kind` that selects
 * them, which is what the JetStream reader's two arm contexts are for.
 */
const brokerUnpublishedLeaves: ReadonlyArray<readonly [string, UnpublishedLeaf]> = [
  ...brokerLeaves(
    [kafkaCommonKeys.reconnect.initialDelay, '250ms'],
    [kafkaCommonKeys.reconnect.maxDelay, '20s'],
    [kafkaCommonKeys.reconnect.factor, 1.5],
    [kafkaCommonKeys.reconnect.maxAttempts, 5],
    [kafkaCommonKeys.reconnect.randomFactor, 0.25],
    // An id: the breaker's numbers are read under actor-ts.circuit-breaker.<id>
    // by readCircuitBreakerOptionsFromConfig, registered above (#1478).
    [kafkaCommonKeys.circuitBreaker, 'orders-kafka'],
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
    [ConfigKeys.io.broker.jetstream.stream.maxAge, 3_600_000_000_000],
    [ConfigKeys.io.broker.jetstream.stream.create, false],
    [ConfigKeys.io.broker.jetstream.consumer.durable, 'order-processor'],
    [ConfigKeys.io.broker.jetstream.consumer.mode, 'pull'],
    [ConfigKeys.io.broker.jetstream.consumer.deliverPolicy.root, 'last'],
    [ConfigKeys.io.broker.jetstream.consumer.deliverPolicy.kind, 'by-start-sequence', {
      value: 'by-start-time',
      reason: 'the reader refuses any kind but the two object arms, so only the other arm gives an answer to compare',
    }],
    [ConfigKeys.io.broker.jetstream.consumer.deliverPolicy.startSeq, 4242],
    [ConfigKeys.io.broker.jetstream.consumer.deliverPolicy.startTime, 1_767_225_600_000],
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
    [ConfigKeys.io.broker.mqtt.brokerUrl, 'mqtt://broker.local:1883'],
    [ConfigKeys.io.broker.mqtt.clientId, 'hub'],
    [ConfigKeys.io.broker.mqtt.credentials.username, 'iot'],
    [ConfigKeys.io.broker.mqtt.credentials.password, 'pw'],
    [ConfigKeys.io.broker.mqtt.qos, 1],
    [ConfigKeys.io.broker.mqtt.will.topic, 'devices/42/status'],
    [ConfigKeys.io.broker.mqtt.will.payload, 'offline'],
    [ConfigKeys.io.broker.mqtt.will.qos, 1],
    [ConfigKeys.io.broker.mqtt.will.retain, true],
    [ConfigKeys.io.broker.mqtt.cleanSession, false],
    [ConfigKeys.io.broker.mqtt.keepAlive, '30s'],
    [ConfigKeys.io.broker.mqtt.protocolVersion, 5],
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
    [ConfigKeys.io.broker.sse.headers, { authorization: 'Bearer t0k3n' }],
    [ConfigKeys.io.broker.sse.idleTimeout, '90s'],
    [ConfigKeys.io.broker.sse.connectTimeout, '5s'],
  ),
  // A framing block's delimiter and caps are observed under the framing
  // contexts of their reader; set alone, without a `kind`, the block cannot be
  // read at all.  The caps are sizes, introduced with a unit so a reader taking
  // them with `getInt` is a kind mismatch rather than a pass.
  ...brokerLeaves(
    [ConfigKeys.io.broker.tcp.host, 'peer.local'],
    [ConfigKeys.io.broker.tcp.port, 7000],
    [ConfigKeys.io.broker.tcp.framing.kind, 'lines'],
    [ConfigKeys.io.broker.tcp.framing.delimiter, '\r\n'],
    [ConfigKeys.io.broker.tcp.framing.maxLineBytes, '64K'],
    [ConfigKeys.io.broker.tcp.framing.maxFrameBytes, '1M'],
    [ConfigKeys.io.broker.tcp.idleTimeout, '90s'],
    [ConfigKeys.io.broker.tcp.connectTimeout, '5s'],
    [ConfigKeys.io.broker.tcp.keepAlive, '30s'],
  ),
  ...brokerLeaves(
    [ConfigKeys.io.broker.tcpServer.bindHost, '127.0.0.1'],
    [ConfigKeys.io.broker.tcpServer.bindPort, 7001],
    [ConfigKeys.io.broker.tcpServer.maxConnections, 64],
    [ConfigKeys.io.broker.tcpServer.framing.kind, 'lines'],
    [ConfigKeys.io.broker.tcpServer.framing.delimiter, '\r\n'],
    [ConfigKeys.io.broker.tcpServer.framing.maxLineBytes, '64K'],
    [ConfigKeys.io.broker.tcpServer.framing.maxFrameBytes, '1M'],
  ),
  ...brokerLeaves(
    [ConfigKeys.io.broker.udp.bindHost, '127.0.0.1'],
    [ConfigKeys.io.broker.udp.bindPort, 5005],
    [ConfigKeys.io.broker.udp.type, 'udp6'],
  ),
  ...brokerLeaves(
    [ConfigKeys.io.broker.websocket.url, 'ws://feed.local/stream'],
    [ConfigKeys.io.broker.websocket.protocols, ['feed-v1']],
    [ConfigKeys.io.broker.websocket.pingInterval, '30s'],
    [ConfigKeys.io.broker.websocket.maxFrameBytes, '1M'],
    [ConfigKeys.io.broker.websocket.onInvalidMessage, 'drop'],
    [ConfigKeys.io.broker.websocket.idleTimeout, '90s'],
    [ConfigKeys.io.broker.websocket.connectTimeout, '10s'],
    [ConfigKeys.io.broker.websocket.inboundHighWaterMark, 256],
    [ConfigKeys.io.broker.websocket.inboundLowWaterMark, 64],
  ),
];

export const CONFIG_READER_REGISTRY: readonly ReaderEntry[] = [
  ...systemReaders,
  ...loggerReaders,
  ...actorReaders,
  ...deploymentReaders,
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
  ...metricsReaders,
  ...tracingReaders,
  ...persistenceReaders,
  ...shardingReaders,
  ...devToolsReaders,
  ...workerReaders,
  ...coordinatedStartupReaders,
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
  ['readFramingFromConfig', 'the shared framing reader the tcp and tcp-server readers hand their own framing keys; those two are entries'],
  ['isSinkEnabled', 'the shared helper each per-sink is…SinkEnabled calls with its own block root; those nine are entries'],
]);

/** Every unpublished key a registered reader is known to read, by section. */
export const UNPUBLISHED_LEAVES: ReadonlyMap<string, UnpublishedLeaf> = new Map([
  ...loggerUnpublishedLeaves,
  ...deploymentUnpublishedLeaves,
  ...clusterUnpublishedLeaves,
  ...discoveryUnpublishedLeaves,
  ...coordinationUnpublishedLeaves,
  ...httpUnpublishedLeaves,
  ...circuitBreakerUnpublishedLeaves,
  ...cacheUnpublishedLeaves,
  ...tracingUnpublishedLeaves,
  ...persistenceUnpublishedLeaves,
  ...shardingUnpublishedLeaves,
  ...coordinatedStartupUnpublishedLeaves,
  ...brokerUnpublishedLeaves,
]);

/** `readDeliveryOptionsFromConfig (otlp)` — the label a probe of `entry` reports under. */
export function entryLabel(entry: ReaderEntry): string {
  return entry.variant === undefined ? entry.name : `${entry.name} (${entry.variant})`;
}
