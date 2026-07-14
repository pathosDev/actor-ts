import { describe, expect, test } from 'bun:test';
import { otelTracer, type OtelApiLike, type OtelSpanLike, type OtelSpanContextLike, type OtelContextLike } from '../../../src/tracing/OtelAdapter.js';
import { OtelAdapterOptions } from '../../../src/tracing/OtelAdapterOptions.js';
import { decodeTraceparent, encodeTraceparent, newSpanId, newTraceId } from '../../../src/tracing/Tracer.js';

/**
 * Tests run against a hand-rolled OTel-shaped fake — keeps the
 * suite self-contained (no extra dev-dep on @opentelemetry/api or
 * sdk-trace-base) and makes the propagation behaviour explicit:
 * each fake method is the simplest correct implementation, so when
 * the adapter does the right thing against the fake we know the
 * adapter doesn't accidentally lean on private OTel-SDK behaviour.
 */

interface FakeRecordedSpan {
  name: string;
  kind?: number;
  attrs: Record<string, unknown>;
  startTime?: number;
  endTime?: number;
  status?: { code: number; message?: string };
  exceptions: Array<Error | string>;
  parentTraceId?: string;
  parentSpanId?: string;
  ctx: OtelSpanContextLike;
  ended: boolean;
}

class FakeContext implements OtelContextLike {
  constructor(public readonly map = new Map<symbol, unknown>()) {}
  setValue(key: symbol, value: unknown): FakeContext {
    const next = new Map(this.map);
    next.set(key, value);
    return new FakeContext(next);
  }
  getValue(key: symbol): unknown { return this.map.get(key); }
}

const SPAN_KEY = Symbol('OTEL_SPAN');
const ROOT = new FakeContext();

function makeFakeSpan(record: FakeRecordedSpan): OtelSpanLike {
  return {
    spanContext: () => record.ctx,
    setAttribute(key, value): OtelSpanLike {
      record.attrs[key] = value;
      return this;
    },
    setStatus(span): OtelSpanLike {
      record.status = span;
      return this;
    },
    recordException(err): void {
      record.exceptions.push(err);
    },
    end(t): void {
      record.endTime = t ?? Date.now();
      record.ended = true;
    },
    isRecording: () => !record.ended,
  };
}

interface FakeOtelApi extends OtelApiLike {
  recorded: FakeRecordedSpan[];
  // Cycle through fake `current` context for `with`-style propagation.
  current: FakeContext;
}

