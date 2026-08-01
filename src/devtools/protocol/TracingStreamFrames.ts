/**
 * Payload of the `spans` stream (#217) — a wire projection of
 * `RecordedSpan` for the flame-graph / waterfall panel.
 *
 * `parentSpanId` + `traceId` reconstruct the tree; `startMs`/`endMs`
 * place the bars.  The two `*HighResolutionMs` fields carry a
 * monotonic-clock reading when the tracer captured one: wall-clock
 * milliseconds are too coarse to resolve actor message handling, which
 * routinely completes inside a single millisecond.
 */

/** Span kind, mirrored from the tracing `SpanKind`. */
export type WireSpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';

/** Span status, mirrored from the tracing `SpanStatus`. */
export type WireSpanStatus = 'unset' | 'ok' | 'error';

/** One completed span. */
export type WireSpan = {
  readonly name: string;
  readonly spanKind: WireSpanKind;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly startMs: number;
  readonly endMs: number;
  /** Monotonic-clock start, when available — preferred for layout. */
  readonly startHighResolutionMs: number | null;
  readonly endHighResolutionMs: number | null;
  readonly status: WireSpanStatus;
  readonly statusMessage: string | null;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  /** Lifted from the `actor.path` attribute — the flame graph groups by it. */
  readonly actorPath: string | null;
  /** Who sent the message, from `actor.sender`; `null` for a `tell` with no sender. */
  readonly senderPath: string | null;
  /** Lifted from the `actor.message.type` attribute. */
  readonly messageType: string | null;
  /**
   * The message itself as JSON, from `actor.message.payload`.
   *
   * Present only while a tracing panel is subscribed — serialising every
   * traced message is not something production tracing should pay for.
   * Bounded in depth and length by the runtime before it gets here.
   */
  readonly messagePayload: string | null;
  readonly exceptions: ReadonlyArray<string>;
};

/** A batch of completed spans, flushed on the stream tick. */
export type SpanBatchPayload = {
  readonly kind: 'span-batch';
  readonly atMs: number;
  readonly spans: ReadonlyArray<WireSpan>;
  /** Spans evicted from the ring before they could be sent. */
  readonly dropped: number;
};

/** Payloads carried by the `spans` stream. */
export type TracingStreamPayload = SpanBatchPayload;

/** Smallest and largest span ring a client may ask for. */
export const TRACING_BUFFER_MINIMUM = 10;
export const TRACING_BUFFER_MAXIMUM = 10_000;
/** What a fresh client gets before it chooses. */
export const TRACING_BUFFER_DEFAULT = 100;

/**
 * `tracing.buffer` — how many recent spans the server keeps.
 *
 * Recording is not something the client turns on; it runs from the
 * moment DevTools attaches, so the last messages are already there when
 * the panel is opened.  What the client does choose is how far back
 * "recent" goes, because that is the part it pays for on the wire.
 */
export type TracingBufferParameters = {
  readonly capacity: number;
};

export type TracingBufferResult = {
  /** What the server settled on, after clamping to its own ceiling. */
  readonly capacity: number;
  readonly retained: number;
};

/** @internal */
export function spanBatchPayload(
  atMs: number,
  spans: ReadonlyArray<WireSpan>,
  dropped: number,
): SpanBatchPayload {
  return { kind: 'span-batch', atMs, spans, dropped };
}
