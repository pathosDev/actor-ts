/**
 * Minimal distributed-tracing API (#10).  The framework instruments
 * actor `onReceive`, cross-wire envelopes, and cluster transport
 * against this interface — users plug in either the built-in
 * {@link RecordingTracer} (handy for tests) or an adapter around
 * `@opentelemetry/api`'s tracer for full OTel export.
 *
 * Goals:
 *   - **Zero overhead when disabled.**  The default `NoopTracer`
 *     short-circuits every operation; framework hot paths
 *     never allocate spans or look up async-storage if tracing
 *     hasn't been enabled.
 *   - **No SDK dependency.**  `actor-ts` doesn't pull in
 *     `@opentelemetry/sdk-*`; users bring their own.
 *   - **W3C-compatible cross-wire.**  Span contexts serialise to
 *     the W3C `traceparent` / `tracestate` shape so downstream
 *     OTel-aware services receive a coherent trace.
 *   - **MDC integration.**  When tracing is active, each span's
 *     `traceId` / `spanId` are merged into the {@link LogContext}
 *     scope so log lines stamped during span execution include
 *     them automatically.
 */

/** Allowed attribute primitive types — matches OTel's spec. */
export type AttributeValue = string | number | boolean;

export interface SpanContext {
  /** 32 hex chars — the trace identifier shared across hops. */
  readonly traceId: string;
  /** 16 hex chars — the per-span identifier. */
  readonly spanId: string;
  /** Bit 0 = sampled.  We support sampled / not-sampled only. */
  readonly traceFlags: number;
  /** Optional W3C tracestate — opaque vendor-specific. */
  readonly traceState?: string;
}

export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';
export type SpanStatus = 'unset' | 'ok' | 'error';

export interface SpanOptions {
  /**
   * Parent span context.  `undefined` means "use the active span".
   * `null` explicitly creates a root span.
   */
  readonly parent?: SpanContext | null;
  readonly attributes?: Readonly<Record<string, AttributeValue>>;
  readonly kind?: SpanKind;
  /** Override the span start time — defaults to `Date.now()`. */
  readonly startTimeMs?: number;
}

export interface Span {
  /** The span's own context — what children would inherit. */
  context(): SpanContext;
  setAttribute(key: string, value: AttributeValue): this;
  setStatus(status: 'ok' | 'error', message?: string): this;
  recordException(err: Error): this;
  /** End the span.  Idempotent — second call is a no-op. */
  end(endTimeMs?: number): void;
  /** True after `end()` has been called. */
  readonly ended: boolean;
}

export interface Tracer {
  startSpan(name: string, opts?: SpanOptions): Span;

  /** Run `fn` with `span` as the active span (read by `activeSpan()`). */
  withActiveSpan<T>(span: Span, fn: () => T): T;

  /** Active span on this async stack, or `null` outside any active scope. */
  activeSpan(): Span | null;

  /**
   * Serialise the active span's context to a W3C-style carrier — used
   * by the cluster transport to thread context across the wire.
   * Returns `null` when no span is active or the tracer is a noop.
   */
  injectContext(): TraceCarrier | null;

  /** Inverse of `injectContext` — recover a `SpanContext` from a carrier. */
  extractContext(carrier: TraceCarrier | null | undefined): SpanContext | null;
}

/**
 * Wire-shape for cross-process span propagation.  Mirrors the W3C
 * Trace Context working group's `traceparent` / `tracestate` headers
 * — see {@link encodeTraceparent} / {@link decodeTraceparent}.
 */
export interface TraceCarrier {
  readonly traceparent: string;
  readonly tracestate?: string;
}

/* ----------------------- W3C traceparent codec ------------------------- */

/**
 * Encode a `SpanContext` as a W3C `traceparent` header value:
 *
 *     00-<traceId>-<spanId>-<flags>
 *
 * Version `00` is the only one currently defined.
 */
export function encodeTraceparent(ctx: SpanContext): string {
  const flags = (ctx.traceFlags & 0xff).toString(16).padStart(2, '0');
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

/**
 * Decode a `traceparent` value back into a `SpanContext`.  Returns
 * `null` for any malformed input — callers treat that as "no parent".
 */
export function decodeTraceparent(s: string): SpanContext | null {
  if (typeof s !== 'string') return null;
  const parts = s.split('-');
  if (parts.length !== 4) return null;
  const [version, traceId, spanId, flagsHex] = parts as [string, string, string, string];
  if (version !== '00') return null;
  if (!/^[0-9a-f]{32}$/.test(traceId)) return null;
  if (!/^[0-9a-f]{16}$/.test(spanId)) return null;
  if (!/^[0-9a-f]{2}$/.test(flagsHex)) return null;
  if (traceId === '0'.repeat(32) || spanId === '0'.repeat(16)) return null;
  return { traceId, spanId, traceFlags: parseInt(flagsHex, 16) };
}

/* ------------------------- Span context helpers ------------------------- */

/** Generate a fresh trace id — 16 random bytes hex-encoded. */
export function newTraceId(): string {
  return randomHex(16);
}

/** Generate a fresh span id — 8 random bytes hex-encoded. */
export function newSpanId(): string {
  return randomHex(8);
}

function randomHex(byteLength: number): string {
  const buf = new Uint8Array(byteLength);
  // crypto.getRandomValues is universally available on Bun, Node, Deno.
  globalThis.crypto.getRandomValues(buf);
  let out = '';
  for (const byte of buf) out += byte.toString(16).padStart(2, '0');
  return out;
}
