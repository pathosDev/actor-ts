/**
 * The tracing panel (#217) — flame graph and waterfall over recorded
 * message spans.
 *
 * Spans arrive live and are grouped into traces; the trace list on the
 * left is the index, the canvas on the right is the detail.  Selection
 * is sticky: a trace you are reading must not be swapped out from under
 * you because a newer one arrived.
 *
 * Canvas, not SVG: a busy trace is hundreds of rectangles that repaint
 * on every hover and resize, and rectangles are all this needs — no
 * text selection, no per-node CSS.
 */
import { h, replaceChildren } from '../../core/dom.js';
import { formatCount, formatTime, shortActorPath } from '../../core/format.js';
import { effect, signal } from '../../core/signal.js';
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
import type { PanelContext, PanelInstance } from '../../shell/PanelRegistry.js';
import type { TracingRecordResult, WireSpan } from '../../../../src/devtools/protocol/index.js';

/** Spans kept in the browser; well beyond what one screen can show. */
const SPAN_CAPACITY = 5_000;

/** How the vertical axis is arranged. */
type ViewMode = 'flame' | 'waterfall';

export function mount(host: HTMLElement, context: PanelContext): PanelInstance {
  let spans: WireSpan[] = [];
  let traces: ReadonlyArray<TraceLayout> = [];
  let rectangles: ReadonlyArray<SpanRectangle> = [];
  let dropped = 0;

  const mode = signal<ViewMode>('flame');
  const selectedTraceId = signal<string | null>(null);
  const hovered = signal<LayoutSpan | null>(null);
  const recording = signal(false);

  const traceList = h('div', { class: 'dt-tracelist' });
  const canvas = h('canvas', { class: 'dt-flame' }) as HTMLCanvasElement;
  const details = h('div', { class: 'dt-spandetails' });
  const summary = h('span', { class: 'dt-toolbar__summary' });

  const modeButton = h('button', {
    class: 'dt-iconbutton',
    type: 'button',
    onclick: () => {
      mode.set(mode.get() === 'flame' ? 'waterfall' : 'flame');
      draw();
    },
  }, 'Waterfall');

  const recordButton = h('button', {
    class: 'dt-iconbutton',
    type: 'button',
    onclick: () => { void toggleRecording(); },
  }, 'Record all messages');

  /**
   * Ask the system to open a root span for every message.
   *
   * Without this the panel is empty on a system that is plainly busy:
   * actors trace a message only when it already belongs to a trace, and
   * a plain `tell` never starts one.
   */
  async function toggleRecording(): Promise<void> {
    const wanted = !recording.get();
    try {
      const result = await context.tap.request<TracingRecordResult>(
        'tracing.record', { enabled: wanted },
      );
      recording.set(result.recording);
    } catch {
      // The server refused (no tracer, panel disabled) — reflect what is
      // actually true rather than what was asked for.
      recording.set(false);
    }
    renderTraceList();
    draw();
  }

  const clearButton = h('button', {
    class: 'dt-iconbutton',
    type: 'button',
    onclick: () => {
      spans = [];
      dropped = 0;
      selectedTraceId.set(null);
      regroup();
    },
  }, 'Clear');

  replaceChildren(host,
    h('h1', { class: 'dt-panel__title' }, 'Tracing'),
    h('p', { class: 'dt-panel__subtitle' },
      'Spans recorded while this panel is open. Flame stacks by call depth; '
      + 'waterfall keeps one row per span.'),
    h('div', { class: 'dt-toolbar' }, recordButton, modeButton, clearButton, summary),
    h('div', { class: 'dt-trace' },
      traceList,
      h('div', { class: 'dt-trace__detail' }, canvas, details),
    ),
  );

  function regroup(): void {
    traces = groupByTrace(spans);
    // Keep the selection if it still exists; otherwise fall back to the
    // newest trace so the panel is never blank while data is arriving.
    const selected = selectedTraceId.get();
    if (selected === null || !traces.some((trace) => trace.traceId === selected)) {
      selectedTraceId.set(traces[0]?.traceId ?? null);
    }
    renderTraceList();
    draw();
  }

  function selectedTrace(): TraceLayout | null {
    const id = selectedTraceId.get();
    return traces.find((trace) => trace.traceId === id) ?? null;
  }

  function renderTraceList(): void {
    summary.textContent = dropped > 0
      ? `${formatCount(spans.length)} spans · ${formatCount(traces.length)} traces · ${formatCount(dropped)} dropped`
      : `${formatCount(spans.length)} spans · ${formatCount(traces.length)} traces`;

    if (traces.length === 0) {
      // The explanation lives in the detail area — this column is about
      // 220px wide, which a four-line code sample does not survive.
      replaceChildren(traceList, h('p', { class: 'dt-empty' }, 'No traces yet.'));
      return;
    }
    replaceChildren(traceList, ...traces.slice(0, 60).map((trace) => {
      const failed = trace.spans.some((entry) => entry.span.status === 'error');
      const classes = ['dt-tracelist__row'];
      if (trace.traceId === selectedTraceId.get()) classes.push('dt-tracelist__row--current');
      return h('button', {
        class: classes.join(' '),
        type: 'button',
        onclick: () => {
          selectedTraceId.set(trace.traceId);
          renderTraceList();
          draw();
        },
      },
        h('span', { class: 'dt-tracelist__time' }, formatTime(trace.startedAtMs)),
        h('span', { class: 'dt-tracelist__name' }, rootNameOf(trace)),
        failed ? h('span', { class: 'dt-badge dt-badge--error' }, 'error') : null,
        h('span', { class: 'dt-tracelist__duration' }, formatMilliseconds(trace.totalMs)),
      );
    }));
  }

  function draw(): void {
    modeButton.textContent = mode.get() === 'flame' ? 'Waterfall' : 'Flame graph';
    recordButton.textContent = recording.get() ? 'Stop recording' : 'Record all messages';
    recordButton.className = recording.get()
      ? 'dt-iconbutton dt-iconbutton--active'
      : 'dt-iconbutton';

    const trace = selectedTrace();
    if (trace === null) {
      rectangles = [];
      clearCanvas(canvas);
      replaceChildren(details, emptyExplanation(recording.get()));
      return;
    }

    const rows = mode.get() === 'flame' ? trace.maxDepth + 1 : trace.spans.length;
    const width = canvas.clientWidth || 600;
    canvas.style.height = `${Math.max(rows * ROW_HEIGHT, ROW_HEIGHT)}px`;

    rectangles = layoutRectangles(
      trace,
      width,
      mode.get() === 'flame' ? (entry) => entry.depth : (_entry, index) => index,
    );
    paint(canvas, rectangles, hovered.get());
    renderDetails(details, hovered.get() ?? rectangles[0]?.span ?? null, trace);
  }

  canvas.addEventListener('mousemove', (event) => {
    const bounds = canvas.getBoundingClientRect();
    const found = hitTest(rectangles, event.clientX - bounds.left, event.clientY - bounds.top);
    const next = found?.span ?? null;
    if (next === hovered.get()) return;
    hovered.set(next);
    paint(canvas, rectangles, next);
    const trace = selectedTrace();
    if (trace !== null) renderDetails(details, next ?? rectangles[0]?.span ?? null, trace);
  });
  canvas.addEventListener('mouseleave', () => {
    hovered.set(null);
    paint(canvas, rectangles, null);
  });

  const stop = context.tap.listen('spans', (payload) => {
    if (payload.kind !== 'span-batch') return;
    dropped += payload.dropped;
    spans.push(...payload.spans);
    // Drop the distant past rather than grow without bound; the recent
    // past is what a live flame graph is for.
    if (spans.length > SPAN_CAPACITY) spans = spans.slice(spans.length - SPAN_CAPACITY);
    regroup();
  });

  const disposeTheme = effect(draw, [currentTheme]);
  const onResize = (): void => draw();
  window.addEventListener('resize', onResize);
  regroup();

  return {
    dispose(): void {
      // The server also stops recording when the last subscriber goes,
      // but saying so explicitly means leaving the panel never depends
      // on unsubscribe ordering.
      if (recording.get()) {
        void context.tap.request('tracing.record', { enabled: false }).catch(() => {
          /* the socket is going away anyway */
        });
      }
      stop();
      disposeTheme();
      window.removeEventListener('resize', onResize);
    },
  };
}

