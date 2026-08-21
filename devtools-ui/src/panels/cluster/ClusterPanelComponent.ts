import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { match } from 'ts-pattern';

import { TapClientService } from '../../app/TapClientService.js';
import { formatCount, formatTime } from '../../core/format.js';
import { currentTheme } from '../../core/theme.js';
import { themeColor } from '../../render/timeseries.js';
import { ringLayout } from './topologyLayout.js';
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

/** Diameter of the topology drawing, in SVG user units. */
const TOPOLOGY_SIZE = 320;

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

/** One member, placed on the ring and coloured. */
type PlacedMember = {
  readonly address: string;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly strokeWidth: number;
  readonly color: string;
  readonly label: string;
  readonly title: string;
};

type Edge = { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number };

/** One member row in the list below the ring. */
type MemberRow = {
  readonly member: ClusterMemberInfo;
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
 * The topology is SVG: a cluster has tens of nodes, not thousands, and SVG
 * gives crisp labels, CSS theming and hover targets for free.  It is written
 * as template markup here rather than built through the `svg()` helper, which
 * is one of the things that helper existed for.
 */
@Component({
  selector: 'devtools-cluster-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="dt-panel__title">Cluster</h1>
    <p class="dt-panel__subtitle">Who is in the cluster, who leads it, and where the shards live.</p>

    <div class="dt-topology">
      @if (placed().length === 0) {
        <p class="dt-empty">Waiting for cluster state…</p>
      } @else {
        <svg
          class="dt-topology__svg"
          [attr.viewBox]="viewBox"
          role="img"
          [attr.aria-label]="'Cluster topology with ' + placed().length + ' members'"
        >
          <!-- Edges first so nodes draw on top of them. A ring is fully
               connected in gossip terms; drawing every pair keeps that honest
               without pretending to show real traffic. -->
          @for (edge of edges(); track $index) {
            <line
              class="dt-topology__edge"
              [attr.x1]="edge.x1" [attr.y1]="edge.y1" [attr.x2]="edge.x2" [attr.y2]="edge.y2"
            />
          }
          @for (node of placed(); track node.address) {
            <g class="dt-topology__node">
              <title>{{ node.title }}</title>
              <circle
                class="dt-topology__circle"
                [attr.cx]="node.x" [attr.cy]="node.y" [attr.r]="node.radius"
                [attr.fill]="node.color" [attr.stroke-width]="node.strokeWidth"
              />
              <text
                class="dt-topology__label"
                [attr.x]="node.x" [attr.y]="node.y + 30" text-anchor="middle"
              >{{ node.label }}</text>
            </g>
          }
        </svg>
        <p class="dt-topology__legend">Larger circle = leader · thick outline = this node</p>
      }
    </div>

    <div class="dt-members">
      @for (row of memberRows(); track row.member.address) {
        <div class="dt-member" [class.dt-member--gone]="row.member.gone">
          <span class="dt-state" [style.background]="row.color"></span>
          <span class="dt-member__address">{{ row.member.address }}</span>
          <span class="dt-member__status">{{ row.statusLabel }}</span>
          @if (row.lastSeen) { <span class="dt-badge dt-badge--error">last seen {{ row.lastSeen }}</span> }
          @if (row.isLeader) { <span class="dt-badge">leader</span> }
          @if (row.member.isSelf) { <span class="dt-badge">self</span> }
          @for (role of row.member.roles; track role) {
            <span class="dt-badge dt-badge--muted">{{ role }}</span>
          }
        </div>
      }
    </div>

    <h2 class="dt-section">Shard distribution</h2>
    <div class="dt-shards">
      @if (shardMaps().length === 0) {
        <p class="dt-empty">
          No shard map yet. Sharded types appear once their coordinator republishes.
        </p>
      } @else {
        @for (shardMap of shardMaps(); track shardMap.typeName) {
          <div class="dt-shardmap">
            <div class="dt-shardmap__head">
              <strong>{{ shardMap.typeName }}</strong>
              <span class="dt-tile__label">{{ shardMap.summary }}</span>
            </div>
            @for (region of shardMap.regions; track region.regionKey) {
              <div class="dt-hotrow">
                <span class="dt-hotrow__name" [title]="region.regionKey">{{ region.label }}</span>
                <span class="dt-hotrow__bar">
                  <span
                    class="dt-hotrow__fill"
                    [style.width.%]="region.percent"
                    [style.background]="region.color"
                  ></span>
                </span>
                <span class="dt-hotrow__value">{{ count(region.count) }}</span>
              </div>
            }
          </div>
        }
      }
    </div>

    <h2 class="dt-section">Membership history</h2>
    <div class="dt-timeline">
      @if (timeline().length === 0) {
        <p class="dt-empty">No membership changes since you attached.</p>
      } @else {
        @for (event of timeline(); track $index) {
          <div class="dt-timeline__row">
            <span class="dt-timeline__time">{{ at(event.atMs) }}</span>
            <span class="dt-badge {{ tone(event.event) }}">{{ event.event }}</span>
            <span class="dt-timeline__subject">
              {{ event.member?.address ?? event.leader ?? '—' }}
            </span>
          </div>
        }
      }
    </div>
  `,
})
export class ClusterPanelComponent {
  private readonly tap = inject(TapClientService);
  private readonly destroyRef = inject(DestroyRef);

  readonly viewBox = `0 0 ${TOPOLOGY_SIZE} ${TOPOLOGY_SIZE}`;

  private readonly members = signal<readonly ClusterMemberInfo[]>([]);
  private readonly leader = signal<string | null>(null);
  private readonly selfAddress = signal('');
  private readonly shardMapsByType = new Map<string, ShardMapInfo>();
  private readonly events = signal<readonly ClusterEventPayload[]>([]);

  /** Bumped when the shard maps change; they are held in a map, not a signal. */
  private readonly revision = signal(0);
  private readonly now = signal(Date.now());

  readonly timeline = this.events.asReadonly();

  readonly placed = computed<readonly PlacedMember[]>(() => {
    const members = this.members();
    currentTheme();
    if (members.length === 0) return [];
    const points = ringLayout(members.length, TOPOLOGY_SIZE / 2, TOPOLOGY_SIZE / 2, TOPOLOGY_SIZE / 2 - 46);
    const leader = this.leader();
    const self = this.selfAddress();
    return members.map((member, index) => {
      const point = points[index]!;
      return {
        address: member.address,
        x: point.x,
        y: point.y,
        radius: member.address === leader ? 15 : 11,
        strokeWidth: member.address === self ? 3 : 1,
        color: this.colorOf(member),
        label: shortAddress(member.address),
        title: `${member.address} — ${member.gone ? 'not answering' : member.status}`,
      };
    });
  });

  readonly edges = computed<readonly Edge[]>(() => {
    const nodes = this.placed();
    const out: Edge[] = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        out.push({ x1: nodes[i]!.x, y1: nodes[i]!.y, x2: nodes[j]!.x, y2: nodes[j]!.y });
      }
    }
    return out;
  });

  /**
   * Live members first, then the departed, each group by address — so a node
   * that dropped out does not shuffle the list it left.
   */
  readonly memberRows = computed<readonly MemberRow[]>(() => {
    const now = this.now();
    const leader = this.leader();
    currentTheme();
    return [...this.members()]
      .sort((a, b) => Number(a.gone) - Number(b.gone) || a.address.localeCompare(b.address))
      .map((member) => ({
        member,
        color: this.colorOf(member),
        statusLabel: member.gone ? 'unreachable' : member.status,
        lastSeen: member.gone ? sinceLabel(now - member.lastSeenAtMs) : null,
        isLeader: member.address === leader && !member.gone,
      }));
  });

  readonly shardMaps = computed<readonly ShardMapView[]>(() => {
    this.revision();
    currentTheme();
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
          color: themeColor(`--dt-data-${(index % 8) + 1}`, '#818cf8'),
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
      if (this.members().some((member) => member.gone)) this.now.set(Date.now());
    }, GONE_CLOCK_INTERVAL_MS);
    this.destroyRef.onDestroy(() => clearInterval(clock));
  }

  count(value: number): string { return formatCount(value); }
  at(atMs: number): string { return formatTime(atMs); }
  tone(name: ClusterEventPayload['event']): string { return badgeToneFor(name); }

  /**
   * A departed node is listed from memory; drawing it in the green it had when
   * it left is the one thing this graph must not do.
   */
  private colorOf(member: ClusterMemberInfo): string {
    return themeColor(member.gone ? '--dt-state-error' : STATUS_TOKENS[member.status], '#64748b');
  }

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
    this.now.set(Date.now());
    this.revision.update((value) => value + 1);
  }
}

/** The registry loads this module and reads this export. */
export const panelComponent = ClusterPanelComponent;
