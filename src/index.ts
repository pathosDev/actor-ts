/*
 * actor-ts — an actor-model framework for TypeScript on Bun.
 *
 *   Quick start:
 *     import { ActorSystem, Actor } from 'actor-ts';
 *
 *     class Hello extends Actor<string> {
 *       onReceive(message: string) { console.log('hello', message); }
 *     }
 *
 *     const system = ActorSystem.create('demo');
 *     const ref = system.spawn(Hello, 'hello');
 *     ref.tell('world');
 *     await system.terminate();
 */

// Option<T> — explicit "might not have a value" type.
export {
  Some,
  None,
  none,
  some,
  fromNullable,
  fromPredicate,
  firstSome,
} from './util/Option.js';
export type { Option } from './util/Option.js';

// Lazy<T> — Scala-style `lazy val`: compute once on first .get(), memoise.
export { Lazy, lazy } from './util/Lazy.js';

// Try<T> — Success<T> / Failure wrapper for synchronous throwing computations.
export {
  Success,
  Failure,
  success,
  failure,
  tryOf,
  trySequence,
} from './util/Try.js';
export type { Try } from './util/Try.js';

// Either<L, R> — right-biased disjoint union for typed-error flows.
export {
  Left,
  Right,
  left,
  right,
  eitherOf,
  eitherSequence,
} from './util/Either.js';
export type { Either } from './util/Either.js';

// BidirectionalMap<K, V> — a Map that also answers value → key, keeping the
// inverse index in step for you.  Persists as a real instance.
export { BidirectionalMap } from './util/BidirectionalMap.js';
export type { BidirectionalMapJson } from './util/BidirectionalMap.js';

// BidirectionalMultiMap<L, R> — the same idea for a many-to-many relation:
// drop a participant on one side and it leaves no trace on the other.
export { BidirectionalMultiMap } from './util/BidirectionalMultiMap.js';
export type { BidirectionalMultiMapJson } from './util/BidirectionalMultiMap.js';

export { OptionsBuilder } from './util/OptionsBuilder.js';
export { OptionsValidator, OptionsError } from './util/OptionsValidator.js';

// Random strings — crypto entropy, no modulo bias, exact length, and an optional
// collision predicate that redraws for you.  The same source the framework names
// its own actors and reply refs from.
export { randomString, randomHex, randomId, randomUuid } from './util/RandomString.js';
export type { ExistsPredicate, RandomStringOptions } from './util/RandomString.js';

// safeStringify — JSON.stringify for log and error paths, which cannot throw.
export { safeStringify } from './util/SafeStringify.js';

// lazyImportModule — import an optional peer dependency, or fail with a message
// that names the package and how to install it.
export { lazyImportModule } from './util/LazyImport.js';
export type { LazyImportOptions } from './util/LazyImport.js';

// Core API
export { Actor } from './Actor.js';
export { ActorRef, Nobody, NobodyRef } from './ActorRef.js';
export { ActorPath } from './ActorPath.js';
export { ActorSelection, parseSelectionPath } from './ActorSelection.js';
export { ActorSystem } from './ActorSystem.js';
export { ActorSystemOptions, ActorSystemOptionsBuilder } from './ActorSystemOptions.js';
export type { ActorSystemOptionsType } from './ActorSystemOptions.js';
export type { ActorContext, Receive, TimerScheduler } from './ActorContext.js';
export { StashOverflowError, StashOutsideHandlerError } from './ActorContext.js';
export { ActorOptions, ActorOptionsBuilder, ActorOptionsValidator } from './ActorOptions.js';
export type { ActorOptionsType, MailboxFactory } from './ActorOptions.js';
export type { ActorClassOrFactory, ActorFactory } from './Actor.js';
export type { EntityContext } from './EntityContext.js';

// Supervision
export {
  Directive,
  OneForOneStrategy,
  AllForOneStrategy,
  defaultStrategy,
  stoppingStrategy,
  escalatingStrategy,
  decideBy,
  ActorInitializationError,
  DeathPactError,
} from './Supervision.js';
export type { Decider, SupervisorStrategy, StrategyOptions } from './Supervision.js';

