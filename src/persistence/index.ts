export {
  PersistenceExtension,
  PersistenceExtensionId,
} from './PersistenceExtension.js';
export { PersistentActor, everyNEvents } from './PersistentActor.js';
export type { SnapshotPolicy } from './PersistentActor.js';

export { eventDispatcher } from './EventDispatcher.js';
export type { EventDispatcherBuilder, EventDispatcherIncomplete } from './EventDispatcher.js';

export type { Journal } from './Journal.js';
export type { SnapshotStore } from './SnapshotStore.js';
export type { PersistentEvent, Snapshot } from './JournalTypes.js';
export { JournalConcurrencyError, JournalError } from './JournalTypes.js';
export type {
  CompressionAlgo,
  CompressionConfig,
  EncryptionConfig,
  PersistenceOptions,
} from './PersistenceOptions.js';

export { InMemoryJournal } from './journals/InMemoryJournal.js';
export { SqliteJournal } from './journals/SqliteJournal.js';
export { SqliteJournalOptions, SqliteJournalOptionsBuilder } from './journals/SqliteJournalOptions.js';
export type { SqliteJournalOptionsType } from './journals/SqliteJournalOptions.js';
export { InMemorySnapshotStore } from './snapshot-stores/InMemorySnapshotStore.js';
export { SqliteSnapshotStore } from './snapshot-stores/SqliteSnapshotStore.js';
export { SqliteSnapshotStoreOptions, SqliteSnapshotStoreOptionsBuilder } from './snapshot-stores/SqliteSnapshotStoreOptions.js';
export type { SqliteSnapshotStoreOptionsType } from './snapshot-stores/SqliteSnapshotStoreOptions.js';
export { CachedSnapshotStore } from './snapshot-stores/CachedSnapshotStore.js';
export { CachedSnapshotStoreOptions, CachedSnapshotStoreOptionsBuilder } from './snapshot-stores/CachedSnapshotStoreOptions.js';
export type { CachedSnapshotStoreOptionsType } from './snapshot-stores/CachedSnapshotStoreOptions.js';

// Cassandra / ScyllaDB plug-in (same CQL protocol — one plug-in).
export { CassandraJournal } from './journals/CassandraJournal.js';
export { CassandraJournalOptions, CassandraJournalOptionsBuilder } from './journals/CassandraJournalOptions.js';
export type { CassandraJournalOptionsType } from './journals/CassandraJournalOptions.js';
export { CassandraSnapshotStore } from './snapshot-stores/CassandraSnapshotStore.js';
export { CassandraSnapshotStoreOptions, CassandraSnapshotStoreOptionsBuilder } from './snapshot-stores/CassandraSnapshotStoreOptions.js';
export type { CassandraSnapshotStoreOptionsType } from './snapshot-stores/CassandraSnapshotStoreOptions.js';
export {
  createCassandraClient,
  keyspaceDdl,
  tagIndexDdl,
} from './journals/CassandraClient.js';
export type {
  CassandraClientLike,
  CassandraConnection,
  CassandraRowResult,
  CassandraBatchQuery,
} from './journals/CassandraClient.js';
export {
  registerCassandraPlugins,
  CASSANDRA_JOURNAL_PLUGIN_ID,
  CASSANDRA_SNAPSHOT_PLUGIN_ID,
} from './journals/CassandraPlugin.js';
export { RegisterCassandraPluginsOptions, RegisterCassandraPluginsOptionsBuilder } from './journals/CassandraPluginOptions.js';
export type { RegisterCassandraPluginsOptionsType } from './journals/CassandraPluginOptions.js';

// PostgreSQL plug-in (journal + snapshot + durable-state).
export { PostgresJournal } from './journals/PostgresJournal.js';
export { PostgresJournalOptions, PostgresJournalOptionsBuilder } from './journals/PostgresJournalOptions.js';
export type { PostgresJournalOptionsType } from './journals/PostgresJournalOptions.js';
export { PostgresSnapshotStore } from './snapshot-stores/PostgresSnapshotStore.js';
export { PostgresSnapshotStoreOptions, PostgresSnapshotStoreOptionsBuilder } from './snapshot-stores/PostgresSnapshotStoreOptions.js';
export type { PostgresSnapshotStoreOptionsType } from './snapshot-stores/PostgresSnapshotStoreOptions.js';
export { PostgresDurableStateStore } from './durable-state-stores/PostgresDurableStateStore.js';
export { PostgresDurableStateStoreOptions, PostgresDurableStateStoreOptionsBuilder } from './durable-state-stores/PostgresDurableStateStoreOptions.js';
export type { PostgresDurableStateStoreOptionsType } from './durable-state-stores/PostgresDurableStateStoreOptions.js';
export {
  registerPostgresPlugins,
  POSTGRES_JOURNAL_PLUGIN_ID,
  POSTGRES_SNAPSHOT_PLUGIN_ID,
  POSTGRES_DURABLE_STATE_PLUGIN_ID,
} from './journals/PostgresPlugin.js';
export { RegisterPostgresPluginsOptions, RegisterPostgresPluginsOptionsBuilder } from './journals/PostgresPluginOptions.js';
export type { RegisterPostgresPluginsOptionsType } from './journals/PostgresPluginOptions.js';
export type { PostgresPluginHandles } from './journals/PostgresPlugin.js';
export type {
  PostgresConnection,
  PgPoolLike,
  PgClientLike,
} from './journals/PostgresClient.js';

