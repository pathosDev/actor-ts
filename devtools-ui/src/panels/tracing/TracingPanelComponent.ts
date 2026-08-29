import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  afterRenderEffect,
  computed,
  inject,
  signal,
  viewChild,
  type ElementRef,
} from '@angular/core';

import { ChartThemeService } from '../../app/charts/ChartThemeService.js';
import { EChartComponent } from '../../app/charts/EChartComponent.js';
import type { DevToolsChartOption } from '../../app/charts/echartsModules.js';
import { buildRectanglesOption, NOMINAL_WIDTH, type ChartRectangle } from '../../app/charts/rectanglesOption.js';
import { TapClientService } from '../../app/TapClientService.js';
import { formatCount, formatTime, shortActorPath } from '../../core/format.js';
import {
  ROW_HEIGHT,
  groupByTrace,
  layoutRectangles,
  spanColorIndex,
  type LayoutSpan,
  type SpanRectangle,
  type TraceLayout,
} from '../../render/flamegraph.js';
import {
  TRACING_BUFFER_DEFAULT,
  type TracingBufferResult,
  type WireSpan,
} from '../../../../src/devtools/protocol/index.js';

/** Ring sizes the buffer selector offers, smallest first. */
const BUFFER_CHOICES: ReadonlyArray<number> = [100, 250, 500, 1_000, 2_500, 5_000, 10_000];

/** Traces listed at once — older ones are still counted, not drawn. */
const TRACE_ROWS = 200;

/** How the vertical axis is arranged. */
type ViewMode = 'flame' | 'waterfall';

/** One trace, reduced to the line a list can show. */
type TraceSummary = {
  /** `sender → actor → actor`, the hops the message actually made. */
  readonly route: string;
  readonly messageType: string;
  readonly payload: string | null;
};

/** A listed trace, with everything the row needs precomputed. */
type TraceRow = {
  readonly trace: TraceLayout;
  readonly summary: TraceSummary;
  readonly failed: boolean;
  readonly time: string;
  readonly duration: string;
  readonly spanCount: number;
};

/** Sub-millisecond spans are the common case, so show enough digits. */
function formatMilliseconds(value: number): string {
  if (value >= 100) return `${value.toFixed(0)} ms`;
  if (value >= 1) return `${value.toFixed(2)} ms`;
  return `${(value * 1000).toFixed(0)} µs`;
}

/** Re-indent captured JSON; it arrives compact to keep the wire small. */
function prettyJson(payload: string): string {
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    // Truncated, so no longer parseable — showing it raw beats hiding it.
    return payload;
  }
}

/**
 * Reduce a trace to sender, route and payload.
 *
 * The route is the actor paths in time order with consecutive repeats
 * collapsed: an actor that handles two messages in one trace is one hop, not
 * two, which is what "where did this go?" means.
 */
function summarise(trace: TraceLayout): TraceSummary {
  const root = trace.spans.find((entry) => entry.depth === 0) ?? trace.spans[0];
  const hops: string[] = [];
  const sender = root?.span.senderPath ?? null;
  if (sender !== null) hops.push(shortActorPath(sender));
  for (const entry of trace.spans) {
    const path = entry.span.actorPath;
    if (path === null) continue;
    const short = shortActorPath(path);
    if (hops[hops.length - 1] !== short) hops.push(short);
  }
  return {
    route: hops.length === 0 ? (root?.span.name ?? '(empty trace)') : hops.join(' → '),
    messageType: root?.span.messageType ?? root?.span.name ?? '—',
    payload: root?.span.messagePayload ?? null,
  };
}

/**
 * Every actor span is called `actor.receive`, so the span name alone labels
 * every bar identically.  The actor and the message are what tell them apart.
 */
function barLabel(span: WireSpan): string {
  if (span.actorPath === null) return span.name;
  const actor = shortActorPath(span.actorPath);
  return span.messageType === null ? actor : `${actor} · ${span.messageType}`;
}

/**
 * The tracing panel (#217) — the route a message took, and where the time went.
 *
 * Two screens rather than a sidebar.  The list is the panel: one row per trace,
 * wide enough to carry the whole route and the payload, which is what you scan
 * when you are looking for *which* message misbehaved.  Clicking one opens the
 * graph, which answers the different question of where its time went.
 *
 * Canvas for the graph, not SVG: a busy trace is hundreds of rectangles that
 * repaint on every hover and resize, and rectangles are all it needs — no text
 * selection, no per-node CSS.  `flamegraph.ts` keeps the layout and the hit
 * test; only the painting lives here.
 */
