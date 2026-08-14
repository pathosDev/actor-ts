export type {
  EventAdapter,
  SnapshotAdapter,
  StateAdapter,
  JournalEnvelope,
  StoredFrame,
  OutboundFrame,
} from './Adapter.js';
export {
  MigrationError,
  isEnvelope,
  encodeEvent,
  decodeEvent,
  encodeState,
  decodeState,
} from './Envelope.js';
export { MigrationChain } from './MigrationChain.js';
export type { MigrationStep, DowncastStep } from './MigrationChain.js';
export {
  defaultsAdapter,
  defaultsSnapshotAdapter,
} from './DefaultsAdapter.js';
export type { DefaultsAdapterSpec } from './DefaultsAdapter.js';
export {
  migratingAdapter,
  migratingSnapshotAdapter,
} from './MigratingAdapter.js';
export {
  wrapEventAsEnvelope,
  wrapStateAsEnvelope,
  migrateInMemoryJournal,
  migrateSnapshotStore,
  formatMigrationResult,
} from './WrapLegacy.js';
export type { MigrationResult } from './WrapLegacy.js';

// #6 — pluggable codec + in-process schema registry.
// #73 — `serializerCodec` adapts a byte-native Serializer (Avro, Protobuf)
// into a Codec, so the registry can hold one wire format per version.
export { jsonCodec, zodCodec, composeCodecs, serializerCodec } from './Codec.js';
export type { Codec, ParserLike } from './Codec.js';
export {
  validatedEventAdapter,
  validatedSnapshotAdapter,
} from './ValidatedAdapter.js';
export type { ValidatedAdapterOptions } from './ValidatedAdapter.js';
export { InMemorySchemaRegistry } from './SchemaRegistry.js';
export type {
  SchemaRegistry,
  SchemaRegistration,
  SchemaDescriptor,
} from './SchemaRegistry.js';

// #87 — journal-to-journal + snapshot-store-to-snapshot-store copy.
export {
  migrateBetweenJournals,
  migrateBetweenSnapshotStores,
  InMemoryMigrationProgressStore,
} from './JournalMigration.js';
export type {
  MigrateJournalsOptions,
  MigrateJournalsResult,
  MigrateSnapshotStoresOptions,
  MigrateSnapshotStoresResult,
  MigrationProgress,
  MigrationProgressStore,
} from './JournalMigration.js';
