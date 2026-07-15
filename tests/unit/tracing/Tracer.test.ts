/**
 * Unit tests for the Tracer primitives + W3C codec (#10).
 *
 *   - Span hierarchy: child inherits parent.traceId, gets fresh spanId.
 *   - Active-span tracking via AsyncLocalStorage; preserved across awaits.
 *   - W3C `traceparent` encode/decode round-trip and rejection of malformed.
 *   - Attribute / status / exception are captured on RecordedSpan.
 *   - NoopTracer produces nothing.
 */
import { describe, expect, test } from 'bun:test';
import { NoopTracer } from '../../../src/tracing/NoopTracer.js';
import { RecordingTracer } from '../../../src/tracing/RecordingTracer.js';
import {
  decodeTraceparent,
  encodeTraceparent,
} from '../../../src/tracing/Tracer.js';

describe('RecordingTracer — span hierarchy', () => {
  test('root span gets a fresh trace id, child shares it', () => {
    const tracer = new RecordingTracer();
    const root = tracer.startSpan('root');
    const child = tracer.withActiveSpan(root, () => tracer.startSpan('child'));
    expect(child.context().traceId).toBe(root.context().traceId);
    expect(child.context().spanId).not.toBe(root.context().spanId);
    root.end();
    child.end();
    const recorded = tracer.recorded();
    expect(recorded).toHaveLength(2);
  });

  test('explicit parent: null forces a fresh root even with an active span', () => {
    const tracer = new RecordingTracer();
    const outer = tracer.startSpan('outer');
    const detached = tracer.withActiveSpan(outer, () => tracer.startSpan('detached', { parent: null }));
    expect(detached.context().traceId).not.toBe(outer.context().traceId);
  });

  test('explicit parent SpanContext overrides the active span', () => {
    const tracer = new RecordingTracer();
    const spanA = tracer.startSpan('a');
    const spanB = tracer.startSpan('b');
    const child = tracer.withActiveSpan(spanA, () => tracer.startSpan('child', { parent: spanB.context() }));
    expect(child.context().traceId).toBe(spanB.context().traceId);
  });
});

describe('RecordingTracer — async propagation', () => {
  test('active span is preserved across await boundaries', async () => {
    const tracer = new RecordingTracer();
    const root = tracer.startSpan('root');
    const observed = await tracer.withActiveSpan(root, async () => {
      await Bun.sleep(5);
      return tracer.activeSpan()?.context().spanId;
    });
    expect(observed).toBe(root.context().spanId);
    root.end();
  });
});

describe('RecordingTracer — recording', () => {
  test('attributes / status / exception are captured', () => {
    const tracer = new RecordingTracer();
    const span = tracer.startSpan('work', { attributes: { 'k1': 'v1' } });
    span.setAttribute('k2', 42);
    span.setStatus('error', 'boom');
    span.recordException(new Error('explosion'));
    span.end();
    const rec = tracer.recorded()[0]!;
    expect(rec.attributes['k1']).toBe('v1');
    expect(rec.attributes['k2']).toBe(42);
    expect(rec.status).toBe('error');
    expect(rec.statusMessage).toBe('boom');
    expect(rec.exceptions[0]?.message).toBe('explosion');
  });

  test('end() is idempotent — second call does not double-record', () => {
    const tracer = new RecordingTracer();
    const span = tracer.startSpan('x');
    span.end();
    span.end();
    expect(tracer.recorded()).toHaveLength(1);
  });

  test('onSpanEnd hook fires once per ended span', () => {
    const ended: string[] = [];
    const tracer = new RecordingTracer({ onSpanEnd: (span) => ended.push(span.name) });
    tracer.startSpan('a').end();
    tracer.startSpan('b').end();
    expect(ended).toEqual(['a', 'b']);
  });

  test('reset() clears the recording but does not interfere with in-flight spans', () => {
    const tracer = new RecordingTracer();
    const span = tracer.startSpan('x');
    tracer.startSpan('y').end();
    tracer.reset();
    expect(tracer.recorded()).toEqual([]);
    span.end();
    // s ends after reset, so it shows up in the post-reset recording.
    expect(tracer.recorded()).toHaveLength(1);
  });
});

describe('W3C traceparent codec', () => {
  test('encode → decode round-trip', () => {
    const ctx = {
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '0123456789abcdef',
      traceFlags: 1,
    };
    const tp = encodeTraceparent(ctx);
    expect(tp).toBe('00-0123456789abcdef0123456789abcdef-0123456789abcdef-01');
    const back = decodeTraceparent(tp);
    expect(back).toEqual(ctx);
  });

  test('decode rejects malformed inputs', () => {
    expect(decodeTraceparent('')).toBeNull();
    expect(decodeTraceparent('00-bad')).toBeNull();
    expect(decodeTraceparent('00-X-Y-01')).toBeNull();
    expect(decodeTraceparent('01-0123456789abcdef0123456789abcdef-0123456789abcdef-01')).toBeNull();
    // All-zero traceId is invalid per spec.
    expect(decodeTraceparent('00-00000000000000000000000000000000-0123456789abcdef-01')).toBeNull();
    // All-zero spanId is invalid too.
    expect(decodeTraceparent('00-0123456789abcdef0123456789abcdef-0000000000000000-01')).toBeNull();
  });
});

describe('NoopTracer', () => {
  test('every operation is a no-op; no spans recorded', () => {
    const tracer = new NoopTracer();
    const span = tracer.startSpan('x');
    span.setAttribute('k', 'v').setStatus('ok').recordException(new Error('e')).end();
    expect(tracer.activeSpan()).toBeNull();
    expect(tracer.injectContext()).toBeNull();
    expect(tracer.extractContext({ traceparent: '00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01' }))
      .toBeNull();
  });
});
