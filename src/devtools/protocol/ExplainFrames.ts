/**
 * Stream payload + request shapes of the per-actor explain plan (#218):
 * the last N message handlings of one actor with their timing breakdown.
 *
 * Capture is opt-in per actor because it is not free — the panel turns
 * it on through the `explain.enable` request rather than requiring a
 * code change and a restart, which is the whole point of asking "what
 * has this actor been doing?" while it is misbehaving.
 */

/** How a message handling finished. */
export type MessageOutcome = 'ok' | 'error' | 'stashed';

/** One recorded message handling. */
export interface ExplainEntry {
  /** Monotonically increasing per actor, so gaps are visible. */
  readonly sequenceNumber: number;
  /** Wall clock at handler start. */
  readonly atMs: number;
  readonly messageType: string;
  readonly senderPath: string | null;
  /**
   * Time from first enqueue to handler start.  `null` when envelope
   * stamping was off at enqueue time.  A stashed-and-replayed message
   * keeps its ORIGINAL stamp, so stash residency is included here.
   */
  readonly mailboxWaitMs: number | null;
  readonly handleTimeMs: number;
  readonly outcome: MessageOutcome;
  readonly errorMessage: string | null;
  /** Span this handling produced, for cross-linking into the trace panel. */
  readonly spanId: string | null;
}

/** The current ring contents of one actor — the `explain` stream. */
export interface ExplainEntriesPayload {
  readonly kind: 'explain-entries';
  readonly atMs: number;
  readonly path: string;
  readonly capacity: number;
  /** Oldest first. */
  readonly entries: ReadonlyArray<ExplainEntry>;
}

/** Payloads carried by the `explain` stream. */
export type ExplainStreamPayload = ExplainEntriesPayload;

/** Parameters of `explain.enable`. */
export interface ExplainEnableParameters {
  readonly path: string;
  readonly capacity?: number;
}

/** Parameters of `explain.disable` and `explain.fetch`. */
export interface ExplainPathParameters {
  readonly path: string;
}

/** Result of `explain.enable` / `explain.disable`. */
export interface ExplainStatusResult {
  readonly path: string;
  readonly enabled: boolean;
  readonly capacity: number;
}

/** @internal */
export function explainEntriesPayload(
  atMs: number,
  path: string,
  capacity: number,
  entries: ReadonlyArray<ExplainEntry>,
): ExplainEntriesPayload {
  return { kind: 'explain-entries', atMs, path, capacity, entries };
}
