/**
 * The cluster panel (#204) — topology, shard distribution, membership
 * history.
 *
 * The topology is SVG: a cluster has tens of nodes, not thousands, and
 * SVG gives crisp labels, CSS theming and hover targets for free.  The
 * shard grid is many small cells that repaint on every coordinator
 * republish, so it is a canvas.
 */
import { h, replaceChildren, svg } from '../../core/dom.js';
import { formatCount, formatTime } from '../../core/format.js';
import { themeColor } from '../../render/timeseries.js';
import { currentTheme } from '../../core/theme.js';
import { effect } from '../../core/signal.js';
import { ringLayout } from './topologyLayout.js';
import type { PanelContext, PanelInstance } from '../../shell/PanelRegistry.js';
import type {
  ClusterEventPayload,
  ClusterMemberInfo,
  ClusterMemberStatus,
  ShardMapInfo,
} from '../../../../src/devtools/protocol/index.js';

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

export function mount(host: HTMLElement, context: PanelContext): PanelInstance {
  let members: ReadonlyArray<ClusterMemberInfo> = [];
  let leader: string | null = null;
  let selfAddress = '';
  const shardMaps = new Map<string, ShardMapInfo>();
  const timeline: ClusterEventPayload[] = [];

  const topology = h('div', { class: 'dt-topology' });
  const memberList = h('div', { class: 'dt-members' });
  const shards = h('div', { class: 'dt-shards' });
  const history = h('div', { class: 'dt-timeline' });

  replaceChildren(host,
    h('h1', { class: 'dt-panel__title' }, 'Cluster'),
    h('p', { class: 'dt-panel__subtitle' }, 'Who is in the cluster, who leads it, and where the shards live.'),
    topology,
    memberList,
    h('h2', { class: 'dt-section' }, 'Shard distribution'),
    shards,
    h('h2', { class: 'dt-section' }, 'Membership history'),
    history,
  );

  function render(): void {
    renderTopology(topology, members, leader, selfAddress);
    renderMembers(memberList, members, leader);
    renderShards(shards, [...shardMaps.values()]);
    renderTimeline(history, timeline);
  }

  const stop = context.tap.listen('cluster', (payload) => {
    switch (payload.kind) {
      case 'cluster-snapshot':
        members = payload.members;
        leader = payload.leader;
        selfAddress = payload.selfAddress;
        for (const shardMap of payload.shardMaps) shardMaps.set(shardMap.typeName, shardMap);
        break;
      case 'cluster-event':
        applyEvent(payload);
        break;
      case 'shard-map-changed':
        shardMaps.set(payload.shardMap.typeName, payload.shardMap);
        break;
      default:
        return;
    }
    render();
  });

  /** Fold an event into the member list and record it for the timeline. */
  function applyEvent(payload: ClusterEventPayload): void {
    if (payload.event === 'leader-changed') {
      leader = payload.leader ?? null;
    } else if (payload.member !== undefined) {
      const member = payload.member;
      const without = members.filter((existing) => existing.address !== member.address);
      // A removed member leaves the list; anything else updates in place.
      members = payload.event === 'member-removed' ? without : [...without, member];
    }
    timeline.unshift(payload);
    if (timeline.length > TIMELINE_CAPACITY) timeline.pop();
  }

  const disposeTheme = effect(render, [currentTheme]);
  render();

  return {
    dispose(): void {
      stop();
      disposeTheme();
    },
  };
}

/* ------------------------------- topology -------------------------------- */

function renderTopology(
  host: HTMLElement,
  members: ReadonlyArray<ClusterMemberInfo>,
  leader: string | null,
  selfAddress: string,
): void {
  if (members.length === 0) {
    replaceChildren(host, h('p', { class: 'dt-empty' }, 'Waiting for cluster state…'));
    return;
  }
  const size = 320;
  const placed = ringLayout(members.length, size / 2, size / 2, size / 2 - 46);

  const canvas = svg('svg', {
    class: 'dt-topology__svg',
    viewBox: `0 0 ${size} ${size}`,
    role: 'img',
    'aria-label': `Cluster topology with ${members.length} members`,
  });

  // Edges first so nodes draw on top of them.  A ring is fully
  // connected in gossip terms; drawing every pair keeps that honest
  // without pretending to show real traffic.
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      canvas.appendChild(svg('line', {
        class: 'dt-topology__edge',
        x1: placed[i]!.x, y1: placed[i]!.y, x2: placed[j]!.x, y2: placed[j]!.y,
      }));
    }
  }

  members.forEach((member, index) => {
    const point = placed[index]!;
    const color = themeColor(STATUS_TOKENS[member.status], '#64748b');
    const group = svg('g', { class: 'dt-topology__node' });
    group.appendChild(svg('title', {}, `${member.address} — ${member.status}`));
    group.appendChild(svg('circle', {
      cx: point.x, cy: point.y,
      r: member.address === leader ? 15 : 11,
      fill: color,
      'stroke-width': member.address === selfAddress ? 3 : 1,
      class: 'dt-topology__circle',
    }));
    group.appendChild(svg('text', {
      x: point.x, y: point.y + 30,
      'text-anchor': 'middle',
      class: 'dt-topology__label',
    }, shortAddress(member.address)));
    canvas.appendChild(group);
  });

  replaceChildren(host, canvas, h('p', { class: 'dt-topology__legend' },
    'Larger circle = leader · thick outline = this node'));
}

