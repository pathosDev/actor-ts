import { Injectable, computed, type Signal } from '@angular/core';

import { currentTheme } from '../../core/theme.js';

/**
 * The colours a chart needs, resolved to real values.
 *
 * ECharts cannot take a CSS custom property — it paints to a canvas, where
 * `var(--dt-data-1)` is just a string it does not understand.  Everything that
 * stays in the DOM keeps using the custom properties directly and gets its
 * theme switching from CSS for free; only the canvases need this.
 */
export type ChartTheme = {
  /** The categorical ramp, in order.  Cycle it for more than eight series. */
  readonly series: readonly string[];
  readonly text: string;
  readonly textMuted: string;
  readonly textStrong: string;
  readonly background: string;
  readonly border: string;
  readonly accent: string;
  readonly stateOk: string;
  readonly stateWarn: string;
  readonly stateError: string;
  readonly stateIdle: string;
};

/** Read one `--dt-*` token, falling back when the sheet has not loaded yet. */
export function themeColor(variable: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  return value === '' ? fallback : value;
}

const FALLBACKS: Readonly<Record<string, string>> = {
  '--dt-data-1': '#818cf8',
  '--dt-data-2': '#22c55e',
  '--dt-data-3': '#f59e0b',
  '--dt-data-4': '#ef4444',
  '--dt-data-5': '#a855f7',
  '--dt-data-6': '#06b6d4',
  '--dt-data-7': '#ec4899',
  '--dt-data-8': '#84cc16',
};

/**
 * The chart palette, recomputed when the theme flips.
 *
 * The `--dt-*` tokens in `:root` stay the single source of colour and
 * `base.css` stays a global stylesheet — this reads them, it does not replace
 * them.  Moving the palette out of CSS would break every chart and every DOM
 * element that shares a token at the same time, which is the reason the
 * coupling is kept rather than tidied away.
 */
@Injectable({ providedIn: 'root' })
export class ChartThemeService {
  /**
   * Depends on `currentTheme` so it recomputes on a flip.  The signal's value
   * is not used — what changed is `data-theme` on the document element, and
   * that is what `getComputedStyle` reads.
   */
  readonly theme: Signal<ChartTheme> = computed<ChartTheme>(() => {
    currentTheme();
    return {
      series: Object.entries(FALLBACKS).map(([variable, fallback]) => themeColor(variable, fallback)),
      text: themeColor('--dt-text', '#cbd5e1'),
      textMuted: themeColor('--dt-text-muted', '#94a3b8'),
      textStrong: themeColor('--dt-text-strong', '#f1f5f9'),
      background: themeColor('--dt-bg', '#0f172a'),
      border: themeColor('--dt-border', '#334155'),
      accent: themeColor('--dt-accent', '#818cf8'),
      stateOk: themeColor('--dt-state-ok', '#22c55e'),
      stateWarn: themeColor('--dt-state-warn', '#f59e0b'),
      stateError: themeColor('--dt-state-error', '#ef4444'),
      stateIdle: themeColor('--dt-state-idle', '#64748b'),
    };
  });
}