/* -------------------------------- drawing -------------------------------- */

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
 * What to say when there is nothing to draw.
 *
 * Almost always the seeding rule rather than a broken tap: an actor
 * opens a span only for a message that already belongs to a trace, and
 * nothing in the framework starts one on its own.  So the empty state
 * has to name the button that fixes it, not just report emptiness.
 */
function emptyExplanation(recording: boolean): HTMLElement {
  if (recording) {
    return h('div', { class: 'dt-emptystate' },
      h('p', { class: 'dt-empty' }, 'Recording every message. Waiting for traffic…'),
    );
  }
  return h('div', { class: 'dt-emptystate' },
    h('p', { class: 'dt-empty' },
      'No spans yet. Actors trace a message only when it already belongs to '
      + 'a trace, so an ordinary tell records nothing.'),
    h('p', { class: 'dt-empty' },
      'Press ', h('strong', {}, 'Record all messages'),
      ' to make every message a root span for as long as this panel is open.'),
    h('p', { class: 'dt-empty' },
      'In production you would start the trace yourself, at the entry point:'),
    h('pre', { class: 'dt-code' }, [
      'const tracer = tracerOf(system);',
      "const span = tracer.startSpan('handle-request');",
      'tracer.withActiveSpan(span, () => ref.tell(message));',
      'span.end();',
    ].join('\n')),
  );
}

