import { describe, expect, test } from 'bun:test';

import type { ChartTheme } from '../src/app/charts/ChartThemeService.js';
import { buildRectanglesOption, NOMINAL_WIDTH } from '../src/app/charts/rectanglesOption.js';
import { buildLineChartOption, buildSparklineOption } from '../src/app/charts/timeSeriesOptions.js';
import { buildTopologyOption } from '../src/app/charts/topologyOption.js';
import type { SeriesPoint } from '../src/core/history.js';

/**
 * The chart options, asserted as plain objects.
 *
 * This is the lever that keeps charts testable without a browser, and it only
 * works because the builders are pure functions of `(data, theme)` — nothing
 * here loads ECharts, touches a canvas or needs a DOM.  Everything imported
 * from `echartsModules.ts` is a TYPE, so the import is erased.
 *
 * What is worth pinning is not "the option has a series" but the two invariants
 * that used to live in `projectPoints` and died with `render/timeseries.ts`
 * (#486).  Both are properties ECharts does NOT have by default, so nothing but
 * a test stands between them and a chart that still looks like a chart while
 * lying about the data.
 */

const THEME: ChartTheme = {
  series: ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666', '#777777', '#888888'],
  text: '#cccccc',
  textMuted: '#999999',
  textStrong: '#ffffff',
  background: '#000000',
  border: '#333333',
  accent: '#818cf8',
  stateOk: '#22c55e',
  stateWarn: '#f59e0b',
  stateError: '#ef4444',
  stateIdle: '#64748b',
};

/** Three samples a minute apart, with a deliberate gap in the middle. */
const POINTS: readonly SeriesPoint[] = [
  { atMs: 1_000, value: 4 },
  { atMs: 61_000, value: 7 },
  { atMs: 601_000, value: 5 },
];

/** ECharts' option types are wide; the tests read specific corners of them. */
const axes = (option: unknown): { x: Record<string, unknown>; y: Record<string, unknown> } => {
  const shaped = option as { xAxis: Record<string, unknown>; yAxis: Record<string, unknown> };
  return { x: shaped.xAxis, y: shaped.yAxis };
};

const seriesOf = (option: unknown): Array<Record<string, unknown>> =>
  (option as { series: Array<Record<string, unknown>> }).series;

describe('time-series options — the invariants projectPoints used to enforce', () => {
  test('the vertical scale starts at zero, on both chart shapes', () => {
    // A rate chart auto-scaled to its own minimum turns ordinary jitter into
    // dramatic-looking mountains, which is the opposite of what a spike
    // indicator is for.  ECharts does NOT do this by default.
    expect(axes(buildSparklineOption(POINTS, '#abcdef')).y['min']).toBe(0);
    expect(axes(buildLineChartOption([{ label: 'x', color: '#abcdef', points: POINTS }], THEME)).y['min'])
      .toBe(0);
  });

  test('the horizontal axis is spaced by time, not by index', () => {
    // A gap in the samples has to show as a gap rather than being quietly
    // compressed away, which is exactly what a category or index axis would do.
    expect(axes(buildSparklineOption(POINTS, '#abcdef')).x['type']).toBe('time');
    expect(axes(buildLineChartOption([{ label: 'x', color: '#abcdef', points: POINTS }], THEME)).x['type'])
      .toBe('time');
  });

  test('points are emitted as [timestamp, value] pairs, in order', () => {
    // The pairing is what makes the time axis meaningful: swap the two and the
    // chart still renders, silently plotting values as instants.
    const data = seriesOf(buildSparklineOption(POINTS, '#abcdef'))[0]!['data'];
    expect(data).toEqual([[1_000, 4], [61_000, 7], [601_000, 5]]);
  });

  test('an empty series is still a valid option rather than a thrown error', () => {
    // The overview renders before the first sample arrives.
    const option = buildSparklineOption([], '#abcdef');
    expect(seriesOf(option)[0]!['data']).toEqual([]);
    expect(axes(option).y['min']).toBe(0);
  });

  test('one line per series, each keeping its own colour', () => {
    const option = buildLineChartOption([
      { label: 'messages / s', color: '#aaaaaa', points: POINTS },
      { label: 'dead letters / s', color: '#bbbbbb', points: POINTS },
    ], THEME);
    const series = seriesOf(option);
    expect(series).toHaveLength(2);
    expect(series.map((entry) => entry['name'])).toEqual(['messages / s', 'dead letters / s']);
    expect((series[0]!['lineStyle'] as Record<string, unknown>)['color']).toBe('#aaaaaa');
    expect((series[1]!['lineStyle'] as Record<string, unknown>)['color']).toBe('#bbbbbb');
  });

  test('no y-axis maximum is imposed, so each chart scales to its own peak', () => {
    // Three charts rather than one exist precisely so a level and a rate do not
    // share a scale; pinning a maximum here would undo that.
    expect(axes(buildLineChartOption([{ label: 'x', color: '#abcdef', points: POINTS }], THEME)).y['max'])
      .toBeUndefined();
  });
});

