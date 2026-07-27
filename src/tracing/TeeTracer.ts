/**
 * A {@link Tracer} that forwards to another one and reports every
 * completed span to an observer.
 *
 * The tracing extension holds exactly one tracer, so anything that
 * wants to watch spans would otherwise have to *replace* whatever is
 * installed — forcing a choice between exporting to OpenTelemetry and
 * looking at a local flame graph.  Teeing removes the choice: the
 * original tracer keeps doing its job, unaware, while a second consumer
 * sees the same spans.
 *
 *     const original = tracerOf(system);
 *     tracing.enable(new TeeTracer(original, (span) => buffer.push(span)));
 *
 * The observer is called after the inner span has ended, and its
 * exceptions are swallowed: an observer is a bystander, and a bug in
 * one must not break the traced code.
 */
import type { RecordedSpan } from './RecordingTracer.js';
import { highResNow } from '../runtime/detect.js';
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

export class TeeTracer implements Tracer {
  constructor(
    /** The tracer doing the real work; every call is forwarded to it. */
    private readonly inner: Tracer,
    /** Called once per completed span. */
    private readonly observe: (span: RecordedSpan) => void,
  ) {}

  /** The wrapped tracer, so a caller can restore it later. */
  unwrap(): Tracer {
    return this.inner;
  }

  startSpan(name: string, options?: SpanOptions): Span {
    // Resolve the parent with the same rule every tracer uses: explicit
    // `null` means root, an explicit context wins, otherwise inherit the
    // active span.  The inner span cannot be asked — `Span` exposes only
    // its own context — so it is recomputed here.
    const parent = options?.parent === null
      ? null
      : options?.parent ?? this.activeSpan()?.context() ?? null;

    return new TeeSpan(
      this.inner.startSpan(name, options),
      name,
      options?.kind ?? 'internal',
      parent,
      options?.startTimeMs ?? Date.now(),
      options?.startTimeMs === undefined ? highResNow() / 1_000_000 : undefined,
      options?.attributes ?? {},
      (span) => this.emit(span),
    );
  }

  withActiveSpan<T>(span: Span, fn: () => T): T {
    // Unwrap first: the inner tracer stores spans in its own async
    // context, and handing it a wrapper would make `activeSpan()`
    // return something it did not create.
    return this.inner.withActiveSpan(span instanceof TeeSpan ? span.unwrap() : span, fn);
  }

  activeSpan(): Span | null {
    return this.inner.activeSpan();
  }

  injectContext(): TraceCarrier | null {
    return this.inner.injectContext();
  }

  extractContext(carrier: TraceCarrier | null | undefined): SpanContext | null {
    return this.inner.extractContext(carrier);
  }

  private emit(span: RecordedSpan): void {
    try {
      this.observe(span);
    } catch {
      /* an observer is a bystander; its failure is not the caller's */
    }
  }
}

/**
 * A span that delegates to the real one while keeping its own copy of
 * everything a {@link RecordedSpan} needs.  The inner `Span` interface
 * is write-only apart from `context()`, so nothing can be read back
 * out of it at the end.
 */
class TeeSpan implements Span {
  private _ended = false;
  private _status: SpanStatus = 'unset';
  private _statusMessage: string | undefined;
  private readonly _attributes: Record<string, AttributeValue> = {};
  private readonly _exceptions: Error[] = [];

  constructor(
    private readonly inner: Span,
    private readonly name: string,
    private readonly kind: SpanKind,
    private readonly parent: SpanContext | null,
    private readonly startTimeMs: number,
    private readonly startHighResolutionMs: number | undefined,
    initialAttributes: Readonly<Record<string, AttributeValue>>,
    private readonly onEnd: (span: RecordedSpan) => void,
  ) {
    Object.assign(this._attributes, initialAttributes);
  }

  /** The delegate, for `withActiveSpan`. */
  unwrap(): Span {
    return this.inner;
  }

  context(): SpanContext {
    return this.inner.context();
  }

  setAttribute(key: string, value: AttributeValue): this {
    if (!this._ended) {
      this._attributes[key] = value;
      this.inner.setAttribute(key, value);
    }
    return this;
  }

  setStatus(status: 'ok' | 'error', message?: string): this {
    if (!this._ended) {
      this._status = status;
      this._statusMessage = message;
      this.inner.setStatus(status, message);
    }
    return this;
  }

  recordException(error: Error): this {
    if (!this._ended) {
      this._exceptions.push(error);
      this.inner.recordException(error);
    }
    return this;
  }

  end(endTimeMs?: number): void {
    if (this._ended) return;
    this._ended = true;
    const endHighResolutionMs = endTimeMs === undefined ? highResNow() / 1_000_000 : undefined;
    this.inner.end(endTimeMs);
    this.onEnd({
      name: this.name,
      kind: this.kind,
      context: this.inner.context(),
      parent: this.parent,
      startTimeMs: this.startTimeMs,
      endTimeMs: endTimeMs ?? Date.now(),
      ...(this.startHighResolutionMs !== undefined && endHighResolutionMs !== undefined
        ? { startHighResolutionMs: this.startHighResolutionMs, endHighResolutionMs }
        : {}),
      attributes: { ...this._attributes },
      status: this._status,
      ...(this._statusMessage !== undefined ? { statusMessage: this._statusMessage } : {}),
      exceptions: [...this._exceptions],
    });
  }

  get ended(): boolean {
    return this._ended;
  }
}
