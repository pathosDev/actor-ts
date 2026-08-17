/**
 * `prom-client` shared-registry example (#64).
 *
 *   bun examples/management/prom-client-shared.ts
 *   curl http://localhost:9102/metrics
 *
 * Demonstrates the bridge from the framework's `MetricsRegistry` into
 * a `prom-client` registry the user already owns.  Two metrics
 * appear at the same exposition endpoint:
 *
 *   - `actor_ts_messages_delivered_total` — framework stock metric
 *     (driven by the worker actor's mailbox).
 *   - `app_orders_total` — app metric the user defines on the
 *     `prom-client` side directly.
 *
 * The framework metric and the app metric live in the **same**
 * `prom-client` registry.  The user's existing `register.metrics()`
 * route emits both — no extra HTTP server, no merging, no duplicate
 * scrape configuration.
 *
 * Note: `prom-client` is an optional peer dep — install it before
 * running:  `npm install prom-client`.
 */
import {
  Actor,
  ActorSystem,
  CoordinatedShutdownId,
  Phases,
} from '../../src/index.js';
import {
  MetricsExtensionId,
  promClientRegistry,
  PromClientAdapterOptions,
} from '../../src/metrics/index.js';
import { attachDevTools } from '../devtools.js';

// `prom-client` is a peer dep; we resolve it lazily so the framework
// build still works without it.  In a real app this is a top-of-file
// `import client from 'prom-client'` — only the example dances around
// the optional install.
const client = await loadPromClient();

class Worker extends Actor<{ id: number }> {
  override async onReceive(_m: { id: number }): Promise<void> {
    await Bun.sleep(2 + Math.random() * 5);
  }
}

// 1. The user's existing prom-client registry.  Their app probably
//    already has one of these — `client.register` is the default
//    global registry; for the demo we make a fresh one so output is
//    deterministic.
const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

// 2. App metric defined directly on the prom-client side.  Untouched
//    by the framework — same registry.
const orders = new client.Counter({
  name: 'app_orders_total',
  help: 'Orders the app processed',
  labelNames: ['region'],
  registers: [registry],
});

// 3. Plug the bridge into the actor system's metrics extension.  Every
//    framework counter / gauge / histogram from here on writes into
//    the same prom-client registry.  `actor_ts_` namespace makes the
//    bridge-sourced families easy to spot in the exposition.
const system = ActorSystem.create('metrics-shared');
const devtools = await attachDevTools(system);
const promAdapterOptions = PromClientAdapterOptions.create()
  .withClient(client)
  .withRegistry(registry)
  .withNamePrefix('actor_ts_');
system.extension(MetricsExtensionId).useRegistry(
  promClientRegistry(promAdapterOptions),
);

// 4. Drive a steady stream so the framework's stock counters tick.
const worker = system.spawn(Worker, 'worker');
let nextId = 0;
const tick = setInterval(() => {
  for (let i = 0; i < 5; i++) worker.tell({ id: nextId++ });
  // Bump the app metric in the same loop — purely to show both move.
  orders.labels({ region: 'eu' }).inc();
}, 100);

// 5. The user's existing /metrics endpoint.  No bridge specifics here
//    — `prom-client.register.metrics()` is the same call the user
//    already makes for their app.
const server = Bun.serve({
  port: 9102,
  fetch: async () => {
    return new Response(await registry.metrics(), {
      headers: { 'content-type': registry.contentType },
    });
  },
});

console.log(`shared prom-client endpoint: http://localhost:${server.port}/metrics`);
console.log('Both `actor_ts_*` (framework) and `app_orders_total` (app) appear in the same scrape.');
console.log('press Ctrl+C to exit');

// The scrape endpoint is the user's own `Bun.serve`, so it joins the
// pipeline explicitly — the same phase the framework's own HTTP bindings
// unbind in.
const coordinatedShutdown = system.extension(CoordinatedShutdownId);
coordinatedShutdown.addTask(Phases.ServiceUnbind, 'stop-metrics-server', () => { server.stop(); });
coordinatedShutdown.addTask(Phases.BeforeServiceUnbind, 'stop-load', () => { clearInterval(tick); });

await system.runUntilTerminated();

/** Optional-peer-dep load.  Tells the user clearly when prom-client is missing. */
async function loadPromClient(): Promise<typeof import('prom-client') & { register: { metrics(): Promise<string>; contentType: string } }> {
  try {
    return (await import('prom-client')) as never;
  } catch {
    process.stderr.write(
      'This example needs `prom-client` (optional peer dep).\n'
      + 'Install it: `npm install prom-client` (or `bun add prom-client`).\n',
    );
    process.exit(1);
  }
}
