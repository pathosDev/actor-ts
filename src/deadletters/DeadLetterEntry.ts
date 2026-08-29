/**
 * The shape a captured dead letter is kept and queried in.
 *
 * Separate from {@link DeadLetter} rather than an extension of it, because
 * the two answer different questions.  `DeadLetter` is an *event*: it names
 * the message, the sender and the recipient, and it is published whether or
 * not anybody is keeping it.  An entry is a *record in a queue*: it needs an
 * identity to be replayed by, a timestamp to be retained by, and paths
 * rather than refs so it survives a round-trip through a journal — none of
 * which belongs on the event, and adding an `id` there would have meant a
 * fourth positional argument on a class eight call sites construct.
 */

/** A payload that was captured whole and can be redelivered as-is. */
export type CapturedPayload = {
  readonly kind: 'captured';
  /** The original message object, byte-for-byte what the sender sent. */
  readonly message: unknown;
};

/**
 * A payload that could not be written to the durable store.
 *
 * The tagged-JSON encoder refuses functions, symbols, `Promise`,
 * weak collections and cycles rather than degrading them silently, so a
 * persistent queue has to choose between losing the letter and losing the
 * payload.  It loses the payload: *that* a message to this recipient died,
 * and when, is the part an operator acts on, and a queue that silently
 * skips its hardest cases is worse than one that says which ones it could
 * not keep.  Such an entry is not replayable — there is nothing to
 * redeliver — and `replay` refuses it rather than sending a placeholder.
 */
export type DegradedPayload = {
  readonly kind: 'degraded';
  /** Constructor name of the message, or `typeof` for a primitive. */
  readonly className: string;
  /** Why the encoder refused it — the `SerializationError`'s message. */
  readonly reason: string;
};

export type DeadLetterPayload = CapturedPayload | DegradedPayload;

/** One captured dead letter, as {@link DeadLetterQueue.list} returns it. */
export type DeadLetterEntry = {
  /** Stable identity, assigned at capture and preserved across a restart. */
  readonly id: string;
  /** Wall-clock capture time, in epoch milliseconds. */
  readonly timestampMs: number;
  /** Path of the actor the message failed to reach. */
  readonly recipientPath: string;
  /** Path of the sender, or `null` when the send carried none. */
  readonly senderPath: string | null;
  readonly payload: DeadLetterPayload;
  /**
   * How many times this letter has already been replayed and come back.
   *
   * Not a diagnostic afterthought: a replayed message that fails again
   * returns to the queue, and without carrying the count forward it would
   * arrive as a *new* entry with a new id, so an operator retrying a poison
   * message would grow the queue one entry per attempt while every
   * individual retry looked like a first one.  `maxReplays` is checked
   * against this.
   */
  readonly replayCount: number;
};

/**
 * Narrowing for {@link DeadLetterQueue.list}.  Every field is optional and
 * they combine with AND; an empty filter matches everything.
 */
export type DeadLetterFilter = {
  /**
   * Keep letters whose recipient path equals this, or lies beneath it —
   * so `/user` selects the whole application subtree and a full path
   * selects one actor.
   */
  readonly recipient?: string;
  /** Keep letters captured at or after this epoch-millisecond instant. */
  readonly sinceMs?: number;
  /** Keep letters captured at or before this epoch-millisecond instant. */
  readonly untilMs?: number;
  /** Keep at most this many, newest first. */
  readonly limit?: number;
};

/** The letter was handed back and has left the queue. */
export type ReplayedResult = {
  readonly kind: 'replayed';
  /**
   * Where the letter was **actually sent** — the alternate path when
   * {@link DeadLetterQueue.replay} was given one, and otherwise the recorded
   * {@link DeadLetterEntry.recipientPath}.
   *
   * Reporting the destination rather than echoing the entry's own field is
   * the only honest choice once a redirect is possible: a caller that logged
   * `recipientPath` from this result would otherwise name the actor that
   * never received the message.
   */
  readonly recipientPath: string;
};
/** No entry with that id — already replayed, evicted, or never captured. */
export type UnknownEntryResult = { readonly kind: 'unknown-entry' };
/**
 * The destination resolves to no actor, so the letter stays put.
 *
 * Deliberately one variant and not two.  A redirect that misses reports the
 * alternate here rather than through a separate
 * `unresolved-alternate-recipient` kind, because the caller is the one who
 * chose the destination and already knows which path it named — a second
 * variant would carry no information the call site does not have, while every
 * consumer would have to handle both to mean the same thing.
 */
export type UnresolvedRecipientResult = {
  readonly kind: 'unresolved-recipient';
  /** The path that was attempted — the alternate when one was given. */
  readonly recipientPath: string;
};
/** The payload was not storable, so there is nothing to redeliver. */
export type DegradedPayloadResult = { readonly kind: 'degraded-payload' };
/**
 * The letter has already come back {@link DeadLetterQueueOptionsType.maxReplays}
 * times.  Refusing is the point: a poison message that dead-letters on every
 * attempt would otherwise be re-queued forever by an operator (or a script)
 * retrying it, and each attempt costs the recipient a turn.
 */
export type QuarantinedResult = {
  readonly kind: 'quarantined';
  readonly replayCount: number;
};

export type DeadLetterReplayResult =
  | ReplayedResult
  | UnknownEntryResult
  | UnresolvedRecipientResult
  | DegradedPayloadResult
  | QuarantinedResult;
