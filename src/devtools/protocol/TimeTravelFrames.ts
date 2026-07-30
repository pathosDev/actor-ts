/**
 * Request/response shapes of the time-travel panel (#201) — browsing a
 * persistence journal and reconstructing past state.
 *
 * Time travel is request/response rather than a stream: it is driven by
 * a human dragging a sequence slider, not by the system emitting
 * events.  Everything here is strictly READ-ONLY — no shape in this
 * module can mutate a journal or a live actor.
 *
 * Two capability tiers, reported per persistence id by
 * `replay.capabilities`:
 *
 *   - `'events-only'` — any journal: list ids, page the event log,
 *     diff event payloads.
 *   - `'state'` — additionally reconstruct the folded state at an
 *     arbitrary sequence number, because a fold for that id is known.
 */

/** How much a given persistence id supports. */
export type ReplayCapability = 'events-only' | 'state';

/** Where the fold behind a `'state'` capability came from. */
export type ReplayFoldSource = 'registered' | 'auto-captured' | 'none';

/** Summary of one persistence id. */
export type JournalIdentifierInfo = {
  readonly persistenceId: string;
  readonly highestSequenceNumber: number;
  readonly capability: ReplayCapability;
};

/** Parameters of `journal.ids`. */
export type JournalIdentifiersParameters = {
  readonly offset?: number;
  readonly limit?: number;
};

/** Result of `journal.ids`. */
export type JournalIdentifiersResult = {
  readonly identifiers: ReadonlyArray<JournalIdentifierInfo>;
  readonly total: number;
  readonly offset: number;
};

/** Parameters of `journal.read`. */
export type JournalReadParameters = {
  readonly persistenceId: string;
  readonly fromSequenceNumber?: number;
  readonly toSequenceNumber?: number;
  readonly limit?: number;
};

/** One journal entry as shown in the event log. */
export type JournalEventView = {
  readonly sequenceNumber: number;
  readonly timestampMs: number;
  readonly tags: ReadonlyArray<string>;
  /** Envelope manifest, or `null` for a raw (non-enveloped) payload. */
  readonly manifest: string | null;
  /** Envelope schema version, or `null` for a raw payload. */
  readonly schemaVersion: number | null;
  /** Decoded payload, passed through the wire serializer. */
  readonly payload: unknown;
  /** True when the payload was truncated for transport. */
  readonly truncated: boolean;
};

/** Result of `journal.read`. */
export type JournalReadResult = {
  readonly persistenceId: string;
  readonly events: ReadonlyArray<JournalEventView>;
  readonly highestSequenceNumber: number;
};

/** Parameters of `replay.capabilities`. */
export type ReplayCapabilitiesParameters = {
  readonly persistenceId: string;
};

/** Result of `replay.capabilities`. */
export type ReplayCapabilitiesResult = {
  readonly persistenceId: string;
  readonly capability: ReplayCapability;
  readonly foldSource: ReplayFoldSource;
};

/** Parameters of `replay.state`. */
export type ReplayStateParameters = {
  readonly persistenceId: string;
  readonly toSequenceNumber: number;
};

/** Reconstructed state at one point in the journal. */
export type ReplayStateResult = {
  readonly persistenceId: string;
  readonly sequenceNumber: number;
  readonly state: unknown;
  /** Snapshot the replay started from, or `null` for a full fold. */
  readonly fromSnapshotSequenceNumber: number | null;
  readonly eventsApplied: number;
  readonly truncated: boolean;
};

/** Parameters of `replay.diff`. */
export type ReplayDiffParameters = {
  readonly persistenceId: string;
  readonly fromSequenceNumber: number;
  readonly toSequenceNumber: number;
};

/**
 * Result of `replay.diff` — both endpoints, with the field-level diff
 * computed in the UI so the server stays a dumb, read-only data source.
 */
export type ReplayDiffResult = {
  readonly persistenceId: string;
  readonly from: ReplayStateResult;
  readonly to: ReplayStateResult;
};