// Runtime services
export { Scheduler } from './Scheduler.js';
export type { Cancellable } from './Scheduler.js';
export {
  Dispatchers,
  ImmediateDispatcher,
  MicrotaskDispatcher,
  ThroughputDispatcher,
} from './Dispatcher.js';
export type { Dispatcher } from './Dispatcher.js';
export { EventStream } from './EventStream.js';
export { EventKey } from './EventKey.js';
export type { EventChannel, EventClass, KindOf } from './EventKey.js';
export { ConsoleLogger, NoopLogger, JsonLogger, LogLevel, DISPLAY_NAME_FIELD } from './Logger.js';
export type { Logger, JsonLogSink } from './Logger.js';
export { LogContext } from './LogContext.js';
export type { LogContextData, LogContextEntry } from './LogContext.js';

// Metrics — Counter / Gauge / Histogram + Prometheus exposition (#11).
export {
  DefaultMetricsRegistry,
  NoopMetricsRegistry,
  DEFAULT_HISTOGRAM_BUCKETS,
  DEFAULT_MAX_SERIES_PER_FAMILY,
  METRICS_OVERFLOW_LABEL_VALUE,
  bucketize,
  MetricsExtension,
  MetricsExtensionId,
  MetricsRegistryOptions,
  MetricsRegistryOptionsBuilder,
  MetricsRegistryOptionsValidator,
  metricsOf,
  exportPrometheus,
  prometheusHandler,
  promClientRegistry,
  PromClientAdapterOptions,
  PromClientAdapterOptionsValidator,
} from './metrics/index.js';
export type {
  MetricsRegistry,
  MetricsRegistryOptionsType,
  Counter,
  Gauge,
  Histogram,
  MetricSample,
  Labels,
  LabelValue,
  CounterOptions,
  GaugeOptions,
  HistogramOptions,
  PromClientLike,
  PromClientRegistryLike,
  PromClientCounter,
  PromClientGauge,
  PromClientHistogram,
  PromClientLabelValues,
  PromClientAdapterOptionsType,
} from './metrics/index.js';

// Distributed tracing — minimal Tracer + NoopTracer + RecordingTracer (#10).
export {
  NoopTracer,
  NOOP_TRACER,
  RecordingTracer,
  TracingExtension,
  TracingExtensionId,
  tracerOf,
  encodeTraceparent,
  decodeTraceparent,
  newTraceId,
  newSpanId,
  otelTracer,
  otelLogger,
  OtelAdapterOptions,
} from './tracing/index.js';
export type {
  Tracer,
  Span,
  SpanContext,
  SpanOptions,
  SpanKind,
  SpanStatus,
  AttributeValue,
  TraceCarrier,
  RecordedSpan,
  RecordingTracerOptions,
  OtelAdapterOptionsType,
  OtelApiLike,
  OtelContextApi,
  OtelContextLike,
  OtelPropagationApi,
  OtelSpanContextLike,
  OtelSpanLike,
  OtelTraceApi,
  OtelTracerLike,
  OtelLoggerAdapterOptions,
  OtelLogsApiLike,
  OtelLoggerProviderLike,
  OtelLoggerLike,
  OtelLogRecord,
  OtelSeverityNumber,
} from './tracing/index.js';

// System messages
export {
  PoisonPill,
  Kill,
  Terminated,
  ReceiveTimeout,
  DeadLetter,
  ActorLifecycleEvent,
  ActorStarted,
  ActorStopped,
  ActorRestarted,
  ActorKilledError,
  AskTimeoutError,
} from './SystemMessages.js';

// Patterns — Success / Failure live in util/Try.js (already exported above).
export {
  pipeTo,
  after,
  retry,
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitBreakerTimeoutError,
  CircuitBreakerOptions,
  CircuitBreakerOptionsBuilder,
  exponentialBackoff,
  linearBackoff,
  BackoffSupervisor,
} from './pattern/index.js';
export type {
  PipeToOptions,
  CancellablePromise,
  RetryOptions,
  CircuitBreakerOptionsType,
  CircuitState,
  BackoffPolicy,
  ExponentialBackoffOptions,
  LinearBackoffOptions,
  BackoffOptions,
  ResetCounter,
  ForwardStrategy,
} from './pattern/index.js';
export {
  Router,
  Broadcast,
  roundRobinStrategy,
  randomStrategy,
  broadcastStrategy,
  smallestMailboxStrategy,
} from './Router.js';
export type { RoutingStrategy, RouterState } from './Router.js';
export {
  ScatterGatherOptions,
  ScatterGatherOptionsBuilder,
  ScatterGatherOptionsValidator,
} from './ScatterGatherOptions.js';
export type { ScatterGatherOptionsType } from './ScatterGatherOptions.js';

