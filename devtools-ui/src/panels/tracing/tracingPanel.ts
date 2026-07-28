/**
 * The tracing panel (#217) — the route a message took, and where the
 * time went.
 *
 * Two screens rather than a sidebar.  The list is the panel: one row per
 * trace, wide enough to carry the whole route and the payload, which is
 * what you scan when you are looking for *which* message misbehaved.
 * Clicking one opens the graph, which answers the different question of
 * where its time went.
 *
 * Canvas for the graph, not SVG: a busy trace is hundreds of rectangles
 * that repaint on every hover and resize, and rectangles are all it
 * needs — no text selection, no per-node CSS.
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

/** Traces listed at once — older ones are still counted, not drawn. */
const TRACE_ROWS = 200;

/** How the vertical axis is arranged. */
type ViewMode = 'flame' | 'waterfall';

export function mount(host: HTMLElement, context: PanelContext): PanelInstance {
  let spans: WireSpan[] = [];
  let traces: ReadonlyArray<TraceLayout> = [];
  let rectangles: ReadonlyArray<SpanRectangle> = [];
  let dropped = 0;

  const mode = signal<ViewMode>('flame');
  const openTraceId = signal<string | null>(null);
  const hovered = signal<LayoutSpan | null>(null);
  const recording = signal(false);

  const traceList = h('div', { class: 'dt-tracetable' });
  const listView = h('section', {}, traceList);
  const canvas = h('canvas', { class: 'dt-flame' }) as HTMLCanvasElement;
  const details = h('div', { class: 'dt-spandetails' });
  const detailHeading = h('div', { class: 'dt-traceheader' });
  const summary = h('span', { class: 'dt-toolbar__summary' });

  const backButton = h('button', {
    class: 'dt-iconbutton',
    type: 'button',
    onclick: () => {
      openTraceId.set(null);
      render();
    },
  }, '← All traces');

  const flameButton = h('button', {
    class: 'dt-iconbutton',
    type: 'button',
    onclick: () => { mode.set('flame'); draw(); },
  }, 'Flame graph');

  const waterfallButton = h('button', {
    class: 'dt-iconbutton',
    type: 'button',
    onclick: () => { mode.set('waterfall'); draw(); },
  }, 'Waterfall');

  const detailView = h('section', {},
    h('div', { class: 'dt-toolbar' }, backButton, flameButton, waterfallButton),
    detailHeading,
    canvas,
    details,
  );

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
    render();
  }

  const clearButton = h('button', {
    class: 'dt-iconbutton',
    type: 'button',
    onclick: () => {
      spans = [];
      dropped = 0;
      openTraceId.set(null);
      regroup();
    },
  }, 'Clear');

  replaceChildren(host,
    h('h1', { class: 'dt-panel__title' }, 'Tracing'),
    h('p', { class: 'dt-panel__subtitle' },
      'Every message recorded while this panel is open, with the route it took. '
      + 'Open one to see where its time went.'),
    h('div', { class: 'dt-toolbar' }, recordButton, clearButton, summary),
    listView,
    detailView,
  );

  function openTrace(): TraceLayout | null {
    const id = openTraceId.get();
    if (id === null) return null;
    return traces.find((trace) => trace.traceId === id) ?? null;
  }

  function regroup(): void {
    traces = groupByTrace(spans);
    // An open trace that aged out of the buffer drops you back to the
    // list rather than to a blank graph.
    if (openTraceId.get() !== null && openTrace() === null) openTraceId.set(null);
    render();
  }

  function render(): void {
    recordButton.textContent = recording.get() ? 'Stop recording' : 'Record all messages';
    recordButton.className = recording.get()
      ? 'dt-iconbutton dt-iconbutton--active'
      : 'dt-iconbutton';
    summary.textContent = dropped > 0
      ? `${formatCount(spans.length)} spans · ${formatCount(traces.length)} traces · ${formatCount(dropped)} dropped`
      : `${formatCount(spans.length)} spans · ${formatCount(traces.length)} traces`;

    const open = openTrace();
    listView.hidden = open !== null;
    detailView.hidden = open === null;
    if (open === null) renderTraceList();
    else draw();
  }

  function renderTraceList(): void {
    if (traces.length === 0) {
      replaceChildren(traceList, emptyExplanation(recording.get()));
      return;
    }
    replaceChildren(traceList,
      h('div', { class: 'dt-tracetable__head' },
        h('span', {}, 'Time'),
        h('span', {}, 'Route'),
        h('span', {}, 'Message'),
        h('span', {}, 'Payload'),
        h('span', {}, 'Duration'),
      ),
      ...traces.slice(0, TRACE_ROWS).map((trace) => {
        const summarised = summarise(trace);
        const failed = trace.spans.some((entry) => entry.span.status === 'error');
        const classes = ['dt-tracetable__row'];
        if (failed) classes.push('dt-tracetable__row--error');
        return h('button', {
          class: classes.join(' '),
          type: 'button',
          title: summarised.payload ?? summarised.route,
          onclick: () => {
            openTraceId.set(trace.traceId);
            hovered.set(null);
            render();
          },
        },
          h('span', { class: 'dt-tracetable__time' }, formatTime(trace.startedAtMs)),
          h('span', { class: 'dt-tracetable__route' }, summarised.route),
          h('span', { class: 'dt-tracetable__message' },
            summarised.messageType,
            trace.spans.length > 1
              ? h('span', { class: 'dt-badge' }, `${formatCount(trace.spans.length)} spans`)
              : null,
            failed ? h('span', { class: 'dt-badge dt-badge--error' }, 'error') : null,
          ),
          h('span', { class: 'dt-tracetable__payload' }, summarised.payload ?? '—'),
          h('span', { class: 'dt-tracetable__duration' }, formatMilliseconds(trace.totalMs)),
        );
      }),
    );
  }

  function draw(): void {
    flameButton.className = mode.get() === 'flame'
      ? 'dt-iconbutton dt-iconbutton--active'
      : 'dt-iconbutton';
    waterfallButton.className = mode.get() === 'waterfall'
      ? 'dt-iconbutton dt-iconbutton--active'
      : 'dt-iconbutton';

    const trace = openTrace();
    if (trace === null) return;

    const summarised = summarise(trace);
    replaceChildren(detailHeading,
      h('div', { class: 'dt-traceheader__route' }, summarised.route),
      h('div', { class: 'dt-traceheader__meta' },
        `${formatTime(trace.startedAtMs)} · ${summarised.messageType}`
        + ` · ${formatCount(trace.spans.length)} spans · ${formatMilliseconds(trace.totalMs)}`),
      summarised.payload === null
        ? null
        : h('pre', { class: 'dt-code' }, prettyJson(summarised.payload)),
    );

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
    const trace = openTrace();
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
    // past is what a live trace list is for.
    if (spans.length > SPAN_CAPACITY) spans = spans.slice(spans.length - SPAN_CAPACITY);
    regroup();
  });

  const disposeTheme = effect(render, [currentTheme]);
  const onResize = (): void => { if (openTrace() !== null) draw(); };
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

