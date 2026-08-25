import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';

import { ChartThemeService } from '../../app/charts/ChartThemeService.js';
import { EChartComponent } from '../../app/charts/EChartComponent.js';
import type { DevToolsChartOption } from '../../app/charts/echartsModules.js';
import { buildLineChartOption, buildSparklineOption, type ChartLine } from '../../app/charts/timeSeriesOptions.js';
import { TapClientService } from '../../app/TapClientService.js';
import { TimeControlService } from '../../app/TimeControlService.js';
import { formatCount, formatDuration, shortActorPath } from '../../core/format.js';
import { peakOf, StatsHistory, type SeriesPoint } from '../../core/history.js';
import { uptimeMillis, type UptimeAnchor } from './uptime.js';
import {
  STATS_HISTORY_DEFAULT_SPAN_MS,
  STATS_HISTORY_SPANS_MS,
  type NodeSample,
  type StatsHistoryResult,
  type StatsSamplePayload,
} from '../../../../src/devtools/protocol/index.js';

/**
 * Backstop on plotted points.
 *
 * The window is bounded by time, not by count — see `StatsHistory` — so this
 * only guards a very long session on a very short span.
 */
const HISTORY_CAPACITY = 6_000;

/** Where the chosen timespan is remembered, alongside the theme. */
const SPAN_STORAGE_KEY = 'actor-ts.devtools.span';

/** Uptime has to advance on its own; nothing pushes a frame for it. */
const CLOCK_INTERVAL_MS = 1000;

/**
 * Why three of the figures on this page can be missing.
 *
 * A registry that forwards its writes to a foreign collector — the
 * `promClientRegistry` bridge — keeps no snapshot, so the server cannot read
 * back what it wrote.  The figures then arrive as 0, which on a busy system
 * is not just wrong but reassuring, and one of them is the framework's own
 * overload signal (#744).
 */
const METRICS_UNAVAILABLE_TITLE =
  'Unavailable — this node\'s MetricsRegistry does not support collect(). '
  + 'With promClientRegistry these figures live on prom-client\'s own /metrics '
  + 'route instead.';

/** One figure, with the shape it has been making. */
type Tile = {
  readonly label: string;
  readonly value: string;
  readonly accent?: boolean;
  readonly alert?: boolean;
  readonly title?: string;
  readonly option?: DevToolsChartOption;
};

/** A chart, with its legend and the option that draws it. */
type ChartBlock = {
  readonly title: string;
  readonly lines: readonly ChartLine[];
  readonly peak: string;
  readonly option: DevToolsChartOption;
};

