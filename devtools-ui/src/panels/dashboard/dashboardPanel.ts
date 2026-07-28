/**
 * The overview — the page DevTools opens on.
 *
 * Three sections, in the order you actually ask the questions: *what am
 * I looking at* (identity and uptime), *how much is it doing* (the
 * numbers), *and is that normal* (the same numbers over time).  It is
 * deliberately not a menu — the nav rail is the way into the tools, and
 * duplicating it here only pushed the figures below the fold.
 *
 * Every figure carries a sparkline and feeds a chart, because a single
 * number cannot tell you whether 40 queued messages is the steady state
 * or the start of a pile-up.
 */
import { h, replaceChildren } from '../../core/dom.js';
import { effect } from '../../core/signal.js';
import { formatCount, formatDuration, shortActorPath } from '../../core/format.js';
import { peakOf, StatsHistory, type SeriesPoint } from '../../core/history.js';
import { drawChart, drawSparkline, themeColor, type ChartSeries } from '../../render/timeseries.js';
import { currentTheme } from '../../core/theme.js';
import type { PanelContext, PanelInstance } from '../../shell/PanelRegistry.js';
import {
  STATS_HISTORY_DEFAULT_SPAN_MS,
  STATS_HISTORY_SPANS_MS,
  type NodeSample,
  type StatsHistoryResult,
  type StatsSamplePayload,
  type WelcomeFrame,
} from '../../../../src/devtools/protocol/index.js';

/**
 * Backstop on plotted points.
 *
 * The window is bounded by time, not by count — see `StatsHistory` — so
 * this only guards a very long session on a very short span.
 */
const HISTORY_CAPACITY = 6_000;

/** Where the chosen timespan is remembered, alongside the theme. */
const SPAN_STORAGE_KEY = 'actor-ts.devtools.span';

/**
 * The timespan this browser last chose.
 *
 * Persisted because it is a preference, not a session detail: someone
 * who works in "last 1 h" wants that after a reload, and reloading is
 * often the first thing they do when something looks wrong.
 * `localStorage` throws in a sandboxed context, so a failure just means
 * the default.
 */
function storedSpanMs(): number {
  try {
    const raw = Number(window.localStorage.getItem(SPAN_STORAGE_KEY));
    return STATS_HISTORY_SPANS_MS.includes(raw) ? raw : STATS_HISTORY_DEFAULT_SPAN_MS;
  } catch {
    return STATS_HISTORY_DEFAULT_SPAN_MS;
  }
}

function rememberSpanMs(spanMs: number): void {
  try {
    window.localStorage.setItem(SPAN_STORAGE_KEY, String(spanMs));
  } catch {
    /* nothing to do — the choice simply will not survive the reload */
  }
}

/** Uptime has to advance on its own; nothing pushes a frame for it. */
const CLOCK_INTERVAL_MS = 1000;

/**
 * Server uptime plus the local time since we were told it.
 *
 * Reading the server's own figure rather than differencing wall clocks
 * keeps the tile right across a reload, a reconnect, and a browser whose
 * clock disagrees with the host's.
 */
interface UptimeAnchor {
  readonly uptimeMs: number;
  readonly receivedAtMs: number;
}

