import type { Routes } from '@angular/router';

import type { DevToolsPanelId } from '../../../src/devtools/protocol/index.js';

/**
 * What the nav rail needs to know about a panel, beyond its route.
 *
 * Carried in the route's `data` so the roster and the routing table cannot
 * drift apart — they were two lists before (#485), a registry and a set of
 * `registerPanel` calls, and keeping them in step was a convention rather than
 * a property.
 */
export type PanelRouteData = {
  readonly id: DevToolsPanelId;
  readonly title: string;
  /** One line, for the nav rail's tooltip. */
  readonly description: string;
};

/**
 * The panel roster, as routes.
 *
 * Every panel is a lazy `loadComponent`, which is what keeps each one in its
 * own chunk and its own size budget — the same property the old registry's
 * lazy `load()` had, expressed the way Angular expresses it.
 *
 * Panels are declared even before their server side exists: the `welcome`
 * handshake decides whether each one is usable, so an unimplemented panel shows
 * up as an explained, disabled nav entry rather than vanishing.
 */
export const PANEL_ROUTES: Routes = [
  {
    path: 'dashboard',
    data: {
      id: 'dashboard',
      title: 'Overview',
      description: 'System at a glance and the way into every tool.',
    } satisfies PanelRouteData,
    loadComponent: () => import('../panels/dashboard/DashboardPanelComponent.js')
      .then((m) => m.DashboardPanelComponent),
  },
  {
    path: 'actors',
    data: {
      id: 'actors',
      title: 'Actors',
      description: 'Live actor tree, mailbox depths and the busiest actors.',
    } satisfies PanelRouteData,
    loadComponent: () => import('../panels/actors/ActorsPanelComponent.js')
      .then((m) => m.ActorsPanelComponent),
  },
  {
    path: 'cluster',
    data: {
      id: 'cluster',
      title: 'Cluster',
      description: 'Node topology, shard distribution and membership history.',
    } satisfies PanelRouteData,
    loadComponent: () => import('../panels/cluster/ClusterPanelComponent.js')
      .then((m) => m.ClusterPanelComponent),
  },
  {
    path: 'tracing',
    data: {
      id: 'tracing',
      title: 'Tracing',
      description: 'Flame graph and waterfall over recorded message spans.',
    } satisfies PanelRouteData,
    loadComponent: () => import('../panels/tracing/TracingPanelComponent.js')
      .then((m) => m.TracingPanelComponent),
  },
  {
    path: 'explain',
    data: {
      id: 'explain',
      title: 'Explain plan',
      description: 'The last messages one actor handled, with timings.',
    } satisfies PanelRouteData,
    loadComponent: () => import('../panels/explain/ExplainPanelComponent.js')
      .then((m) => m.ExplainPanelComponent),
  },
  {
    path: 'time-travel',
    data: {
      id: 'time-travel',
      title: 'Time travel',
      description: 'Browse a journal and reconstruct state at any point.',
    } satisfies PanelRouteData,
    loadComponent: () => import('../panels/timetravel/TimeTravelPanelComponent.js')
      .then((m) => m.TimeTravelPanelComponent),
  },
  {
    path: 'profiler',
    data: {
      id: 'profiler',
      title: 'Profiler',
      description: 'Sample where the actor system spends its time.',
    } satisfies PanelRouteData,
    loadComponent: () => import('../panels/profiler/ProfilerPanelComponent.js')
      .then((m) => m.ProfilerPanelComponent),
  },
  {
    path: 'dead-letters',
    data: {
      id: 'dead-letters',
      title: 'Dead letters',
      description: 'Messages the system could not deliver, and why.',
    } satisfies PanelRouteData,
    loadComponent: () => import('../panels/deadletters/DeadLettersPanelComponent.js')
      .then((m) => m.DeadLettersPanelComponent),
  },
  {
    path: 'event-stream',
    data: {
      id: 'event-stream',
      title: 'Event stream',
      description: 'Live tail of the event bus, and the cluster PubSub topics.',
    } satisfies PanelRouteData,
    loadComponent: () => import('../panels/eventstream/EventStreamPanelComponent.js')
      .then((m) => m.EventStreamPanelComponent),
  },
  {
    path: 'config',
    data: {
      id: 'config',
      title: 'Configuration',
      description: 'Every resolved HOCON key, and which layer set it.',
    } satisfies PanelRouteData,
    loadComponent: () => import('../panels/config/ConfigPanelComponent.js')
      .then((m) => m.ConfigPanelComponent),
  },
];

/** The nav roster, in declaration order. */
export const PANEL_ROSTER: readonly PanelRouteData[] = PANEL_ROUTES
  .map((route) => route.data as PanelRouteData);

export const APP_ROUTES: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  ...PANEL_ROUTES,
  // Anything else is not a panel.  The server never serves this document for
  // an unknown PATH — `UiAssetRoutes.ts` has no SPA fallback on purpose — so
  // this only catches an unknown HASH, which is a typo rather than a 404.
  { path: '**', redirectTo: 'dashboard' },
];