describe('topology option', () => {
  const node = (address: string, extra: Partial<{ isLeader: boolean; isSelf: boolean }> = {}) => ({
    address,
    label: address.split('@')[1] ?? address,
    status: 'up',
    color: '#22c55e',
    isLeader: false,
    isSelf: false,
    ...extra,
  });

  test('places members on a deterministic circle rather than a force layout', () => {
    // A force-directed layout would move a member because another one joined,
    // which makes the drawing unreadable as a thing you watch over time.
    const series = seriesOf(buildTopologyOption([node('s@a:1'), node('s@b:2')], THEME))[0]!;
    expect(series['type']).toBe('graph');
    expect(series['layout']).toBe('circular');
  });

  test('links every pair, because a ring is fully connected in gossip terms', () => {
    const links = seriesOf(buildTopologyOption(
      [node('s@a:1'), node('s@b:2'), node('s@c:3')], THEME,
    ))[0]!['links'] as unknown[];
    // Three members → three pairs, not six: an edge is undirected here.
    expect(links).toHaveLength(3);
  });

  test('a single member has no edges at all', () => {
    const links = seriesOf(buildTopologyOption([node('s@a:1')], THEME))[0]!['links'] as unknown[];
    expect(links).toHaveLength(0);
  });

  test('the leader is larger and this node is outlined', () => {
    const data = seriesOf(buildTopologyOption([
      node('s@a:1', { isLeader: true }),
      node('s@b:2', { isSelf: true }),
      node('s@c:3'),
    ], THEME))[0]!['data'] as Array<Record<string, unknown>>;
    const [leader, self, plain] = data;
    expect(leader!['symbolSize']).toBeGreaterThan(plain!['symbolSize'] as number);
    expect((self!['itemStyle'] as Record<string, unknown>)['borderWidth']).toBe(3);
    expect((plain!['itemStyle'] as Record<string, unknown>)['borderWidth']).toBe(0);
  });

  test('a member carries the colour it was given, not one derived here', () => {
    // A departed node is drawn in the error colour rather than the green it had
    // when it left — the panel decides that, and this must not second-guess it.
    const data = seriesOf(buildTopologyOption(
      [{ ...node('s@a:1'), color: '#ef4444', status: 'not answering' }], THEME,
    ))[0]!['data'] as Array<Record<string, unknown>>;
    expect((data[0]!['itemStyle'] as Record<string, unknown>)['color']).toBe('#ef4444');
  });
});

describe('rectangles option — the flame graph, waterfall and icicle', () => {
  const bar = (x: number, width: number, label = 'bar') =>
    ({ x, y: 0, width, height: 20, label, color: '#123456' });

  test('one datum per rectangle, so a hover reports an index into our layout', () => {
    // ECharts owns the hit region; the index is how it maps back to the
    // geometry `layoutRectangles` produced.
    const option = buildRectanglesOption([bar(0, 100), bar(100, 50), bar(150, 25)], THEME);
    expect(seriesOf(option)[0]!['data']).toEqual([[0], [1], [2]]);
  });

  test('the x-axis spans the nominal width the layout was computed at', () => {
    // The geometry is laid out once at a fixed width and scaled when painted,
    // so a resize re-scales rather than re-laying-out.
    const { x } = axes(buildRectanglesOption([bar(0, 10)], THEME));
    expect(x['min']).toBe(0);
    expect(x['max']).toBe(NOMINAL_WIDTH);
  });

  test('hovering one bar blurs the rest rather than redrawing them', () => {
    const series = seriesOf(buildRectanglesOption([bar(0, 10)], THEME))[0]!;
    expect((series['emphasis'] as Record<string, unknown>)['focus']).toBe('self');
    const blur = (series['blur'] as Record<string, Record<string, unknown>>)['itemStyle']!;
    expect(blur['opacity']).toBeLessThan(1);
  });

  test('an empty profile is a valid option with nothing in it', () => {
    expect(seriesOf(buildRectanglesOption([], THEME))[0]!['data']).toEqual([]);
  });

  test('the grid has no padding, so pixel coordinates mean what they say', () => {
    // `renderItem` returns raw pixel shapes; a non-zero grid would shift every
    // bar by an amount the layout never accounted for.
    const grid = (buildRectanglesOption([bar(0, 10)], THEME) as unknown as {
      grid: Record<string, number>;
    }).grid;
    expect(grid).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
  });
});
