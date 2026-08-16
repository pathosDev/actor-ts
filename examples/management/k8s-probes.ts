/**
 * Realistic Management: simulates a Kubernetes deployment.  The pod
 * exposes /health (liveness — independent of cluster), /ready (readiness —
 * requires cluster Up + dependencies), /cluster/members (debugging) and
 * /cluster/leave (PreStop hook).  Custom health checks test the journal
 * and the sharding region.
 *
 *   bun run examples/management/k8s-probes.ts
 *
 * Then, in another terminal:
 *   curl -i http://127.0.0.1:8558/health
 *   curl -i http://127.0.0.1:8558/ready
 *   curl -X POST http://127.0.0.1:8558/cluster/leave
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
import { attachDevTools } from '../devtools.js';

async function main(): Promise<void> {
  const system = ActorSystem.create('k8s-probes');
  const devtools = await attachDevTools(system);
  const clusterOptions = ClusterOptions.create()
    .withHost('pod')
    .withPort(2552)
    .withTransport(new InMemoryTransport(new NodeAddress('k8s-probes', 'pod', 2552)));
  const cluster = await Cluster.join(system, clusterOptions);

  const routes = managementRoutes(system, cluster, {
    enableLeaveEndpoint: true,
  });

  // The system-wide registry — `Cluster.join` already put the framework's
  // two cluster readiness checks in it, and the framework's liveness check
  // is there too.  Application checks join them here.
  const health = healthChecksOf(system);

  // Liveness stays independent of every dependency — a failing liveness
  // probe restarts the pod, and no restart fixes someone else's outage.
  health.addLiveness(() => ({ name: 'warm-caches', status: true }));

  // Readiness gate: app config loaded + simulated DB connection.  Cluster
  // membership and cluster connectivity are already covered by the
  // framework's own checks.
  let databaseConnected = false;
  health.addReadiness(() => ({ name: 'config', status: true }));
  health.addReadiness(() => ({
    name: 'database',
    status: databaseConnected,
    detail: databaseConnected ? '' : 'connecting',
  }));

  const binding = await system.http(8558).bind(routes);
  console.log(`Kubernetes probes on http://${binding.host}:${binding.port}`);
  console.log(`  Liveness:  GET  /health`);
  console.log(`  Readiness: GET  /ready   (currently DOWN — database not connected)`);
  console.log(`  Members:   GET  /cluster/members`);
  console.log(`  PreStop:   POST /cluster/leave`);

  // Simulate the database coming online after 2s — readiness flips to UP.
  setTimeout(() => {
    databaseConnected = true;
    console.log('-- database now ready — readiness probe will return 200 --');
  }, 2_000);

  // Graceful shutdown hook (SIGINT).
  process.on('SIGINT', async () => {
    console.log('\nSIGINT — leaving cluster and unbinding HTTP');
    await binding.unbind();
    await cluster.leave();
    await system.terminate();
    process.exit(0);
  });

  // Keep the process alive indefinitely for demo purposes.
  await new Promise(() => { /* park */ });
}

void main();
