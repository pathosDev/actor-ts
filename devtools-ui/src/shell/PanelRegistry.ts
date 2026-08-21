/**
 * Panel plug-in registry.
 *
 * Panels are registered with a lazy `load()` so each one becomes its
 * own bundle chunk.  That is what keeps the phases independent: adding
 * the tracing or profiler panel later is one `registerPanel` call plus
 * a new directory, with no edit to the shell — and it keeps the
 * per-panel size budgets individually measurable in the build.
 */
import type { Type } from '@angular/core';
import type { DevToolsPanelId } from '../../../src/devtools/protocol/index.js';
import type { ReadonlySignal } from '../core/signal.js';
import type { TapClient } from '../core/tapClient.js';
import type { UiRoute } from '../core/router.js';

/** What a panel gets when it mounts. */
export type PanelContext = {
  readonly tap: TapClient;
  readonly route: ReadonlySignal<UiRoute>;
};

/** A mounted panel; `dispose` detaches its effects and stream listeners. */
export interface PanelInstance {
  dispose(): void;
}

/**
 * A panel that builds its own DOM.
 *
 * The original shape, and a shrinking population: each panel becomes an
 * Angular component in its own commit (#485), and this half of the union — with
 * `LegacyPanelHostComponent`, `core/dom.ts` and `core/signal.ts` — goes with the
 * last of them.
 */
export interface LegacyPanelModule {
  mount(host: HTMLElement, context: PanelContext): PanelInstance;
}

/**
 * A panel that is an Angular component.
 *
 * Loaded through the same lazy `import()` as the legacy shape rather than
 * through a router `loadComponent`, which is what keeps the per-panel chunk
 * split — and therefore the per-panel size budgets — working identically while
 * the two shapes coexist.
 */
export type ComponentPanelModule = {
  readonly panelComponent: Type<unknown>;
};

/** What a panel module may export. */
export type PanelModule = LegacyPanelModule | ComponentPanelModule;

/** Narrows to the component shape; everything else still mounts imperatively. */
export function isComponentPanel(module: PanelModule): module is ComponentPanelModule {
  return 'panelComponent' in module;
}

/** Registration record. */
export interface PanelDefinition {
  readonly id: DevToolsPanelId;
  readonly title: string;
  /** One line, shown on the dashboard card. */
  readonly description: string;
  /** Sort order in the nav rail and on the dashboard. */
  readonly order: number;
  load(): Promise<PanelModule>;
}

const panels = new Map<DevToolsPanelId, PanelDefinition>();

/** Register a panel.  Call once per panel from `main.ts`. */
export function registerPanel(definition: PanelDefinition): void {
  panels.set(definition.id, definition);
}

/** All registered panels, in display order. */
export function registeredPanels(): ReadonlyArray<PanelDefinition> {
  return [...panels.values()].sort((a, b) => a.order - b.order);
}

/** Look up one panel. */
export function findPanel(id: string): PanelDefinition | undefined {
  return panels.get(id as DevToolsPanelId);
}
