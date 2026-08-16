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
export type { JournalEntry, PersistentEvent, Snapshot } from './JournalTypes.js';
export { JournalConcurrencyError, JournalError } from './JournalTypes.js';
// The two integrity failures a recovery can raise.  Exported because
// `onRecoveryFailure` is documented as discriminating on them, which needs the
// classes themselves — `reason.name === '…'` breaks on any rewording (#1053).
export { SnapshotIntegrityError, JournalIntegrityError } from './Replay.js';
export type {
  CompressionAlgo,
  CompressionConfig,
  EncryptionConfig,
  IntegrityConfig,
  PersistenceOptions,
  MasterKeyRing,
  MasterKeyRingEntry,
} from './PersistenceOptions.js';
export { decodePayload, encodePayload } from './storage/PayloadCodec.js';
// Exported so an application can check its ids against the same rules the
// framework enforces — the one thing that makes the #133 tightening safe
// to adopt without a trial run against production data.
export {
  assertValidPersistenceId,
  persistenceIdRejection,
} from './storage/PersistenceIdValidator.js';
export { MAX_PERSISTENCE_ID_LENGTH } from './Constants.js';
export { StoreSerializerOptionsBuilder } from './storage/StoreSerializerOptions.js';
export type { StoreSerializerOptionsBase } from './storage/StoreSerializerOptions.js';

export { InMemoryJournal } from './journals/InMemoryJournal.js';
export { SqliteJournal } from './journals/SqliteJournal.js';
export {
  SqliteJournalOptions,
  SqliteJournalOptionsBuilder,
  SqliteJournalOptionsValidator,
} from './journals/SqliteJournalOptions.js';
export type { SqliteJournalOptionsType } from './journals/SqliteJournalOptions.js';
export { InMemorySnapshotStore } from './snapshot-stores/InMemorySnapshotStore.js';
export { SqliteSnapshotStore } from './snapshot-stores/SqliteSnapshotStore.js';
export {
  SqliteSnapshotStoreOptions,
  SqliteSnapshotStoreOptionsBuilder,
  SqliteSnapshotStoreOptionsValidator,
} from './snapshot-stores/SqliteSnapshotStoreOptions.js';
export type { SqliteSnapshotStoreOptionsType } from './snapshot-stores/SqliteSnapshotStoreOptions.js';

export { SqliteDurableStateStore } from './durable-state-stores/SqliteDurableStateStore.js';
export {
  SqliteDurableStateStoreOptions,
  SqliteDurableStateStoreOptionsBuilder,
  SqliteDurableStateStoreOptionsValidator,
} from './durable-state-stores/SqliteDurableStateStoreOptions.js';
export type { SqliteDurableStateStoreOptionsType } from './durable-state-stores/SqliteDurableStateStoreOptions.js';
export {
  adaptSqliteDatabase,
  applySqliteBusyTimeout,
  buildSqliteDatabase,
} from './journals/SqliteClient.js';
export { DEFAULT_SQLITE_BUSY_TIMEOUT_MS } from './Constants.js';
export type { SqliteConnection } from './journals/SqliteClient.js';
// The per-runtime driver seam behind buildSqliteDatabase, exposed for the
// same #124 reason: the documented "bring your own handle" route needs it,
// and no other entry point serves it (#1002).
export { getSqliteDriver } from '../runtime/sqlite/index.js';
export type { SqliteDriver } from '../runtime/sqlite/index.js';
export { CachedSnapshotStore } from './snapshot-stores/CachedSnapshotStore.js';
export { CachedSnapshotStoreOptions, CachedSnapshotStoreOptionsBuilder, CachedSnapshotStoreOptionsValidator } from './snapshot-stores/CachedSnapshotStoreOptions.js';
export type { CachedSnapshotStoreOptionsType } from './snapshot-stores/CachedSnapshotStoreOptions.js';

