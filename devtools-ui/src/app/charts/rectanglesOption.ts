import type { ChartTheme } from './ChartThemeService.js';
import type { CustomSeriesOption, DevToolsChartOption } from './echartsModules.js';

/**
 * Nominal width the geometry is laid out at.
 *
 * `layoutRectangles` and `layoutProfile` take a pixel width, and they stay
 * exactly as they were — they are the tested part.  Laying out at a fixed
 * nominal width and scaling in `renderItem` makes the result resolution
 * independent, so a resize re-scales rather than re-laying-out, and the layout
 * functions never learn about the chart.
 */
export const NOMINAL_WIDTH = 1000;

/** One bar, in nominal coordinates. */
export type ChartRectangle = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly label: string;
  readonly color: string;
};

/**
 * A flame graph, a waterfall or an icicle — they are the same drawing.
 *
 * ECharts has no flame-graph series, which is why the geometry stayed ours:
 * this only paints what `flamegraph.ts` and `profileTree.ts` computed.  What it
 * buys over the hand-rolled `paint()` is the parts nobody wants to write twice
 * — the device-pixel-ratio handling, the resize, and hit regions that report
 * which bar the pointer is over without a second geometry pass.
 *
 * Dimming is `emphasis`/`blur`: hovering a bar blurs the rest, which is the
 * same reading as the old explicit `globalAlpha` pass and costs no extra draw.
 */
export function buildRectanglesOption(
  rectangles: readonly ChartRectangle[],
  theme: ChartTheme,
): DevToolsChartOption {
  // One cast, at the library boundary and nowhere else.  ECharts' published
  // `CustomSeriesOption` and the one its composed option type expects are two
  // different declarations of the same shape, so a `custom` series cannot be
  // written without it.  Everything the series actually contains is checked
  // above this line.
  const option = {
    animation: false,
    grid: { left: 0, right: 0, top: 0, bottom: 0 },
    xAxis: { type: 'value', min: 0, max: NOMINAL_WIDTH, show: false },
    yAxis: { type: 'value', min: 0, max: 1, inverse: true, show: false },
    tooltip: {
      backgroundColor: theme.background,
      borderColor: theme.border,
      textStyle: { color: theme.text },
      formatter: (params: unknown) => {
        const index = (params as { dataIndex?: number }).dataIndex ?? -1;
        return rectangles[index]?.label ?? '';
      },
    },
    series: [{
      type: 'custom',
      // Blur the rest while one bar is hovered: the same reading the explicit
      // alpha pass gave, without a second draw.
      emphasis: { focus: 'self' as const },
      blur: { itemStyle: { opacity: 0.45 } },
      data: rectangles.map((_, index) => [index]),
      renderItem: ((params: unknown, api: unknown) => {
        const index = (params as { dataIndex: number }).dataIndex;
        const rectangle = rectangles[index];
        if (rectangle === undefined) return { type: 'group', children: [] };
        const drawing = api as {
          getWidth(): number;
          getHeight(): number;
        };
        const scale = drawing.getWidth() / NOMINAL_WIDTH;
        const x = rectangle.x * scale;
        const width = Math.max(rectangle.width * scale, 1);
        const children: unknown[] = [{
          type: 'rect',
          shape: { x, y: rectangle.y, width, height: rectangle.height },
          style: {
            fill: rectangle.color,
            stroke: theme.background,
            lineWidth: 1,
          },
        }];
        // Only label a bar with room for it; clipped text is worse than none.
        if (width > 42) {
          children.push({
            type: 'text',
            style: {
              x: x + 5,
              y: rectangle.y + rectangle.height / 2,
              text: rectangle.label,
              fill: theme.textStrong,
              font: '11px ui-monospace, monospace',
              verticalAlign: 'middle',
              truncate: { outerWidth: width - 10 },
            },
          });
        }
        return { type: 'group', children };
        // Cast at the boundary: `renderItem` is typed against ECharts' own
        // params/api interfaces, and the two values used here — `dataIndex` and
        // `getWidth()` — are a much smaller surface than either of them.
      }) as CustomSeriesOption['renderItem'],
    }],
  };
  return option as DevToolsChartOption;
}