// Cluster (multi-node: membership, gossip, sharding, rebalance).
export * from './cluster/index.js';

// Configuration (HOCON with code overrides).
export {
  Config,
  ConfigError,
  parseDuration,
  parseSize,
  parseHocon,
  resolveSubstitutions,
  deepMerge,
  REFERENCE_CONF,
} from './config/index.js';
export type { LoadOptions, ConfigObject, ConfigValue } from './config/index.js';

// Serialization (pluggable, JSON + CBOR built-in; Avro + Protobuf take a
// compiled schema the user brings).
export {
  SerializationExtension,
  SerializationExtensionId,
  JsonSerializer,
  CborSerializer,
  CborEncoder,
  CborDecoder,
  CborEncodeError,
  CborDecodeError,
  SerializationError,
  RESERVED_SERIALIZER_IDS_BELOW,
  AvroSerializer,
  AvroSerializerOptions,
  AvroSerializerOptionsBuilder,
  AvroSerializerOptionsValidator,
  ProtobufSerializer,
  ProtobufSerializerOptions,
  ProtobufSerializerOptionsBuilder,
  ProtobufSerializerOptionsValidator,
} from './serialization/index.js';
export type {
  Serializer,
  SerializedValue,
  AvroSerializerOptionsType,
  AvroType,
  ProtobufSerializerOptionsType,
  ProtobufMessageType,
  ProtobufWriter,
  ProtobufConversionOptions,
} from './serialization/index.js';

// Extensions mechanism.
export { Extensions, extensionId } from './Extension.js';
export type { Extension, ExtensionId } from './Extension.js';

// Coordinated Shutdown (phase-ordered graceful termination).
export {
  CoordinatedShutdown,
  CoordinatedShutdownId,
  Phases,
  Reason,
  UnknownReason,
  ActorSystemTerminateReason,
  ClusterLeavingReason,
  ClusterDowningReason,
  ProcessTerminateReason,
} from './CoordinatedShutdown.js';
export type { ShutdownTask, PhaseDefinition } from './CoordinatedShutdown.js';

// TestKit (TestProbe, ManualScheduler).
export { TestKit, TestKitOptions, TestProbe, TestProbeOptions, ManualScheduler } from './testkit/index.js';
export type { TestKitOptionsType, TestProbeOptionsType } from './testkit/index.js';

