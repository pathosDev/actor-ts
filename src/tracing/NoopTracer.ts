import type {
  Span, SpanContext, SpanOptions, TraceCarrier, Tracer,
} from './Tracer.js';

/**
 * The default tracer — every operation is a no-op so framework
 * instrumentation pays nothing when tracing is not enabled.  All
 * `Span`s share the same singleton; `injectContext` returns null;
 * `withActiveSpan` invokes `fn` directly.
 */

const ZERO_CTX: SpanContext = Object.freeze({
  traceId: '0'.repeat(32),
  spanId: '0'.repeat(16),
  traceFlags: 0,
});

const NOOP_SPAN: Span = Object.freeze({
  context: () => ZERO_CTX,
  setAttribute: () => NOOP_SPAN,
  setStatus: () => NOOP_SPAN,
  recordException: () => NOOP_SPAN,
  end: () => { /* no-op */ },
  ended: true,
}) as unknown as Span;

export class NoopTracer implements Tracer {
  startSpan(_name: string, _opts?: SpanOptions): Span { return NOOP_SPAN; }
  withActiveSpan<T>(_span: Span, fn: () => T): T { return fn(); }
  activeSpan(): Span | null { return null; }
  injectContext(): TraceCarrier | null { return null; }
  extractContext(_carrier: TraceCarrier | null | undefined): SpanContext | null { return null; }
}

/** Module-shared singleton — every `NoopTracer` is identical anyway. */
export const NOOP_TRACER: Tracer = new NoopTracer();