export function mount(host: HTMLElement, context: PanelContext): PanelInstance {
  let spanMs = storedSpanMs();
  const history = new StatsHistory(HISTORY_CAPACITY, spanMs);
  let uptime: UptimeAnchor | null = null;
  let resolutionMs = 0;

  const commonTiles = h('div', { class: 'dt-tiles' });
  const numberTiles = h('div', { class: 'dt-tiles' });
  const throughput = chartBlock('Throughput');
  const population = chartBlock('Actors');
  const backlog = chartBlock('Backlog');
  const hotList = h('div', { class: 'dt-hotlist' });
  const spanNote = h('span', { class: 'dt-toolbar__summary' });

  const spanChooser = h('select', {
    class: 'dt-input',
    'aria-label': 'Charted timespan',
    onchange: (event: Event) => {
      void loadHistory(Number((event.target as HTMLSelectElement).value));
    },
  }, ...STATS_HISTORY_SPANS_MS.map((choice) => h('option', {
    value: String(choice),
    ...(choice === spanMs ? { selected: true } : {}),
  }, `last ${spanLabel(choice)}`))) as HTMLSelectElement;

  /**
   * Fetch the chosen window from the server.
   *
   * The server has been recording since it attached, so switching to
   * "last 24 hours" fills the charts immediately instead of starting an
   * empty one that would take a day to become useful.
   */
  async function loadHistory(wantedMs: number): Promise<void> {
    spanMs = wantedMs;
    rememberSpanMs(wantedMs);
    try {
      const result = await context.tap.request<StatsHistoryResult>(
        'stats.history', { spanMs: wantedMs },
      );
      resolutionMs = result.resolutionMs;
      history.seed(result.points, result.spanMs);
    } catch {
      // An older server, or the request failed — keep collecting live
      // rather than blanking a chart that already has something in it.
      resolutionMs = 0;
    }
    spanChooser.value = String(spanMs);
    render();
  }
  const nodeTable = h('div', { class: 'dt-nodetable' });
  const nodeSection = h('section', {},
    h('h2', { class: 'dt-section' }, 'Per node'),
    nodeTable,
  );

  replaceChildren(host,
    h('h1', { class: 'dt-panel__title' }, 'Overview'),
    h('p', { class: 'dt-panel__subtitle' }, 'What this system is, what it is doing, and how that is trending.'),
    h('div', { class: 'dt-toolbar' }, spanChooser, spanNote),
    h('section', {},
      h('h2', { class: 'dt-section' }, 'Common'),
      commonTiles,
    ),
    h('section', {},
      h('h2', { class: 'dt-section' }, 'Numbers'),
      numberTiles,
    ),
    nodeSection,
    h('section', {},
      h('h2', { class: 'dt-section' }, 'Charts'),
      h('div', { class: 'dt-charts' }, throughput.node, population.node, backlog.node),
      h('h3', { class: 'dt-chart__title' }, 'Busiest mailboxes'),
      hotList,
    ),
  );

  const renderTiles = (): void => {
    const welcome = context.tap.welcome.get();
    renderCommon(commonTiles, welcome, history, uptimeMillis(uptime, welcome));
    renderNumbers(numberTiles, history);
    renderNodes(nodeSection, nodeTable, history.latest());
  };
  const render = (): void => {
    renderTiles();
    // Say the resolution out loud: a day of data in two-minute buckets
    // is a different chart from a minute of it per second, and only the
    // label distinguishes them.
    spanNote.textContent = resolutionMs === 0
      ? ''
      : `${formatCount(history.size)} points · ${spanLabel(resolutionMs)} resolution`;
    renderCharts(throughput, population, backlog, history);
    renderHotList(hotList, history.latest());
  };

  const stopListening = context.tap.listen('stats', (payload) => {
    if (payload.kind !== 'stats-sample') return;
    history.push(payload);
    uptime = { uptimeMs: payload.uptimeMs, receivedAtMs: Date.now() };
    render();
  });

  const disposeWelcome = effect(renderTiles, [context.tap.welcome]);

  // Canvas colours are read from CSS variables, so a theme flip needs a
  // repaint — nothing re-renders on its own.
  const disposeTheme = effect(render, [currentTheme]);

  void loadHistory(spanMs);
  const clock = setInterval(renderTiles, CLOCK_INTERVAL_MS);
  const onResize = (): void => renderCharts(throughput, population, backlog, history);
  window.addEventListener('resize', onResize);

  return {
    dispose(): void {
      clearInterval(clock);
      window.removeEventListener('resize', onResize);
      stopListening();
      disposeWelcome();
      disposeTheme();
    },
  };
}

