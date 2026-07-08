/*
 * actor-ts — an actor-model framework for TypeScript on Bun.
 *
 *   Quick start:
 *     import { ActorSystem, Actor, Props } from 'actor-ts';
 *
 *     class Hello extends Actor<string> {
 *       onReceive(msg: string) { console.log('hello', msg); }
 *     }
 *
 *     const system = ActorSystem.create('demo');
 *     const ref = system.spawn(Props.create(() => new Hello()), 'hello');
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
export { OptionsBuilder } from './util/OptionsBuilder.js';

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
export { Props } from './Props.js';
export type { ActorFactory, PropsConfig } from './Props.js';

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
export { ConsoleLogger, NoopLogger, JsonLogger, LogLevel } from './Logger.js';
export type { Logger, JsonLogSink } from './Logger.js';
export { LogContext } from './LogContext.js';
export type { LogContextData } from './LogContext.js';

// Metrics — Counter / Gauge / Histogram + Prometheus exposition (#11).
export {
  DefaultMetricsRegistry,
  NoopMetricsRegistry,
  DEFAULT_HISTOGRAM_BUCKETS,
  MetricsExtension,
  MetricsExtensionId,
  metricsOf,
  exportPrometheus,
  prometheusHandler,
  promClientRegistry,
  PromClientAdapterOptions,
} from './metrics/index.js';
export type {
  MetricsRegistry,
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
} from './Router.js';
export type { RoutingStrategy, RouterState } from './Router.js';

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

// Serialization (pluggable, JSON + CBOR built-in).
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
} from './serialization/index.js';
export type { Serializer, SerializedValue } from './serialization/index.js';

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
  JournalConcurrencyError,
  JournalError,
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
  FilesystemObjectStorageOptions,
  S3ObjectStorageOptions,
  ObjectStorageSnapshotStoreOptions,
  ObjectStorageDurableStateStoreOptions,
  ObjectStoragePluginOptions,
  ProjectionOptions,
  ByPersistenceIdProjectionOptions,
  ByTagProjectionOptions,
  DurableStateOptions,
  ReplicatedEventSourcedActor,
  VectorClock,
  LastWriterWinsResolver,
  CustomMergeResolver,
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
} from './persistence/index.js';

// CRDTs + DistributedData (gossip-replicated key-value store of CRDTs).
export {
  GCounter,
  PNCounter,
  GSet,
  ORSet,
  LWWRegister,
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
  InMemoryCache,
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

// Mailbox variants (BoundedMailbox, PriorityMailbox).
export {
  BoundedMailbox,
  MailboxFullError,
  PriorityMailbox,
} from './mailbox/index.js';
export type {
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
  HealthCheckFn,
  HealthCheckResult,
} from './management/index.js';

// Coordination (Lease API + InMemoryLease reference + KubernetesLease stub).
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
  typedProps,
  same,
  stopped,
  unhandled,
  empty,
  ignore,
} from './typed/index.js';
export type {
  Behavior,
  Signal,
  StashBuffer,
  TypedActorContext,
  ReceiveBehavior,
  SetupBehavior,
  WithTimersBehavior,
  WithStashBehavior,
  SuperviseBehavior,
  SameBehavior,
  StoppedBehavior,
  UnhandledBehavior,
  EmptyBehavior,
  IgnoreBehavior,
  SuperviseBuilder,
} from './typed/index.js';

// Worker-Cluster (multi-core via Bun/Web-Workers).
export { WorkerCluster, WorkerClusterOptions, WorkerBroker, WorkerNode } from './worker/index.js';
export type {
  WorkerClusterOptionsType,
  WorkerHandle,
  WorkerInitMessage,
  WorkerReadyMessage,
  WorkerNodeContext,
  RestartPolicy,
} from './worker/index.js';
