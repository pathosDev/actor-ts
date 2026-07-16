/**
 * Bridge from the framework's {@link Tracer} to the OpenTelemetry
 * API (#63).
 *
 * The framework instruments actor message handling, cross-wire
 * envelopes, and cluster transport against its own minimal
 * {@link Tracer} interface — no SDK dependency.  Production users
 * who want their spans in Jaeger / Tempo / Honeycomb / Datadog need
 * an adapter to `@opentelemetry/api`.  Without one each user writes
 * the same plumbing; this file ships it once.
 *
 * The adapter delegates everything: `startSpan` to the real OTel
 * `Tracer.startSpan`, `withActiveSpan` to `context.with` over an
 * OTel context with the wrapped span attached, `injectContext`/
 * `extractContext` to OTel's W3C-compatible `propagation.inject` /
 * `.extract`.  Net effect: every actor-ts span shows up in the
 * user's OTel SDK, with `traceparent` flowing across the wire to
 * downstream services that speak W3C Trace Context.
 *
 * **Optional peer dep**: `@opentelemetry/api` is not a hard dep of
 * the framework.  Users who want this adapter pass their existing
 * import (`import * as otel from '@opentelemetry/api'`) into
 * `otelTracer(OtelAdapterOptions.create().withApi(otel))` — same
 * passthrough pattern as the
 * prom-client adapter (#64).  Structural typing on the OTel surface
 * means we never `import '@opentelemetry/api'` ourselves.
 */

import type { OtelAdapterOptions, OtelAdapterOptionsType } from './OtelAdapterOptions.js';
import type {
  AttributeValue, Span, SpanContext, SpanKind, SpanOptions, TraceCarrier, Tracer,
} from './Tracer.js';

/* ----------------------- OpenTelemetry API surface ----------------------- */
/* Structural — keep in sync with @opentelemetry/api v1.x.  We use only the */
/* surface needed to drive end-to-end span lifecycle + W3C propagation.     */

export interface OtelSpanContextLike {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
  readonly traceState?: string;
  readonly isRemote?: boolean;
}

export interface OtelSpanLike {
  spanContext(): OtelSpanContextLike;
  setAttribute(key: string, value: AttributeValue): OtelSpanLike;
  setStatus(status: { code: number; message?: string }): OtelSpanLike;
  recordException(err: Error | string, time?: number): void;
  end(time?: number): void;
  isRecording(): boolean;
}

export interface OtelContextLike {
  // Opaque — OTel's Context is a structural type with `getValue`/`setValue`
  // we don't need to call directly.  Treated as a black box here.
  readonly __opaque?: never;
}

export interface OtelTracerLike {
  startSpan(
    name: string,
    options?: {
      kind?: number;
      attributes?: Record<string, AttributeValue>;
      startTime?: number;
      root?: boolean;
    },
    context?: OtelContextLike,
  ): OtelSpanLike;
}

export interface OtelTraceApi {
  getTracer(name: string, version?: string): OtelTracerLike;
  setSpan(context: OtelContextLike, span: OtelSpanLike): OtelContextLike;
  getSpan(context: OtelContextLike): OtelSpanLike | undefined;
  getActiveSpan(): OtelSpanLike | undefined;
  getSpanContext(context: OtelContextLike): OtelSpanContextLike | undefined;
  setSpanContext(context: OtelContextLike, sc: OtelSpanContextLike): OtelContextLike;
  wrapSpanContext(sc: OtelSpanContextLike): OtelSpanLike;
}

export interface OtelContextApi {
  active(): OtelContextLike;
  with<F extends (...args: never[]) => unknown>(context: OtelContextLike, fn: F): ReturnType<F>;
  /** OTel exports `ROOT_CONTEXT` as a top-level constant; some shims also rehang it here. */
  readonly ROOT_CONTEXT?: OtelContextLike;
}

export interface OtelPropagationApi {
  inject(context: OtelContextLike, carrier: Record<string, string>): void;
  extract(context: OtelContextLike, carrier: Record<string, string | undefined>): OtelContextLike;
}

export interface OtelApiLike {
  readonly trace: OtelTraceApi;
  readonly context: OtelContextApi;
  readonly propagation: OtelPropagationApi;
  readonly SpanStatusCode: { readonly UNSET: number; readonly OK: number; readonly ERROR: number };
  readonly SpanKind: {
    readonly INTERNAL: number; readonly SERVER: number; readonly CLIENT: number;
    readonly PRODUCER: number; readonly CONSUMER: number;
  };
  /** Optional — re-export of the root context constant if the SDK exposes it on the namespace. */
  readonly ROOT_CONTEXT?: OtelContextLike;
}

/* ------------------------------- adapter ------------------------------- */