// MariaDB / MySQL plug-in (journal + snapshot + durable-state).
export { MariaDbJournal } from './journals/MariaDbJournal.js';
export { MariaDbJournalOptions, MariaDbJournalOptionsBuilder } from './journals/MariaDbJournalOptions.js';
export type { MariaDbJournalOptionsType } from './journals/MariaDbJournalOptions.js';
export { MariaDbSnapshotStore } from './snapshot-stores/MariaDbSnapshotStore.js';
export { MariaDbSnapshotStoreOptions, MariaDbSnapshotStoreOptionsBuilder } from './snapshot-stores/MariaDbSnapshotStoreOptions.js';
export type { MariaDbSnapshotStoreOptionsType } from './snapshot-stores/MariaDbSnapshotStoreOptions.js';
export { MariaDbDurableStateStore } from './durable-state-stores/MariaDbDurableStateStore.js';
export { MariaDbDurableStateStoreOptions, MariaDbDurableStateStoreOptionsBuilder } from './durable-state-stores/MariaDbDurableStateStoreOptions.js';
export type { MariaDbDurableStateStoreOptionsType } from './durable-state-stores/MariaDbDurableStateStoreOptions.js';
export {
  registerMariaDbPlugins,
  MARIADB_JOURNAL_PLUGIN_ID,
  MARIADB_SNAPSHOT_PLUGIN_ID,
  MARIADB_DURABLE_STATE_PLUGIN_ID,
} from './journals/MariaDbPlugin.js';
export { RegisterMariaDbPluginsOptions, RegisterMariaDbPluginsOptionsBuilder } from './journals/MariaDbPluginOptions.js';
export type { RegisterMariaDbPluginsOptionsType } from './journals/MariaDbPluginOptions.js';
export type { MariaDbPluginHandles } from './journals/MariaDbPlugin.js';
export type {
  MariaDbConnection,
  MariaDbPoolLike,
  MariaDbConnectionLike,
} from './journals/MariaDbClient.js';

// Durable State (state-oriented alternative to Event Sourcing).
export { DurableStateActor } from './DurableStateActor.js';
export { DurableStateOptions, DurableStateOptionsBuilder } from './DurableStateOptions.js';
export type { DurableStateOptionsType } from './DurableStateOptions.js';
export {
  DurableStateConcurrencyError,
} from './DurableStateStore.js';
export type {
  DurableStateStore,
  DurableStateRecord,
} from './DurableStateStore.js';
export { InMemoryDurableStateStore } from './durable-state-stores/InMemoryDurableStateStore.js';

// Schema-evolution / migration: adapters, envelope helpers, MigrationChain, defaultsAdapter.
export type {
  EventAdapter,
  SnapshotAdapter,
  StateAdapter,
  JournalEnvelope,
  StoredFrame,
  OutboundFrame,
  MigrationStep,
  DowncastStep,
  DefaultsAdapterSpec,
  MigrationResult,
  // #6 — codec + schema registry types.
  Codec,
  ParserLike,
  ValidatedAdapterOptions,
  SchemaRegistry,
  SchemaRegistration,
  SchemaDescriptor,
  // #87 — journal-to-journal + snapshot-store-to-snapshot-store copy.
  MigrateJournalsOptions,
  MigrateJournalsResult,
  MigrateSnapshotStoresOptions,
  MigrateSnapshotStoresResult,
  MigrationProgress,
  MigrationProgressStore,
} from './migration/index.js';
export {
  MigrationError,
  MigrationChain,
  defaultsAdapter,
  defaultsSnapshotAdapter,
  migratingAdapter,
  migratingSnapshotAdapter,
  isEnvelope,
  encodeEvent,
  decodeEvent,
  encodeState,
  decodeState,
  wrapEventAsEnvelope,
  wrapStateAsEnvelope,
  migrateInMemoryJournal,
  migrateSnapshotStore,
  formatMigrationResult,
  // #6 — codec + schema registry runtime.
  jsonCodec,
  zodCodec,
  composeCodecs,
  validatedEventAdapter,
  validatedSnapshotAdapter,
  InMemorySchemaRegistry,
  // #87 — journal-to-journal + snapshot-store-to-snapshot-store copy.
  migrateBetweenJournals,
  migrateBetweenSnapshotStores,
  InMemoryMigrationProgressStore,
} from './migration/index.js';

// Persistence Query — read-side query layer for projections.
export type {
  PersistenceQuery,
  LiveQueryOptions,
  Offset,
  TaggedEvent,
  TagFilter,
  TagFilterSpec,
} from './query/PersistenceQuery.js';
export {
  offsetStart,
  offsetCompare,
  offsetGreater,
  offsetGreaterOrEqual,
  offsetOfEvent,
  normalizeTagFilter,
  eventMatchesTagFilter,
} from './query/PersistenceQuery.js';
export { InMemoryQuery } from './query/InMemoryQuery.js';
export { SqliteQuery } from './query/SqliteQuery.js';
export { CassandraQuery } from './query/CassandraQuery.js';

