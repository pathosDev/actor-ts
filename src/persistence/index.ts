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
export { SqliteJournal, SqliteJournalOptions } from './journals/SqliteJournal.js';
export type { SqliteJournalSettings } from './journals/SqliteJournal.js';
export { InMemorySnapshotStore } from './snapshot-stores/InMemorySnapshotStore.js';
export { SqliteSnapshotStore, SqliteSnapshotStoreOptions } from './snapshot-stores/SqliteSnapshotStore.js';
export type { SqliteSnapshotStoreSettings } from './snapshot-stores/SqliteSnapshotStore.js';
export { CachedSnapshotStore, CachedSnapshotStoreOptions } from './snapshot-stores/CachedSnapshotStore.js';
export type { CachedSnapshotStoreSettings } from './snapshot-stores/CachedSnapshotStore.js';

// Cassandra / ScyllaDB plug-in (same CQL protocol — one plug-in).
export { CassandraJournal, CassandraJournalOptions } from './journals/CassandraJournal.js';
export type { CassandraJournalSettings } from './journals/CassandraJournal.js';
export { CassandraSnapshotStore, CassandraSnapshotStoreOptions } from './snapshot-stores/CassandraSnapshotStore.js';
export type { CassandraSnapshotStoreSettings } from './snapshot-stores/CassandraSnapshotStore.js';
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
  RegisterCassandraPluginsOptions,
  CASSANDRA_JOURNAL_PLUGIN_ID,
  CASSANDRA_SNAPSHOT_PLUGIN_ID,
} from './journals/CassandraPlugin.js';
export type { RegisterCassandraPluginsSettings } from './journals/CassandraPlugin.js';

// PostgreSQL plug-in (journal + snapshot + durable-state).
export { PostgresJournal, PostgresJournalOptions } from './journals/PostgresJournal.js';
export type { PostgresJournalSettings } from './journals/PostgresJournal.js';
export { PostgresSnapshotStore, PostgresSnapshotStoreOptions } from './snapshot-stores/PostgresSnapshotStore.js';
export type { PostgresSnapshotStoreSettings } from './snapshot-stores/PostgresSnapshotStore.js';
export { PostgresDurableStateStore, PostgresDurableStateStoreOptions } from './durable-state-stores/PostgresDurableStateStore.js';
export type { PostgresDurableStateStoreSettings } from './durable-state-stores/PostgresDurableStateStore.js';
export {
  registerPostgresPlugins,
  RegisterPostgresPluginsOptions,
  POSTGRES_JOURNAL_PLUGIN_ID,
  POSTGRES_SNAPSHOT_PLUGIN_ID,
  POSTGRES_DURABLE_STATE_PLUGIN_ID,
} from './journals/PostgresPlugin.js';
export type {
  RegisterPostgresPluginsSettings,
  PostgresPluginHandles,
} from './journals/PostgresPlugin.js';
export type {
  PostgresConnection,
  PgPoolLike,
  PgClientLike,
} from './journals/PostgresClient.js';

// MariaDB / MySQL plug-in (journal + snapshot + durable-state).
export { MariaDbJournal, MariaDbJournalOptions } from './journals/MariaDbJournal.js';
export type { MariaDbJournalSettings } from './journals/MariaDbJournal.js';
export { MariaDbSnapshotStore, MariaDbSnapshotStoreOptions } from './snapshot-stores/MariaDbSnapshotStore.js';
export type { MariaDbSnapshotStoreSettings } from './snapshot-stores/MariaDbSnapshotStore.js';
export { MariaDbDurableStateStore, MariaDbDurableStateStoreOptions } from './durable-state-stores/MariaDbDurableStateStore.js';
export type { MariaDbDurableStateStoreSettings } from './durable-state-stores/MariaDbDurableStateStore.js';
export {
  registerMariaDbPlugins,
  RegisterMariaDbPluginsOptions,
  MARIADB_JOURNAL_PLUGIN_ID,
  MARIADB_SNAPSHOT_PLUGIN_ID,
  MARIADB_DURABLE_STATE_PLUGIN_ID,
} from './journals/MariaDbPlugin.js';
export type {
  RegisterMariaDbPluginsSettings,
  MariaDbPluginHandles,
} from './journals/MariaDbPlugin.js';
export type {
  MariaDbConnection,
  MariaDbPoolLike,
  MariaDbConnectionLike,
} from './journals/MariaDbClient.js';

// Durable State (state-oriented alternative to Event Sourcing).
export { DurableStateActor, DurableStateOptions } from './DurableStateActor.js';
export type { DurableStateSettings } from './DurableStateActor.js';
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
  ProjectionOptions,
  ByPidProjectionOptions,
  ByTagProjectionOptions,
} from './projection/ProjectionActor.js';
export type {
  ProjectionSettings,
  ByPidSettings,
  ByTagSettings,
} from './projection/ProjectionActor.js';
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
export { FilesystemObjectStorageBackend, FilesystemObjectStorageOptions } from './object-storage/FilesystemObjectStorageBackend.js';
export type { FilesystemObjectStorageSettings } from './object-storage/FilesystemObjectStorageBackend.js';
export { S3ObjectStorageBackend, S3ObjectStorageOptions } from './object-storage/S3ObjectStorageBackend.js';
export type {
  S3ObjectStorageSettings,
  S3Credentials,
  S3ClientLike,
} from './object-storage/S3ObjectStorageBackend.js';
export {
  ObjectStorageSnapshotStore,
  ObjectStorageSnapshotStoreOptions,
} from './snapshot-stores/ObjectStorageSnapshotStore.js';
export type {
  ObjectStorageSnapshotStoreSettings,
} from './snapshot-stores/ObjectStorageSnapshotStore.js';
export { ObjectStorageDurableStateStore, ObjectStorageDurableStateStoreOptions } from './durable-state-stores/ObjectStorageDurableStateStore.js';
export type { ObjectStorageDurableStateStoreSettings } from './durable-state-stores/ObjectStorageDurableStateStore.js';
export {
  registerObjectStoragePlugins,
  ObjectStoragePluginOptions,
  OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID,
  OBJECT_STORAGE_DURABLE_STATE_PLUGIN_ID,
} from './object-storage/ObjectStoragePlugin.js';
export type {
  ObjectStoragePluginSettings,
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