// Cassandra / ScyllaDB plug-in (same CQL protocol — one plug-in).
export { CassandraJournal } from './journals/CassandraJournal.js';
export { CassandraJournalOptions, CassandraJournalOptionsBuilder, CassandraJournalOptionsValidator } from './journals/CassandraJournalOptions.js';
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

// Store lifecycle shared by every backend that talks to an external system —
// lazy first-use connection, one-shot schema preparation, ownership-aware
// teardown.  The relational and MongoDB families both build on it.
export { LazyStore } from './LazyStore.js';
export type { LazyStoreConfig } from './LazyStore.js';

// Relational base layer — the extension point for a new SQL backend.  Supply a
// `SqlDialect` plus a `SqlPool` adapter and the journal / snapshot /
// durable-state trio comes with it, instead of a third copy of three stores.
export { RelationalJournal } from './relational/RelationalJournal.js';
export type { RelationalJournalConfig } from './relational/RelationalJournal.js';
export { RelationalSnapshotStore } from './relational/RelationalSnapshotStore.js';
export type { RelationalSnapshotStoreConfig } from './relational/RelationalSnapshotStore.js';
export { RelationalDurableStateStore } from './relational/RelationalDurableStateStore.js';
export type { RelationalDurableStateStoreConfig } from './relational/RelationalDurableStateStore.js';
export { RelationalStore } from './relational/RelationalStore.js';
export type { RelationalStoreConfig } from './relational/RelationalStore.js';
export { expandPlaceholders } from './relational/SqlDialect.js';
export type { InsertConflictSignal, JournalTableNames, SqlDialect } from './relational/SqlDialect.js';
export type { SqlExecutor, SqlPool, SqlResult } from './relational/SqlPool.js';
export { postgresDialect } from './relational/PostgresDialect.js';
export { mariaDbDialect } from './relational/MariaDbDialect.js';

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

// Cloudflare D1 plug-in (journal + snapshot + durable-state).  SQLite at the
// edge over D1's REST API — SDK-free, using the built-in HttpClient, and sharing
// `sqliteDialect` with the local SQLite and libSQL backends.
export { D1Journal } from './journals/D1Journal.js';
export {
  D1JournalOptions,
  D1JournalOptionsBuilder,
  D1JournalOptionsValidator,
} from './journals/D1JournalOptions.js';
export type { D1JournalOptionsType } from './journals/D1JournalOptions.js';
export { D1SnapshotStore } from './snapshot-stores/D1SnapshotStore.js';
export {
  D1SnapshotStoreOptions,
  D1SnapshotStoreOptionsBuilder,
  D1SnapshotStoreOptionsValidator,
} from './snapshot-stores/D1SnapshotStoreOptions.js';
export type { D1SnapshotStoreOptionsType } from './snapshot-stores/D1SnapshotStoreOptions.js';
export { D1DurableStateStore } from './durable-state-stores/D1DurableStateStore.js';
export {
  D1DurableStateStoreOptions,
  D1DurableStateStoreOptionsBuilder,
  D1DurableStateStoreOptionsValidator,
} from './durable-state-stores/D1DurableStateStoreOptions.js';
export type { D1DurableStateStoreOptionsType } from './durable-state-stores/D1DurableStateStoreOptions.js';
export {
  D1OptionsBuilderBase,
  D1OptionsValidatorBase,
  assertD1BaseUrl,
} from './journals/D1OptionsBase.js';
export type { D1OptionsBaseType } from './journals/D1OptionsBase.js';
export {
  registerD1Plugins,
  D1_JOURNAL_PLUGIN_ID,
  D1_SNAPSHOT_PLUGIN_ID,
  D1_DURABLE_STATE_PLUGIN_ID,
} from './journals/D1Plugin.js';
export { RegisterD1PluginsOptions, RegisterD1PluginsOptionsBuilder } from './journals/D1PluginOptions.js';
export type { RegisterD1PluginsOptionsType } from './journals/D1PluginOptions.js';
export type { D1PluginHandles } from './journals/D1Plugin.js';
export { D1RequestError, DEFAULT_D1_BASE_URL, adaptD1Client, buildD1Client } from './journals/D1Client.js';
export type { D1ClientLike, D1Connection, D1QueryResult } from './journals/D1Client.js';

