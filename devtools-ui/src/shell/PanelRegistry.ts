/**
 * Panel plug-in registry.
 *
 * Panels are registered with a lazy `load()` so each one becomes its
 * own bundle chunk.  That is what keeps the phases independent: adding
 * the tracing or profiler panel later is one `registerPanel` call plus
 * a new directory, with no edit to the shell — and it keeps the
 * per-panel size budgets individually measurable in the build.
 */
import type { DevToolsPanelId } from '../../../src/devtools/protocol/index.js';
import type { ReadonlySignal } from '../core/signal.js';
import type { TapClient } from '../core/tapClient.js';
import type { UiRoute } from '../core/router.js';

/** What a panel gets when it mounts. */
export interface PanelContext {
  readonly tap: TapClient;
  readonly route: ReadonlySignal<UiRoute>;
}

/** A mounted panel; `dispose` detaches its effects and stream listeners. */
export interface PanelInstance {
  dispose(): void;
}

/** The module shape a panel's `index.ts` must default-export. */
export interface PanelModule {
  mount(host: HTMLElement, context: PanelContext): PanelInstance;
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
