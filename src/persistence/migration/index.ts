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
export type { MigrationStep } from './MigrationChain.js';
export {
  defaultsAdapter,
  defaultsSnapshotAdapter,
} from './defaultsAdapter.js';
export type { DefaultsAdapterSpec } from './defaultsAdapter.js';