function shortAddress(address: string): string {
  // `system@host:port` — the host:port is what distinguishes nodes.
  return address.split('@')[1] ?? address;
}

/* -------------------------------- members -------------------------------- */

function renderMembers(
  host: HTMLElement,
  members: ReadonlyArray<ClusterMemberInfo>,
  leader: string | null,
): void {
  if (members.length === 0) {
    replaceChildren(host);
    return;
  }
  const sorted = [...members].sort((a, b) => a.address.localeCompare(b.address));
  replaceChildren(host, ...sorted.map((member) => h('div', { class: 'dt-member' },
    h('span', {
      class: 'dt-state',
      style: `background:${themeColor(STATUS_TOKENS[member.status], '#64748b')}`,
    }),
    h('span', { class: 'dt-member__address' }, member.address),
    h('span', { class: 'dt-member__status' }, member.status),
    member.address === leader ? h('span', { class: 'dt-badge' }, 'leader') : null,
    member.isSelf ? h('span', { class: 'dt-badge' }, 'self') : null,
    ...member.roles.map((role) => h('span', { class: 'dt-badge dt-badge--muted' }, role)),
  )));
}

/* --------------------------------- shards -------------------------------- */

function renderShards(host: HTMLElement, shardMaps: ReadonlyArray<ShardMapInfo>): void {
  if (shardMaps.length === 0) {
    replaceChildren(host, h('p', { class: 'dt-empty' },
      'No shard map yet. Sharded types appear once their coordinator republishes.'));
    return;
  }
  replaceChildren(host, ...shardMaps.map((shardMap) => {
    const byRegion = new Map<string, number>();
    for (const assignment of shardMap.shardHome) {
      byRegion.set(assignment.regionKey, (byRegion.get(assignment.regionKey) ?? 0) + 1);
    }
    const regions = [...byRegion.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const peak = Math.max(...regions.map(([, count]) => count), 1);

    return h('div', { class: 'dt-shardmap' },
      h('div', { class: 'dt-shardmap__head' },
        h('strong', {}, shardMap.typeName),
        h('span', { class: 'dt-tile__label' },
          `${formatCount(shardMap.shardHome.length)} shards · ${regions.length} regions`),
      ),
      ...regions.map(([regionKey, count], index) => h('div', { class: 'dt-hotrow' },
        h('span', { class: 'dt-hotrow__name', title: regionKey }, shortAddress(regionKey)),
        h('span', { class: 'dt-hotrow__bar' },
          h('span', {
            class: 'dt-hotrow__fill',
            style: `width:${(count / peak) * 100}%;background:${seriesColor(index)}`,
          }),
        ),
        h('span', { class: 'dt-hotrow__value' }, formatCount(count)),
      )),
    );
  }));
}

/** Cycle the categorical ramp so adjacent regions stay distinguishable. */
function seriesColor(index: number): string {
  return themeColor(`--dt-data-${(index % 8) + 1}`, '#818cf8');
}

/* -------------------------------- timeline ------------------------------- */

function renderTimeline(host: HTMLElement, events: ReadonlyArray<ClusterEventPayload>): void {
  if (events.length === 0) {
    replaceChildren(host, h('p', { class: 'dt-empty' }, 'No membership changes since you attached.'));
    return;
  }
  replaceChildren(host, ...events.map((event) => h('div', { class: 'dt-timeline__row' },
    h('span', { class: 'dt-timeline__time' }, formatTime(event.atMs)),
    h('span', { class: `dt-badge ${badgeToneFor(event.event)}` }, event.event),
    h('span', { class: 'dt-timeline__subject' },
      event.member?.address ?? event.leader ?? '—'),
  )));
}

function badgeToneFor(name: ClusterEventPayload['event']): string {
  if (name === 'member-unreachable' || name === 'member-down') return 'dt-badge--error';
  if (name === 'member-left' || name === 'member-removed') return 'dt-badge--warn';
  return '';
}