// Persistence / Event Sourcing.
export {
  PersistentActor,
  PersistenceExtension,
  PersistenceExtensionId,
  InMemoryJournal,
  InMemorySnapshotStore,
  SqliteJournal,
  SqliteSnapshotStore,
  // The lock-wait budget every SQLite handle gets, and the seam that opens
  // one.  Both were reachable only through the internal barrel, which left
  // the `busyTimeoutMs` default unobservable from outside the package and the
  // documented "share ONE handle across stores" route unusable (#124).
  DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
  buildSqliteDatabase,
  JournalConcurrencyError,
  JournalError,
  SnapshotIntegrityError,
  JournalIntegrityError,
  everyNEvents,
  DurableStateActor,
  InMemoryDurableStateStore,
  DurableStateConcurrencyError,
  CassandraJournal,
  CassandraSnapshotStore,
  createCassandraClient,
  keyspaceDdl,
  registerCassandraPlugins,
  CASSANDRA_JOURNAL_PLUGIN_ID,
  CASSANDRA_SNAPSHOT_PLUGIN_ID,
  PostgresJournal,
  PostgresSnapshotStore,
  PostgresDurableStateStore,
  registerPostgresPlugins,
  POSTGRES_JOURNAL_PLUGIN_ID,
  POSTGRES_SNAPSHOT_PLUGIN_ID,
  POSTGRES_DURABLE_STATE_PLUGIN_ID,
  MariaDbJournal,
  MariaDbSnapshotStore,
  MariaDbDurableStateStore,
  registerMariaDbPlugins,
  MARIADB_JOURNAL_PLUGIN_ID,
  MARIADB_SNAPSHOT_PLUGIN_ID,
  MARIADB_DURABLE_STATE_PLUGIN_ID,
  LibSqlJournal,
  LibSqlSnapshotStore,
  LibSqlDurableStateStore,
  registerLibSqlPlugins,
  LIBSQL_JOURNAL_PLUGIN_ID,
  LIBSQL_SNAPSHOT_PLUGIN_ID,
  LIBSQL_DURABLE_STATE_PLUGIN_ID,
  LazyStore,
  MsSqlJournal,
  MsSqlSnapshotStore,
  MsSqlDurableStateStore,
  registerMsSqlPlugins,
  MSSQL_JOURNAL_PLUGIN_ID,
  MSSQL_SNAPSHOT_PLUGIN_ID,
  MSSQL_DURABLE_STATE_PLUGIN_ID,
  MongoJournal,
  MongoSnapshotStore,
  MongoDurableStateStore,
  MongoQuery,
  MongoStore,
  registerMongoPlugins,
  isMongoDuplicateKeyError,
  DEFAULT_MONGO_DATABASE,
  MONGO_JOURNAL_PLUGIN_ID,
  MONGO_SNAPSHOT_PLUGIN_ID,
  MONGO_DURABLE_STATE_PLUGIN_ID,
  DynamoDbJournal,
  DynamoDbSnapshotStore,
  DynamoDbDurableStateStore,
  DynamoDbStore,
  registerDynamoDbPlugins,
  isConditionalCheckFailed,
  DYNAMODB_JOURNAL_PLUGIN_ID,
  DYNAMODB_SNAPSHOT_PLUGIN_ID,
  DYNAMODB_DURABLE_STATE_PLUGIN_ID,
  D1Journal,
  D1SnapshotStore,
  D1DurableStateStore,
  registerD1Plugins,
  D1RequestError,
  DEFAULT_D1_BASE_URL,
  D1_JOURNAL_PLUGIN_ID,
  D1_SNAPSHOT_PLUGIN_ID,
  D1_DURABLE_STATE_PLUGIN_ID,
  FilesystemObjectStorageBackend,
  S3ObjectStorageBackend,
  ObjectStorageSnapshotStore,
  ObjectStorageDurableStateStore,
  ObjectStorageBackendError,
  ObjectStorageConcurrencyError,
  registerObjectStoragePlugins,
  OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID,
  OBJECT_STORAGE_DURABLE_STATE_PLUGIN_ID,
  compressionByPrefix,
  encryptionByPrefix,
  resolveCompression,
  resolveEncryption,
  MigrationChain,
  MigrationError,
  defaultsAdapter,
  defaultsSnapshotAdapter,
  migratingAdapter,
  migratingSnapshotAdapter,
  jsonCodec,
  zodCodec,
  composeCodecs,
  serializerCodec,
  validatedEventAdapter,
  validatedSnapshotAdapter,
  InMemorySchemaRegistry,
  InMemoryQuery,
  SqliteQuery,
  CassandraQuery,
  offsetStart,
  offsetCompare,
  offsetGreater,
  offsetGreaterOrEqual,
  offsetOfEvent,
  normalizeTagFilter,
  eventMatchesTagFilter,
  tagFilterCursorKey,
  defaultPersistenceIdPageSize,
  persistenceIdPage,
  ProjectionActor,
  InMemoryOffsetStore,
  DurableStateOffsetStore,
  // Fluent options builders (builder-only construction).
  SqliteJournalOptions,
  SqliteSnapshotStoreOptions,
  CassandraJournalOptions,
  CassandraSnapshotStoreOptions,
  RegisterCassandraPluginsOptions,
  PostgresJournalOptions,
  PostgresSnapshotStoreOptions,
  PostgresDurableStateStoreOptions,
  RegisterPostgresPluginsOptions,
  MariaDbJournalOptions,
  MariaDbSnapshotStoreOptions,
  MariaDbDurableStateStoreOptions,
  RegisterMariaDbPluginsOptions,
  LibSqlJournalOptions,
  LibSqlSnapshotStoreOptions,
  LibSqlDurableStateStoreOptions,
  RegisterLibSqlPluginsOptions,
  MsSqlJournalOptions,
  MsSqlSnapshotStoreOptions,
  MsSqlDurableStateStoreOptions,
  RegisterMsSqlPluginsOptions,
  MongoJournalOptions,
  MongoSnapshotStoreOptions,
  MongoDurableStateStoreOptions,
  RegisterMongoPluginsOptions,
  DynamoDbJournalOptions,
  DynamoDbSnapshotStoreOptions,
  DynamoDbDurableStateStoreOptions,
  RegisterDynamoDbPluginsOptions,
  D1JournalOptions,
  D1SnapshotStoreOptions,
  D1DurableStateStoreOptions,
  RegisterD1PluginsOptions,
  FilesystemObjectStorageOptions,
  S3ObjectStorageOptions,
  ObjectStorageSnapshotStoreOptions,
  ObjectStorageDurableStateStoreOptions,
  ObjectStoragePluginOptions,
  ProjectionOptions,
  ByPersistenceIdProjectionOptions,
  ByTagProjectionOptions,
  DurableStateOptions,
  DurableStateOptionsValidator,
  assertValidPersistenceId,
  persistenceIdRejection,
  MAX_PERSISTENCE_ID_LENGTH,
  ReplicatedEventSourcedActor,
  VectorClock,
  LastWriterWinsResolver,
  CustomMergeResolver,
  eventDispatcher,
  CachedSnapshotStore,
  CachedSnapshotStoreOptions,
  reEncryptObjectStorage,
  InMemoryReEncryptProgressStore,
} from './persistence/index.js';
export type {
  Journal,
  SnapshotStore,
  PersistentEvent,
  Snapshot,
  SnapshotPolicy,
  DurableStateOptionsType,
  DurableStateStore,
  DurableStateRecord,
  CassandraJournalOptionsType,
  CassandraSnapshotStoreOptionsType,
  CassandraClientLike,
  CassandraConnection,
  CassandraRowResult,
  CassandraBatchQuery,
  RegisterCassandraPluginsOptionsType,
  PostgresJournalOptionsType,
  PostgresSnapshotStoreOptionsType,
  PostgresDurableStateStoreOptionsType,
  RegisterPostgresPluginsOptionsType,
  PostgresPluginHandles,
  PostgresConnection,
  PgPoolLike,
  PgClientLike,
  MariaDbJournalOptionsType,
  MariaDbSnapshotStoreOptionsType,
  MariaDbDurableStateStoreOptionsType,
  RegisterMariaDbPluginsOptionsType,
  MariaDbPluginHandles,
  MariaDbConnection,
  MariaDbPoolLike,
  MariaDbConnectionLike,
  LibSqlJournalOptionsType,
  LibSqlSnapshotStoreOptionsType,
  LibSqlDurableStateStoreOptionsType,
  RegisterLibSqlPluginsOptionsType,
  LibSqlPluginHandles,
  LibSqlConnection,
  LibSqlClientLike,
  LibSqlResultSet,
  LibSqlStatement,
  LibSqlTransactionLike,
  LazyStoreConfig,
  MsSqlJournalOptionsType,
  MsSqlSnapshotStoreOptionsType,
  MsSqlDurableStateStoreOptionsType,
  RegisterMsSqlPluginsOptionsType,
  MsSqlPluginHandles,
  MsSqlConnection,
  MsSqlPoolLike,
  MsSqlRequestLike,
  MsSqlResult,
  MsSqlTransactionLike,
  MongoJournalOptionsType,
  MongoSnapshotStoreOptionsType,
  MongoDurableStateStoreOptionsType,
  RegisterMongoPluginsOptionsType,
  MongoPluginHandles,
  MongoStoreConfig,
  MongoConnection,
  MongoClientLike,
  MongoCollectionLike,
  MongoCursorLike,
  MongoDatabaseLike,
  MongoDeleteResult,
  MongoDocument,
  MongoResource,
  MongoSortSpec,
  MongoUpdateResult,
  DynamoDbJournalOptionsType,
  DynamoDbSnapshotStoreOptionsType,
  DynamoDbDurableStateStoreOptionsType,
  RegisterDynamoDbPluginsOptionsType,
  DynamoDbPluginHandles,
  DynamoDbStoreConfig,
  DynamoDbTableSchema,
  DynamoDbConnection,
  DynamoDbOperations,
  DynamoDbClientLike,
  DynamoDbAttribute,
  DynamoDbItem,
  D1JournalOptionsType,
  D1SnapshotStoreOptionsType,
  D1DurableStateStoreOptionsType,
  RegisterD1PluginsOptionsType,
  D1PluginHandles,
  D1Connection,
  D1ClientLike,
  D1QueryResult,
  ObjectStorageBackend,
  ObjectFetched,
  ObjectInfo,
  PutOptions,
  FilesystemObjectStorageOptionsType,
  S3ObjectStorageOptionsType,
  S3Credentials,
  S3ClientLike,
  ObjectStorageSnapshotStoreOptionsType,
  ObjectStorageDurableStateStoreOptionsType,
  ObjectStoragePluginOptionsType,
  ObjectStoragePluginHandles,
  ObjectStorageBackendSpec,
  CompressionConfig,
  CompressionResolver,
  CompressionAlgo,
  EncryptionConfig,
  EncryptionResolver,
  EventAdapter,
  SnapshotAdapter,
  StateAdapter,
  JournalEnvelope,
  MigrationStep,
  DowncastStep,
  DefaultsAdapterSpec,
  Codec,
  ParserLike,
  ValidatedAdapterOptions,
  SchemaRegistry,
  SchemaRegistration,
  SchemaDescriptor,
  PersistenceQuery,
  LiveQueryOptions,
  Offset,
  PaginationOptions,
  TaggedEvent,
  TagFilter,
  TagFilterSpec,
  ProjectionOptionsType,
  ByPersistenceIdProjectionOptionsType,
  ByTagProjectionOptionsType,
  OffsetStore,
  ReplicatedEventEnvelope,
  VectorClockData,
  VectorClockOrder,
  ConflictResolver,
  ConflictCandidate,
  EventDispatcherBuilder,
  EventDispatcherIncomplete,
  CachedSnapshotStoreOptionsType,
  ReEncryptOptions,
  ReEncryptResult,
  ReEncryptProgress,
  ReEncryptResumeState,
  ReEncryptProgressStore,
  MasterKeyRing,
  MasterKeyRingEntry,
} from './persistence/index.js';