function makeFakeOtelApi(): FakeOtelApi {
  const recorded: FakeRecordedSpan[] = [];
  const api: FakeOtelApi = {
    recorded,
    current: ROOT,
    SpanStatusCode: { UNSET: 0, OK: 1, ERROR: 2 },
    SpanKind: { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 },
    ROOT_CONTEXT: ROOT,

    trace: {
      getTracer: (_n, _v): { startSpan: typeof startSpan } => ({ startSpan }),
      setSpan(ctx, span): OtelContextLike {
        return (ctx as FakeContext).setValue(SPAN_KEY, span);
      },
      getSpan(ctx): OtelSpanLike | undefined {
        return (ctx as FakeContext).getValue(SPAN_KEY) as OtelSpanLike | undefined;
      },
      getActiveSpan(): OtelSpanLike | undefined {
        return (api.current as FakeContext).getValue(SPAN_KEY) as OtelSpanLike | undefined;
      },
      getSpanContext(ctx): OtelSpanContextLike | undefined {
        const span = (ctx as FakeContext).getValue(SPAN_KEY) as OtelSpanLike | undefined;
        return span?.spanContext();
      },
      setSpanContext(ctx, sc): OtelContextLike {
        // Wrap into a non-recording span and stash on the context.
        const span = api.trace.wrapSpanContext(sc);
        return (ctx as FakeContext).setValue(SPAN_KEY, span);
      },
      wrapSpanContext(sc): OtelSpanLike {
        return {
          spanContext: () => sc,
          setAttribute(): OtelSpanLike { return this; },
          setStatus(): OtelSpanLike { return this; },
          recordException(): void { /* noop on remote-wrapped */ },
          end(): void { /* noop */ },
          isRecording: () => false,
        };
      },
    },

    context: {
      active: () => api.current,
      with<F extends (...args: never[]) => unknown>(ctx: OtelContextLike, fn: F): ReturnType<F> {
        const prev = api.current;
        api.current = ctx as FakeContext;
        try { return fn() as ReturnType<F>; } finally { api.current = prev; }
      },
      ROOT_CONTEXT: ROOT,
    },

    propagation: {
      // W3C-Trace-Context-style inject — write `traceparent` (and `tracestate`
      // if present) using the framework's existing encoder.  When there's no
      // span on the context, write nothing.
      inject(ctx, carrier): void {
        const span = (ctx as FakeContext).getValue(SPAN_KEY) as OtelSpanLike | undefined;
        if (!span) return;
        const sc = span.spanContext();
        carrier['traceparent'] = encodeTraceparent({
          traceId: sc.traceId, spanId: sc.spanId, traceFlags: sc.traceFlags,
        });
        if (sc.traceState) carrier['tracestate'] = sc.traceState;
      },
      extract(ctx, carrier): OtelContextLike {
        const tp = carrier['traceparent'];
        if (!tp) return ctx;
        const decoded = decodeTraceparent(tp);
        if (!decoded) return ctx;
        const sc: OtelSpanContextLike = {
          traceId: decoded.traceId,
          spanId: decoded.spanId,
          traceFlags: decoded.traceFlags,
          ...(carrier['tracestate'] ? { traceState: carrier['tracestate'] } : {}),
          isRemote: true,
        };
        return api.trace.setSpanContext(ctx, sc);
      },
    },
  };

  function startSpan(
    name: string,
    options?: { kind?: number; attributes?: Record<string, unknown>; startTime?: number; root?: boolean },
    ctx?: OtelContextLike,
  ): OtelSpanLike {
    const useCtx = ctx ?? api.current;
    const parentSpan = !options?.root
      ? ((useCtx as FakeContext).getValue(SPAN_KEY) as OtelSpanLike | undefined)
      : undefined;
    const parentCtx = parentSpan?.spanContext();
    const traceId = parentCtx?.traceId ?? newTraceId();
    const spanId = newSpanId();
    const flags = parentCtx?.traceFlags ?? 1;
    const record: FakeRecordedSpan = {
      name,
      ...(options?.kind !== undefined ? { kind: options.kind } : {}),
      attrs: { ...(options?.attributes ?? {}) },
      ...(options?.startTime !== undefined ? { startTime: options.startTime } : {}),
      exceptions: [],
      ...(parentCtx ? { parentTraceId: parentCtx.traceId, parentSpanId: parentCtx.spanId } : {}),
      ctx: { traceId, spanId, traceFlags: flags },
      ended: false,
    };
    recorded.push(record);
    return makeFakeSpan(record);
  }

  return api;
}

