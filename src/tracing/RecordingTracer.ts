import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  AttributeValue,
  Span,
  SpanContext,
  SpanKind,
  SpanOptions,
  SpanStatus,
  TraceCarrier,
  Tracer,
} from './Tracer.js';
import { highResNow } from '../runtime/detect.js';
import {
  decodeTraceparent,
  encodeTraceparent,
  newSpanId,
  newTraceId,
} from './Tracer.js';

/**
 * Reference {@link Tracer} implementation.  Generates real ids,
 * tracks span hierarchy via parent context, propagates the active
 * span through `AsyncLocalStorage`, and records ended spans into an
 * in-memory buffer for assertions.
 *
 * Production usage: the recorder list is your sink.  For full
 * OpenTelemetry export, pass each completed span through to the OTel
 * SDK in `onSpanEnd` — or write a thin adapter that delegates the
 * `Tracer` calls to `@opentelemetry/api.trace.getTracer(...)`.
 *
 * This impl is **not** an OpenTelemetry SDK — it doesn't sample,
 * batch, or export.  Its role is the in-process backbone for
 * actor-ts's instrumentation; the SDK boundary lives in the
 * adapter layer.
 */

export type RecordedSpan = {
  readonly name: string;
  readonly kind: SpanKind;
  readonly context: SpanContext;
  readonly parent: SpanContext | null;
  readonly startTimeMs: number;
  readonly endTimeMs: number;
  /**
   * Monotonic-clock start, in fractional milliseconds.
   *
   * `startTimeMs`/`endTimeMs` are wall clock, which is what an exporter
   * needs but too coarse to lay out a flame graph: actor message
   * handling routinely completes inside a single millisecond, so every
   * bar would be zero-width.  These two are taken from the same
   * high-resolution clock the benchmarks use.  Absent when the caller
   * supplied explicit timestamps — there is no honest way to invent a
   * monotonic reading for a time someone else chose.
   */
  readonly startHighResolutionMs?: number;
  readonly endHighResolutionMs?: number;
  readonly attributes: Readonly<Record<string, AttributeValue>>;
  readonly status: SpanStatus;
  readonly statusMessage?: string;
  readonly exceptions: ReadonlyArray<Error>;
};

export type RecordingTracerOptions = {
  /** Hook invoked when a span ends — wire to your exporter here. */
  readonly onSpanEnd?: (span: RecordedSpan) => void;
  /** Sampling decision per span.  Default `() => true` (sample all). */
  readonly sampler?: (name: string, options: SpanOptions | undefined) => boolean;
  /**
   * Cap on the in-memory recording, oldest evicted first.
   *
   * Unset means unbounded, which is right for a test that asserts over
   * every span but wrong for anything long-lived: a tracer left enabled
   * on a busy system grows without limit.  Set `0` to keep none at all —
   * the sensible choice when {@link onSpanEnd} is the real sink and
   * `recorded()` is never read.
   */
  readonly maxRecorded?: number;
};

class RecordingSpan implements Span {
  private _ended = false;
  private _status: SpanStatus = 'unset';
  private _statusMessage?: string;
  private readonly _attributes: Record<string, AttributeValue> = {};
  private readonly _exceptions: Error[] = [];
  private _endTimeMs = 0;
  private _endHighResolutionMs: number | undefined;

  constructor(
    public readonly name: string,
    public readonly kind: SpanKind,
    public readonly _context: SpanContext,
    public readonly _parent: SpanContext | null,
    public readonly _startTimeMs: number,
    public readonly _startHighResolutionMs: number | undefined,
    initialAttributes: Readonly<Record<string, AttributeValue>>,
    private readonly tracer: RecordingTracer,
  ) {
    Object.assign(this._attributes, initialAttributes);
  }

  context(): SpanContext { return this._context; }

  setAttribute(key: string, value: AttributeValue): this {
    if (!this._ended) this._attributes[key] = value;
    return this;
  }

  setStatus(status: 'ok' | 'error', message?: string): this {
    if (!this._ended) {
      this._status = status;
      this._statusMessage = message;
    }
    return this;
  }

  recordException(err: Error): this {
    if (!this._ended) this._exceptions.push(err);
    return this;
  }

