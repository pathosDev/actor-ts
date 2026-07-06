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
  Cluster,
  ClusterOptions,
  InMemoryTransport,
  NodeAddress,
  managementRoutes,
} from '../../src/index.js';

async function main(): Promise<void> {
  const system = ActorSystem.create('k8s-probes');
  const cluster = await Cluster.join(system, ClusterOptions.create()
    .withHost('pod')
    .withPort(2552)
    .withTransport(new InMemoryTransport(new NodeAddress('k8s-probes', 'pod', 2552))));

  const { routes, health } = managementRoutes(system, cluster, {
    enableLeaveEndpoint: true,
  });

  // Liveness stays independent of cluster — only says "process alive, not deadlocked".
  health.addLiveness(() => ({ name: 'event-loop', status: true }));

  // Readiness gate: app config loaded + simulated DB connection + cluster already covered.
  let dbConnected = false;
  health.addReadiness(() => ({ name: 'config', status: true }));
  health.addReadiness(() => ({ name: 'db', status: dbConnected, detail: dbConnected ? '' : 'connecting' }));

  const binding = await system.http(8558).bind(routes);
  console.log(`Kubernetes probes on http://${binding.host}:${binding.port}`);
  console.log(`  Liveness:  GET  /health`);
  console.log(`  Readiness: GET  /ready   (currently DOWN — db not connected)`);
  console.log(`  Members:   GET  /cluster/members`);
  console.log(`  PreStop:   POST /cluster/leave`);

  // Simulate the DB coming online after 2s — readiness flips to UP.
  setTimeout(() => {
    dbConnected = true;
    console.log('-- db now ready — readiness probe will return 200 --');
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