// DynamoDB plug-in (journal + snapshot + durable-state).  The concurrency
// backstop is a conditional write, and `TransactWriteItems` makes a multi-event
// append atomic — stronger than the relational backends manage.
export { DynamoDbJournal } from './journals/DynamoDbJournal.js';
export {
  DynamoDbJournalOptions,
  DynamoDbJournalOptionsBuilder,
  DynamoDbJournalOptionsValidator,
} from './journals/DynamoDbJournalOptions.js';
export type { DynamoDbJournalOptionsType } from './journals/DynamoDbJournalOptions.js';
export { DynamoDbSnapshotStore } from './snapshot-stores/DynamoDbSnapshotStore.js';
export {
  DynamoDbSnapshotStoreOptions,
  DynamoDbSnapshotStoreOptionsBuilder,
  DynamoDbSnapshotStoreOptionsValidator,
} from './snapshot-stores/DynamoDbSnapshotStoreOptions.js';
export type { DynamoDbSnapshotStoreOptionsType } from './snapshot-stores/DynamoDbSnapshotStoreOptions.js';
export { DynamoDbDurableStateStore } from './durable-state-stores/DynamoDbDurableStateStore.js';
export {
  DynamoDbDurableStateStoreOptions,
  DynamoDbDurableStateStoreOptionsBuilder,
  DynamoDbDurableStateStoreOptionsValidator,
} from './durable-state-stores/DynamoDbDurableStateStoreOptions.js';
export type { DynamoDbDurableStateStoreOptionsType } from './durable-state-stores/DynamoDbDurableStateStoreOptions.js';
export { DynamoDbStore } from './journals/DynamoDbStore.js';
export type { DynamoDbStoreConfig, DynamoDbTableSchema } from './journals/DynamoDbStore.js';
export {
  DynamoDbOptionsBuilderBase,
  DynamoDbOptionsValidatorBase,
  assertDynamoDbTableName,
} from './journals/DynamoDbOptionsBase.js';
export type { DynamoDbOptionsBaseType, DynamoDbTableProvisioning } from './journals/DynamoDbOptionsBase.js';
export {
  registerDynamoDbPlugins,
  DYNAMODB_JOURNAL_PLUGIN_ID,
  DYNAMODB_SNAPSHOT_PLUGIN_ID,
  DYNAMODB_DURABLE_STATE_PLUGIN_ID,
} from './journals/DynamoDbPlugin.js';
export { RegisterDynamoDbPluginsOptions, RegisterDynamoDbPluginsOptionsBuilder } from './journals/DynamoDbPluginOptions.js';
export type { RegisterDynamoDbPluginsOptionsType } from './journals/DynamoDbPluginOptions.js';
export type { DynamoDbPluginHandles } from './journals/DynamoDbPlugin.js';
export {
  isConditionalCheckFailed,
  isTableAlreadyExists,
  isTableNotFound,
  numberAttribute,
  readNumber,
  readString,
  readStringSet,
  stringAttribute,
  stringSetAttribute,
} from './journals/DynamoDbClient.js';
export type {
  DynamoDbAttribute,
  DynamoDbBatchWriteResult,
  DynamoDbClientLike,
  DynamoDbConnection,
  DynamoDbGetResult,
  DynamoDbItem,
  DynamoDbOperations,
  DynamoDbQueryResult,
  DynamoDbTableDescription,
} from './journals/DynamoDbClient.js';

