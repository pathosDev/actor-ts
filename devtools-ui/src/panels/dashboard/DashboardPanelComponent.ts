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

import { TapClientService } from '../../app/TapClientService.js';
import { formatCount, formatDuration, shortActorPath } from '../../core/format.js';
import { peakOf, StatsHistory, type SeriesPoint } from '../../core/history.js';
import { themeColor, type ChartSeries } from '../../render/timeseries.js';
import { ChartComponent, SparklineComponent } from './canvasCharts.js';
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

/** One figure, with the shape it has been making. */
type Tile = {
  readonly label: string;
  readonly value: string;
  readonly accent?: boolean;
  readonly alert?: boolean;
  readonly title?: string;
  readonly points?: readonly SeriesPoint[];
  readonly color?: string;
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
  imports: [ChartComponent, NgTemplateOutlet, SparklineComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="dt-panel__title">Overview</h1>
    <p class="dt-panel__subtitle">What this system is, what it is doing, and how that is trending.</p>

    <div class="dt-toolbar">
      <!-- Selection is bound per option rather than as a value on the select:
           the value is applied before the loop has produced the options, so the
           browser falls back to the first one, and the control then disagrees
           with the span the panel is actually charting (#485). -->
      <select class="dt-input" aria-label="Charted timespan" (change)="onSpan($event)">
        @for (choice of spanChoices; track choice) {
          <option [value]="choice" [selected]="choice === spanMs()">last {{ label(choice) }}</option>
        }
      </select>
      <span class="dt-toolbar__summary">{{ spanNote() }}</span>
    </div>

    <section>
      <h2 class="dt-section">Common</h2>
      <div class="dt-tiles">
        @for (tile of commonTiles(); track tile.label) {
          <ng-container *ngTemplateOutlet="tileTemplate; context: { $implicit: tile }" />
        }
      </div>
    </section>

    <section>
      <h2 class="dt-section">Numbers</h2>
      <div class="dt-tiles">
        @for (tile of numberTiles(); track tile.label) {
          <ng-container *ngTemplateOutlet="tileTemplate; context: { $implicit: tile }" />
        }
      </div>
    </section>

    <!-- Hidden on a system with a single node: a breakdown of one is the totals
         with extra steps. It appears the moment a cluster has a second member,
         which is also the moment the totals stop telling you WHERE something is
         happening. -->
    <section [hidden]="nodes().length < 2">
      <h2 class="dt-section">Per node</h2>
      <div class="dt-nodetable">
        <div class="dt-nodetable__head">
          <span>Node</span><span>Actors</span><span>Messages</span><span>Backlog</span>
          <span>Restarts</span><span>Dead letters</span><span>Uptime</span>
        </div>
        @for (node of nodes(); track node.figures.address) {
          <div
            class="dt-nodetable__row"
            [class.dt-nodetable__row--stale]="node.stale"
            [title]="nodeTitle(node)"
          >
            <span class="dt-nodetable__address">
              {{ node.figures.address }}
              @if (node.isSelf) { <span class="dt-badge">self</span> }
              @if (node.stale) { <span class="dt-badge dt-badge--error">not answering</span> }
            </span>
            <span class="dt-nodetable__figure">{{ count(node.figures.actorCount) }}</span>
            <span class="dt-nodetable__figure">{{ count(node.figures.messagesProcessed) }}</span>
            <span class="dt-nodetable__figure">{{ count(node.figures.mailboxBacklog) }}</span>
            <span class="dt-nodetable__figure">{{ count(node.figures.actorsRestarted) }}</span>
            <span class="dt-nodetable__figure">{{ count(node.figures.deadLetters) }}</span>
            <span class="dt-nodetable__figure">{{ duration(node.figures.uptimeMs) }}</span>
          </div>
        }
      </div>
    </section>

    <section>
      <h2 class="dt-section">Charts</h2>
      <div class="dt-charts">
        <devtools-chart
          class="dt-chart"
          title="Throughput"
          [series]="throughput()"
          [collecting]="collecting()"
          [peakLabel]="peakOfSeries(throughput())"
        />
        <devtools-chart
          class="dt-chart"
          title="Actors"
          [series]="population()"
          [collecting]="collecting()"
          [peakLabel]="peakOfSeries(population())"
        />
        <devtools-chart
          class="dt-chart"
          title="Backlog"
          [series]="backlog()"
          [collecting]="collecting()"
          [peakLabel]="peakOfSeries(backlog())"
        />
      </div>

      <h3 class="dt-chart__title">Busiest mailboxes</h3>
      <div class="dt-hotlist">
        @if (hotList().length === 0) {
          <p class="dt-empty">Every mailbox is empty.</p>
        } @else {
          @for (entry of hotList(); track entry.path) {
            <div class="dt-hotrow" [title]="entry.path">
              <span class="dt-hotrow__name">{{ shorten(entry.path) }}</span>
              <span class="dt-hotrow__bar">
                <span class="dt-hotrow__fill" [style.width.%]="entry.percent"></span>
              </span>
              <span class="dt-hotrow__value">{{ count(entry.size) }}</span>
            </div>
          }
        }
      </div>
    </section>

    <ng-template #tileTemplate let-tile>
      <div class="dt-tile" [attr.title]="tile.title ?? null">
        <div class="dt-tile__label">{{ tile.label }}</div>
        <div
          class="dt-tile__value"
          [class.dt-tile__accent]="tile.accent"
          [class.dt-tile__alert]="tile.alert"
        >{{ tile.value }}</div>
        @if (tile.points && tile.points.length > 1) {
          <devtools-sparkline [points]="tile.points" [colorVariable]="tile.color ?? '--dt-accent'" />
        }
      </div>
    </ng-template>
  `,
})
export class DashboardPanelComponent {
  private readonly tap = inject(TapClientService);
  private readonly destroyRef = inject(DestroyRef);

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
    ];
  });

  readonly numberTiles = computed<readonly Tile[]>(() => {
    this.revision();
    const latest = this.latest();
    if (latest === null) return [{ label: 'Live figures', value: 'waiting for first sample…' }];
    const history = this.history;
    return [
      { label: 'Actors', value: formatCount(latest.actorCount), points: history.levels('actorCount'), color: '--dt-data-1' },
      { label: 'Messages / s', value: history.latestRate('messagesProcessed').toFixed(1), points: history.rates('messagesProcessed'), color: '--dt-data-1' },
      { label: 'Processed messages', value: formatCount(latest.messagesProcessed) },
      { label: 'Spawns / s', value: history.latestRate('actorsStarted').toFixed(1), points: history.rates('actorsStarted'), color: '--dt-data-2' },
      { label: 'Stops / s', value: history.latestRate('actorsStopped').toFixed(1), points: history.rates('actorsStopped'), color: '--dt-data-6' },
      { label: 'Restarts', value: formatCount(latest.actorsRestarted), points: history.rates('actorsRestarted'), color: '--dt-data-5', alert: latest.actorsRestarted > 0 },
      { label: 'Mailbox backlog', value: formatCount(latest.mailboxBacklog), points: history.levels('mailboxBacklog'), color: latest.mailboxBacklog > 0 ? '--dt-data-3' : '--dt-data-2' },
      { label: 'Stashed', value: formatCount(latest.stashedTotal), points: history.levels('stashedTotal'), color: '--dt-data-6' },
      { label: 'Suspended actors', value: formatCount(latest.suspendedActors), points: history.levels('suspendedActors'), color: '--dt-data-5', alert: latest.suspendedActors > 0 },
      { label: 'Dead letters', value: formatCount(latest.deadLetters), points: history.rates('deadLetters'), color: '--dt-data-4', alert: latest.deadLetters > 0 },
      {
        label: 'Mailbox drops',
        value: formatCount(latest.mailboxDrops),
        points: history.rates('mailboxDrops'),
        color: '--dt-data-4',
        alert: latest.mailboxDrops > 0,
        title: 'Messages a bounded mailbox threw away on overflow.',
      },
      this.latencyTile(latest),
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

  readonly throughput = computed<readonly ChartSeries[]>(() => {
    this.revision();
    return [
      this.series('messages / s', '--dt-data-1', '#818cf8', this.history.rates('messagesProcessed')),
      this.series('dead letters / s', '--dt-data-4', '#ef4444', this.history.rates('deadLetters')),
    ];
  });

  readonly population = computed<readonly ChartSeries[]>(() => {
    this.revision();
    return [
      this.series('actors', '--dt-data-2', '#22c55e', this.history.levels('actorCount')),
      this.series('suspended', '--dt-data-5', '#a78bfa', this.history.levels('suspendedActors')),
    ];
  });

  readonly backlog = computed<readonly ChartSeries[]>(() => {
    this.revision();
    return [
      this.series('mailbox backlog', '--dt-data-3', '#f59e0b', this.history.levels('mailboxBacklog')),
      this.series('stashed', '--dt-data-6', '#22d3ee', this.history.levels('stashedTotal')),
    ];
  });

  constructor() {
    this.destroyRef.onDestroy(this.tap.listen('stats', (payload) => {
      if (payload.kind !== 'stats-sample') return;
      this.history.push(payload);
      this.uptimeAnchor = { uptimeMs: payload.uptimeMs, receivedAtMs: Date.now() };
      this.touch();
    }));

    // Stamped on the way down and only cleared by a real `open`, so a reconnect
    // that flickers `closed` → `connecting` → `closed` cannot walk the clock
    // forward one transition at a time.
    effect(() => {
      const open = this.tap.status() === 'open';
      this.frozenAtMs.update((frozen) => (open ? null : frozen ?? Date.now()));
    });

    const clock = setInterval(() => this.now.set(Date.now()), CLOCK_INTERVAL_MS);
    this.destroyRef.onDestroy(() => clearInterval(clock));

    void this.loadHistory(this.spanMs());
  }

  count(value: number): string { return formatCount(value); }
  duration(ms: number): string { return formatDuration(ms); }
  label(ms: number): string { return spanLabel(ms); }
  shorten(path: string): string { return shortActorPath(path); }
  peakOfSeries(lines: readonly ChartSeries[]): string {
    return formatCount(Math.max(...lines.map((line) => peakOf(line.points)), 0));
  }

  nodeTitle(node: NodeSample): string {
    return node.stale
      ? `Last answered ${formatDuration(this.now() - node.receivedAtMs)} ago`
      : node.figures.address;
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
    this.now.set(Date.now());
    this.revision.update((value) => value + 1);
  }

  private series(
    label: string,
    variable: string,
    fallback: string,
    points: readonly SeriesPoint[],
  ): ChartSeries {
    return { label, color: themeColor(variable, fallback), points };
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