// Replicated Event Sourcing — multi-master event-sourced actors.
export { ReplicatedEventSourcedActor } from './ReplicatedEventSourcedActor.js';
export type { ReplicatedEventEnvelope } from './ReplicatedEventSourcedActor.js';
export { VectorClock } from './replicated/VectorClock.js';
export type { VectorClockData, VectorClockOrder } from './replicated/VectorClock.js';
export {
  LastWriterWinsResolver,
  CustomMergeResolver,
} from './replicated/ConflictResolver.js';
export type {
  ConflictResolver,
  ConflictCandidate,
} from './replicated/ConflictResolver.js';

// Projections — actor wrapper with at-least-once delivery + offset persistence.
export {
  ProjectionActor,
} from './projection/ProjectionActor.js';
export {
  ProjectionOptions,
  ProjectionOptionsBuilder,
  ByPidProjectionOptions,
  ByPidProjectionOptionsBuilder,
  ByTagProjectionOptions,
  ByTagProjectionOptionsBuilder,
} from './projection/ProjectionOptions.js';
export type {
  ProjectionOptionsType,
  ByPidProjectionOptionsType,
  ByTagProjectionOptionsType,
} from './projection/ProjectionOptions.js';
export type { OffsetStore } from './projection/OffsetStore.js';
export {
  InMemoryOffsetStore,
  DurableStateOffsetStore,
} from './projection/OffsetStore.js';

// Object-storage plug-in (S3 / filesystem) for snapshots + durable state.
export {
  ObjectStorageBackendError,
  ObjectStorageConcurrencyError,
} from './object-storage/ObjectStorageBackend.js';
export type {
  ObjectStorageBackend,
  ObjectFetched,
  ObjectInfo,
  PutOptions,
} from './object-storage/ObjectStorageBackend.js';
export { FilesystemObjectStorageBackend } from './object-storage/FilesystemObjectStorageBackend.js';
export { FilesystemObjectStorageOptions, FilesystemObjectStorageOptionsBuilder } from './object-storage/FilesystemObjectStorageOptions.js';
export type { FilesystemObjectStorageOptionsType } from './object-storage/FilesystemObjectStorageOptions.js';
export { S3ObjectStorageBackend } from './object-storage/S3ObjectStorageBackend.js';
export { S3ObjectStorageOptions, S3ObjectStorageOptionsBuilder } from './object-storage/S3ObjectStorageOptions.js';
export type { S3ObjectStorageOptionsType } from './object-storage/S3ObjectStorageOptions.js';
export type {
  S3Credentials,
  S3ClientLike,
} from './object-storage/S3ObjectStorageBackend.js';
export {
  ObjectStorageSnapshotStore,
} from './snapshot-stores/ObjectStorageSnapshotStore.js';
export { ObjectStorageSnapshotStoreOptions, ObjectStorageSnapshotStoreOptionsBuilder } from './snapshot-stores/ObjectStorageSnapshotStoreOptions.js';
export type { ObjectStorageSnapshotStoreOptionsType } from './snapshot-stores/ObjectStorageSnapshotStoreOptions.js';
export { ObjectStorageDurableStateStore } from './durable-state-stores/ObjectStorageDurableStateStore.js';
export { ObjectStorageDurableStateStoreOptions, ObjectStorageDurableStateStoreOptionsBuilder } from './durable-state-stores/ObjectStorageDurableStateStoreOptions.js';
export type { ObjectStorageDurableStateStoreOptionsType } from './durable-state-stores/ObjectStorageDurableStateStoreOptions.js';
export {
  registerObjectStoragePlugins,
  OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID,
  OBJECT_STORAGE_DURABLE_STATE_PLUGIN_ID,
} from './object-storage/ObjectStoragePlugin.js';
export { ObjectStoragePluginOptions, ObjectStoragePluginOptionsBuilder } from './object-storage/ObjectStoragePluginOptions.js';
export type { ObjectStoragePluginOptionsType } from './object-storage/ObjectStoragePluginOptions.js';
export type {
  ObjectStoragePluginHandles,
  ObjectStorageBackendSpec,
} from './object-storage/ObjectStoragePlugin.js';
export {
  compressionByPrefix,
  encryptionByPrefix,
  resolveCompression,
  resolveEncryption,
} from './object-storage/PluginConfig.js';
export type {
  CompressionResolver,
  EncryptionResolver,
} from './object-storage/PluginConfig.js';
export {
  reEncryptObjectStorage,
  InMemoryReEncryptProgressStore,
} from './object-storage/reEncryptionSweep.js';
export type {
  ReEncryptOptions,
  ReEncryptResult,
  ReEncryptProgress,
  ReEncryptResumeState,
  ReEncryptProgressStore,
} from './object-storage/reEncryptionSweep.js';
