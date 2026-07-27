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
export interface WireSpan {
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
  /** Lifted from the `actor.message.type` attribute. */
  readonly messageType: string | null;
  readonly exceptions: ReadonlyArray<string>;
}

/** A batch of completed spans, flushed on the stream tick. */
export interface SpanBatchPayload {
  readonly kind: 'span-batch';
  readonly atMs: number;
  readonly spans: ReadonlyArray<WireSpan>;
  /** Spans evicted from the ring before they could be sent. */
  readonly dropped: number;
}

/** Payloads carried by the `spans` stream. */
export type TracingStreamPayload = SpanBatchPayload;

/** @internal */
export function spanBatchPayload(
  atMs: number,
  spans: ReadonlyArray<WireSpan>,
  dropped: number,
): SpanBatchPayload {
  return { kind: 'span-batch', atMs, spans, dropped };
}
