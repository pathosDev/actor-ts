/**
 * The panel roster, lifted out of `main.ts` when that became an Angular
 * bootstrap (#483).
 *
 * Registration is the only place that knows the full roster: every later phase
 * adds one entry here plus its own directory, and the shell, router and
 * dashboard pick it up without changes.  Panels are declared even before their
 * server side exists — the handshake decides whether each one is usable, so an
 * unimplemented panel shows up as an explained card rather than vanishing.
 *
 * The lazy `load()` per panel is also what keeps the per-panel size budgets
 * measurable: each one becomes its own chunk, and `scripts/build-devtools-ui.mjs`
 * attributes a budget to it by name.  That property has to survive the move to
 * Angular's builder, which is why these stayed dynamic `import()`s rather than
 * becoming router-level `loadComponent`s in this issue — the shell still owns
 * navigation until #485 ports it.
 */
import { registerPanel } from './PanelRegistry.js';

/** Register every panel.  Called once, from the shell host adapter. */
export function registerAllPanels(): void {
  registerPanel({
    id: 'dashboard',
    title: 'Overview',
    description: 'System at a glance and the way into every tool.',
    order: 0,
    load: () => import('../panels/dashboard/dashboardPanel.js'),
  });

  registerPanel({
    id: 'actors',
    title: 'Actors',
    description: 'Live actor tree, mailbox depths and the busiest actors.',
    order: 10,
    load: () => import('../panels/actors/actorsPanel.js'),
  });

  registerPanel({
    id: 'cluster',
    title: 'Cluster',
    description: 'Node topology, shard distribution and membership history.',
    order: 20,
    load: () => import('../panels/cluster/clusterPanel.js'),
  });

  registerPanel({
    id: 'tracing',
    title: 'Tracing',
    description: 'Flame graph and waterfall over recorded message spans.',
    order: 30,
    load: () => import('../panels/tracing/tracingPanel.js'),
  });

  registerPanel({
    id: 'explain',
    title: 'Explain plan',
    description: 'The last messages one actor handled, with timings.',
    order: 40,
    load: () => import('../panels/explain/ExplainPanelComponent.js'),
  });

  registerPanel({
    id: 'time-travel',
    title: 'Time travel',
    description: 'Browse a journal and reconstruct state at any point.',
    order: 50,
    load: () => import('../panels/timetravel/TimeTravelPanelComponent.js'),
  });

  registerPanel({
    id: 'profiler',
    title: 'Profiler',
    description: 'Sample where the actor system spends its time.',
    order: 60,
    load: () => import('../panels/profiler/profilerPanel.js'),
  });
}
