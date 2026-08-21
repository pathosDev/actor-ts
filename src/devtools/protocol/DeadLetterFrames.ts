import type { WireValue } from '../internal/WireSerializer.js';

/**
 * Dead letters, as the panel reads them (#553).
 *
 * A pull rather than a stream, for the same reason the explain plan is one:
 * the queue is a bounded ring the system already keeps, so asking for it once
 * a second costs one request, while pushing every capture would put DevTools
 * on the path of the very failures it is watching.  Dead letters are also rare
 * by nature — a system producing enough of them to strain a poll has a problem
 * the panel is about to show you anyway.
 */

/** One captured letter, flattened for the wire. */
export type DeadLetterView = {
  /** Stable identity, assigned at capture and preserved across a restart. */
  readonly id: string;
  readonly timestampMs: number;
  /** Path of the actor the message failed to reach. */
  readonly recipientPath: string;
  /** Path of the sender, or `null` when the send carried none. */
  readonly senderPath: string | null;
  /** Constructor name of the message, or `typeof` for a primitive. */
  readonly messageType: string;
  /**
   * The message, sanitised to something `JSON.stringify` accepts.
   *
   * `null` when the queue could not keep the payload at all — see
   * {@link degradedReason}.  A letter with no payload is still worth showing:
   * *that* a message to this recipient died, and when, is the part an operator
   * acts on.
   */
  readonly payload: unknown;
  /** True when the payload was cut to fit the wire limits. */
  readonly truncated: boolean;
  /** Why the queue refused the payload, or `null` when it kept it. */
  readonly degradedReason: string | null;
  /**
   * How many times this letter has already been replayed and come back.
   *
   * Shown because a non-zero count changes what the reader is looking at: a
   * poison message being retried, rather than a fresh failure.
   */
  readonly replayCount: number;
};

/** What `deadletters.list` answers. */
export type DeadLettersResult = {
  /** Newest first — the question is almost always "what just broke". */
  readonly entries: ReadonlyArray<DeadLetterView>;
  /** How many the queue holds in total, before this request's limit. */
  readonly total: number;
  /** The ring's capacity, so the panel can say how much room is left. */
  readonly capacity: number;
};

/** What `deadletters.list` accepts. */
export type DeadLettersParameters = {
  /**
   * Keep letters whose recipient path equals this, or lies beneath it — so
   * `/user` selects the whole application subtree and a full path selects one
   * actor.  The queue's own filter does the matching.
   */
  readonly recipient?: string;
  /** Keep at most this many, newest first. */
  readonly limit?: number;
};

/** Rows the panel draws at once.  Older ones are counted, not listed. */
export const DEAD_LETTER_ROWS = 200;

/** @internal */
export function deadLetterView(
  entry: {
    readonly id: string;
    readonly timestampMs: number;
    readonly recipientPath: string;
    readonly senderPath: string | null;
    readonly replayCount: number;
  },
  messageType: string,
  wire: WireValue | null,
  degradedReason: string | null,
): DeadLetterView {
  return {
    id: entry.id,
    timestampMs: entry.timestampMs,
    recipientPath: entry.recipientPath,
    senderPath: entry.senderPath,
    messageType,
    payload: wire?.value ?? null,
    truncated: wire?.truncated ?? false,
    degradedReason,
    replayCount: entry.replayCount,
  };
}
