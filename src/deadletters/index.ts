/**
 * Dead-letter capture, inspection and replay (#433).
 *
 * The queue itself is reached through `system.deadLetterQueue`; this barrel
 * exists for the types an application needs to name — the entry shape it
 * lists, the filter it narrows with, and the options family it configures.
 */
export { DeadLetterQueue } from './DeadLetterQueue.js';
export {
  DEAD_LETTER_STORES,
  DEFAULT_DEAD_LETTER_MAX_ENTRIES,
  DEFAULT_DEAD_LETTER_MAX_REPLAYS,
  DEFAULT_DEAD_LETTER_RETENTION_MS,
  DEFAULT_DEAD_LETTER_STORE,
  DeadLetterQueueOptions,
  DeadLetterQueueOptionsBuilder,
  DeadLetterQueueOptionsValidator,
  defaultDeadLetterPersistenceId,
  readDeadLetterQueueOptionsFromConfig,
} from './DeadLetterQueueOptions.js';
export type {
  DeadLetterQueueOptionsType,
  DeadLetterStore,
} from './DeadLetterQueueOptions.js';
export type {
  CapturedPayload,
  DeadLetterEntry,
  DeadLetterFilter,
  DeadLetterPayload,
  DeadLetterReplayResult,
  DegradedPayload,
  DegradedPayloadResult,
  QuarantinedResult,
  ReplayedResult,
  UnknownEntryResult,
  UnresolvedRecipientResult,
} from './DeadLetterEntry.js';