// MongoDB plug-in (journal + snapshot + durable-state + indexed tag query).
// The first document-store backend: no SqlDialect, but the same two-layer
// optimistic concurrency, with a unique compound index in place of a primary key.
export { MongoJournal } from './journals/MongoJournal.js';
export {
  MongoJournalOptions,
  MongoJournalOptionsBuilder,
  MongoJournalOptionsValidator,
  MONGO_URL_PROTOCOLS,
} from './journals/MongoJournalOptions.js';
export type { MongoJournalOptionsType } from './journals/MongoJournalOptions.js';
export { MongoSnapshotStore } from './snapshot-stores/MongoSnapshotStore.js';
export {
  MongoSnapshotStoreOptions,
  MongoSnapshotStoreOptionsBuilder,
  MongoSnapshotStoreOptionsValidator,
} from './snapshot-stores/MongoSnapshotStoreOptions.js';
export type { MongoSnapshotStoreOptionsType } from './snapshot-stores/MongoSnapshotStoreOptions.js';
export { MongoDurableStateStore } from './durable-state-stores/MongoDurableStateStore.js';
export {
  MongoDurableStateStoreOptions,
  MongoDurableStateStoreOptionsBuilder,
  MongoDurableStateStoreOptionsValidator,
} from './durable-state-stores/MongoDurableStateStoreOptions.js';
export type { MongoDurableStateStoreOptionsType } from './durable-state-stores/MongoDurableStateStoreOptions.js';
export { MongoQuery } from './query/MongoQuery.js';
export { MongoStore } from './journals/MongoStore.js';
export type { MongoStoreConfig } from './journals/MongoStore.js';
export {
  registerMongoPlugins,
  MONGO_JOURNAL_PLUGIN_ID,
  MONGO_SNAPSHOT_PLUGIN_ID,
  MONGO_DURABLE_STATE_PLUGIN_ID,
} from './journals/MongoPlugin.js';
export { RegisterMongoPluginsOptions, RegisterMongoPluginsOptionsBuilder } from './journals/MongoPluginOptions.js';
export type { RegisterMongoPluginsOptionsType } from './journals/MongoPluginOptions.js';
export type { MongoPluginHandles } from './journals/MongoPlugin.js';
export { DEFAULT_MONGO_DATABASE, isMongoDuplicateKeyError } from './journals/MongoClient.js';
export type {
  MongoClientLike,
  MongoCollectionLike,
  MongoConnection,
  MongoCursorLike,
  MongoDatabaseLike,
  MongoDeleteResult,
  MongoDocument,
  MongoResource,
  MongoSortSpec,
  MongoUpdateResult,
} from './journals/MongoClient.js';

// Microsoft SQL Server plug-in (journal + snapshot + durable-state).  The
// `mssql`/tedious driver is pure JavaScript, so it runs on all three runtimes.
export { MsSqlJournal } from './journals/MsSqlJournal.js';
export {
  MsSqlJournalOptions,
  MsSqlJournalOptionsBuilder,
  MsSqlJournalOptionsValidator,
} from './journals/MsSqlJournalOptions.js';
export type { MsSqlJournalOptionsType } from './journals/MsSqlJournalOptions.js';
export { MsSqlSnapshotStore } from './snapshot-stores/MsSqlSnapshotStore.js';
export {
  MsSqlSnapshotStoreOptions,
  MsSqlSnapshotStoreOptionsBuilder,
  MsSqlSnapshotStoreOptionsValidator,
} from './snapshot-stores/MsSqlSnapshotStoreOptions.js';
export type { MsSqlSnapshotStoreOptionsType } from './snapshot-stores/MsSqlSnapshotStoreOptions.js';
export { MsSqlDurableStateStore } from './durable-state-stores/MsSqlDurableStateStore.js';
export {
  MsSqlDurableStateStoreOptions,
  MsSqlDurableStateStoreOptionsBuilder,
  MsSqlDurableStateStoreOptionsValidator,
} from './durable-state-stores/MsSqlDurableStateStoreOptions.js';
export type { MsSqlDurableStateStoreOptionsType } from './durable-state-stores/MsSqlDurableStateStoreOptions.js';
export {
  registerMsSqlPlugins,
  MSSQL_JOURNAL_PLUGIN_ID,
  MSSQL_SNAPSHOT_PLUGIN_ID,
  MSSQL_DURABLE_STATE_PLUGIN_ID,
} from './journals/MsSqlPlugin.js';
export { RegisterMsSqlPluginsOptions, RegisterMsSqlPluginsOptionsBuilder } from './journals/MsSqlPluginOptions.js';
export type { RegisterMsSqlPluginsOptionsType } from './journals/MsSqlPluginOptions.js';
export type { MsSqlPluginHandles } from './journals/MsSqlPlugin.js';
export type {
  MsSqlConnection,
  MsSqlPoolLike,
  MsSqlRequestLike,
  MsSqlResult,
  MsSqlTransactionLike,
} from './journals/MsSqlClient.js';
export { msSqlDialect } from './relational/MsSqlDialect.js';

