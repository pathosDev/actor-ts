import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { match } from 'ts-pattern';

import { ChartThemeService, type ChartTheme } from '../../app/charts/ChartThemeService.js';
import { EChartComponent } from '../../app/charts/EChartComponent.js';
import type { DevToolsChartOption } from '../../app/charts/echartsModules.js';
import { buildTopologyOption, type TopologyNode } from '../../app/charts/topologyOption.js';
import { TapClientService } from '../../app/TapClientService.js';
import { TimeControlService } from '../../app/TimeControlService.js';
import { formatCount, formatTime } from '../../core/format.js';
import type {
  ClusterEventPayload,
  ClusterMemberInfo,
  ClusterMemberStatus,
  ClusterSnapshotPayload,
  ShardMapChangedPayload,
  ShardMapInfo,
} from '../../../../src/devtools/protocol/index.js';

/** Ticks the "last seen" ages of members that have left. */
const GONE_CLOCK_INTERVAL_MS = 1000;

/** How many membership transitions the timeline keeps. */
const TIMELINE_CAPACITY = 60;

/** Member status → the semantic colour token that carries its meaning. */
const STATUS_TOKENS: Readonly<Record<ClusterMemberStatus, string>> = {
  joining: '--dt-state-warn',
  'weakly-up': '--dt-state-warn',
  up: '--dt-state-ok',
  unreachable: '--dt-state-error',
  leaving: '--dt-state-warn',
  down: '--dt-state-error',
  removed: '--dt-state-idle',
};

/** The same tokens, resolved, for the one thing that paints to a canvas. */
function resolvedToken(variable: string, theme: ChartTheme): string {
  switch (variable) {
    case '--dt-state-ok': return theme.stateOk;
    case '--dt-state-warn': return theme.stateWarn;
    case '--dt-state-error': return theme.stateError;
    default: return theme.stateIdle;
  }
}

/** One member row in the list below the ring. */
type MemberRow = {
  readonly member: ClusterMemberInfo;
  /** A CSS custom property reference — the DOM themes itself. */
  readonly color: string;
  readonly statusLabel: string;
  readonly lastSeen: string | null;
  readonly isLeader: boolean;
};

/** One shard type's distribution across regions. */
type ShardMapView = {
  readonly typeName: string;
  readonly summary: string;
  readonly regions: ReadonlyArray<{
    readonly regionKey: string;
    readonly label: string;
    readonly count: number;
    readonly percent: number;
    readonly color: string;
  }>;
};

/** `system@host:port` — the host:port is what distinguishes nodes. */
function shortAddress(address: string): string {
  return address.split('@')[1] ?? address;
}