export function otelTracer(options: OtelAdapterOptions): Tracer {
  const resolvedOptions = options as OtelAdapterOptionsType;
  const { api } = resolvedOptions;
  const otelTracerInstance = resolvedOptions.tracer ?? api.trace.getTracer(resolvedOptions.tracerName ?? 'actor-ts', resolvedOptions.tracerVersion);

  const SPAN_KIND_MAP: Record<SpanKind, number> = {
    internal: api.SpanKind.INTERNAL,
    server:   api.SpanKind.SERVER,
    client:   api.SpanKind.CLIENT,
    producer: api.SpanKind.PRODUCER,
    consumer: api.SpanKind.CONSUMER,
  };

  /**
   * Resolve `ROOT_CONTEXT` whether the SDK exports it at the top level
   * of the namespace or hangs it off `context`.  Falls back to `active()`
   * when neither is exposed — at startSpan time before any scope is
   * active that's equivalent.
   */
  function rootContext(): OtelContextLike {
    return api.ROOT_CONTEXT ?? api.context.ROOT_CONTEXT ?? api.context.active();
  }

  /** Translate an OTel `SpanContext` to our shape (drop `isRemote`, keep `traceState`). */
  function pickSpanContext(sc: OtelSpanContextLike): SpanContext {
    return {
      traceId: sc.traceId,
      spanId: sc.spanId,
      traceFlags: sc.traceFlags,
      ...(sc.traceState ? { traceState: sc.traceState } : {}),
    };
  }

  /** Wrap an OTel span in our `Span` interface.  Cheap; safe to call repeatedly. */
  function wrapSpan(otelSpan: OtelSpanLike): Span {
    let ended = false;
    const wrapper: Span = {
      context(): SpanContext { return pickSpanContext(otelSpan.spanContext()); },
      setAttribute(key, value): Span {
        if (!ended) otelSpan.setAttribute(key, value);
        return wrapper;
      },
      setStatus(status, message): Span {
        if (!ended) {
          otelSpan.setStatus({
            code: status === 'ok' ? api.SpanStatusCode.OK : api.SpanStatusCode.ERROR,
            ...(message !== undefined ? { message } : {}),
          });
        }
        return wrapper;
      },
      recordException(err): Span {
        if (!ended) otelSpan.recordException(err);
        return wrapper;
      },
      end(endTimeMs): void {
        if (ended) return;
        ended = true;
        otelSpan.end(endTimeMs);
      },
      get ended(): boolean { return ended; },
    };
    otelOf.set(wrapper, otelSpan);
    return wrapper;
  }

  // Wrap-to-OTel back-reference.  `withActiveSpan` reads from this map
  // to put the right OTel span on the OTel context; lookups fall back
  // gracefully (just-run-fn) when the user passes a span we didn't create.
  const otelOf = new WeakMap<Span, OtelSpanLike>();

  return {
    startSpan(name, options2?: SpanOptions): Span {
      let context = api.context.active();
      if (options2?.parent === null) {
        // Explicit root.  Pass `root: true` to OTel so its sampling
        // decision treats this as a new trace; switch the context to
        // ROOT just to make sure no ambient parent leaks in.
        context = rootContext();
      } else if (options2?.parent) {
        // Explicit parent SpanContext: install it on a fresh context.
        context = api.trace.setSpanContext(rootContext(), {
          traceId: options2.parent.traceId,
          spanId: options2.parent.spanId,
          traceFlags: options2.parent.traceFlags,
          ...(options2.parent.traceState ? { traceState: options2.parent.traceState } : {}),
          isRemote: true,
        });
      }
      const otelSpan = otelTracerInstance.startSpan(
        name,
        {
          ...(options2?.kind ? { kind: SPAN_KIND_MAP[options2.kind] } : {}),
          ...(options2?.attributes ? { attributes: { ...options2.attributes } } : {}),
          ...(options2?.startTimeMs !== undefined ? { startTime: options2.startTimeMs } : {}),
          ...(options2?.parent === null ? { root: true } : {}),
        },
        context,
      );
      return wrapSpan(otelSpan);
    },

    withActiveSpan<T>(span: Span, fn: () => T): T {
      const otelSpan = otelOf.get(span);
      if (!otelSpan) {
        // Not one of ours — degrade to running `fn` without OTel
        // context propagation.  Better than throwing; covers the
        // (unusual) case where the caller mixed adapter outputs.
        return fn();
      }
      const context = api.trace.setSpan(api.context.active(), otelSpan);
      return api.context.with(context, fn) as T;
    },

    activeSpan(): Span | null {
      const otelSpan = api.trace.getActiveSpan();
      if (!otelSpan) return null;
      return wrapSpan(otelSpan);
    },

    injectContext(): TraceCarrier | null {
      const carrier: Record<string, string> = {};
      api.propagation.inject(api.context.active(), carrier);
      const traceparent = carrier['traceparent'];
      if (!traceparent) return null;
      return {
        traceparent,
        ...(carrier['tracestate'] ? { tracestate: carrier['tracestate'] } : {}),
      };
    },

    extractContext(carrier): SpanContext | null {
      if (!carrier) return null;
      const newContext = api.propagation.extract(rootContext(), {
        traceparent: carrier.traceparent,
        ...(carrier.tracestate ? { tracestate: carrier.tracestate } : {}),
      });
      const sc = api.trace.getSpanContext(newContext);
      if (!sc) return null;
      return pickSpanContext(sc);
    },
  };
}
