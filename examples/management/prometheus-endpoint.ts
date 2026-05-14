/**
 * Prometheus exposition endpoint via `Bun.serve` (#11).
 *
 *   bun run examples/management/prometheus-endpoint.ts
 *   curl http://localhost:9101/metrics
 *
 * Spins up:
 *   - An ActorSystem with metrics enabled.
 *   - A worker actor that processes a few messages per second so the
 *     stock counters tick visibly.
 *   - A Bun HTTP server on port 9101 that returns the registry's
 *     state in Prometheus text format.
 *
 * Point Prometheus (or `curl`) at `/metrics` and scrape away.
 */
import {
  Actor,
  ActorSystem,
  MetricsExtensionId,
  Props,
  prometheusHandler,
} from '../../src/index.js';

class Worker extends Actor<{ id: number }> {
  override async onReceive(_m: { id: number }): Promise<void> {
    // Pretend to do some work — the message-handler histogram captures it.
    await Bun.sleep(2 + Math.random() * 5);
  }
}

const system = ActorSystem.create('metrics-demo');
const registry = system.extension(MetricsExtensionId).enable();

const worker = system.spawn(Props.create(() => new Worker()), 'worker');
let counter = 0;
const interval = setInterval(() => {
  // Drive a small steady stream so the counters change between scrapes.
  for (let i = 0; i < 5; i++) worker.tell({ id: counter++ });
}, 100);

// Custom counter / gauge example — domain metrics live alongside stock
// ones in the same registry.
registry.counter('demo_orders_processed_total', { region: 'eu' }).inc(42);
registry.gauge('demo_active_workers', {}).set(1);

const server = Bun.serve({
  port: 9101,
  fetch: prometheusHandler(registry),
});

console.log(`prometheus endpoint: http://localhost:${server.port}/metrics`);
console.log('press Ctrl+C to exit');

process.on('SIGINT', async () => {
  clearInterval(interval);
  server.stop();
  await system.terminate();
  process.exit(0);
});
