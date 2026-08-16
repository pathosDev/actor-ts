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
} from '../../src/index.js';
import {
  Cluster,
  ClusterOptions,
  InMemoryTransport,
  NodeAddress,
} from '../../src/cluster/index.js';
import {
  healthChecksOf,
  managementRoutes,
} from '../../src/management/index.js';

async function main(): Promise<void> {
  const system = ActorSystem.create('mgmt-hello');
  const clusterOptions = ClusterOptions.create()
    .withHost('local')
    .withPort(1)
    .withTransport(new InMemoryTransport(new NodeAddress('mgmt-hello', 'local', 1)));
  const cluster = await Cluster.join(system, clusterOptions);

  const routes = managementRoutes(system, cluster);
  // Register a trivial readiness check on the system-wide registry — the
  // same one `Cluster.join` put its own two checks in, and the same one a
  // gRPC health service would read.
  healthChecksOf(system).addReadiness(() => ({ name: 'config-loaded', status: true }));

  const binding = await system.http(8558, { host: '127.0.0.1' }).bind(routes);
  console.log(`management endpoint on http://${binding.host}:${binding.port}`);

  // Not a drain sleep — nothing is queued for it to flush, and deleting it
  // leaves the output unchanged.  It is the dwell that makes the curl line
  // above true: without it the port is unbound again before anyone can hit it.
  console.log('try: curl http://127.0.0.1:8558/cluster/members');
  await Bun.sleep(200);

  await binding.unbind();
  await cluster.leave();
  await system.terminate();
}

void main();