// CRDTs + DistributedData (gossip-replicated key-value store of CRDTs).
export {
  GCounter,
  PNCounter,
  GSet,
  ORSet,
  LWWRegister,
  GCounterMap,
  LWWMap,
  MVRegister,
  ORMap,
  DistributedData,
  DistributedDataOptions,
  DistributedDataId,
} from './crdt/index.js';
export type {
  Crdt,
  ReplicaId,
  GCounterJson,
  PNCounterJson,
  GSetJson,
  ORSetJson,
  LWWRegisterJson,
  GCounterMapJson,
  GCounterMapOptions,
  LWWMapJson,
  LWWMapOptions,
  MVRegisterJson,
  ORMapJson,
  ORMapOptions,
  DistributedDataOptionsType,
  CrdtFactory,
  CrdtJson,
} from './crdt/index.js';

// HTTP (directives DSL, Fastify default backend, caching middleware).
export * from './http/index.js';

// I/O & message-broker actors (TCP/UDP/MQTT/WebSocket; Kafka/AMQP/gRPC in Phase 2).
export * from './io/index.js';

// Cache abstraction (in-memory / Redis / Memcached) + extension.
export {
  CacheError,
  acquireLock,
  InMemoryCache,
  InMemoryCacheOptions,
  RedisCache,
  RedisCacheOptions,
  MemcachedCache,
  MemcachedCacheOptions,
  CacheExtension,
  CacheExtensionId,
  IN_MEMORY_CACHE_PLUGIN_ID,
  REDIS_CACHE_PLUGIN_ID,
  MEMCACHED_CACHE_PLUGIN_ID,
} from './cache/index.js';
export type {
  Cache,
  CacheLock,
  InMemoryCacheOptionsType,
  RedisCacheOptionsType,
  RedisClientLike,
  MemcachedCacheOptionsType,
  MemcachedClientLike,
} from './cache/index.js';

