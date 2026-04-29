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
} from './defaultsAdapter.js';
export type { DefaultsAdapterSpec } from './defaultsAdapter.js';
export {
  migratingAdapter,
  migratingSnapshotAdapter,
} from './migratingAdapter.js';
export {
  wrapEventAsEnvelope,
  wrapStateAsEnvelope,
  migrateInMemoryJournal,
  migrateSnapshotStore,
  formatMigrationResult,
} from './wrapLegacy.js';
export type { MigrationResult } from './wrapLegacy.js';
