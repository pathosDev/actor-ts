import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  inject,
  input,
  signal,
} from '@angular/core';

import { currentTheme } from '../../core/theme.js';
import { peakOf, type SeriesPoint } from '../../core/history.js';
import { drawChart, drawSparkline, themeColor, type ChartSeries } from '../../render/timeseries.js';

/**
 * The two canvases the overview draws, as components.
 *
 * Drawing has to happen after the view exists — a canvas has no layout size
 * until it is in the document — which is what `afterRenderEffect` is for.  Both
 * components re-read their colours from the `--dt-*` custom properties on every
 * paint rather than caching them, because that is what makes a theme flip
 * recolour the canvas: nothing else would repaint it.
 *
 * They are components rather than an imperative pass over `querySelectorAll`
 * because the inputs are then the whole contract, which is also the seam #486
 * replaces with ECharts — the panel above will not have to change when it does.
 */

/** A figure's recent shape, drawn inside its tile. */
@Component({
  selector: 'devtools-sparkline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<canvas class="dt-tile__spark"></canvas>',
})
export class SparklineComponent {
  readonly points = input.required<readonly SeriesPoint[]>();
  /** CSS custom property naming the series colour. */
  readonly colorVariable = input('--dt-accent');

  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    afterRenderEffect(() => {
      const points = this.points();
      const variable = this.colorVariable();
      currentTheme();
      const canvas = this.element.nativeElement.querySelector('canvas');
      if (canvas === null || points.length < 2) return;
      drawSparkline(canvas, points, themeColor(variable, '#818cf8'), peakOf(points));
    });
  }
}

/**
 * One chart: a legend, a peak reading and the lines themselves.
 *
 * Three of these rather than one chart with everything on it, because a level
 * and a rate cannot share a y-axis honestly — a backlog of 400 flattens a 2/s
 * line to nothing.  Each holds one kind of quantity and scales to its own peak.
 */
@Component({
  selector: 'devtools-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h3 class="dt-chart__title">{{ title() }}</h3>
    <div class="dt-chart__legend">
      @if (collecting()) {
        <span class="dt-empty">collecting samples…</span>
      } @else {
        @for (line of series(); track line.label) {
          <span class="dt-legend__item">
            <span class="dt-legend__swatch" [style.background]="line.color"></span>{{ line.label }}
          </span>
        }
        <span class="dt-legend__peak">peak {{ peakLabel() }}</span>
      }
    </div>
    <canvas class="dt-chart__canvas"></canvas>
  `,
})
export class ChartComponent {
  readonly title = input.required<string>();
  readonly series = input.required<readonly ChartSeries[]>();
  /** True while there is not yet enough history to draw anything meaningful. */
  readonly collecting = input(false);
  readonly peakLabel = input('0');

  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  /** Bumped on resize: a canvas keeps its backing store until told otherwise. */
  private readonly viewport = signal(0);

  constructor() {
    const destroyRef = inject(DestroyRef);

    const onResize = (): void => this.viewport.update((value) => value + 1);
    window.addEventListener('resize', onResize);
    destroyRef.onDestroy(() => window.removeEventListener('resize', onResize));

    afterRenderEffect(() => {
      const lines = this.series();
      const collecting = this.collecting();
      currentTheme();
      this.viewport();
      const canvas = this.element.nativeElement.querySelector('canvas');
      if (canvas === null || collecting) return;
      drawChart(canvas, lines, Math.max(...lines.map((line) => peakOf(line.points)), 0));
    });
  }
}