describe('otelTracer', () => {
  test('startSpan records name, kind, attributes; end propagates', () => {
    const api = makeFakeOtelApi();
    const otelOptions = OtelAdapterOptions.create()
      .withApi(api);
    const tracer = otelTracer(otelOptions);

    const span = tracer.startSpan('handle.message', {
      kind: 'consumer',
      attributes: { 'app.kind': 'demo' },
    });
    span.setAttribute('msg.size', 32);
    span.setStatus('ok');
    span.end();

    expect(api.recorded).toHaveLength(1);
    const recorded = api.recorded[0]!;
    expect(recorded.name).toBe('handle.message');
    expect(recorded.kind).toBe(api.SpanKind.CONSUMER);
    expect(recorded.attrs).toEqual({ 'app.kind': 'demo', 'msg.size': 32 });
    expect(recorded.status).toEqual({ code: api.SpanStatusCode.OK });
    expect(recorded.ended).toBe(true);
  });

  test('end() is idempotent and silences subsequent attribute writes', () => {
    const api = makeFakeOtelApi();
    const otelOptions = OtelAdapterOptions.create()
      .withApi(api);
    const tracer = otelTracer(otelOptions);
    const span = tracer.startSpan('once');
    span.end();
    span.setAttribute('after-end', 1);
    span.end();
    const recorded = api.recorded[0]!;
    expect(recorded.attrs['after-end']).toBeUndefined();
    expect(span.ended).toBe(true);
  });

  test('withActiveSpan + activeSpan thread the OTel context', () => {
    const api = makeFakeOtelApi();
    const otelOptions = OtelAdapterOptions.create()
      .withApi(api);
    const tracer = otelTracer(otelOptions);
    const outer = tracer.startSpan('outer');

    const inner = tracer.withActiveSpan(outer, () => {
      const activeSpan = tracer.activeSpan();
      expect(activeSpan).not.toBeNull();
      expect(activeSpan!.context().traceId).toBe(outer.context().traceId);
      expect(activeSpan!.context().spanId).toBe(outer.context().spanId);
      // Child span started inside `withActiveSpan` should see the
      // outer span as its parent — same trace, different spanId.
      const child = tracer.startSpan('inner');
      return child;
    });

    const childRec = api.recorded.find((recorded) => recorded.name === 'inner')!;
    const outerCtx = outer.context();
    expect(childRec.parentTraceId).toBe(outerCtx.traceId);
    expect(childRec.parentSpanId).toBe(outerCtx.spanId);
    inner.end();
    outer.end();
    expect(tracer.activeSpan()).toBeNull();
  });

  test('explicit parent: SpanContext carrier produces a child in the same trace', () => {
    const api = makeFakeOtelApi();
    const otelOptions = OtelAdapterOptions.create()
      .withApi(api);
    const tracer = otelTracer(otelOptions);
    const parentCtx = { traceId: '0123456789abcdef0123456789abcdef', spanId: '0123456789abcdef', traceFlags: 1 };
    const child = tracer.startSpan('child', { parent: parentCtx });
    const recorded = api.recorded[0]!;
    expect(recorded.parentTraceId).toBe(parentCtx.traceId);
    expect(recorded.parentSpanId).toBe(parentCtx.spanId);
    expect(child.context().traceId).toBe(parentCtx.traceId);
  });

  test('explicit parent: null forces a fresh root', () => {
    const api = makeFakeOtelApi();
    const otelOptions = OtelAdapterOptions.create()
      .withApi(api);
    const tracer = otelTracer(otelOptions);

    const outer = tracer.startSpan('outer');
    tracer.withActiveSpan(outer, () => {
      const root = tracer.startSpan('root', { parent: null });
      // Recorded span should have no parent (we passed root: true to fake
      // startSpan which skips parent inheritance).
      const recorded = api.recorded.find((x) => x.name === 'root')!;
      expect(recorded.parentTraceId).toBeUndefined();
      expect(recorded.parentSpanId).toBeUndefined();
      // And it's in a different trace than `outer`.
      expect(root.context().traceId).not.toBe(outer.context().traceId);
      root.end();
    });
    outer.end();
  });

  test('injectContext returns null when no active span; W3C traceparent when active', () => {
    const api = makeFakeOtelApi();
    const otelOptions = OtelAdapterOptions.create()
      .withApi(api);
    const tracer = otelTracer(otelOptions);

    expect(tracer.injectContext()).toBeNull();
    const span = tracer.startSpan('outer');
    tracer.withActiveSpan(span, () => {
      const carrier = tracer.injectContext();
      expect(carrier).not.toBeNull();
      const tp = carrier!.traceparent;
      // 00-<32hex>-<16hex>-<2hex>
      expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
      const decoded = decodeTraceparent(tp)!;
      expect(decoded.traceId).toBe(span.context().traceId);
      expect(decoded.spanId).toBe(span.context().spanId);
    });
    span.end();
  });

  test('extractContext: round-trip a remote traceparent through the adapter', () => {
    const api = makeFakeOtelApi();
    const otelOptions = OtelAdapterOptions.create()
      .withApi(api);
    const tracer = otelTracer(otelOptions);

    const remoteTraceId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const remoteSpanId = 'bbbbbbbbbbbbbbbb';
    const tp = `00-${remoteTraceId}-${remoteSpanId}-01`;

    const sc = tracer.extractContext({ traceparent: tp });
    expect(sc).not.toBeNull();
    expect(sc!.traceId).toBe(remoteTraceId);
    expect(sc!.spanId).toBe(remoteSpanId);
    expect(sc!.traceFlags).toBe(1);

    // Use the extracted context as parent — child inherits the trace id.
    const child = tracer.startSpan('handle.envelope', { parent: sc! });
    expect(child.context().traceId).toBe(remoteTraceId);
    child.end();
  });

  test('extractContext: malformed input returns null', () => {
    const api = makeFakeOtelApi();
    const otelOptions = OtelAdapterOptions.create()
      .withApi(api);
    const tracer = otelTracer(otelOptions);
    expect(tracer.extractContext({ traceparent: 'garbage' })).toBeNull();
    expect(tracer.extractContext(null)).toBeNull();
  });

  test('span.recordException routes to OTel span', () => {
    const api = makeFakeOtelApi();
    const otelOptions = OtelAdapterOptions.create()
      .withApi(api);
    const tracer = otelTracer(otelOptions);
    const span = tracer.startSpan('boom');
    const err = new Error('fail');
    span.recordException(err);
    span.end();
    expect(api.recorded[0]!.exceptions).toEqual([err]);
  });

  test('cross-wire propagation chain: A injects, B extracts → child trace lines up', () => {
    const api = makeFakeOtelApi();
    const otelOptions = OtelAdapterOptions.create()
      .withApi(api);
    const tracer = otelTracer(otelOptions);

    // Side A: start span, inject.
    const aSpan = tracer.startSpan('a.send');
    let carrier = null as null | { traceparent: string };
    tracer.withActiveSpan(aSpan, () => {
      carrier = tracer.injectContext();
    });
    aSpan.end();
    expect(carrier).not.toBeNull();

    // Side B: extract, start child.
    const remoteCtx = tracer.extractContext(carrier);
    expect(remoteCtx).not.toBeNull();
    const bSpan = tracer.startSpan('b.receive', { parent: remoteCtx! });
    bSpan.end();

    expect(bSpan.context().traceId).toBe(aSpan.context().traceId);
    const bRec = api.recorded.find((recorded) => recorded.name === 'b.receive')!;
    expect(bRec.parentSpanId).toBe(aSpan.context().spanId);
  });

  test('setStatus translates ok/error to OTel SpanStatusCode', () => {
    const api = makeFakeOtelApi();
    const otelOptions = OtelAdapterOptions.create()
      .withApi(api);
    const tracer = otelTracer(otelOptions);
    const okSpan = tracer.startSpan('ok-span');
    okSpan.setStatus('ok');
    okSpan.end();
    const errSpan = tracer.startSpan('err-span');
    errSpan.setStatus('error', 'something went bad');
    errSpan.end();
    expect(api.recorded[0]!.status).toEqual({ code: api.SpanStatusCode.OK });
    expect(api.recorded[1]!.status).toEqual({
      code: api.SpanStatusCode.ERROR,
      message: 'something went bad',
    });
  });

  test('setAttribute after end() is silently dropped', () => {
    const api = makeFakeOtelApi();
    const otelOptions = OtelAdapterOptions.create()
      .withApi(api);
    const tracer = otelTracer(otelOptions);
    const span = tracer.startSpan('x');
    span.setAttribute('before', 1);
    span.end();
    span.setAttribute('after', 2);
    expect(api.recorded[0]!.attrs).toEqual({ before: 1 });
  });

  test('setStatus after end() is silently dropped', () => {
    const api = makeFakeOtelApi();
    const otelOptions = OtelAdapterOptions.create()
      .withApi(api);
    const tracer = otelTracer(otelOptions);
    const span = tracer.startSpan('x');
    span.end();
    span.setStatus('error', 'too late');
    expect(api.recorded[0]!.status).toBeUndefined();
  });

  test('recordException after end() is silently dropped', () => {
    const api = makeFakeOtelApi();
    const otelOptions = OtelAdapterOptions.create()
      .withApi(api);
    const tracer = otelTracer(otelOptions);
    const span = tracer.startSpan('x');
    span.end();
    span.recordException(new Error('after-end'));
    expect(api.recorded[0]!.exceptions).toEqual([]);
  });

  test('startSpan startTime option is forwarded to OTel', () => {
    const api = makeFakeOtelApi();
    const otelOptions = OtelAdapterOptions.create()
      .withApi(api);
    const tracer = otelTracer(otelOptions);
    const t0 = Date.now() - 5000;
    const span = tracer.startSpan('back-dated', { startTimeMs: t0 });
    span.end();
    expect(api.recorded[0]!.startTime).toBe(t0);
  });

  test('end() with an explicit endTime forwards it to OTel', () => {
    const api = makeFakeOtelApi();
    const otelOptions = OtelAdapterOptions.create()
      .withApi(api);
    const tracer = otelTracer(otelOptions);
    const span = tracer.startSpan('x');
    const t1 = Date.now() + 5000;
    span.end(t1);
    expect(api.recorded[0]!.endTime).toBe(t1);
  });

  test('withActiveSpan on a foreign span (not produced by this tracer) degrades to running fn', () => {
    const api = makeFakeOtelApi();
    const otelOptions = OtelAdapterOptions.create()
      .withApi(api);
    const tracer = otelTracer(otelOptions);
    // Hand-craft a Span that the WeakMap will not find.
    const foreign = {
      context: () => ({ traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 0 }),
      setAttribute: () => foreign,
      setStatus: () => foreign,
      recordException: () => foreign,
      end: () => {},
      get ended() { return false; },
    };
    let ran = false;
    const out = tracer.withActiveSpan(foreign as unknown as ReturnType<typeof tracer.startSpan>, () => {
      ran = true;
      return 42;
    });
    expect(ran).toBe(true);
    expect(out).toBe(42);
  });

  test('all SpanKinds map to OTel SpanKind correctly', () => {
    const api = makeFakeOtelApi();
    const otelOptions = OtelAdapterOptions.create()
      .withApi(api);
    const tracer = otelTracer(otelOptions);
    const kinds = ['internal', 'server', 'client', 'producer', 'consumer'] as const;
    for (const key of kinds) {
      const span = tracer.startSpan(`span-${key}`, { kind: key });
      span.end();
    }
    expect(api.recorded.map(recorded => recorded.kind)).toEqual([
      api.SpanKind.INTERNAL,
      api.SpanKind.SERVER,
      api.SpanKind.CLIENT,
      api.SpanKind.PRODUCER,
      api.SpanKind.CONSUMER,
    ]);
  });

  test('user-supplied tracer wins over the auto-resolved one', () => {
    const api = makeFakeOtelApi();
    let userTracerCalls = 0;
    const userTracer = {
      startSpan(name: string): OtelSpanLike {
        userTracerCalls++;
        return {
          spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }),
          setAttribute: function (): OtelSpanLike { return this; },
          setStatus: function (): OtelSpanLike { return this; },
          recordException: (): void => {},
          end: (): void => {},
          isRecording: (): boolean => true,
        };
      },
    };
    const otelOptions = OtelAdapterOptions.create()
      .withApi(api)
      .withTracer(userTracer);
    const tracer = otelTracer(otelOptions);
    const span = tracer.startSpan('via-user-tracer');
    span.end();
    expect(userTracerCalls).toBe(1);
    // The api's internal recorded array is bypassed — user tracer
    // produced the span, not api.trace.getTracer.
    expect(api.recorded.length).toBe(0);
  });
});
