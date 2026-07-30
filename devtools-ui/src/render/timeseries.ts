/**
 * Canvas time-series rendering — sparklines in tiles, larger area
 * charts below them.
 *
 * Canvas rather than SVG because these redraw on every sample: at one
 * tick a second with several hundred points, replacing SVG nodes churns
 * the DOM for no benefit, while a canvas repaint is a single call.
 *
 * The geometry is a pure function ({@link projectPoints}) so the part
 * that can be wrong in a subtle way is testable without a DOM.
 */
import type { SeriesPoint } from '../core/history.js';

/** A projected point in canvas pixels. */
export type ProjectedPoint = {
  readonly x: number;
  readonly y: number;
};

/** Plot area in CSS pixels. */
export type PlotBox = {
  readonly width: number;
  readonly height: number;
  /** Space left below the line so a flat zero series is still visible. */
  readonly padding: number;
};

/**
 * Map samples onto the plot box.
 *
 * The vertical scale always starts at zero — a rate chart auto-scaled
 * to its own minimum turns ordinary jitter into dramatic-looking
 * mountains, which is the opposite of what a spike indicator is for.
 * The horizontal axis is spaced by TIME, not by index, so a gap in the
 * samples shows as a gap rather than being quietly compressed away.
 */
export function projectPoints(
  points: ReadonlyArray<SeriesPoint>,
  box: PlotBox,
  peak: number,
): ReadonlyArray<ProjectedPoint> {
  if (points.length === 0) return [];

  const usableHeight = Math.max(box.height - box.padding * 2, 1);
  const scaleTop = peak > 0 ? peak : 1;

  if (points.length === 1) {
    const only = points[0]!;
    return [{
      x: box.width,
      y: box.padding + usableHeight - (only.value / scaleTop) * usableHeight,
    }];
  }

  const firstMs = points[0]!.atMs;
  const spanMs = Math.max(points[points.length - 1]!.atMs - firstMs, 1);
  return points.map((point) => ({
    x: ((point.atMs - firstMs) / spanMs) * box.width,
    y: box.padding + usableHeight - (Math.min(point.value, scaleTop) / scaleTop) * usableHeight,
  }));
}

/** Size the backing store for the display's pixel ratio, and clear it. */
function prepare(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const context = canvas.getContext('2d');
  if (context === null) return null;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || Number(canvas.getAttribute('width')) || 120;
  const height = canvas.clientHeight || Number(canvas.getAttribute('height')) || 32;
  if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
    canvas.width = width * ratio;
    canvas.height = height * ratio;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  return context;
}

/** Resolve a CSS custom property so canvas colours follow the theme. */
export function themeColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

/** A compact line + fill, sized to its element. */
export function drawSparkline(
  canvas: HTMLCanvasElement,
  points: ReadonlyArray<SeriesPoint>,
  color: string,
  peak: number,
): void {
  const context = prepare(canvas);
  if (context === null) return;
  const box: PlotBox = {
    width: canvas.clientWidth || 120,
    height: canvas.clientHeight || 32,
    padding: 2,
  };
  const projected = projectPoints(points, box, peak);
  if (projected.length < 2) return;

  context.beginPath();
  context.moveTo(projected[0]!.x, projected[0]!.y);
  for (const point of projected.slice(1)) context.lineTo(point.x, point.y);

  // Fill under the line first, then stroke it on top.
  context.save();
  context.lineTo(projected[projected.length - 1]!.x, box.height);
  context.lineTo(projected[0]!.x, box.height);
  context.closePath();
  context.globalAlpha = 0.18;
  context.fillStyle = color;
  context.fill();
  context.restore();

  context.beginPath();
  context.moveTo(projected[0]!.x, projected[0]!.y);
  for (const point of projected.slice(1)) context.lineTo(point.x, point.y);
  context.strokeStyle = color;
  context.lineWidth = 1.5;
  context.lineJoin = 'round';
  context.stroke();
}

/** One named series in a chart. */
export type ChartSeries = {
  readonly label: string;
  readonly color: string;
  readonly points: ReadonlyArray<SeriesPoint>;
};

/**
 * A larger multi-series chart with a baseline and a peak label.
 *
 * All series share one vertical scale so they stay comparable — a chart
 * where each line is scaled to itself invites reading a quiet series as
 * if it were as busy as a loud one.
 */
export function drawChart(
  canvas: HTMLCanvasElement,
  series: ReadonlyArray<ChartSeries>,
  peak: number,
): void {
  const context = prepare(canvas);
  if (context === null) return;
  const box: PlotBox = {
    width: canvas.clientWidth || 400,
    height: canvas.clientHeight || 120,
    padding: 8,
  };

  context.strokeStyle = themeColor('--dt-border', '#334155');
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, box.height - box.padding);
  context.lineTo(box.width, box.height - box.padding);
  context.stroke();

  for (const line of series) {
    const projected = projectPoints(line.points, box, peak);
    if (projected.length < 2) continue;
    context.beginPath();
    context.moveTo(projected[0]!.x, projected[0]!.y);
    for (const point of projected.slice(1)) context.lineTo(point.x, point.y);
    context.strokeStyle = line.color;
    context.lineWidth = 1.75;
    context.lineJoin = 'round';
    context.stroke();
  }
}