/** Coarse ages read better than precise ones for something an hour old. */
function sinceLabel(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function badgeToneFor(name: ClusterEventPayload['event']): string {
  if (name === 'member-unreachable' || name === 'member-down') return 'dt-badge--error';
  if (name === 'member-left' || name === 'member-removed') return 'dt-badge--warn';
  return '';
}

/**
 * The cluster panel (#204) — topology, shard distribution, membership history.
 *
 * The ring is an ECharts `graph` with `layout: 'circular'` (#486), which
 * replaced both the hand-built SVG and `ringLayout`: placing points on a circle
 * is exactly the kind of thing worth handing to a chart library, and the layout
 * stays deterministic rather than force-directed, so a member does not move
 * because another one joined.
 *
 * Everything else here stays DOM and themes itself through the `--dt-*` custom
 * properties.  Only the canvas needs resolved colours, because `var(...)` means
 * nothing to a canvas — which is the whole reason `ChartThemeService` exists.
 */
@Component({
  selector: 'devtools-cluster-panel',
  imports: [EChartComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './ClusterPanelComponent.html',
})
export class ClusterPanelComponent {
  private readonly tap = inject(TapClientService);
  private readonly time = inject(TimeControlService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly chartTheme = inject(ChartThemeService).theme;

  private readonly members = signal<readonly ClusterMemberInfo[]>([]);
  private readonly leader = signal<string | null>(null);
  private readonly selfAddress = signal('');
  private readonly shardMapsByType = new Map<string, ShardMapInfo>();
  private readonly events = signal<readonly ClusterEventPayload[]>([]);

  /** Bumped when the shard maps change; they are held in a map, not a signal. */
  private readonly revision = signal(0);
  private readonly now = signal(Date.now());

  readonly timeline = this.events.asReadonly();

  readonly topologyNodes = computed<readonly TopologyNode[]>(() => {
    const leader = this.leader();
    const self = this.selfAddress();
    const theme = this.chartTheme();
    return this.members().map((member) => ({
      address: member.address,
      label: shortAddress(member.address),
      status: member.gone ? 'not answering' : member.status,
      // A departed node is listed from memory; drawing it in the green it had
      // when it left is the one thing this graph must not do.
      color: resolvedToken(member.gone ? '--dt-state-error' : STATUS_TOKENS[member.status], theme),
      isLeader: member.address === leader,
      isSelf: member.address === self,
    }));
  });

  readonly topologyOption = computed<DevToolsChartOption>(() =>
    buildTopologyOption(this.topologyNodes(), this.chartTheme()));

  /**
   * Live members first, then the departed, each group by address — so a node
   * that dropped out does not shuffle the list it left.
   */
  readonly memberRows = computed<readonly MemberRow[]>(() => {
    const now = this.now();
    const leader = this.leader();
    return [...this.members()]
      .sort((a, b) => Number(a.gone) - Number(b.gone) || a.address.localeCompare(b.address))
      .map((member) => ({
        member,
        color: `var(${member.gone ? '--dt-state-error' : STATUS_TOKENS[member.status]})`,
        statusLabel: member.gone ? 'unreachable' : member.status,
        lastSeen: member.gone ? sinceLabel(now - member.lastSeenAtMs) : null,
        isLeader: member.address === leader && !member.gone,
      }));
  });

  readonly shardMaps = computed<readonly ShardMapView[]>(() => {
    this.revision();
    return [...this.shardMapsByType.values()].map((shardMap) => {
      const byRegion = new Map<string, number>();
      for (const assignment of shardMap.shardHome) {
        byRegion.set(assignment.regionKey, (byRegion.get(assignment.regionKey) ?? 0) + 1);
      }
      const regions = [...byRegion.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const peak = Math.max(...regions.map(([, count]) => count), 1);
      return {
        typeName: shardMap.typeName,
        summary: `${formatCount(shardMap.shardHome.length)} shards · ${regions.length} regions`,
        regions: regions.map(([regionKey, count], index) => ({
          regionKey,
          label: shortAddress(regionKey),
          count,
          percent: (count / peak) * 100,
          // Cycle the categorical ramp so adjacent regions stay distinguishable.
          // A custom property, not a resolved colour: this is a DOM bar, and CSS
          // re-themes it for free.
          color: `var(--dt-data-${(index % 8) + 1})`,
        })),
      };
    });
  });

  constructor() {
    this.destroyRef.onDestroy(this.tap.listen('cluster', (payload) => {
      match(payload)
        .with({ kind: 'cluster-snapshot' }, (p) => this.onClusterSnapshot(p))
        .with({ kind: 'cluster-event' }, (p) => this.onClusterEvent(p))
        .with({ kind: 'shard-map-changed' }, (p) => this.onShardMapChanged(p))
        .otherwise(() => this.onUnknownClusterPayload());
    }));

    // A departed node's "last seen" has to keep counting.  Nothing arrives on
    // the stream to prompt it: membership changes are the events, and the whole
    // point of a retained member is that it stopped producing any.
    const clock = setInterval(() => {
      // A departed node's age is a duration like any other, so it holds still
      // while time is paused rather than counting up beside a frozen view.
      if (this.time.paused()) return;
      if (this.members().some((member) => member.gone)) this.now.set(Date.now());
    }, GONE_CLOCK_INTERVAL_MS);
    this.destroyRef.onDestroy(() => clearInterval(clock));
  }

  count(value: number): string { return formatCount(value); }
  at(atMs: number): string { return formatTime(atMs); }
  tone(name: ClusterEventPayload['event']): string { return badgeToneFor(name); }

  private onClusterSnapshot(payload: ClusterSnapshotPayload): void {
    this.members.set(payload.members);
    this.leader.set(payload.leader);
    this.selfAddress.set(payload.selfAddress);
    for (const shardMap of payload.shardMaps) this.shardMapsByType.set(shardMap.typeName, shardMap);
    this.touch();
  }

  private onClusterEvent(payload: ClusterEventPayload): void {
    // Matched on `event` rather than `kind`: `kind` is already spent on
    // `'cluster-event'`, which is what distinguishes this payload from the
    // snapshot and shard-map ones, so the transition name lives one level in.
    match(payload.event)
      .with('leader-changed', () => this.onLeaderChanged(payload))
      .with('member-removed', () => this.onMemberRemoved(payload))
      .otherwise(() => this.onMemberUpserted(payload));
    this.events.update((current) => [payload, ...current].slice(0, TIMELINE_CAPACITY));
    this.touch();
  }

  private onShardMapChanged(payload: ShardMapChangedPayload): void {
    this.shardMapsByType.set(payload.shardMap.typeName, payload.shardMap);
    this.touch();
  }

  private onUnknownClusterPayload(): void {}

  private onLeaderChanged(payload: ClusterEventPayload): void {
    this.leader.set(payload.leader ?? null);
  }

  /** A removed member leaves the list. */
  private onMemberRemoved(payload: ClusterEventPayload): void {
    const member = payload.member;
    if (member === undefined) return;
    this.members.update((current) => current.filter((e) => e.address !== member.address));
  }

  /**
   * Every other transition updates the member in place.  Events that carry no
   * member (`self-up`, `self-removed`, `shard-map-changed`) fall here too and
   * are a no-op — they change no membership.
   */
  private onMemberUpserted(payload: ClusterEventPayload): void {
    const member = payload.member;
    if (member === undefined) return;
    this.members.update((current) => [...current.filter((e) => e.address !== member.address), member]);
  }

  private touch(): void {
    this.now.set(this.time.nowMs());
    this.revision.update((value) => value + 1);
  }
}

/** The registry loads this module and reads this export. */
export const panelComponent = ClusterPanelComponent;
