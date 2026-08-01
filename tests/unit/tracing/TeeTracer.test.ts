import { describe, expect, test } from 'bun:test';
import { RecordingTracer, type RecordedSpan } from '../../../src/tracing/RecordingTracer.js';
import { TeeTracer } from '../../../src/tracing/TeeTracer.js';

function tee(): { inner: RecordingTracer; tracer: TeeTracer; observed: RecordedSpan[] } {
  const inner = new RecordingTracer();
  const observed: RecordedSpan[] = [];
  return { inner, tracer: new TeeTracer(inner, (span) => observed.push(span)), observed };
}

describe('TeeTracer', () => {
  test('the inner tracer still records everything', () => {
    const { inner, tracer } = tee();
    tracer.startSpan('work').end();
    expect(inner.recorded().map((span) => span.name)).toEqual(['work']);
  });

  test('the observer sees the same span', () => {
    const { tracer, observed } = tee();
    tracer.startSpan('work', { kind: 'consumer' }).end();
    expect(observed).toHaveLength(1);
    expect(observed[0]!.name).toBe('work');
    expect(observed[0]!.kind).toBe('consumer');
  });

  test('both sides agree on the span context', () => {
    const { inner, tracer, observed } = tee();
    tracer.startSpan('work').end();
    expect(observed[0]!.context.spanId).toBe(inner.recorded()[0]!.context.spanId);
    expect(observed[0]!.context.traceId).toBe(inner.recorded()[0]!.context.traceId);
  });

  test('attributes, status and exceptions reach the observer', () => {
    const { tracer, observed } = tee();
    const span = tracer.startSpan('work');
    span.setAttribute('actor.path', '/user/a');
    span.setStatus('error', 'it broke');
    span.recordException(new Error('boom'));
    span.end();

    expect(observed[0]!.attributes['actor.path']).toBe('/user/a');
    expect(observed[0]!.status).toBe('error');
    expect(observed[0]!.statusMessage).toBe('it broke');
    expect(observed[0]!.exceptions.map((e) => e.message)).toEqual(['boom']);
  });

  test('the inner tracer receives the same attributes and status', () => {
    const { inner, tracer } = tee();
    const span = tracer.startSpan('work');
    span.setAttribute('k', 'v');
    span.setStatus('ok');
    span.end();
    expect(inner.recorded()[0]!.attributes['k']).toBe('v');
    expect(inner.recorded()[0]!.status).toBe('ok');
  });

  test('a nested span records its parent', () => {
    const { tracer, observed } = tee();
    const outer = tracer.startSpan('outer');
    tracer.withActiveSpan(outer, () => {
      tracer.startSpan('inner').end();
    });
    outer.end();

    const inner = observed.find((span) => span.name === 'inner')!;
    const outerRecorded = observed.find((span) => span.name === 'outer')!;
    expect(inner.parent?.spanId).toBe(outerRecorded.context.spanId);
    expect(inner.context.traceId).toBe(outerRecorded.context.traceId);
  });

  test('withActiveSpan unwraps, so the inner tracer sees its own span', () => {
    // Handing the wrapper to the inner tracer would make its
    // `activeSpan()` return something it never created.
    const { inner, tracer } = tee();
    const span = tracer.startSpan('outer');
    tracer.withActiveSpan(span, () => {
      expect(inner.activeSpan()).not.toBeNull();
      expect(inner.activeSpan()).toBe((span as unknown as { unwrap(): unknown }).unwrap() as never);
    });
    span.end();
  });

  test('carries high-resolution timestamps for the flame graph', () => {
    const { tracer, observed } = tee();
    tracer.startSpan('work').end();
    expect(observed[0]!.startHighResolutionMs).toBeGreaterThan(0);
    expect(observed[0]!.endHighResolutionMs)
      .toBeGreaterThanOrEqual(observed[0]!.startHighResolutionMs!);
  });

  test('omits high-resolution timestamps when the caller supplied its own', () => {
    // Pairing a chosen wall-clock instant with a monotonic reading taken
    // now would yield a duration matching neither.
    const { tracer, observed } = tee();
    tracer.startSpan('work', { startTimeMs: 1_000 }).end(2_000);
    expect(observed[0]!.startHighResolutionMs).toBeUndefined();
    expect(observed[0]!.endHighResolutionMs).toBeUndefined();
    expect(observed[0]!.endTimeMs - observed[0]!.startTimeMs).toBe(1_000);
  });

  test('ending twice reports once', () => {
    const { tracer, observed } = tee();
    const span = tracer.startSpan('work');
    span.end();
    span.end();
    expect(observed).toHaveLength(1);
  });

  test('an observer that throws does not break the traced code', () => {
    const inner = new RecordingTracer();
    const tracer = new TeeTracer(inner, () => { throw new Error('observer bug'); });
    expect(() => tracer.startSpan('work').end()).not.toThrow();
    expect(inner.recorded()).toHaveLength(1);
  });

  test('unwrap hands back the original tracer, so it can be restored', () => {
    const { inner, tracer } = tee();
    expect(tracer.unwrap()).toBe(inner);
  });

  test('context propagation is delegated', () => {
    const { tracer } = tee();
    const span = tracer.startSpan('work');
    tracer.withActiveSpan(span, () => {
      const carrier = tracer.injectContext();
      expect(carrier).not.toBeNull();
      expect(tracer.extractContext(carrier)?.traceId).toBe(span.context().traceId);
    });
    span.end();
  });
});

describe('RecordingTracer — bounded recording', () => {
  test('keeps every span when unbounded', () => {
    const tracer = new RecordingTracer();
    for (let i = 0; i < 50; i++) tracer.startSpan(`s${i}`).end();
    expect(tracer.recorded()).toHaveLength(50);
  });

  test('evicts the oldest once the cap is reached', () => {
    const tracer = new RecordingTracer({ maxRecorded: 3 });
    for (let i = 0; i < 10; i++) tracer.startSpan(`s${i}`).end();
    expect(tracer.recorded().map((span) => span.name)).toEqual(['s7', 's8', 's9']);
  });

  test('a cap of zero keeps nothing but still calls the hook', () => {
    const seen: string[] = [];
    const tracer = new RecordingTracer({ maxRecorded: 0, onSpanEnd: (s) => seen.push(s.name) });
    tracer.startSpan('a').end();
    tracer.startSpan('b').end();
    expect(tracer.recorded()).toHaveLength(0);
    expect(seen).toEqual(['a', 'b']);
  });

  test('records high-resolution timestamps by default', () => {
    const tracer = new RecordingTracer();
    tracer.startSpan('work').end();
    const span = tracer.recorded()[0]!;
    expect(span.startHighResolutionMs).toBeGreaterThan(0);
    expect(span.endHighResolutionMs).toBeGreaterThanOrEqual(span.startHighResolutionMs!);
  });
});