/** `90s`, `5min`, `2h` — short enough for an option label. */
function spanLabel(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 3_600_000)} h`;
}

/* -------------------------------- uptime -------------------------------- */

function uptimeMillis(anchor: UptimeAnchor | null, welcome: WelcomeFrame | null): number | null {
  if (anchor !== null) return anchor.uptimeMs + (Date.now() - anchor.receivedAtMs);
  // Before the first sample the handshake is all we have.  It reports
  // the system's start, so this is right too — just clock-skewed on a
  // remote host.
  return welcome === null ? null : Date.now() - welcome.startedAtMs;
}

/* ----------------------------- common section ---------------------------- */

function renderCommon(
  host: HTMLElement,
  welcome: WelcomeFrame | null,
  history: StatsHistory,
  uptimeMs: number | null,
): void {
  if (welcome === null) {
    replaceChildren(host, tile('Connection', 'connecting…'));
    return;
  }
  const latest = history.latest();
  replaceChildren(host,
    tile('Actor system', welcome.systemName, { accent: true }),
    tile('Uptime', uptimeMs === null ? '—' : formatDuration(uptimeMs)),
    tile('Runtime', latest?.runtime ?? '—'),
    clusterTile(latest),
  );
}

function clusterTile(latest: StatsSamplePayload | null): HTMLElement {
  const cluster = latest?.cluster;
  if (cluster === undefined) {
    return tile('Cluster', latest === null ? '—' : 'not clustered');
  }
  const leader = cluster.leader ?? 'none';
  return tile('Cluster', `${cluster.up} / ${cluster.members} up`, {
    alert: cluster.unreachable > 0,
    title: `leader ${leader} · self ${cluster.selfAddress}`
      + (cluster.unreachable > 0 ? ` · ${cluster.unreachable} unreachable` : ''),
  });
}

/* ----------------------------- numbers section --------------------------- */

function renderNumbers(host: HTMLElement, history: StatsHistory): void {
  const latest = history.latest();
  if (latest === null) {
    replaceChildren(host, tile('Live figures', 'waiting for first sample…'));
    return;
  }
  replaceChildren(host,
    tile('Actors', formatCount(latest.actorCount), {
      series: history.levels('actorCount'),
      color: '--dt-data-1',
    }),
    tile('Messages / s', history.latestRate('messagesProcessed').toFixed(1), {
      series: history.rates('messagesProcessed'),
      color: '--dt-data-1',
    }),
    tile('Processed messages', formatCount(latest.messagesProcessed)),
    tile('Spawns / s', history.latestRate('actorsStarted').toFixed(1), {
      series: history.rates('actorsStarted'),
      color: '--dt-data-2',
    }),
    tile('Stops / s', history.latestRate('actorsStopped').toFixed(1), {
      series: history.rates('actorsStopped'),
      color: '--dt-data-6',
    }),
    tile('Restarts', formatCount(latest.actorsRestarted), {
      series: history.rates('actorsRestarted'),
      color: '--dt-data-5',
      alert: latest.actorsRestarted > 0,
    }),
    tile('Mailbox backlog', formatCount(latest.mailboxBacklog), {
      series: history.levels('mailboxBacklog'),
      color: latest.mailboxBacklog > 0 ? '--dt-data-3' : '--dt-data-2',
    }),
    tile('Stashed', formatCount(latest.stashedTotal), {
      series: history.levels('stashedTotal'),
      color: '--dt-data-6',
    }),
    tile('Suspended actors', formatCount(latest.suspendedActors), {
      series: history.levels('suspendedActors'),
      color: '--dt-data-5',
      alert: latest.suspendedActors > 0,
    }),
    tile('Dead letters', formatCount(latest.deadLetters), {
      series: history.rates('deadLetters'),
      color: '--dt-data-4',
      alert: latest.deadLetters > 0,
    }),
    tile('Mailbox drops', formatCount(latest.mailboxDrops), {
      series: history.rates('mailboxDrops'),
      color: '--dt-data-4',
      alert: latest.mailboxDrops > 0,
      title: 'Messages a bounded mailbox threw away on overflow.',
    }),
    latencyTile(latest),
  );
}

function latencyTile(latest: StatsSamplePayload): HTMLElement {
  const latency = latest.handlerLatency;
  if (latency === undefined) return tile('Handler p99', '—');
  return tile('Handler p99', formatMillis(latency.p99Ms), {
    title: `p50 ${formatMillis(latency.p50Ms)} over ${formatCount(latency.count)} messages`
      + ' — interpolated from histogram buckets, so approximate.',
  });
}

/** Latency reads in ms, and the interesting range spans four decades. */
function formatMillis(value: number): string {
  if (value < 1) return `${value.toFixed(2)} ms`;
  if (value < 100) return `${value.toFixed(1)} ms`;
  return `${Math.round(value)} ms`;
}

/* --------------------------------- tiles --------------------------------- */

interface TileOptions {
  readonly accent?: boolean;
  readonly alert?: boolean;
  readonly series?: ReadonlyArray<SeriesPoint>;
  /** CSS custom property naming the series colour. */
  readonly color?: string;
  /** Hover text for the figures that need a sentence of context. */
  readonly title?: string;
}

function tile(label: string, value: string, options: TileOptions = {}): HTMLElement {
  const classes = ['dt-tile__value'];
  if (options.accent) classes.push('dt-tile__accent');
  if (options.alert) classes.push('dt-tile__alert');

  const attributes = options.title === undefined
    ? { class: 'dt-tile' }
    : { class: 'dt-tile', title: options.title };
  const node = h('div', attributes,
    h('div', { class: 'dt-tile__label' }, label),
    h('div', { class: classes.join(' ') }, value),
  );

  const series = options.series;
  if (series !== undefined && series.length > 1) {
    const canvas = h('canvas', { class: 'dt-tile__spark' }) as HTMLCanvasElement;
    node.appendChild(canvas);
    // A canvas has no layout size until it is in the document.
    queueMicrotask(() => drawSparkline(
      canvas,
      series,
      themeColor(options.color ?? '--dt-accent', '#818cf8'),
      peakOf(series),
    ));
  }
  return node;
}

/* --------------------------------- charts -------------------------------- */

interface ChartBlock {
  readonly node: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly legend: HTMLElement;
}

function chartBlock(title: string): ChartBlock {
  const canvas = h('canvas', { class: 'dt-chart__canvas' }) as HTMLCanvasElement;
  const legend = h('div', { class: 'dt-chart__legend' });
  return {
    canvas,
    legend,
    node: h('section', { class: 'dt-chart' },
      h('h3', { class: 'dt-chart__title' }, title),
      legend,
      canvas,
    ),
  };
}

/**
 * Three charts rather than one, because a level and a rate cannot share
 * a y-axis honestly: a backlog of 400 flattens a 2/s line to nothing.
 * Each chart holds one kind of quantity and scales to its own peak.
 */
function renderCharts(
  throughput: ChartBlock,
  population: ChartBlock,
  backlog: ChartBlock,
  history: StatsHistory,
): void {
  renderChart(throughput, history, [
    series('messages / s', '--dt-data-1', '#818cf8', history.rates('messagesProcessed')),
    series('dead letters / s', '--dt-data-4', '#ef4444', history.rates('deadLetters')),
  ]);
  renderChart(population, history, [
    series('actors', '--dt-data-2', '#22c55e', history.levels('actorCount')),
    series('suspended', '--dt-data-5', '#a78bfa', history.levels('suspendedActors')),
  ]);
  renderChart(backlog, history, [
    series('mailbox backlog', '--dt-data-3', '#f59e0b', history.levels('mailboxBacklog')),
    series('stashed', '--dt-data-6', '#22d3ee', history.levels('stashedTotal')),
  ]);
}

function series(
  label: string,
  variable: string,
  fallback: string,
  points: ReadonlyArray<SeriesPoint>,
): ChartSeries {
  return { label, color: themeColor(variable, fallback), points };
}

function renderChart(block: ChartBlock, history: StatsHistory, lines: ReadonlyArray<ChartSeries>): void {
  if (history.size < 2) {
    replaceChildren(block.legend, h('span', { class: 'dt-empty' }, 'collecting samples…'));
    return;
  }
  const peak = Math.max(...lines.map((line) => peakOf(line.points)), 0);
  replaceChildren(block.legend,
    ...lines.map((line) => h('span', { class: 'dt-legend__item' },
      h('span', { class: 'dt-legend__swatch', style: `background:${line.color}` }),
      line.label,
    )),
    h('span', { class: 'dt-legend__peak' }, `peak ${formatCount(peak)}`),
  );
  drawChart(block.canvas, lines, peak);
}

/* -------------------------------- per node ------------------------------- */

/**
 * The same figures again, one row per node.
 *
 * Hidden on a system with a single node: a breakdown of one is the
 * totals with extra steps.  It appears the moment a cluster has a second
 * member, which is also the moment the totals stop telling you where
 * something is happening.
 */
function renderNodes(
  section: HTMLElement,
  host: HTMLElement,
  latest: StatsSamplePayload | null,
): void {
  const nodes = latest?.nodes ?? [];
  section.hidden = nodes.length < 2;
  if (section.hidden) return;

  const ordered = [...nodes].sort((a, b) =>
    Number(b.isSelf) - Number(a.isSelf) || a.figures.address.localeCompare(b.figures.address));
  replaceChildren(host,
    h('div', { class: 'dt-nodetable__head' },
      h('span', {}, 'Node'),
      h('span', {}, 'Actors'),
      h('span', {}, 'Messages'),
      h('span', {}, 'Backlog'),
      h('span', {}, 'Restarts'),
      h('span', {}, 'Dead letters'),
      h('span', {}, 'Uptime'),
    ),
    ...ordered.map((node) => nodeRow(node)),
  );
}

function nodeRow(node: NodeSample): HTMLElement {
  const figures = node.figures;
  const classes = ['dt-nodetable__row'];
  if (node.stale) classes.push('dt-nodetable__row--stale');
  return h('div', {
    class: classes.join(' '),
    title: node.stale
      ? `Last answered ${formatDuration(Date.now() - node.receivedAtMs)} ago`
      : figures.address,
  },
    h('span', { class: 'dt-nodetable__address' },
      figures.address,
      node.isSelf ? h('span', { class: 'dt-badge' }, 'self') : null,
      node.stale ? h('span', { class: 'dt-badge dt-badge--error' }, 'not answering') : null,
    ),
    h('span', { class: 'dt-nodetable__figure' }, formatCount(figures.actorCount)),
    h('span', { class: 'dt-nodetable__figure' }, formatCount(figures.messagesProcessed)),
    h('span', { class: 'dt-nodetable__figure' }, formatCount(figures.mailboxBacklog)),
    h('span', { class: 'dt-nodetable__figure' }, formatCount(figures.actorsRestarted)),
    h('span', { class: 'dt-nodetable__figure' }, formatCount(figures.deadLetters)),
    h('span', { class: 'dt-nodetable__figure' }, formatDuration(figures.uptimeMs)),
  );
}

/* ------------------------------- hot list -------------------------------- */

function renderHotList(host: HTMLElement, latest: StatsSamplePayload | null): void {
  const entries = latest?.topMailboxes ?? [];
  if (entries.length === 0) {
    replaceChildren(host, h('p', { class: 'dt-empty' }, 'Every mailbox is empty.'));
    return;
  }
  const peak = Math.max(...entries.map((entry) => entry.size), 1);
  replaceChildren(host, ...entries.map((entry) => h('div', { class: 'dt-hotrow', title: entry.path },
    h('span', { class: 'dt-hotrow__name' }, shortActorPath(entry.path)),
    h('span', { class: 'dt-hotrow__bar' },
      h('span', { class: 'dt-hotrow__fill', style: `width:${(entry.size / peak) * 100}%` }),
    ),
    h('span', { class: 'dt-hotrow__value' }, formatCount(entry.size)),
  )));
}