/* ------------------------------- summarising ------------------------------ */

/** One trace, reduced to the line a list can show. */
interface TraceSummary {
  /** `sender → actor → actor`, the hops the message actually made. */
  readonly route: string;
  readonly messageType: string;
  readonly payload: string | null;
}

/**
 * Reduce a trace to sender, route and payload.
 *
 * The route is the actor paths in time order with consecutive repeats
 * collapsed: an actor that handles two messages in one trace is one hop,
 * not two, which is what "where did this go?" means.
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

/** Re-indent captured JSON; it arrives compact to keep the wire small. */
function prettyJson(payload: string): string {
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    // Truncated, so no longer parseable — showing it raw beats hiding it.
    return payload;
  }
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
    // "Waiting for traffic" alone reads as broken next to an overview
    // that is counting hundreds of messages a minute — most of which,
    // on an idle system, are DevTools talking to this very browser.
    return h('div', { class: 'dt-emptystate' },
      h('p', { class: 'dt-empty' }, 'Recording. Nothing from your actors yet.'),
      h('p', { class: 'dt-empty' },
        "DevTools' own messages are excluded: its hub publishes the spans it "
        + 'just recorded, so tracing them would feed every batch back in as the '
        + 'payload of the next one.'),
      h('p', { class: 'dt-empty' },
        'So an otherwise idle system can show a message rate on the overview '
        + 'while this list stays empty — that traffic is the tool, not the '
        + 'application. Make your actors do something and it will appear here.'),
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
        barLabel(rectangle.span.span),
        rectangle.x + 5,
        rectangle.y + rectangle.height / 2,
      );
      context.restore();
    }
  }
}

/**
 * Every actor span is called `actor.receive`, so the span name alone
 * labels every bar identically.  The actor and the message are what
 * tell them apart.
 */
function barLabel(span: WireSpan): string {
  if (span.actorPath === null) return span.name;
  const actor = shortActorPath(span.actorPath);
  return span.messageType === null ? actor : `${actor} · ${span.messageType}`;
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
  if (span.senderPath !== null) rows.push(['From', shortActorPath(span.senderPath)]);
  if (span.actorPath !== null) rows.push(['To', shortActorPath(span.actorPath)]);
  if (span.messageType !== null) rows.push(['Message', span.messageType]);
  if (span.exceptions.length > 0) rows.push(['Exceptions', span.exceptions.join('; ')]);
  rows.push(['Trace', `${trace.traceId.slice(0, 16)}… (${formatCount(trace.spans.length)} spans)`]);

  const lifted = new Set(['actor.path', 'actor.message.type', 'actor.sender', 'actor.message.payload']);
  const attributes = Object.entries(span.attributes).filter(([key]) => !lifted.has(key));

  replaceChildren(host,
    h('dl', { class: 'dt-kv' }, ...rows.flatMap(([key, value]) => [
      h('dt', {}, key),
      h('dd', { title: value }, value),
    ])),
    span.messagePayload === null
      ? null
      : h('pre', { class: 'dt-code' }, prettyJson(span.messagePayload)),
    attributes.length === 0 ? null : h('dl', { class: 'dt-kv dt-kv--muted' },
      ...attributes.flatMap(([key, value]) => [h('dt', {}, key), h('dd', {}, String(value))]),
    ),
  );
}

/** Sub-millisecond spans are the common case, so show enough digits. */
function formatMilliseconds(value: number): string {
  if (value >= 100) return `${value.toFixed(0)} ms`;
  if (value >= 1) return `${value.toFixed(2)} ms`;
  return `${(value * 1000).toFixed(0)} µs`;
}
