/**
 * The only module in this bundle that imports ECharts.
 *
 * Everything else reaches it through a lazy `import()` from
 * `EChartComponent`, which is what keeps ECharts in its own attributable chunk
 * and out of the shell budget — the shell is what every page load pays for,
 * and a reader who never opens a chart should not pay for a chart library.
 *
 * The import set is tree-shaken deliberately rather than pulling `echarts`
 * whole: the full build is several times the size of everything else in this
 * UI combined.  Adding a chart type means adding it here, and the size budget
 * in `scripts/build-devtools-ui.mjs` is what notices if that stops being a
 * considered decision.
 *
 *   - `LineChart`   — the overview's sparklines and its three line charts.
 *   - `GraphChart`  — the cluster ring, with `layout: 'circular'`.
 *   - `CustomChart` — the tracing flame graph and waterfall, and the profiler
 *                     icicle.  ECharts has no flame-graph series, so the
 *                     geometry stays ours and this only draws it.
 */
import { init, use, type ComposeOption, type ECharts } from 'echarts/core';
import { CustomChart, GraphChart, LineChart } from 'echarts/charts';
import type {
  CustomSeriesOption,
  GraphSeriesOption,
  LineSeriesOption,
} from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import type { GridComponentOption, TooltipComponentOption } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

use([
  LineChart,
  GraphChart,
  CustomChart,
  GridComponent,
  TooltipComponent,
  CanvasRenderer,
]);

/**
 * The option type for exactly the modules registered above.
 *
 * Composed rather than `echarts`' own catch-all `EChartsOption`: the composed
 * type rejects an option for a series that was never registered, which is a
 * blank chart at runtime and a compile error here.
 */
export type DevToolsChartOption = ComposeOption<
  | CustomSeriesOption
  | GraphSeriesOption
  | LineSeriesOption
  | GridComponentOption
  | TooltipComponentOption
>;

export type { CustomSeriesOption, ECharts };
export { init };
