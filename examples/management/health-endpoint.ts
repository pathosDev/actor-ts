/**
 * Hello Management: expose /health + /cluster/members on port 8558.
 * Kubernetes probes map directly onto the endpoints — point
 * livenessProbe.httpGet.path at /health and readinessProbe at /ready.
 *
 *   bun run examples/management/health-endpoint.ts
 *   curl http://127.0.0.1:8558/cluster/members
 *   curl http://127.0.0.1:8558/health
 *   curl http://127.0.0.1:8558/ready
 */
import {
  ActorSystem,
  Cluster,
  ClusterOptions,
  InMemoryTransport,
  NodeAddress,
  managementRoutes,
} from '../../src/index.js';

async function main(): Promise<void> {
  const system = ActorSystem.create('mgmt-hello');
  const clusterOptions = ClusterOptions.create()
    .withHost('local')
    .withPort(1)
    .withTransport(new InMemoryTransport(new NodeAddress('mgmt-hello', 'local', 1)));
  const cluster = await Cluster.join(system, clusterOptions);

  const { routes, health } = managementRoutes(system, cluster);
  // Register a trivial readiness check.
  health.addReadiness(() => ({ name: 'config-loaded', status: true }));

  const binding = await system.http(8558, { host: '127.0.0.1' }).bind(routes);
  console.log(`management endpoint on http://${binding.host}:${binding.port}`);

  // Let the server run for a short while in the demo, then shut down.
  console.log('try: curl http://127.0.0.1:8558/cluster/members');
  await Bun.sleep(200);

  await binding.unbind();
  await cluster.leave();
  await system.terminate();
}

void main();