  end(endTimeMs?: number): void {
    if (this._ended) return;
    this._ended = true;
    // A caller-supplied end time is a wall-clock instant of their
    // choosing; pairing it with a monotonic reading taken now would
    // produce a duration that matches neither.  Better to have no
    // high-resolution pair than a misleading one.
    this._endHighResolutionMs = endTimeMs === undefined ? highResolutionMs() : undefined;
    this._endTimeMs = endTimeMs ?? Date.now();
    this.tracer._recordEnd(this.snapshot());
  }

  get ended(): boolean { return this._ended; }

  /** @internal — used by the tracer when emitting the recording. */
  snapshot(): RecordedSpan {
    return {
      name: this.name,
      kind: this.kind,
      context: this._context,
      parent: this._parent,
      startTimeMs: this._startTimeMs,
      endTimeMs: this._endTimeMs,
      // Both or neither: half a pair cannot produce a duration.
      ...(this._startHighResolutionMs !== undefined && this._endHighResolutionMs !== undefined
        ? {
          startHighResolutionMs: this._startHighResolutionMs,
          endHighResolutionMs: this._endHighResolutionMs,
        }
        : {}),
      attributes: { ...this._attributes },
      status: this._status,
      ...(this._statusMessage !== undefined ? { statusMessage: this._statusMessage } : {}),
      exceptions: [...this._exceptions],
    };
  }
}

export class RecordingTracer implements Tracer {
  private readonly storage = new AsyncLocalStorage<Span>();
  private readonly _recorded: RecordedSpan[] = [];
  private readonly onSpanEnd?: (span: RecordedSpan) => void;
  private readonly sampler: (name: string, options: SpanOptions | undefined) => boolean;
  private readonly maxRecorded: number | undefined;

  constructor(options: RecordingTracerOptions = {}) {
    this.onSpanEnd = options.onSpanEnd;
    this.sampler = options.sampler ?? (() => true);
    this.maxRecorded = options.maxRecorded;
  }

  startSpan(name: string, options?: SpanOptions): Span {
    const sampled = this.sampler(name, options);
    // Resolve parent: explicit `null` = root, undefined = active span,
    // a SpanContext = explicit parent.
    let parentContext: SpanContext | null;
    if (options?.parent === null) {
      parentContext = null;
    } else if (options?.parent !== undefined) {
      parentContext = options.parent;
    } else {
      parentContext = this.activeSpan()?.context() ?? null;
    }
    const traceId = parentContext?.traceId ?? newTraceId();
    const spanId = newSpanId();
    const context: SpanContext = {
      traceId, spanId,
      traceFlags: sampled ? 1 : 0,
      ...(parentContext?.traceState ? { traceState: parentContext.traceState } : {}),
    };
    return new RecordingSpan(
      name,
      options?.kind ?? 'internal',
      context,
      parentContext,
      options?.startTimeMs ?? Date.now(),
      options?.startTimeMs === undefined ? highResolutionMs() : undefined,
      options?.attributes ?? {},
      this,
    );
  }

  withActiveSpan<T>(span: Span, fn: () => T): T {
    return this.storage.run(span, fn);
  }

  activeSpan(): Span | null {
    return this.storage.getStore() ?? null;
  }

  injectContext(): TraceCarrier | null {
    const span = this.activeSpan();
    if (!span) return null;
    return { traceparent: encodeTraceparent(span.context()) };
  }

  extractContext(carrier: TraceCarrier | null | undefined): SpanContext | null {
    if (!carrier) return null;
    const context = decodeTraceparent(carrier.traceparent);
    if (!context) return null;
    return carrier.tracestate ? { ...context, traceState: carrier.tracestate } : context;
  }

  /** Snapshot of every ended span — primarily for tests. */
  recorded(): ReadonlyArray<RecordedSpan> { return [...this._recorded]; }

  /** Clear the recording buffer.  Spans currently in flight are unaffected. */
  reset(): void { this._recorded.length = 0; }

  /** @internal — invoked from `Span.end()`. */
  _recordEnd(span: RecordedSpan): void {
    if (this.maxRecorded === undefined) {
      this._recorded.push(span);
    } else if (this.maxRecorded > 0) {
      this._recorded.push(span);
      if (this._recorded.length > this.maxRecorded) this._recorded.shift();
    }
    // The hook fires either way: a consumer that keeps no buffer still
    // wants every span.
    this.onSpanEnd?.(span);
  }
}

/** Monotonic clock in fractional milliseconds — the flame graph's axis. */
function highResolutionMs(): number {
  return highResNow() / 1_000_000;
}
