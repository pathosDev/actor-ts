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

export interface RecordedSpan {
  readonly name: string;
  readonly kind: SpanKind;
  readonly context: SpanContext;
  readonly parent: SpanContext | null;
  readonly startTimeMs: number;
  readonly endTimeMs: number;
  readonly attributes: Readonly<Record<string, AttributeValue>>;
  readonly status: SpanStatus;
  readonly statusMessage?: string;
  readonly exceptions: ReadonlyArray<Error>;
}

export interface RecordingTracerOptions {
  /** Hook invoked when a span ends — wire to your exporter here. */
  readonly onSpanEnd?: (span: RecordedSpan) => void;
  /** Sampling decision per span.  Default `() => true` (sample all). */
  readonly sampler?: (name: string, options: SpanOptions | undefined) => boolean;
}

class RecordingSpan implements Span {
  private _ended = false;
  private _status: SpanStatus = 'unset';
  private _statusMessage?: string;
  private readonly _attributes: Record<string, AttributeValue> = {};
  private readonly _exceptions: Error[] = [];
  private _endTimeMs = 0;

  constructor(
    public readonly name: string,
    public readonly kind: SpanKind,
    public readonly _context: SpanContext,
    public readonly _parent: SpanContext | null,
    public readonly _startTimeMs: number,
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

  constructor(options: RecordingTracerOptions = {}) {
    this.onSpanEnd = options.onSpanEnd;
    this.sampler = options.sampler ?? (() => true);
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
    this._recorded.push(span);
    this.onSpanEnd?.(span);
  }
}