function clearCanvas(canvas: HTMLCanvasElement): void {
  preparedContext(canvas);
}

function paint(
  canvas: HTMLCanvasElement,
  rectangles: ReadonlyArray<SpanRectangle>,
  highlighted: LayoutSpan | null,
): void {
  const context = preparedContext(canvas);
  if (context === null) return;
  const border = themeColor('--dt-bg', '#0f172a');
  const label = themeColor('--dt-text-strong', '#f1f5f9');
  context.font = '11px ui-monospace, monospace';
  context.textBaseline = 'middle';

  for (const rectangle of rectangles) {
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
      context.fillText(
        rectangle.span.span.name,
        rectangle.x + 5,
        rectangle.y + rectangle.height / 2,
      );
      context.restore();
    }
  }
}

/* -------------------------------- details -------------------------------- */

function renderDetails(host: HTMLElement, entry: LayoutSpan | null, trace: TraceLayout): void {
  if (entry === null) {
    replaceChildren(host, h('p', { class: 'dt-empty' }, 'Hover a span for details.'));
    return;
  }
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
  if (span.actorPath !== null) rows.push(['Actor', shortActorPath(span.actorPath)]);
  if (span.messageType !== null) rows.push(['Message', span.messageType]);
  if (span.exceptions.length > 0) rows.push(['Exceptions', span.exceptions.join('; ')]);
  rows.push(['Trace', `${trace.traceId.slice(0, 16)}… (${formatCount(trace.spans.length)} spans)`]);

  const attributes = Object.entries(span.attributes)
    .filter(([key]) => key !== 'actor.path' && key !== 'actor.message.type');

  replaceChildren(host,
    h('dl', { class: 'dt-kv' }, ...rows.flatMap(([key, value]) => [
      h('dt', {}, key),
      h('dd', { title: value }, value),
    ])),
    attributes.length === 0 ? null : h('dl', { class: 'dt-kv dt-kv--muted' },
      ...attributes.flatMap(([key, value]) => [h('dt', {}, key), h('dd', {}, String(value))]),
    ),
  );
}

function rootNameOf(trace: TraceLayout): string {
  const root = trace.spans.find((entry) => entry.depth === 0) ?? trace.spans[0];
  return root?.span.name ?? '(empty trace)';
}

/** Sub-millisecond spans are the common case, so show enough digits. */
function formatMilliseconds(value: number): string {
  if (value >= 100) return `${value.toFixed(0)} ms`;
  if (value >= 1) return `${value.toFixed(2)} ms`;
  return `${(value * 1000).toFixed(0)} µs`;
}
