/**
 * The dashboard — the page DevTools opens on.
 *
 * Two jobs.  First, answer "what am I looking at and is it healthy?"
 * at a glance, without picking a tool.  Second, be the map: one card
 * per panel, each either a link or a greyed card saying *why* it is
 * not available, so nothing about this system's capabilities is hidden
 * behind a click that fails.
 *
 * Every figure carries a sparkline and feeds the chart below, because
 * a single number cannot tell you whether 40 queued messages is the
 * steady state or the start of a pile-up.
 */
import { h, replaceChildren } from '../../core/dom.js';
import { panelHref } from '../../core/router.js';
import { effect } from '../../core/signal.js';
import { formatCount, formatDuration, formatTime, shortActorPath } from '../../core/format.js';
import { DEVTOOLS_PROTOCOL_VERSION } from '../../core/tapClient.js';
import { peakOf, StatsHistory, type SeriesPoint } from '../../core/history.js';
import { drawChart, drawSparkline, themeColor, type ChartSeries } from '../../render/timeseries.js';
import { currentTheme } from '../../core/theme.js';
import { registeredPanels, type PanelContext, type PanelInstance } from '../../shell/PanelRegistry.js';
import { panelStatusOf } from '../../shell/panelStatus.js';
import type { StatsSamplePayload, WelcomeFrame } from '../../../../src/devtools/protocol/index.js';

/** Roughly fifteen minutes at the server's default one-second tick. */
const HISTORY_CAPACITY = 900;

/** Uptime has to advance on its own; nothing pushes a frame for it. */
const CLOCK_INTERVAL_MS = 1000;

