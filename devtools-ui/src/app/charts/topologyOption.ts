import type { ChartTheme } from './ChartThemeService.js';
import type { DevToolsChartOption } from './echartsModules.js';

/** One cluster member, ready to place on the ring. */
export type TopologyNode = {
  /** Full address — the tooltip and the identity. */
  readonly address: string;
  /** Short `host:port`, which is what distinguishes nodes at a glance. */
  readonly label: string;
  readonly status: string;
  readonly color: string;
  readonly isLeader: boolean;
  readonly isSelf: boolean;
};

/**
 * The cluster ring.
 *
 * `layout: 'circular'` is what replaced `ringLayout` — placing points on a
 * circle is exactly the kind of thing worth handing to a chart library, and it
 * stays deterministic rather than force-directed, so a member does not move
 * because another one joined.
 *
 * Every pair is linked. A ring is fully connected in gossip terms, and drawing
 * every pair keeps that honest without pretending to show real traffic.
 *
 * The three encodings the hand-drawn SVG carried are preserved: a larger symbol
 * for the leader, a thicker border for this node, and — the one thing this
 * graph must not get wrong — a departed member drawn in the error colour rather
 * than the green it had when it left.
 */
export function buildTopologyOption(
  nodes: readonly TopologyNode[],
  theme: ChartTheme,
): DevToolsChartOption {
  return {
    animation: false,
    tooltip: {
      backgroundColor: theme.background,
      borderColor: theme.border,
      textStyle: { color: theme.text },
      formatter: (params: unknown) => {
        const name = (params as { name?: string }).name ?? '';
        const node = nodes.find((entry) => entry.address === name);
        return node === undefined ? name : `${node.address} — ${node.status}`;
      },
    },
    series: [{
      type: 'graph',
      layout: 'circular',
      circular: { rotateLabel: false },
      roam: false,
      // Placement is left to ECharts. `center`/`radius` are documented for a
      // circular graph but absent from its TypeScript surface, and the default
      // already leaves room for the labels below each node.
      symbolSize: 22,
      label: {
        show: true,
        position: 'bottom',
        distance: 8,
        color: theme.textMuted,
        fontSize: 11,
        formatter: (params: unknown) => {
          const name = (params as { name?: string }).name ?? '';
          return nodes.find((entry) => entry.address === name)?.label ?? name;
        },
      },
      lineStyle: { color: theme.border, opacity: 0.45, width: 1 },
      data: nodes.map((node) => ({
        name: node.address,
        symbolSize: node.isLeader ? 28 : 20,
        itemStyle: {
          color: node.color,
          borderColor: theme.textStrong,
          borderWidth: node.isSelf ? 3 : 0,
        },
      })),
      links: nodes.flatMap((from, index) => nodes
        .slice(index + 1)
        .map((to) => ({ source: from.address, target: to.address }))),
    }],
  };
}
