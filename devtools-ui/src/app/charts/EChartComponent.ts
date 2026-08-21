import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

import type { DevToolsChartOption, ECharts } from './echartsModules.js';

/**
 * One chart, and the only thing that loads ECharts.
 *
 * The import is a lazy `import()` so ECharts lands in its own chunk: the shell
 * is what every page load pays for, and a reader who opens the actor tree and
 * nothing else should not pay for a chart library.  The build attributes that
 * chunk to the `charts` budget.
 *
 * This also absorbs the three near-identical device-pixel-ratio helpers the
 * hand-drawn canvases each carried — ECharts owns its backing store, and a
 * `ResizeObserver` is a better answer than a window `resize` listener for an
 * element whose size can change without the window doing so.
 */
@Component({
  selector: 'devtools-echart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
  styles: ':host { display: block; }',
})
export class EChartComponent {
  readonly option = input.required<DevToolsChartOption>();
  /** CSS height, because a chart element has no intrinsic one. */
  readonly height = input('220px');

  /**
   * The `dataIndex` under the pointer, or `null`.
   *
   * Emitted rather than handled here because what an index MEANS belongs to the
   * panel: for the flame graph it is an index into the rectangles our own
   * layout produced, which is the part ECharts has no opinion about.
   */
  readonly hovered = output<number | null>();

  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly chart = signal<ECharts | null>(null);
  /**
   * Whether an option has been applied yet.
   *
   * `resize()` walks the series of the current option, and a freshly `init`ed
   * chart has none — it throws inside ECharts rather than no-opping.  The
   * observer below fires as soon as it starts observing, which is before the
   * effect has had a chance to set anything, so without this the first paint of
   * every chart logged an error.
   */
  private applied = false;

  constructor() {
    const destroyRef = inject(DestroyRef);
    let disposed = false;

    void (async () => {
      const { init } = await import('./echartsModules.js');
      if (disposed) return;
      const instance = init(this.element.nativeElement, undefined, { renderer: 'canvas' });
      instance.on('mouseover', (event: { dataIndex?: number }) => {
        this.hovered.emit(event.dataIndex ?? null);
      });
      instance.on('globalout', () => this.hovered.emit(null));
      this.chart.set(instance);
    })();

    // `ResizeObserver`, not a window listener: the nav rail and the offline
    // dialog can change a panel's width without the window resizing at all.
    const observer = new ResizeObserver(() => { if (this.applied) this.chart()?.resize(); });
    observer.observe(this.element.nativeElement);

    destroyRef.onDestroy(() => {
      disposed = true;
      observer.disconnect();
      this.chart()?.dispose();
    });

    effect(() => {
      this.element.nativeElement.style.height = this.height();
      const instance = this.chart();
      if (instance === null) return;
      // `notMerge` so a series that disappears from the option disappears from
      // the chart; merging would leave the previous run's bars on screen.
      instance.setOption(this.option(), { notMerge: true });
      this.applied = true;
      instance.resize();
    });
  }
}
