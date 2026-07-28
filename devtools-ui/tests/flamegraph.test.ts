import { describe, expect, test } from 'bun:test';
import {
  durationOf,
  groupByTrace,
  hitTest,
  layoutRectangles,
  layoutTrace,
  spanColorIndex,
} from '../src/render/flamegraph.js';
import type { WireSpan } from '../../src/devtools/protocol/index.js';

function span(
  spanId: string,
  parentSpanId: string | null,
  startHighResolutionMs: number,
  endHighResolutionMs: number,
  overrides: Partial<WireSpan> = {},
): WireSpan {
  return {
    name: `span-${spanId}`,
    spanKind: 'internal',
    senderPath: null,
    messagePayload: null,
    traceId: 'trace-1',
    spanId,
    parentSpanId,
    startMs: 1_000 + startHighResolutionMs,
    endMs: 1_000 + endHighResolutionMs,
    startHighResolutionMs,
    endHighResolutionMs,
    status: 'ok',
    statusMessage: null,
    attributes: {},
    actorPath: null,
    messageType: null,
    exceptions: [],
    ...overrides,
  };
}

describe('durationOf', () => {
  test('prefers the monotonic clock', () => {
    expect(durationOf(span('a', null, 10, 10.4))).toBeCloseTo(0.4, 5);
  });

  test('falls back to wall clock when there is no monotonic pair', () => {
    const wallOnly = span('a', null, 0, 0, {
      startHighResolutionMs: null,
      endHighResolutionMs: null,
      startMs: 1_000,
      endMs: 1_007,
    });
    expect(durationOf(wallOnly)).toBe(7);
  });

  test('never reports a negative duration', () => {
    expect(durationOf(span('a', null, 10, 5))).toBe(0);
  });
});

describe('layoutTrace', () => {
  test('is empty for no spans', () => {
    const layout = layoutTrace([]);
    expect(layout.spans).toEqual([]);
    expect(layout.totalMs).toBe(0);
  });

  test('assigns stack depth from the parent chain', () => {
    const layout = layoutTrace([
      span('root', null, 0, 10),
      span('child', 'root', 1, 6),
      span('grandchild', 'child', 2, 4),
    ]);
    const depths = Object.fromEntries(layout.spans.map((e) => [e.span.spanId, e.depth]));
    expect(depths).toEqual({ root: 0, child: 1, grandchild: 2 });
    expect(layout.maxDepth).toBe(2);
  });

  test('normalises times to the start of the trace', () => {
    const layout = layoutTrace([
      span('root', null, 500, 510),
      span('child', 'root', 502, 505),
    ]);
    const root = layout.spans.find((e) => e.span.spanId === 'root')!;
    const child = layout.spans.find((e) => e.span.spanId === 'child')!;
    expect(root.startMs).toBe(0);
    expect(child.startMs).toBe(2);
    expect(layout.totalMs).toBe(10);
  });

  test('treats a span whose parent is missing as a root', () => {
    // The parent may not have ended yet, or was dropped under
    // backpressure — hiding the child would lose the interesting work.
    const layout = layoutTrace([span('orphan', 'vanished', 0, 5)]);
    expect(layout.spans[0]!.depth).toBe(0);
  });

  test('computes self time by subtracting children', () => {
    const layout = layoutTrace([
      span('root', null, 0, 10),
      span('a', 'root', 0, 3),
      span('b', 'root', 3, 7),
    ]);
    // 10 total minus 3 + 4 spent in children.
    expect(layout.spans.find((e) => e.span.spanId === 'root')!.selfMs).toBe(3);
    expect(layout.spans.find((e) => e.span.spanId === 'a')!.selfMs).toBe(3);
  });

  test('clamps self time at zero when children overrun their parent', () => {
    const layout = layoutTrace([
      span('root', null, 0, 5),
      span('long-child', 'root', 0, 20),
    ]);
    expect(layout.spans.find((e) => e.span.spanId === 'root')!.selfMs).toBe(0);
  });

  test('survives a cyclic parent link instead of hanging', () => {
    // Ids come off the wire; a malformed trace must not lock the panel.
    const layout = layoutTrace([
      span('a', 'b', 0, 5),
      span('b', 'a', 0, 5),
    ]);
    expect(layout.spans).toHaveLength(2);
    expect(layout.spans.every((e) => Number.isFinite(e.depth))).toBe(true);
  });

  test('orders by start time, then by depth', () => {
    const layout = layoutTrace([
      span('child', 'root', 5, 6),
      span('root', null, 0, 10),
    ]);
    expect(layout.spans.map((e) => e.span.spanId)).toEqual(['root', 'child']);
  });
});

