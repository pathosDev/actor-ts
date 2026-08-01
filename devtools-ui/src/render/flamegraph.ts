/**
 * Trace layout and flame-graph rendering.
 *
 * Two views over the same spans, because they answer different
 * questions.  A **waterfall** keeps every span on its own row in time
 * order — "what happened, and when?".  A **flame graph** stacks
 * children on their parent — "where did the time go?".  Both come from
 * the same `layoutTrace` call; only the drawing differs.
 *
 * The layout is a pure function so the part that is easy to get subtly
 * wrong — nesting, self time, clamping a child that outlives its
 * parent — is testable without a canvas.
 */
import type { WireSpan } from '../../../src/devtools/protocol/index.js';

/** A span placed in the layout. */
export type LayoutSpan = {
  readonly span: WireSpan;
  /** Stack depth; a root is 0. */
  readonly depth: number;
  /** Milliseconds from the start of the trace. */
  readonly startMs: number;
  readonly durationMs: number;
  /** Duration minus time accounted for by children — the flame's point. */
  readonly selfMs: number;
};

/** A whole trace, laid out. */
export type TraceLayout = {
  readonly traceId: string;
  readonly spans: ReadonlyArray<LayoutSpan>;
  /** Wall time from the first span's start to the last one's end. */
  readonly totalMs: number;
  readonly startedAtMs: number;
  readonly maxDepth: number;
};

/**
 * Duration of one span, preferring the monotonic clock.
 *
 * Wall-clock milliseconds are too coarse here: an actor message
 * routinely completes inside one, which would make every bar
 * zero-width and the graph useless.
 */
export function durationOf(span: WireSpan): number {
  if (span.startHighResolutionMs !== null && span.endHighResolutionMs !== null) {
    return Math.max(span.endHighResolutionMs - span.startHighResolutionMs, 0);
  }
  return Math.max(span.endMs - span.startMs, 0);
}

/** Start of one span on whichever clock `durationOf` used. */
function startOf(span: WireSpan): number {
  return span.startHighResolutionMs ?? span.startMs;
}

/** Group spans by trace, newest trace first. */
export function groupByTrace(spans: ReadonlyArray<WireSpan>): ReadonlyArray<TraceLayout> {
  const byTrace = new Map<string, WireSpan[]>();
  for (const span of spans) {
    const bucket = byTrace.get(span.traceId);
    if (bucket === undefined) byTrace.set(span.traceId, [span]);
    else bucket.push(span);
  }
  return [...byTrace.values()]
    .map((group) => layoutTrace(group))
    .sort((a, b) => b.startedAtMs - a.startedAtMs);
}

/**
 * Lay out one trace: assign depths, normalise times to the trace start,
 * and compute self time.
 *
 * A span whose parent is missing from the batch is treated as a root.
 * The parent may simply not have ended yet, or may have been dropped
 * under backpressure — either way, hiding the child would lose the very
 * work the developer is looking for.
 */
export function layoutTrace(spans: ReadonlyArray<WireSpan>): TraceLayout {
  if (spans.length === 0) {
    return { traceId: '', spans: [], totalMs: 0, startedAtMs: 0, maxDepth: 0 };
  }

  const bySpanId = new Map(spans.map((span) => [span.spanId, span]));
  const origin = Math.min(...spans.map(startOf));
  const wallOrigin = Math.min(...spans.map((span) => span.startMs));

  const depthCache = new Map<string, number>();
  const depthOf = (span: WireSpan, seen: Set<string>): number => {
    const cached = depthCache.get(span.spanId);
    if (cached !== undefined) return cached;
    const parentId = span.parentSpanId;
    // `seen` guards against a cycle: ids come off the wire, and a
    // malformed trace must not hang the panel.
    if (parentId === null || !bySpanId.has(parentId) || seen.has(parentId)) {
      depthCache.set(span.spanId, 0);
      return 0;
    }
    seen.add(span.spanId);
    const depth = depthOf(bySpanId.get(parentId)!, seen) + 1;
    depthCache.set(span.spanId, depth);
    return depth;
  };

  // Children's time, summed per parent, for the self-time subtraction.
  const childMsByParent = new Map<string, number>();
  for (const span of spans) {
    const parentId = span.parentSpanId;
    if (parentId === null || !bySpanId.has(parentId)) continue;
    childMsByParent.set(parentId, (childMsByParent.get(parentId) ?? 0) + durationOf(span));
  }

  const laid: LayoutSpan[] = spans.map((span) => {
    const durationMs = durationOf(span);
    return {
      span,
      depth: depthOf(span, new Set()),
      startMs: startOf(span) - origin,
      durationMs,
      // Children can overrun a parent when clocks or clamping disagree;
      // negative self time would render as a bar pointing backwards.
      selfMs: Math.max(durationMs - (childMsByParent.get(span.spanId) ?? 0), 0),
    };
  });

  laid.sort((a, b) => a.startMs - b.startMs || a.depth - b.depth);
  const totalMs = Math.max(...laid.map((entry) => entry.startMs + entry.durationMs), 0);

  return {
    traceId: spans[0]!.traceId,
    spans: laid,
    totalMs,
    startedAtMs: wallOrigin,
    maxDepth: Math.max(...laid.map((entry) => entry.depth), 0),
  };
}

/** A drawn rectangle, kept so a hit test can find what was clicked. */
export type SpanRectangle = {
  readonly span: LayoutSpan;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** Vertical space one row occupies, in CSS pixels. */
export const ROW_HEIGHT = 20;

/**
 * Place every span as a rectangle.
 *
 * `rowOf` decides the vertical position, which is the only difference
 * between the two views: stacking by depth gives a flame graph, one row
 * per span in time order gives a waterfall.
 */
export function layoutRectangles(
  trace: TraceLayout,
  width: number,
  rowOf: (entry: LayoutSpan, index: number) => number,
): ReadonlyArray<SpanRectangle> {
  const scale = trace.totalMs > 0 ? width / trace.totalMs : 0;
  return trace.spans.map((entry, index) => ({
    span: entry,
    x: entry.startMs * scale,
    // A sub-pixel span still has to be visible and clickable.
    width: Math.max(entry.durationMs * scale, 1),
    y: rowOf(entry, index) * ROW_HEIGHT,
    height: ROW_HEIGHT - 2,
  }));
}

/** Topmost rectangle covering the point, or `null`. */
export function hitTest(
  rectangles: ReadonlyArray<SpanRectangle>,
  x: number,
  y: number,
): SpanRectangle | null {
  // Last match wins: later rectangles are drawn on top.
  let found: SpanRectangle | null = null;
  for (const rectangle of rectangles) {
    if (x >= rectangle.x && x <= rectangle.x + rectangle.width
      && y >= rectangle.y && y <= rectangle.y + rectangle.height) {
      found = rectangle;
    }
  }
  return found;
}

/**
 * Stable colour for a span.
 *
 * Hashed from the name so the same operation keeps its colour across
 * redraws and between traces — a flame graph whose colours shuffle on
 * every frame is unreadable.  Error spans override, because status
 * matters more than identity.
 */
export function spanColorIndex(span: WireSpan): number {
  if (span.status === 'error') return -1;
  let hash = 0;
  for (let i = 0; i < span.name.length; i++) {
    hash = (hash * 31 + span.name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 8;
}
