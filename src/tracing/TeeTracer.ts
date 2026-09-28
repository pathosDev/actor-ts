/**
 * A {@link Tracer} that forwards to another one and reports every
 * completed span to an observer.
 *
 * The tracing extension holds exactly one tracer, so anything that
 * wants to watch spans would otherwise have to *replace* whatever is
 * installed — forcing a choice between exporting to OpenTelemetry and
 * looking at a local flame graph.  Teeing removes the choice: the
 * original tracer keeps doing its job, unaware, while a second consumer
 * sees the spans too.
 *
 *     const original = tracerOf(system);
 *     tracing.enable(new TeeTracer(original, (span) => buffer.push(span)));
 *
 * The observer is called after the inner span has ended, and its
 * exceptions are swallowed: an observer is a bystander, and a bug in
 * one must not break the traced code.
 *
 * **The two sides no longer necessarily see the same spans.**  A third
 * argument names attribute keys the observer gets and the inner tracer
 * does not, and it exists for one situation: the observer switched an
 * instrumentation flag on for its own sake, and the value that flag
 * produces would otherwise ride out through a tracer somebody else
 * configured.  DevTools' `SpanTap` withholds `actor.message.payload`
 * that way, so attaching a debugger cannot push message bodies into an
 * APM the operator never pointed at them (#1420).  Nothing else is
 * filtered — name, timings, status, exceptions, parentage and every
 * other attribute are forwarded verbatim — and with the argument left
 * out the tee is transparent, exactly as it was.
 */
import type { RecordedSpan } from './RecordingTracer.js';
import { highResNow } from '../runtime/Detect.js';
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
    /**
     * Attribute keys the observer sees and {@link inner} never does.
     *
     * Empty by default, which is the transparent tee.  A fresh `Set`
     * rather than a shared frozen one: a tee is built once per
     * installation, so the allocation is not on any path worth
     * optimising, and a module-level mutable singleton handed to every
     * instance is a footgun for the cost of nothing.
     */
    private readonly withheldAttributes: ReadonlySet<string> = new Set(),
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
      this.inner.startSpan(name, this.withoutWithheldAttributes(options)),
      name,
      options?.kind ?? 'internal',
      parent,
      options?.startTimeMs ?? Date.now(),
      options?.startTimeMs === undefined ? highResNow() / 1_000_000 : undefined,
      // The observer's copy is taken from the ORIGINAL options: the
      // filtering is about what leaves through `inner`, not about what
      // the span was.
      options?.attributes ?? {},
      this.withheldAttributes,
      (span) => this.emit(span),
    );
  }

  /**
   * `options` as the inner tracer is allowed to see it.
   *
   * Returns the caller's own object whenever nothing would be dropped,
   * so the ordinary tee — and every span that carries no withheld key —
   * allocates nothing extra.  `startSpan` runs once per actor message.
   */
  private withoutWithheldAttributes(options?: SpanOptions): SpanOptions | undefined {
    if (this.withheldAttributes.size === 0 || options?.attributes === undefined) return options;
    let kept: Record<string, AttributeValue> | null = null;
    for (const key of Object.keys(options.attributes)) {
      if (!this.withheldAttributes.has(key)) continue;
      kept ??= { ...options.attributes };
      delete kept[key];
    }
    return kept === null ? options : { ...options, attributes: kept };
  }

  withActiveSpan<T>(span: Span, callback: () => T): T {
    // Unwrap first: the inner tracer stores spans in its own async
    // context, and handing it a wrapper would make `activeSpan()`
    // return something it did not create.
    return this.inner.withActiveSpan(span instanceof TeeSpan ? span.unwrap() : span, callback);
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
 *
 * Its own copy is the complete one; `withheldAttributes` subtracts only
 * from what reaches the delegate.  `setAttribute` is the second door
 * into a span's bag — filtering the initial one in
 * {@link TeeTracer.startSpan} and not this one would be no filter at
 * all for any instrumentation that writes after the span opens.
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
    private readonly withheldAttributes: ReadonlySet<string>,
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
      if (!this.withheldAttributes.has(key)) this.inner.setAttribute(key, value);
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