// libSQL / Turso plug-in (journal + snapshot + durable-state) — SQLite over
// HTTP/WebSocket, so it needs no native binding and runs on all three runtimes.
export { LibSqlJournal } from './journals/LibSqlJournal.js';
export {
  LibSqlJournalOptions,
  LibSqlJournalOptionsBuilder,
  LibSqlJournalOptionsValidator,
  LIBSQL_URL_PROTOCOLS,
} from './journals/LibSqlJournalOptions.js';
export type { LibSqlJournalOptionsType } from './journals/LibSqlJournalOptions.js';
export { LibSqlSnapshotStore } from './snapshot-stores/LibSqlSnapshotStore.js';
export {
  LibSqlSnapshotStoreOptions,
  LibSqlSnapshotStoreOptionsBuilder,
  LibSqlSnapshotStoreOptionsValidator,
} from './snapshot-stores/LibSqlSnapshotStoreOptions.js';
export type { LibSqlSnapshotStoreOptionsType } from './snapshot-stores/LibSqlSnapshotStoreOptions.js';
export { LibSqlDurableStateStore } from './durable-state-stores/LibSqlDurableStateStore.js';
export {
  LibSqlDurableStateStoreOptions,
  LibSqlDurableStateStoreOptionsBuilder,
  LibSqlDurableStateStoreOptionsValidator,
} from './durable-state-stores/LibSqlDurableStateStoreOptions.js';
export type { LibSqlDurableStateStoreOptionsType } from './durable-state-stores/LibSqlDurableStateStoreOptions.js';
export {
  registerLibSqlPlugins,
  LIBSQL_JOURNAL_PLUGIN_ID,
  LIBSQL_SNAPSHOT_PLUGIN_ID,
  LIBSQL_DURABLE_STATE_PLUGIN_ID,
} from './journals/LibSqlPlugin.js';
export { RegisterLibSqlPluginsOptions, RegisterLibSqlPluginsOptionsBuilder } from './journals/LibSqlPluginOptions.js';
export type { RegisterLibSqlPluginsOptionsType } from './journals/LibSqlPluginOptions.js';
export type { LibSqlPluginHandles } from './journals/LibSqlPlugin.js';
export type {
  LibSqlConnection,
  LibSqlClientLike,
  LibSqlResultSet,
  LibSqlStatement,
  LibSqlTransactionLike,
} from './journals/LibSqlClient.js';
export { sqliteDialect } from './relational/SqliteDialect.js';

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
export {
  DurableStateOptions,
  DurableStateOptionsBuilder,
  DurableStateOptionsValidator,
} from './DurableStateOptions.js';
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
  // #73 — a byte-native Serializer (Avro, Protobuf) as a per-version codec.
  serializerCodec,
  validatedEventAdapter,
  validatedSnapshotAdapter,
  InMemorySchemaRegistry,
  // #87 — journal-to-journal + snapshot-store-to-snapshot-store copy.
  migrateBetweenJournals,
  migrateBetweenSnapshotStores,
  InMemoryMigrationProgressStore,
  // #630 — a compacted source the target journal cannot represent.
  CompactedSourceError,
} from './migration/index.js';

