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

import { TapClientService } from '../../app/TapClientService.js';
import { formatCount, formatTime, shortActorPath } from '../../core/format.js';
import { currentTheme } from '../../core/theme.js';
import { themeColor } from '../../render/timeseries.js';
import {
  ROW_HEIGHT,
  groupByTrace,
  hitTest,
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

function preparedContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const context = canvas.getContext('2d');
  if (context === null) return null;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 600;
  const height = canvas.clientHeight || ROW_HEIGHT;
  if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
    canvas.width = width * ratio;
    canvas.height = height * ratio;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  return context;
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
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="dt-panel__title">Tracing</h1>
    <p class="dt-panel__subtitle">
      Every message the system handled, with the route it took. Recording runs from the
      moment DevTools attaches, so the recent past is already here.
    </p>

    <div class="dt-toolbar">
      <select class="dt-input" aria-label="Messages to keep" (change)="onCapacity($event)">
        @for (choice of bufferChoices; track choice) {
          <option [value]="choice" [selected]="choice === capacity()">
            keep {{ count(choice) }} messages
          </option>
        }
      </select>
      <button class="dt-iconbutton" type="button" (click)="onClear()">Clear</button>
      <span class="dt-toolbar__summary">{{ summary() }}</span>
    </div>

    @if (openTrace(); as trace) {
      <section>
        <div class="dt-toolbar">
          <button class="dt-iconbutton" type="button" (click)="onBack()">← All traces</button>
          <button
            class="dt-iconbutton"
            [class.dt-iconbutton--active]="mode() === 'flame'"
            type="button"
            (click)="onMode('flame')"
          >Flame graph</button>
          <button
            class="dt-iconbutton"
            [class.dt-iconbutton--active]="mode() === 'waterfall'"
            type="button"
            (click)="onMode('waterfall')"
          >Waterfall</button>
        </div>

        <div class="dt-traceheader">
          <div class="dt-traceheader__route">{{ openSummary()!.route }}</div>
          <div class="dt-traceheader__meta">{{ openMeta() }}</div>
          @if (openSummary()!.payload !== null) {
            <pre class="dt-code">{{ pretty(openSummary()!.payload!) }}</pre>
          }
        </div>

        <canvas class="dt-flame" #flame (mousemove)="onMove($event)" (mouseleave)="onLeave()"></canvas>

        <div class="dt-spandetails">
          @if (detailRows(); as detail) {
            <dl class="dt-kv">
              @for (row of detail.rows; track row[0]) {
                <dt>{{ row[0] }}</dt><dd [title]="row[1]">{{ row[1] }}</dd>
              }
            </dl>
            @if (detail.payload !== null) {
              <pre class="dt-code">{{ pretty(detail.payload) }}</pre>
            }
            @if (detail.attributes.length > 0) {
              <dl class="dt-kv dt-kv--muted">
                @for (attribute of detail.attributes; track attribute[0]) {
                  <dt>{{ attribute[0] }}</dt><dd>{{ attribute[1] }}</dd>
                }
              </dl>
            }
          } @else {
            <p class="dt-empty">Hover a span for details.</p>
          }
        </div>
      </section>
    } @else {
      <section>
        <div class="dt-tracetable">
          @if (rows().length === 0) {
            <!-- "Nothing yet" alone reads as broken next to an overview counting
                 hundreds of messages a minute — most of which, on an idle system,
                 are DevTools talking to this very browser. So the empty state has
                 to name the reason, not just report emptiness. -->
            <div class="dt-emptystate">
              <p class="dt-empty">Recording. Nothing from your actors yet.</p>
              <p class="dt-empty">
                DevTools' own messages are excluded: its hub publishes the spans it just
                recorded, so tracing them would feed every batch back in as the payload of
                the next one.
              </p>
              <p class="dt-empty">
                So an otherwise idle system can show a message rate on the overview while
                this list stays empty — that traffic is the tool, not the application. Make
                your actors do something and it will appear here.
              </p>
            </div>
          } @else {
            <div class="dt-tracetable__head">
              <span>Time</span><span>Route</span><span>Message</span>
              <span>Payload</span><span>Duration</span>
            </div>
            @for (row of rows(); track row.trace.traceId) {
              <button
                type="button"
                class="dt-tracetable__row"
                [class.dt-tracetable__row--error]="row.failed"
                [title]="row.summary.payload ?? row.summary.route"
                (click)="onOpen(row.trace.traceId)"
              >
                <span class="dt-tracetable__time">{{ row.time }}</span>
                <span class="dt-tracetable__route">{{ row.summary.route }}</span>
                <span class="dt-tracetable__message">
                  {{ row.summary.messageType }}
                  @if (row.spanCount > 1) {
                    <span class="dt-badge">{{ count(row.spanCount) }} spans</span>
                  }
                  @if (row.failed) { <span class="dt-badge dt-badge--error">error</span> }
                </span>
                <span class="dt-tracetable__payload">{{ row.summary.payload ?? '—' }}</span>
                <span class="dt-tracetable__duration">{{ row.duration }}</span>
              </button>
            }
          }
        </div>
      </section>
    }
  `,
})
export class TracingPanelComponent {
  private readonly tap = inject(TapClientService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly flame = viewChild<ElementRef<HTMLCanvasElement>>('flame');

  readonly bufferChoices = BUFFER_CHOICES;

  private spans: WireSpan[] = [];
  private rectangles: readonly SpanRectangle[] = [];

  private readonly traces = signal<readonly TraceLayout[]>([]);
  private readonly dropped = signal(0);

  readonly capacity = signal<number>(TRACING_BUFFER_DEFAULT);
  readonly mode = signal<ViewMode>('flame');
  readonly openTraceId = signal<string | null>(null);
  readonly hovered = signal<LayoutSpan | null>(null);

  /** Bumped on resize: a canvas keeps its backing store until told otherwise. */
  private readonly viewport = signal(0);

  readonly summary = computed(() => {
    const spanCount = this.spans.length;
    const traceCount = this.traces().length;
    const dropped = this.dropped();
    // Read through `traces()` so this recomputes when a batch lands; `spans`
    // is a plain array on purpose, since it is appended to per batch.
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

  readonly detailRows = computed(() => {
    const trace = this.openTrace();
    const entry = this.hovered() ?? this.rectangles[0]?.span ?? null;
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

    const onResize = (): void => this.viewport.update((value) => value + 1);
    window.addEventListener('resize', onResize);
    this.destroyRef.onDestroy(() => window.removeEventListener('resize', onResize));

    this.destroyRef.onDestroy(this.tap.listen('spans', (payload) => {
      if (payload.kind !== 'span-batch') return;
      this.dropped.update((value) => value + payload.dropped);
      this.spans.push(...payload.spans);
      // Never hold more than the server retains: the ring size is the same
      // answer to "how far back do I care?" on both sides.
      this.trimSpans();
      this.regroup();
    }));

    afterRenderEffect(() => {
      this.openTrace();
      this.mode();
      this.hovered();
      currentTheme();
      this.viewport();
      this.draw();
    });

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
    this.spans = [];
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

  onMove(event: MouseEvent): void {
    const canvas = this.flame()?.nativeElement;
    if (canvas === undefined) return;
    const bounds = canvas.getBoundingClientRect();
    const found = hitTest(this.rectangles, event.clientX - bounds.left, event.clientY - bounds.top);
    this.hovered.set(found?.span ?? null);
  }

  onLeave(): void { this.hovered.set(null); }

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

  /** Hold no more than the server does; anything else is a slow leak. */
  private trimSpans(): void {
    const capacity = this.capacity();
    if (this.spans.length > capacity) this.spans = this.spans.slice(this.spans.length - capacity);
  }

  private regroup(): void {
    const grouped = groupByTrace(this.spans);
    this.traces.set(grouped);
    // An open trace that aged out of the buffer drops you back to the list
    // rather than to a blank graph.
    const id = this.openTraceId();
    if (id !== null && !grouped.some((trace) => trace.traceId === id)) this.openTraceId.set(null);
  }

  private draw(): void {
    const canvas = this.flame()?.nativeElement;
    const trace = this.openTrace();
    if (canvas === undefined || trace === null) {
      this.rectangles = [];
      return;
    }
    const flame = this.mode() === 'flame';
    const rows = flame ? trace.maxDepth + 1 : trace.spans.length;
    const width = canvas.clientWidth || 600;
    canvas.style.height = `${Math.max(rows * ROW_HEIGHT, ROW_HEIGHT)}px`;

    this.rectangles = layoutRectangles(
      trace,
      width,
      flame ? (entry) => entry.depth : (_entry, index) => index,
    );

    const context = preparedContext(canvas);
    if (context === null) return;
    const border = themeColor('--dt-bg', '#0f172a');
    const label = themeColor('--dt-text-strong', '#f1f5f9');
    const highlighted = this.hovered();
    context.font = '11px ui-monospace, monospace';
    context.textBaseline = 'middle';

    for (const rectangle of this.rectangles) {
      const index = spanColorIndex(rectangle.span.span);
      context.fillStyle = index === -1
        ? themeColor('--dt-state-error', '#ef4444')
        : themeColor(`--dt-data-${index + 1}`, '#818cf8');
      context.globalAlpha = highlighted === null || highlighted === rectangle.span ? 1 : 0.45;
      context.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
      context.globalAlpha = 1;

      context.strokeStyle = border;
      context.lineWidth = 1;
      context.strokeRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);

      // Only label a bar with room for it; clipped text is worse than none.
      if (rectangle.width > 42) {
        context.save();
        context.beginPath();
        context.rect(rectangle.x + 3, rectangle.y, rectangle.width - 6, rectangle.height);
        context.clip();
        context.fillStyle = label;
        context.fillText(barLabel(rectangle.span.span), rectangle.x + 5, rectangle.y + rectangle.height / 2);
        context.restore();
      }
    }
  }
}

/** The registry loads this module and reads this export. */
export const panelComponent = TracingPanelComponent;