export function mount(host: HTMLElement, context: PanelContext): PanelInstance {
  const history = new StatsHistory(HISTORY_CAPACITY);

  const tiles = h('div', { class: 'dt-tiles' });
  const chartCanvas = h('canvas', { class: 'dt-chart__canvas' }) as HTMLCanvasElement;
  const chartLegend = h('div', { class: 'dt-chart__legend' });
  const hotList = h('div', { class: 'dt-hotlist' });
  const cards = h('div', { class: 'dt-cards' });

  replaceChildren(host,
    h('h1', { class: 'dt-panel__title' }, 'Overview'),
    h('p', { class: 'dt-panel__subtitle' }, 'System at a glance, and the way into every tool.'),
    tiles,
    h('section', { class: 'dt-chart' },
      h('h2', { class: 'dt-section' }, 'Last few minutes'),
      chartLegend,
      chartCanvas,
    ),
    h('section', {},
      h('h2', { class: 'dt-section' }, 'Busiest mailboxes'),
      hotList,
    ),
    h('h2', { class: 'dt-section' }, 'Tools'),
    cards,
  );

  const render = (): void => {
    renderTiles(tiles, context.tap.welcome.get(), history);
    renderChart(chartCanvas, chartLegend, history);
    renderHotList(hotList, history.latest());
  };

  const stopListening = context.tap.listen('stats', (payload) => {
    if (payload.kind !== 'stats-sample') return;
    history.push(payload);
    render();
  });

  const disposeWelcome = effect(() => {
    renderTiles(tiles, context.tap.welcome.get(), history);
    replaceChildren(cards, ...buildCards(context.tap.welcome.get()));
  }, [context.tap.welcome]);

  // Canvas colours are read from CSS variables, so a theme flip needs a
  // repaint — nothing re-renders on its own.
  const disposeTheme = effect(render, [currentTheme]);

  const clock = setInterval(
    () => renderTiles(tiles, context.tap.welcome.get(), history),
    CLOCK_INTERVAL_MS,
  );
  const onResize = (): void => renderChart(chartCanvas, chartLegend, history);
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

/* -------------------------------- tiles --------------------------------- */

function renderTiles(host: HTMLElement, welcome: WelcomeFrame | null, history: StatsHistory): void {
  if (welcome === null) {
    replaceChildren(host, tile('Connection', 'connecting…'));
    return;
  }
  const latest = history.latest();
  const parts: HTMLElement[] = [
    tile('Actor system', welcome.systemName, { accent: true }),
    tile('Uptime', formatDuration(Date.now() - welcome.startedAtMs)),
  ];

  if (latest === null) {
    // Subscribed, but the stream has not ticked yet.
    parts.push(
      tile('Framework', welcome.serverVersion),
      tile('Tap protocol', `v${DEVTOOLS_PROTOCOL_VERSION}`),
      tile('Live figures', 'waiting for first sample…'),
    );
    replaceChildren(host, ...parts, panelCountTile(welcome));
    return;
  }

  parts.push(
    tile('Runtime', latest.runtime),
    tile('Actors', formatCount(latest.actorCount), {
      series: history.levels('actorCount'),
      color: '--dt-data-1',
    }),
    tile('Mailbox backlog', formatCount(latest.mailboxBacklog), {
      series: history.levels('mailboxBacklog'),
      color: latest.mailboxBacklog > 0 ? '--dt-data-3' : '--dt-data-2',
    }),
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
    tile('Dead letters', formatCount(latest.deadLetters), {
      series: history.rates('deadLetters'),
      color: '--dt-data-4',
      alert: latest.deadLetters > 0,
    }),
  );

  const cluster = latest.cluster;
  if (cluster !== undefined) {
    parts.push(tile('Cluster', `${cluster.up} / ${cluster.members} up`, {
      alert: cluster.unreachable > 0,
    }));
  }

  parts.push(tile('Attached since', formatTime(welcome.startedAtMs)));
  replaceChildren(host, ...parts, panelCountTile(welcome));
}

function panelCountTile(welcome: WelcomeFrame): HTMLElement {
  const active = welcome.panels.filter((panel) => panel.status === 'active').length;
  return tile('Tools available', `${active} / ${welcome.panels.length}`);
}

interface TileOptions {
  readonly accent?: boolean;
  readonly alert?: boolean;
  readonly series?: ReadonlyArray<SeriesPoint>;
  /** CSS custom property naming the series colour. */
  readonly color?: string;
}

function tile(label: string, value: string, options: TileOptions = {}): HTMLElement {
  const classes = ['dt-tile__value'];
  if (options.accent) classes.push('dt-tile__accent');
  if (options.alert) classes.push('dt-tile__alert');

  const node = h('div', { class: 'dt-tile' },
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

/* -------------------------------- chart --------------------------------- */

function renderChart(canvas: HTMLCanvasElement, legend: HTMLElement, history: StatsHistory): void {
  if (history.size < 2) {
    replaceChildren(legend, h('span', { class: 'dt-empty' }, 'collecting samples…'));
    return;
  }
  const series: ChartSeries[] = [
    {
      label: 'mailbox backlog',
      color: themeColor('--dt-data-3', '#f59e0b'),
      points: history.levels('mailboxBacklog'),
    },
    {
      label: 'spawns / s',
      color: themeColor('--dt-data-2', '#22c55e'),
      points: history.rates('actorsStarted'),
    },
    {
      label: 'dead letters / s',
      color: themeColor('--dt-data-4', '#ef4444'),
      points: history.rates('deadLetters'),
    },
  ];
  // One shared scale keeps the lines comparable; scaling each to itself
  // would make a quiet series look as busy as a loud one.
  const peak = Math.max(...series.map((line) => peakOf(line.points)), 0);

  replaceChildren(legend,
    ...series.map((line) => h('span', { class: 'dt-legend__item' },
      h('span', { class: 'dt-legend__swatch', style: `background:${line.color}` }),
      line.label,
    )),
    h('span', { class: 'dt-legend__peak' }, `peak ${formatCount(peak)}`),
  );
  drawChart(canvas, series, peak);
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

/* --------------------------------- cards --------------------------------- */

function buildCards(welcome: WelcomeFrame | null): ReadonlyArray<HTMLElement> {
  const panels = registeredPanels().filter((panel) => panel.id !== 'dashboard');
  if (panels.length === 0) {
    return [h('p', { class: 'dt-empty' }, 'No tools are registered in this build.')];
  }
  return panels.map((panel) => {
    const descriptor = panelStatusOf(welcome, panel.id);
    if (descriptor.status === 'active') {
      return h('a', { class: 'dt-card', href: panelHref(panel.id) },
        h('div', { class: 'dt-card__title' }, panel.title),
        h('div', { class: 'dt-card__text' }, panel.description),
        h('span', { class: 'dt-card__badge' }, 'open'),
      );
    }
    return h('div', { class: 'dt-card dt-card--unavailable' },
      h('div', { class: 'dt-card__title' }, panel.title),
      h('div', { class: 'dt-card__text' }, descriptor.reason ?? panel.description),
      h('span', { class: 'dt-card__badge dt-card__badge--unavailable' }, descriptor.status),
    );
  });
}