@Component({
  selector: 'devtools-tracing-panel',
  imports: [EChartComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './TracingPanelComponent.html',
})
export class TracingPanelComponent {
  private readonly tap = inject(TapClientService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly chartTheme = inject(ChartThemeService).theme;

  readonly bufferChoices = BUFFER_CHOICES;

  /**
   * The retained spans, keyed by `spanId` and in arrival order (#1350).
   *
   * A `Map` rather than an array because the same span can arrive twice and
   * must be recognised, not appended.  `SpanTap.snapshot()` hands a fresh
   * subscriber the server's whole ring, and two existing paths re-subscribe a
   * stream that is already open: the sequence-gap recovery in `tapClient`, and
   * the re-subscribe of every live stream after a reconnect.  Appending that
   * snapshot drew every span the panel already held a second time — a doubled
   * flame graph, duplicated children under a trace, and a span count that was
   * simply wrong.
   *
   * The panels that survive the same frame do so because their handlers
   * REPLACE — `ActorTreeModel.reset` drops its map, `onClusterSnapshot` calls
   * `members.set(...)`.  This one accumulates, so it needs identity instead.
   * `spanId` is 16 hex characters of crypto-grade randomness (W3C
   * trace-context), so it is one.
   *
   * A `Map` keeps insertion order and re-keying an existing entry leaves that
   * order alone, which is what makes a resent span land back in its own place
   * rather than jumping to the end of the ring.
   */
  private spans = new Map<string, WireSpan>();

  private readonly traces = signal<readonly TraceLayout[]>([]);
  private readonly dropped = signal(0);

  readonly capacity = signal<number>(TRACING_BUFFER_DEFAULT);
  readonly mode = signal<ViewMode>('flame');
  readonly openTraceId = signal<string | null>(null);
  readonly hovered = signal<LayoutSpan | null>(null);


  readonly summary = computed(() => {
    const spanCount = this.spans.size;
    const traceCount = this.traces().length;
    const dropped = this.dropped();
    // Read through `traces()` so this recomputes when a batch lands; `spans`
    // is a plain `Map` on purpose, since it is written per batch and a signal
    // holding it would report a change the identity never made.
    return dropped > 0
      ? `${formatCount(spanCount)} spans · ${formatCount(traceCount)} traces · ${formatCount(dropped)} dropped`
      : `${formatCount(spanCount)} spans · ${formatCount(traceCount)} traces`;
  });

  /** Only the newest `TRACE_ROWS` are drawn; the rest are still counted. */
  readonly rows = computed<readonly TraceRow[]>(() => this.traces().slice(0, TRACE_ROWS).map((trace) => ({
    trace,
    summary: summarise(trace),
    failed: trace.spans.some((entry) => entry.span.status === 'error'),
    time: formatTime(trace.startedAtMs),
    duration: formatMilliseconds(trace.totalMs),
    spanCount: trace.spans.length,
  })));

  readonly openTrace = computed<TraceLayout | null>(() => {
    const id = this.openTraceId();
    if (id === null) return null;
    return this.traces().find((trace) => trace.traceId === id) ?? null;
  });

  readonly openSummary = computed(() => {
    const trace = this.openTrace();
    return trace === null ? null : summarise(trace);
  });

  readonly openMeta = computed(() => {
    const trace = this.openTrace();
    const summary = this.openSummary();
    if (trace === null || summary === null) return '';
    return `${formatTime(trace.startedAtMs)} · ${summary.messageType}`
      + ` · ${formatCount(trace.spans.length)} spans · ${formatMilliseconds(trace.totalMs)}`;
  });

  /**
   * The bars, laid out at a nominal width and scaled when painted.
   *
   * `layoutRectangles` is unchanged — it is the tested part, and it never
   * learns about the chart.
   */
  readonly spanRectangles = computed<readonly SpanRectangle[]>(() => {
    const trace = this.openTrace();
    if (trace === null) return [];
    const flame = this.mode() === 'flame';
    return layoutRectangles(trace, NOMINAL_WIDTH, flame ? (entry) => entry.depth : (_entry, index) => index);
  });

  readonly flameHeight = computed(() => {
    const trace = this.openTrace();
    if (trace === null) return `${ROW_HEIGHT}px`;
    const rows = this.mode() === 'flame' ? trace.maxDepth + 1 : trace.spans.length;
    return `${Math.max(rows * ROW_HEIGHT, ROW_HEIGHT)}px`;
  });

  readonly flameOption = computed<DevToolsChartOption>(() => {
    const theme = this.chartTheme();
    const bars: ChartRectangle[] = this.spanRectangles().map((rectangle) => {
      const index = spanColorIndex(rectangle.span.span);
      return {
        x: rectangle.x,
        y: rectangle.y,
        width: rectangle.width,
        height: rectangle.height,
        label: barLabel(rectangle.span.span),
        color: index === -1 ? theme.stateError : theme.series[index % theme.series.length]!,
      };
    });
    return buildRectanglesOption(bars, theme);
  });

  readonly detailRows = computed(() => {
    const trace = this.openTrace();
    const entry = this.hovered() ?? this.spanRectangles()[0]?.span ?? null;
    if (trace === null || entry === null) return null;
    const span = entry.span;
    const rows: Array<[string, string]> = [
      ['Span', span.name],
      ['Kind', span.spanKind],
      ['Duration', formatMilliseconds(entry.durationMs)],
      ['Self time', formatMilliseconds(entry.selfMs)],
      ['Offset in trace', formatMilliseconds(entry.startMs)],
      ['Depth', String(entry.depth)],
      ['Status', span.statusMessage === null ? span.status : `${span.status} — ${span.statusMessage}`],
    ];
    if (span.senderPath !== null) rows.push(['From', shortActorPath(span.senderPath)]);
    if (span.actorPath !== null) rows.push(['To', shortActorPath(span.actorPath)]);
    if (span.messageType !== null) rows.push(['Message', span.messageType]);
    if (span.exceptions.length > 0) rows.push(['Exceptions', span.exceptions.join('; ')]);
    rows.push(['Trace', `${trace.traceId.slice(0, 16)}… (${formatCount(trace.spans.length)} spans)`]);

    const lifted = new Set(['actor.path', 'actor.message.type', 'actor.sender', 'actor.message.payload']);
    return {
      rows,
      payload: span.messagePayload,
      attributes: Object.entries(span.attributes)
        .filter(([key]) => !lifted.has(key))
        .map(([key, value]) => [key, String(value)] as [string, string]),
    };
  });

  constructor() {

    this.destroyRef.onDestroy(this.tap.listen('spans', (payload) => {
      if (payload.kind !== 'span-batch') return;
      this.dropped.update((value) => value + payload.dropped);
      for (const span of payload.spans) this.spans.set(span.spanId, span);
      // Never hold more than the server retains: the ring size is the same
      // answer to "how far back do I care?" on both sides.
      this.trimSpans();
      this.regroup();
    }));

    // Say the default out loud, so the two rings agree even if their defaults
    // ever drift apart.
    void this.setCapacity(TRACING_BUFFER_DEFAULT);
  }

  count(value: number): string { return formatCount(value); }
  pretty(payload: string): string { return prettyJson(payload); }

  onCapacity(event: Event): void {
    void this.setCapacity(Number((event.target as HTMLSelectElement).value));
  }

  onClear(): void {
    this.spans.clear();
    this.dropped.set(0);
    this.openTraceId.set(null);
    this.regroup();
  }

  onOpen(traceId: string): void {
    this.openTraceId.set(traceId);
    this.hovered.set(null);
  }

  onBack(): void { this.openTraceId.set(null); }
  onMode(mode: ViewMode): void { this.mode.set(mode); }

  /**
   * ECharts reports which bar the pointer is over, so the second geometry pass
   * the hand-rolled `hitTest` performed is gone with it (#486).
   */
  onHovered(index: number | null): void {
    this.hovered.set(index === null ? null : this.spanRectangles()[index]?.span ?? null);
  }

  /**
   * Ask the server to retain more (or less) of the recent past.
   *
   * Recording itself is not negotiable — it runs from the moment DevTools
   * attaches, which is what puts the interesting messages on screen before you
   * thought to look.  This is only how far back it keeps, and the reply is what
   * the server settled on rather than what was asked for.
   */
  private async setCapacity(wanted: number): Promise<void> {
    try {
      const result = await this.tap.request<TracingBufferResult>('tracing.buffer', { capacity: wanted });
      this.capacity.set(result.capacity);
    } catch {
      // An older server, or the panel is disabled — leave local trimming where
      // it was rather than pretending anything changed.
    }
    this.trimSpans();
    this.regroup();
  }

  /**
   * Hold no more than the server does; anything else is a slow leak.
   *
   * Oldest first, which is what the array slice did — a `Map` iterates in
   * insertion order, and deleting through that iterator is defined.
   */
  private trimSpans(): void {
    let excess = this.spans.size - this.capacity();
    if (excess <= 0) return;
    for (const spanId of this.spans.keys()) {
      this.spans.delete(spanId);
      if (--excess === 0) return;
    }
  }

  private regroup(): void {
    const grouped = groupByTrace([...this.spans.values()]);
    this.traces.set(grouped);
    // An open trace that aged out of the buffer drops you back to the list
    // rather than to a blank graph.
    const id = this.openTraceId();
    if (id !== null && !grouped.some((trace) => trace.traceId === id)) this.openTraceId.set(null);
  }

}

/** The registry loads this module and reads this export. */
export const panelComponent = TracingPanelComponent;