// Persistence Query — read-side query layer for projections.
export type {
  PersistenceQuery,
  LiveQueryOptions,
  Offset,
  PaginationOptions,
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
  tagFilterCursorKey,
  defaultPersistenceIdPageSize,
} from './query/PersistenceQuery.js';
// #156 — the paging semantics `Journal.persistenceIdsPaginated` has to match,
// exported so an out-of-tree journal can implement the optional method against
// the same definition the in-repo backends are checked against.
export { persistenceIdPage } from './Journal.js';
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
  ProjectionOptionsValidator,
  ByPersistenceIdProjectionOptions,
  ByPersistenceIdProjectionOptionsBuilder,
  ByTagProjectionOptions,
  ByTagProjectionOptionsBuilder,
  PROJECTION_RECOVERY_STRATEGIES,
  DEFAULT_PROJECTION_RECOVERY_STRATEGY,
  DEFAULT_PROJECTION_MAX_RETRIES,
  DEFAULT_PROJECTION_RETRY_BACKOFF_MS,
  DEFAULT_PROJECTION_MAX_RETRY_BACKOFF_MS,
  defaultProjectionRecoveryOptions,
} from './projection/ProjectionOptions.js';
export type {
  ProjectionOptionsType,
  ProjectionRecoveryStrategy,
  ProjectionRecoveryOptionsType,
  ProjectionFailure,
  ProjectionFailureAction,
  ByPersistenceIdProjectionOptionsType,
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
export { FilesystemObjectStorageOptions, FilesystemObjectStorageOptionsBuilder, FilesystemObjectStorageOptionsValidator } from './object-storage/FilesystemObjectStorageOptions.js';
export type { FilesystemObjectStorageOptionsType } from './object-storage/FilesystemObjectStorageOptions.js';
export { S3ObjectStorageBackend } from './object-storage/S3ObjectStorageBackend.js';
export { S3ObjectStorageOptions, S3ObjectStorageOptionsBuilder, S3ObjectStorageOptionsValidator } from './object-storage/S3ObjectStorageOptions.js';
export type { S3ObjectStorageOptionsType } from './object-storage/S3ObjectStorageOptions.js';
export type {
  S3Credentials,
  S3ClientLike,
} from './object-storage/S3ObjectStorageBackend.js';
export {
  ObjectStorageSnapshotStore,
} from './snapshot-stores/ObjectStorageSnapshotStore.js';
export { ObjectStorageSnapshotStoreOptions, ObjectStorageSnapshotStoreOptionsBuilder, ObjectStorageSnapshotStoreOptionsValidator } from './snapshot-stores/ObjectStorageSnapshotStoreOptions.js';
export type { ObjectStorageSnapshotStoreOptionsType } from './snapshot-stores/ObjectStorageSnapshotStoreOptions.js';
export { ObjectStorageDurableStateStore } from './durable-state-stores/ObjectStorageDurableStateStore.js';
export { ObjectStorageDurableStateStoreOptions, ObjectStorageDurableStateStoreOptionsBuilder, ObjectStorageDurableStateStoreOptionsValidator } from './durable-state-stores/ObjectStorageDurableStateStoreOptions.js';
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
  resolveIntegrity,
} from './object-storage/PluginConfig.js';
export type {
  CompressionResolver,
  EncryptionResolver,
  IntegrityResolver,
} from './object-storage/PluginConfig.js';
export {
  reEncryptObjectStorage,
  InMemoryReEncryptProgressStore,
} from './object-storage/ReEncryptionSweep.js';
export type {
  ReEncryptOptions,
  ReEncryptResult,
  ReEncryptProgress,
  ReEncryptResumeState,
  ReEncryptProgressStore,
} from './object-storage/ReEncryptionSweep.js';
