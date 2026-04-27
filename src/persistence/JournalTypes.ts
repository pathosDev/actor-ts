/**
 * Shared types for the persistence pipeline.  Kept separate from Journal.ts
 * so plug-ins can implement the protocol without importing the default
 * Journal implementation.
 */

/** An event stored in the journal, paired with its positional metadata. */
export interface PersistentEvent<E = unknown> {
  /** Entity id this event belongs to ("bank-account-42", "order-7", …). */
  readonly persistenceId: string;
  /** 1-based monotonic sequence number within the entity's stream. */
  readonly sequenceNr: number;
  /** User-domain event payload. */
  readonly event: E;
  /** Wall-clock time the journal persisted the event. */
  readonly timestamp: number;
  /** Optional tags that Projections / Persistence-Query can filter on. */
  readonly tags?: ReadonlyArray<string>;
}

/** A snapshot of an entity's state at a given sequence number. */
export interface Snapshot<S = unknown> {
  readonly persistenceId: string;
  /** Events up to and including this seq are reflected in `state`. */
  readonly sequenceNr: number;
  readonly state: S;
  readonly timestamp: number;
}

/** Raised when the caller's `expectedSeq` does not match the journal. */
export class JournalConcurrencyError extends Error {
  constructor(
    public readonly persistenceId: string,
    public readonly expectedSeq: number,
    public readonly actualSeq: number,
  ) {
    super(`Journal concurrency mismatch for "${persistenceId}": expected ${expectedSeq}, journal has ${actualSeq}`);
    this.name = 'JournalConcurrencyError';
  }
}

/** Generic persistence failure, raised by plug-ins that wrap external stores. */
export class JournalError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'JournalError';
  }
}