// Reliable Delivery (at-least-once point-to-point).
export {
  ReliableDelivery,
  ProducerController,
  ProducerControllerOptions,
  ConsumerController,
  ConsumerControllerOptions,
  ConsumerControllerOptionsBuilder,
} from './delivery/index.js';
export type {
  ProducerControllerOptionsType,
  ProducerSend,
  ConsumerControllerOptionsType,
  ProducerHandle,
  ConsumerHandle,
  Delivery,
  Acknowledgment,
  ConfirmationCallback,
} from './delivery/index.js';

// FSM DSL (named-state FSM on top of the OO Actor).
export { FSM, PersistentFSM } from './fsm/index.js';
export type {
  Transition as FsmTransition,
  StayTransition as FsmStay,
  FsmResult,
  StateHandler as FsmStateHandler,
  TransitionCallback as FsmTransitionCallback,
  // #52 — persistent FSM (state-machine + event sourcing).
  FsmStateData,
  FsmTransition as PersistentFsmTransition,
  FsmTransitionMap,
} from './fsm/index.js';

// Mailboxes: the unbounded base (the default since #1148) and its variants.
export {
  Mailbox,
  BoundedMailbox,
  MailboxFullError,
  PriorityMailbox,
  BoundedMailboxOptions,
  BoundedMailboxOptionsBuilder,
  PriorityMailboxOptions,
  PriorityMailboxOptionsBuilder,
} from './mailbox/index.js';
export type {
  DropReportingMailbox,
  Envelope,
  MailboxDropReason,
  BoundedMailboxOptionsType,
  BoundedMailboxOverflow,
  PriorityMailboxOptionsType,
  PriorityFunction,
} from './mailbox/index.js';

