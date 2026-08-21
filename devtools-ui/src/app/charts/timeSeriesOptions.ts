import type { SeriesPoint } from '../../core/history.js';
import type { ChartTheme } from './ChartThemeService.js';
import type { DevToolsChartOption } from './echartsModules.js';

/** One line on a chart. */
export type ChartLine = {
  readonly label: string;
  readonly color: string;
  readonly points: readonly SeriesPoint[];
};

/**
 * Two properties every time series here must keep, and the reason they are
 * spelled out rather than left to defaults.
 *
 * They were enforced by `projectPoints` in the hand-drawn renderer, whose JSDoc
 * documented them; that function dies with `render/timeseries.ts`, and ECharts
 * has neither by default.  Both are pinned by the option-builder tests (#487),
 * because a chart that silently loses them still looks like a chart.
 *
 *   - **The vertical scale always starts at zero.**  A rate chart auto-scaled
 *     to its own minimum turns ordinary jitter into dramatic-looking mountains,
 *     which is the opposite of what a spike indicator is for.
 *   - **The horizontal axis is spaced by TIME, not by index**, so a gap in the
 *     samples shows as a gap rather than being quietly compressed away.
 */
const ZERO_BASED_Y = { min: 0 } as const;
const TIME_X = { type: 'time' } as const;

function toPairs(points: readonly SeriesPoint[]): Array<[number, number]> {
  return points.map((point) => [point.atMs, point.value]);
}

/**
 * A figure's recent shape, drawn inside its tile.
 *
 * No axes, no grid, no tooltip: at this size they would be most of the ink, and
 * the tile's own number is the reading.  The line is the whole point.
 */
export function buildSparklineOption(
  points: readonly SeriesPoint[],
  color: string,
): DevToolsChartOption {
  return {
    animation: false,
    grid: { left: 0, right: 0, top: 2, bottom: 2, containLabel: false },
    xAxis: { ...TIME_X, show: false },
    yAxis: { ...ZERO_BASED_Y, type: 'value', show: false },
    series: [{
      type: 'line',
      data: toPairs(points),
      showSymbol: false,
      lineStyle: { color, width: 1.5 },
      areaStyle: { color, opacity: 0.15 },
    }],
  };
}

/**
 * One of the overview's three charts.
 *
 * Three rather than one, because a level and a rate cannot share a y-axis
 * honestly: a backlog of 400 flattens a 2/s line to nothing.  Each chart holds
 * one kind of quantity and scales to its own peak — which is also why the
 * y-axis maximum is left to ECharts while the minimum is not.
 */
export function buildLineChartOption(
  lines: readonly ChartLine[],
  theme: ChartTheme,
): DevToolsChartOption {
  return {
    animation: false,
    grid: { left: 44, right: 12, top: 12, bottom: 24 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: theme.background,
      borderColor: theme.border,
      textStyle: { color: theme.text },
    },
    xAxis: {
      ...TIME_X,
      axisLine: { lineStyle: { color: theme.border } },
      axisLabel: { color: theme.textMuted },
      splitLine: { show: false },
    },
    yAxis: {
      ...ZERO_BASED_Y,
      type: 'value',
      axisLine: { show: false },
      axisLabel: { color: theme.textMuted },
      splitLine: { lineStyle: { color: theme.border, opacity: 0.4 } },
    },
    series: lines.map((line) => ({
      type: 'line',
      name: line.label,
      data: toPairs(line.points),
      showSymbol: false,
      lineStyle: { color: line.color, width: 1.5 },
      itemStyle: { color: line.color },
    })),
  };
}