/**
 * The timespan this browser last chose.
 *
 * Persisted because it is a preference, not a session detail: someone who works
 * in "last 1 h" wants that after a reload, and reloading is often the first
 * thing they do when something looks wrong.  `localStorage` throws in a
 * sandboxed context, so a failure just means the default.
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

/** `90s`, `5min`, `2h` — short enough for an option label. */
function spanLabel(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 3_600_000)} h`;
}

/**
 * What a metrics-derived tile shows when the node cannot read its registry.
 *
 * A dash rather than a zero, and flagged as an alert: the whole point of the
 * flag behind it is that "0 mailbox drops" and "no reading" look identical
 * and mean opposite things.
 */
function unreadableTile(label: string): Tile {
  return { label, value: '—', alert: true, title: METRICS_UNAVAILABLE_TITLE };
}

/** Latency reads in ms, and the interesting range spans four decades. */
function formatMillis(value: number): string {
  if (value < 1) return `${value.toFixed(2)} ms`;
  if (value < 100) return `${value.toFixed(1)} ms`;
  return `${Math.round(value)} ms`;
}

/**
 * The overview — the page DevTools opens on.
 *
 * Three sections, in the order you actually ask the questions: *what am I
 * looking at* (identity and uptime), *how much is it doing* (the numbers), *and
 * is that normal* (the same numbers over time).  It is deliberately not a menu
 * — the nav rail is the way into the tools, and duplicating it here only pushed
 * the figures below the fold.
 *
 * Every figure carries a sparkline and feeds a chart, because a single number
 * cannot tell you whether 40 queued messages is the steady state or the start
 * of a pile-up.
 */
@Component({
  selector: 'devtools-dashboard-panel',
  imports: [EChartComponent, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './DashboardPanelComponent.html',
})
export class DashboardPanelComponent {
  private readonly tap = inject(TapClientService);
  private readonly time = inject(TimeControlService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly chartTheme = inject(ChartThemeService).theme;

  readonly spanChoices = STATS_HISTORY_SPANS_MS;

  private readonly history = new StatsHistory(HISTORY_CAPACITY, storedSpanMs());
  private uptimeAnchor: UptimeAnchor | null = null;

  /** Bumped whenever the history changes, so the derived views recompute. */
  private readonly revision = signal(0);
  private readonly now = signal(Date.now());

  readonly spanMs = signal(storedSpanMs());
  private readonly resolutionMs = signal(0);

  /**
   * When the connection went away, or `null` while something answers.
   *
   * Every other figure on the page stops of its own accord when the samples
   * stop, because it is a number somebody sent us.  Uptime is the exception: it
   * is interpolated locally between samples, so left alone it keeps counting
   * past the death of the system it measures — the one figure here that would
   * invent data.  Freezing the clock at the moment contact was lost stops it at
   * the last thing we were actually told, and the first sample after a
   * reconnect corrects it.
   */
  private readonly frozenAtMs = signal<number | null>(null);

  private readonly latest = computed<StatsSamplePayload | null>(() => {
    this.revision();
    return this.history.latest();
  });

  readonly collecting = computed(() => {
    this.revision();
    return this.history.size < 2;
  });

  /**
   * Say the resolution out loud: a day of data in two-minute buckets is a
   * different chart from a minute of it per second, and only the label
   * distinguishes them.
   */
  readonly spanNote = computed(() => {
    this.revision();
    const resolution = this.resolutionMs();
    return resolution === 0
      ? ''
      : `${formatCount(this.history.size)} points · ${spanLabel(resolution)} resolution`;
  });

  readonly commonTiles = computed<readonly Tile[]>(() => {
    const welcome = this.tap.welcome();
    if (welcome === null) return [{ label: 'Connection', value: 'connecting…' }];
    const frozen = this.frozenAtMs();
    const uptimeMs = uptimeMillis(this.uptimeAnchor, welcome, frozen ?? this.now());
    const latest = this.latest();
    return [
      { label: 'Actor system', value: welcome.systemName, accent: true },
      // Beside the system name, because the two together are the identity —
      // *what* this is and *which* version of it — while uptime, runtime and
      // cluster below are all state.  The badge tooltip carries the version too,
      // but a screenshot of the overview is what people paste into a bug report,
      // and a tooltip does not survive one.
      {
        label: 'actor-ts',
        value: welcome.serverVersion,
        title: `Tap protocol v${welcome.protocolVersion}`,
      },
      {
        label: 'Uptime',
        value: uptimeMs === null ? '—' : formatDuration(uptimeMs),
        // The one tile whose stillness needs explaining: the others plainly
        // stopped being updated, this one plainly stopped counting.
        ...(frozen === null ? {} : { title: 'Stopped — nothing has answered since this reading' }),
      },
      { label: 'Runtime', value: latest?.runtime ?? '—' },
      this.clusterTile(latest),
      // Only when there is something to say.  A "Metrics: available" tile on
      // every healthy system would be noise, and the tiles below already read
      // as available by carrying a number.
      ...(latest?.metricsUnavailable === true
        ? [{
          label: 'Metrics',
          value: 'unavailable',
          alert: true,
          title: METRICS_UNAVAILABLE_TITLE,
        } satisfies Tile]
        : []),
    ];
  });

  readonly numberTiles = computed<readonly Tile[]>(() => {
    this.revision();
    const latest = this.latest();
    if (latest === null) return [{ label: 'Live figures', value: 'waiting for first sample…' }];
    const history = this.history;
    const palette = this.chartTheme().series;
    const spark = (points: readonly SeriesPoint[], index: number): DevToolsChartOption | undefined =>
      (points.length > 1 ? buildSparklineOption(points, palette[index]!) : undefined);
    // Exactly three figures here come from the metrics registry; the rest are
    // read from the actor tree and the event stream and stay correct even
    // when the registry cannot be collected.  Blanking the whole panel would
    // hide the figures that are still true (#744).
    const blind = latest.metricsUnavailable === true;

    return [
      { label: 'Actors', value: formatCount(latest.actorCount), option: spark(history.levels('actorCount'), 0) },
      blind ? unreadableTile('Messages / s') : { label: 'Messages / s', value: history.latestRate('messagesProcessed').toFixed(1), option: spark(history.rates('messagesProcessed'), 0) },
      blind ? unreadableTile('Processed messages') : { label: 'Processed messages', value: formatCount(latest.messagesProcessed) },
      { label: 'Spawns / s', value: history.latestRate('actorsStarted').toFixed(1), option: spark(history.rates('actorsStarted'), 1) },
      { label: 'Stops / s', value: history.latestRate('actorsStopped').toFixed(1), option: spark(history.rates('actorsStopped'), 5) },
      { label: 'Restarts', value: formatCount(latest.actorsRestarted), option: spark(history.rates('actorsRestarted'), 4), alert: latest.actorsRestarted > 0 },
      { label: 'Mailbox backlog', value: formatCount(latest.mailboxBacklog), option: spark(history.levels('mailboxBacklog'), latest.mailboxBacklog > 0 ? 2 : 1) },
      { label: 'Stashed', value: formatCount(latest.stashedTotal), option: spark(history.levels('stashedTotal'), 5) },
      { label: 'Suspended actors', value: formatCount(latest.suspendedActors), option: spark(history.levels('suspendedActors'), 4), alert: latest.suspendedActors > 0 },
      { label: 'Dead letters', value: formatCount(latest.deadLetters), option: spark(history.rates('deadLetters'), 3), alert: latest.deadLetters > 0 },
      blind ? unreadableTile('Mailbox drops') : {
        label: 'Mailbox drops',
        value: formatCount(latest.mailboxDrops),
        option: spark(history.rates('mailboxDrops'), 3),
        alert: latest.mailboxDrops > 0,
        title: 'Messages a bounded mailbox threw away on overflow.',
      },
      blind ? unreadableTile('Handler p99') : this.latencyTile(latest),
    ];
  });

  /**
   * Self first, then by address — a cluster view is read from the node you are
   * attached to outwards.
   */
  readonly nodes = computed<readonly NodeSample[]>(() => {
    const latest = this.latest();
    return [...(latest?.nodes ?? [])].sort((a, b) =>
      Number(b.isSelf) - Number(a.isSelf) || a.figures.address.localeCompare(b.figures.address));
  });

  readonly hotList = computed(() => {
    const entries = this.latest()?.topMailboxes ?? [];
    const peak = Math.max(...entries.map((entry) => entry.size), 1);
    return entries.map((entry) => ({ ...entry, percent: (entry.size / peak) * 100 }));
  });

  /**
   * Three charts rather than one, because a level and a rate cannot share a
   * y-axis honestly: a backlog of 400 flattens a 2/s line to nothing.  Each
   * chart holds one kind of quantity and scales to its own peak.
   */
  readonly charts = computed<readonly ChartBlock[]>(() => {
    this.revision();
    const theme = this.chartTheme();
    const history = this.history;
    const line = (label: string, index: number, points: readonly SeriesPoint[]): ChartLine =>
      ({ label, color: theme.series[index]!, points });

    const blocks: Array<{ title: string; lines: ChartLine[] }> = [
      {
        title: 'Throughput',
        lines: [
          line('messages / s', 0, history.rates('messagesProcessed')),
          line('dead letters / s', 3, history.rates('deadLetters')),
        ],
      },
      {
        title: 'Actors',
        lines: [
          line('actors', 1, history.levels('actorCount')),
          line('suspended', 4, history.levels('suspendedActors')),
        ],
      },
      {
        title: 'Backlog',
        lines: [
          line('mailbox backlog', 2, history.levels('mailboxBacklog')),
          line('stashed', 5, history.levels('stashedTotal')),
        ],
      },
    ];

    return blocks.map((block) => ({
      title: block.title,
      lines: block.lines,
      peak: formatCount(Math.max(...block.lines.map((entry) => peakOf(entry.points)), 0)),
      option: buildLineChartOption(block.lines, theme),
    }));
  });

  constructor() {
    this.destroyRef.onDestroy(this.tap.listen('stats', (payload) => {
      if (payload.kind !== 'stats-sample') return;
      this.history.push(payload);
      this.uptimeAnchor = { uptimeMs: payload.uptimeMs, receivedAtMs: this.time.nowMs() };
      this.touch();
    }));

    // Stamped on the way down and only cleared by a real `open`, so a reconnect
    // that flickers `closed` → `connecting` → `closed` cannot walk the clock
    // forward one transition at a time.
    effect(() => {
      const open = this.tap.status() === 'open';
      this.frozenAtMs.update((frozen) => (open ? null : frozen ?? Date.now()));
    });

    const clock = setInterval(() => {
      // Uptime is interpolated locally, so it is the one figure here that would
      // keep inventing data through a pause.  Every other tile stopped because
      // its samples stopped.
      if (this.time.paused()) return;
      this.now.set(Date.now());
    }, CLOCK_INTERVAL_MS);
    this.destroyRef.onDestroy(() => clearInterval(clock));

    // Resuming jumps the charts to now, which on its own would leave a hole
    // exactly the width of the pause.  The server records continuously
    // (`StatsHistoryStore`), so asking for the window again fills it in —
    // pausing then costs no history at all (#1349).
    let wasPaused = this.time.paused();
    effect(() => {
      const paused = this.time.paused();
      const resumed = wasPaused && !paused;
      wasPaused = paused;
      if (resumed) void this.loadHistory(this.spanMs());
    });

    void this.loadHistory(this.spanMs());
  }

  count(value: number): string { return formatCount(value); }
  duration(ms: number): string { return formatDuration(ms); }
  label(ms: number): string { return spanLabel(ms); }
  shorten(path: string): string { return shortActorPath(path); }

  nodeTitle(node: NodeSample): string {
    const base = node.stale
      ? `Last answered ${formatDuration(this.now() - node.receivedAtMs)} ago`
      : node.figures.address;
    return node.figures.metricsUnavailable === true
      ? `${base} — ${METRICS_UNAVAILABLE_TITLE}`
      : base;
  }

  /**
   * One node's message count, or a dash when that node could not read its
   * own registry.
   *
   * Per node rather than per cluster: the bridge is installed on a system,
   * so in a mixed deployment one node can be blind while its peers report
   * honestly, and a shared dash would throw away the peers' figures.
   */
  nodeMessages(node: NodeSample): string {
    return node.figures.metricsUnavailable === true
      ? '—'
      : formatCount(node.figures.messagesProcessed);
  }

  onSpan(event: Event): void {
    void this.loadHistory(Number((event.target as HTMLSelectElement).value));
  }

  /**
   * Fetch the chosen window from the server.
   *
   * The server has been recording since it attached, so switching to "last 24
   * hours" fills the charts immediately instead of starting an empty one that
   * would take a day to become useful.
   */
  private async loadHistory(wantedMs: number): Promise<void> {
    this.spanMs.set(wantedMs);
    rememberSpanMs(wantedMs);
    try {
      const result = await this.tap.request<StatsHistoryResult>('stats.history', { spanMs: wantedMs });
      this.resolutionMs.set(result.resolutionMs);
      this.history.seed(result.points, result.spanMs);
    } catch {
      // An older server, or the request failed — keep collecting live rather
      // than blanking a chart that already has something in it.
      this.resolutionMs.set(0);
    }
    this.touch();
  }

  /** Fold new data in.  Kept out of the computeds, which stay pure. */
  private touch(): void {
    this.now.set(this.time.nowMs());
    this.revision.update((value) => value + 1);
  }

  private clusterTile(latest: StatsSamplePayload | null): Tile {
    const cluster = latest?.cluster;
    if (cluster === undefined) {
      return { label: 'Cluster', value: latest === null ? '—' : 'not clustered' };
    }
    const leader = cluster.leader ?? 'none';
    return {
      label: 'Cluster',
      value: `${cluster.up} / ${cluster.members} up`,
      alert: cluster.unreachable > 0,
      title: `leader ${leader} · self ${cluster.selfAddress}`
        + (cluster.unreachable > 0 ? ` · ${cluster.unreachable} unreachable` : ''),
    };
  }

  private latencyTile(latest: StatsSamplePayload): Tile {
    const latency = latest.handlerLatency;
    if (latency === undefined) return { label: 'Handler p99', value: '—' };
    return {
      label: 'Handler p99',
      value: formatMillis(latency.p99Ms),
      title: `p50 ${formatMillis(latency.p50Ms)} over ${formatCount(latency.count)} messages`
        + ' — interpolated from histogram buckets, so approximate.',
    };
  }
}

/** The registry loads this module and reads this export. */
export const panelComponent = DashboardPanelComponent;