// Management (cluster-admin HTTP endpoints + health/readiness probes).
export {
  managementRoutes,
  isHealthy,
  HealthCheckRegistry,
} from './management/index.js';
export type {
  ManagementRoutesOptionsType,
  HealthCheckFunction,
  HealthCheckResult,
} from './management/index.js';

// Coordination (Lease API + InMemoryLease reference + KubernetesLease).
export { InMemoryLease, inMemoryLeaseStore, KubernetesLease, LeaseOptions, KubernetesLeaseOptions } from './coordination/index.js';
export type { Lease, LeaseOptionsType, KubernetesLeaseOptionsType } from './coordination/index.js';

// Discovery / Receptionist + seed providers.
export {
  ServiceKey,
  Receptionist,
  ReceptionistExtension,
  ReceptionistId,
  Register,
  Registered,
  Deregister,
  Find,
  Subscribe as ReceptionistSubscribe,
  Unsubscribe as ReceptionistUnsubscribe,
  // The cluster block above re-exports pub-sub's own `SubscribeRejected`
  // with `export *`; both refusals carry a different payload (`key` vs
  // `topic`), so the discovery one is aliased exactly like `Subscribe` is.
  SubscribeRejected as ReceptionistSubscribeRejected,
  Listing,
  ConfigSeedProvider,
  ConfigSeedProviderOptions,
  seedsFromEnv,
  DnsSeedProvider,
  DnsSeedProviderOptions,
  AggregateSeedProvider,
  KubernetesApiSeedProvider,
  KubernetesApiSeedProviderOptions,
  autoDiscovery,
  AutoDiscoveryOptions,
  singleProviderDiscovery,
  ReceptionistOptions,
} from './discovery/index.js';
export type {
  ReceptionistOptionsType,
  ReceptionistGossipMessage,
  ReceptionistSubscriberRef,
  ReceptionistSubscribeRejectionReason,
  SeedProvider,
  ConfigSeedProviderOptionsType,
  DnsSeedProviderOptionsType,
  KubernetesApiSeedProviderOptionsType,
  AutoDiscoveryOptionsType,
} from './discovery/index.js';

// Typed Behaviors DSL (functional facade over the OO Actor API).
export {
  Behaviors,
  TypedActor,
  typedActor,
  same,
  stopped,
  unhandled,
  empty,
  ignore,
} from './typed/index.js';
export type {
  Behavior,
  BehaviorInterceptor,
  BehaviorInterceptorTarget,
  Signal,
  StashBuffer,
  TypedActorContext,
  ReceiveBehavior,
  SetupBehavior,
  WithTimersBehavior,
  WithStashBehavior,
  SuperviseBehavior,
  InterceptBehavior,
  SameBehavior,
  StoppedBehavior,
  UnhandledBehavior,
  EmptyBehavior,
  IgnoreBehavior,
  SuperviseBuilder,
  LogMessagesOptions,
} from './typed/index.js';

// Worker-Cluster (multi-core via Bun/Web-Workers).
export { WorkerCluster, WorkerClusterOptions, WorkerBroker, WorkerNode } from './worker/index.js';
export type {
  WorkerClusterOptionsType,
  WorkerBackend,
  WorkerHandle,
  WorkerInitMessage,
  WorkerReadyMessage,
  WorkerNodeContext,
  RestartPolicy,
} from './worker/index.js';
