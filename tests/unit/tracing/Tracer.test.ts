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
    const t = new RecordingTracer();
    const root = t.startSpan('root');
    const child = t.withActiveSpan(root, () => t.startSpan('child'));
    expect(child.context().traceId).toBe(root.context().traceId);
    expect(child.context().spanId).not.toBe(root.context().spanId);
    root.end();
    child.end();
    const recorded = t.recorded();
    expect(recorded).toHaveLength(2);
  });

  test('explicit parent: null forces a fresh root even with an active span', () => {
    const t = new RecordingTracer();
    const outer = t.startSpan('outer');
    const detached = t.withActiveSpan(outer, () => t.startSpan('detached', { parent: null }));
    expect(detached.context().traceId).not.toBe(outer.context().traceId);
  });

  test('explicit parent SpanContext overrides the active span', () => {
    const t = new RecordingTracer();
    const a = t.startSpan('a');
    const b = t.startSpan('b');
    const child = t.withActiveSpan(a, () => t.startSpan('child', { parent: b.context() }));
    expect(child.context().traceId).toBe(b.context().traceId);
  });
});

describe('RecordingTracer — async propagation', () => {
  test('active span is preserved across await boundaries', async () => {
    const t = new RecordingTracer();
    const root = t.startSpan('root');
    const observed = await t.withActiveSpan(root, async () => {
      await Bun.sleep(5);
      return t.activeSpan()?.context().spanId;
    });
    expect(observed).toBe(root.context().spanId);
    root.end();
  });
});

describe('RecordingTracer — recording', () => {
  test('attributes / status / exception are captured', () => {
    const t = new RecordingTracer();
    const s = t.startSpan('work', { attributes: { 'k1': 'v1' } });
    s.setAttribute('k2', 42);
    s.setStatus('error', 'boom');
    s.recordException(new Error('explosion'));
    s.end();
    const rec = t.recorded()[0]!;
    expect(rec.attributes['k1']).toBe('v1');
    expect(rec.attributes['k2']).toBe(42);
    expect(rec.status).toBe('error');
    expect(rec.statusMessage).toBe('boom');
    expect(rec.exceptions[0]?.message).toBe('explosion');
  });

  test('end() is idempotent — second call does not double-record', () => {
    const t = new RecordingTracer();
    const s = t.startSpan('x');
    s.end();
    s.end();
    expect(t.recorded()).toHaveLength(1);
  });

  test('onSpanEnd hook fires once per ended span', () => {
    const ended: string[] = [];
    const t = new RecordingTracer({ onSpanEnd: (s) => ended.push(s.name) });
    t.startSpan('a').end();
    t.startSpan('b').end();
    expect(ended).toEqual(['a', 'b']);
  });

  test('reset() clears the recording but does not interfere with in-flight spans', () => {
    const t = new RecordingTracer();
    const s = t.startSpan('x');
    t.startSpan('y').end();
    t.reset();
    expect(t.recorded()).toEqual([]);
    s.end();
    // s ends after reset, so it shows up in the post-reset recording.
    expect(t.recorded()).toHaveLength(1);
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
    const t = new NoopTracer();
    const s = t.startSpan('x');
    s.setAttribute('k', 'v').setStatus('ok').recordException(new Error('e')).end();
    expect(t.activeSpan()).toBeNull();
    expect(t.injectContext()).toBeNull();
    expect(t.extractContext({ traceparent: '00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01' }))
      .toBeNull();
  });
});
