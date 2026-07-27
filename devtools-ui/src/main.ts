/**
 * DevTools UI bootstrap.
 *
 * Registration is the only place that knows the full panel roster:
 * every later phase adds one entry here plus its own directory, and
 * the shell, router and dashboard pick it up without changes.  Panels
 * are declared even before their server side exists — the handshake
 * decides whether each one is usable, so an unimplemented panel shows
 * up as an explained card rather than vanishing.
 */
import './styles/base.css';
import { connectTap, tapUrl } from './core/tapClient.js';
import { registerPanel } from './shell/PanelRegistry.js';
import { mountAppShell } from './shell/AppShell.js';

registerPanel({
  id: 'dashboard',
  title: 'Overview',
  description: 'System at a glance and the way into every tool.',
  order: 0,
  load: () => import('./panels/dashboard/dashboardPanel.js'),
});

registerPanel({
  id: 'actors',
  title: 'Actors',
  description: 'Live actor tree, mailbox depths and the busiest actors.',
  order: 10,
  load: () => import('./panels/actors/actorsPanel.js'),
});

registerPanel({
  id: 'cluster',
  title: 'Cluster',
  description: 'Node topology, shard distribution and membership history.',
  order: 20,
  load: () => import('./panels/cluster/clusterPanel.js'),
});

registerPanel({
  id: 'tracing',
  title: 'Tracing',
  description: 'Flame graph and waterfall over recorded message spans.',
  order: 30,
  load: () => import('./panels/tracing/tracingPanel.js'),
});

// Declared but not built yet — see `panels/notImplementedPanel.ts`.
// Each later phase swaps one of these `load` lines for its real panel.
registerPanel({
  id: 'explain',
  title: 'Explain plan',
  description: 'The last messages one actor handled, with timings.',
  order: 40,
  load: () => import('./panels/notImplementedPanel.js'),
});

registerPanel({
  id: 'time-travel',
  title: 'Time travel',
  description: 'Browse a journal and reconstruct state at any point.',
  order: 50,
  load: () => import('./panels/notImplementedPanel.js'),
});

registerPanel({
  id: 'profiler',
  title: 'Profiler',
  description: 'Sample where the actor system spends its time.',
  order: 60,
  load: () => import('./panels/notImplementedPanel.js'),
});

const root = document.getElementById('app');
if (root !== null) mountAppShell(root, connectTap(tapUrl()));