describe('groupByTrace', () => {
  test('splits spans by trace and puts the newest first', () => {
    const older = { ...span('x', null, 0, 1), traceId: 'old', startMs: 1_000 };
    const newer = { ...span('y', null, 0, 1), traceId: 'new', startMs: 5_000 };
    const traces = groupByTrace([older, newer]);
    expect(traces.map((t) => t.traceId)).toEqual(['new', 'old']);
  });
});

describe('layoutRectangles', () => {
  const trace = layoutTrace([
    span('root', null, 0, 10),
    span('child', 'root', 5, 10),
  ]);

  test('scales spans across the available width', () => {
    const rectangles = layoutRectangles(trace, 100, (entry) => entry.depth);
    const root = rectangles.find((r) => r.span.span.spanId === 'root')!;
    const child = rectangles.find((r) => r.span.span.spanId === 'child')!;
    expect(root.x).toBe(0);
    expect(root.width).toBe(100);
    expect(child.x).toBe(50);
    expect(child.width).toBe(50);
  });

  test('stacks by depth for a flame graph', () => {
    const rectangles = layoutRectangles(trace, 100, (entry) => entry.depth);
    const root = rectangles.find((r) => r.span.span.spanId === 'root')!;
    const child = rectangles.find((r) => r.span.span.spanId === 'child')!;
    expect(child.y).toBeGreaterThan(root.y);
  });

  test('gives one row per span for a waterfall', () => {
    const rectangles = layoutRectangles(trace, 100, (_entry, index) => index);
    expect(new Set(rectangles.map((r) => r.y)).size).toBe(2);
  });

  test('keeps a sub-pixel span visible and clickable', () => {
    const tiny = layoutTrace([span('root', null, 0, 1_000), span('blip', 'root', 0, 0.001)]);
    const rectangles = layoutRectangles(tiny, 100, (entry) => entry.depth);
    expect(rectangles.find((r) => r.span.span.spanId === 'blip')!.width).toBe(1);
  });

  test('does not divide by zero for an instantaneous trace', () => {
    const instant = layoutTrace([span('root', null, 5, 5)]);
    const rectangles = layoutRectangles(instant, 100, () => 0);
    expect(Number.isFinite(rectangles[0]!.x)).toBe(true);
    expect(Number.isFinite(rectangles[0]!.width)).toBe(true);
  });
});

describe('hitTest', () => {
  const trace = layoutTrace([span('root', null, 0, 10), span('child', 'root', 5, 10)]);
  const rectangles = layoutRectangles(trace, 100, (entry) => entry.depth);

  test('finds the span under the point', () => {
    expect(hitTest(rectangles, 10, 5)?.span.span.spanId).toBe('root');
  });

  test('prefers the rectangle drawn last where they overlap', () => {
    expect(hitTest(rectangles, 60, 25)?.span.span.spanId).toBe('child');
  });

  test('returns null outside every rectangle', () => {
    expect(hitTest(rectangles, 10, 500)).toBeNull();
  });
});

describe('spanColorIndex', () => {
  test('is stable for the same name, so colours do not shuffle', () => {
    // Different spans, different traces, same operation name.
    const first = spanColorIndex({ ...span('a', null, 0, 1), name: 'actor.receive' });
    const second = spanColorIndex({
      ...span('b', null, 40, 41), name: 'actor.receive', traceId: 'other',
    });
    expect(first).toBe(second);
  });

  test('gives different operations different colours', () => {
    const receive = spanColorIndex({ ...span('a', null, 0, 1), name: 'actor.receive' });
    const envelope = spanColorIndex({ ...span('b', null, 0, 1), name: 'cluster.envelope.received' });
    expect(receive).not.toBe(envelope);
  });

  test('stays inside the categorical ramp', () => {
    for (const name of ['a', 'bb', 'actor.receive', 'cluster.envelope.received']) {
      const index = spanColorIndex({ ...span('x', null, 0, 1), name });
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(8);
    }
  });

  test('marks an error span regardless of its name', () => {
    expect(spanColorIndex({ ...span('x', null, 0, 1), status: 'error' })).toBe(-1);
  });
});
