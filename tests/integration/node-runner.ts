/**
 * Per-container cluster-node entrypoint (#313).
 *
 * One Bun process per container — configured purely via environment
 * variables, so the same image (Dockerfile.node) becomes any of the
 * five cluster nodes by changing `NODE_NAME` / `HOST` / `SEEDS`.
 *
 * Listens on three ports:
 *   - CLUSTER_PORT (9000): TcpTransport for cluster gossip
 *   - MGMT_PORT (8080):    management HTTP (auth-protected)
 *   - CONTROL_PORT (8090): test-control HTTP (internal network only)
 *
 * Logs as JSON to stdout so the controller can correlate events
 * across nodes via `jq` / `vector` / standard log-aggregation tools.
 */

import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { Cluster } from '../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../src/cluster/ClusterOptions.js';
import {
  Actor,
  BearerTokenAuth,
  HttpExtensionId,
  IpAllowlist,
  Props,
} from '../../src/index.js';
import { JsonLogger, LogLevel } from '../../src/Logger.js';
import { managementRoutes } from '../../src/management/index.js';
import { ReceptionistId, ReceptionistOptions } from '../../src/discovery/index.js';
import { Register } from '../../src/discovery/ReceptionistMessages.js';
import { DistributedDataId, DistributedDataOptions } from '../../src/crdt/index.js';
import { ClusterSingletonId } from '../../src/cluster/singleton/ClusterSingleton.js';
import { StartSingletonOptions } from '../../src/cluster/singleton/StartSingletonOptions.js';
import { ClusterSharding } from '../../src/cluster/sharding/ClusterSharding.js';
import { StartShardingOptions } from '../../src/cluster/sharding/StartShardingOptions.js';
import { ClusterClientReceptionistId } from '../../src/cluster/ClusterClientReceptionist.js';
import { CoordinatedShutdownId, Phases } from '../../src/CoordinatedShutdown.js';
import { PersistenceExtensionId } from '../../src/persistence/PersistenceExtension.js';
import { InMemoryJournal } from '../../src/persistence/journals/InMemoryJournal.js';
import { InMemorySnapshotStore } from '../../src/persistence/snapshot-stores/InMemorySnapshotStore.js';
import { MetricsExtensionId } from '../../src/metrics/MetricsExtension.js';
import { CounterSingleton } from './lib/singleton.js';
import {
  SHARDING_TYPE_NAME,
  ShardedCounter,
  type ShardedCommand,
} from './lib/sharded-counter.js';
import { EchoActor } from './lib/echo.js';
import { makeControlRoutes, WORKER_KEY } from './lib/control-routes.js';

const SYSTEM_NAME = process.env.SYSTEM_NAME ?? 'integration';
const NODE_NAME = process.env.NODE_NAME ?? 'node-x';
const HOST = process.env.HOST ?? NODE_NAME;
const CLUSTER_PORT = Number(process.env.CLUSTER_PORT ?? 9000);
const MGMT_PORT = Number(process.env.MGMT_PORT ?? 8080);
const CONTROL_PORT = Number(process.env.CONTROL_PORT ?? 8090);
const SEEDS = (process.env.SEEDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const MGMT_TOKEN = process.env.MGMT_TOKEN ?? 'integration-test-token';
const LOG_LEVEL = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
// Comma-separated list of all node hostnames, used by scenario 13's
// shutdown hook to forward a "I am shutting down" marker to a peer
// that's still alive (so the controller can verify the hook fired).
const PEERS = (process.env.PEERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function parseLevel(name: string): LogLevel {
  switch (name) {
    case 'debug': return LogLevel.Debug;
    case 'info':  return LogLevel.Info;
    case 'warn':  return LogLevel.Warn;
    case 'error': return LogLevel.Error;
    case 'off':   return LogLevel.Off;
    default:      return LogLevel.Info;
  }
}

async function main(): Promise<void> {
  const logger = new JsonLogger(parseLevel(LOG_LEVEL), '', { node: NODE_NAME });
  logger.info('node-runner starting', { host: HOST, clusterPort: CLUSTER_PORT, seeds: SEEDS });

  const systemOptions = ActorSystemOptions.create()
    .withLogger(logger);
  const system = ActorSystem.create(SYSTEM_NAME, systemOptions);
  // Enable the metrics registry — defaults to NoopMetricsRegistry,
  // which would silently swallow every `counter.inc()` from
  // `actor_mailbox_dropped_total` (the hook scenario 14 verifies).
  system.extension(MetricsExtensionId).enable();
  logger.info('MetricsExtension enabled');
  const cluster = await Cluster.join(
    system,
    ClusterOptions.create()
      .withHost(HOST)
      .withPort(CLUSTER_PORT)
      .withSeeds(SEEDS)
      // Tighter failure detection than the default so scenarios don't
      // wait forever for a partition to register.
      .withFailureDetector({ heartbeatIntervalMs: 200, unreachableAfterMs: 1_500, downAfterMs: 4_000 })
      .withGossipIntervalMs(250),
  );

  // ============================================================
  // Bootstrap cluster-wide gossip extensions BEFORE binding HTTP.
  //
  // Both Receptionist + DistributedData register `_onWire` handlers
  // on their respective wire-message kinds inside the actor's
  // `preStart`.  A peer's outgoing gossip / write-request is
  // silently dropped on the receiving node if the receiving node
  // has no handler registered yet.  Bootstrapping these BEFORE the
  // healthcheck flips green (and therefore before any scenario can
  // hit the control routes) means every node has all four
  // wire-kinds subscribed before peer traffic starts flowing —
  // closes a microtask race the original lazy-on-first-hit design
  // exposed.
  // ============================================================

  // Receptionist + auto-registered IdleWorker.  Tighter gossip
  // interval than the default 1s so convergence in scenarios is
  // observable inside the test budget.
  const receptionistRef = system.extension(ReceptionistId).start(
    cluster,
    ReceptionistOptions.create().withGossipIntervalMs(250),
  );
  class IdleWorker extends Actor<unknown> {
    override onReceive(_m: unknown): void { /* noop */ }
  }
  const worker = system.spawnAnonymous(Props.create<unknown>(() => new IdleWorker()));
  receptionistRef.tell(new Register(WORKER_KEY, worker));
  logger.info('Receptionist started + worker registered', { key: WORKER_KEY.id });

  // DistributedData.  Same gossip-interval tightening.
  system.extension(DistributedDataId).start(
    cluster,
    DistributedDataOptions.create().withGossipInterval(250),
  );
  logger.info('DistributedData started');

  // ClusterSingleton — every node spawns the manager; only the
  // leader's manager spawns the actual CounterSingleton child.
  // The host-node identity is baked into the singleton at construction
  // time, so `SingletonWho` replies tell us which node currently
  // hosts the instance (used by scenario 05 to verify failover).
  const singleton = system.extension(ClusterSingletonId).start(
    cluster,
    StartSingletonOptions.create()
      .withTypeName('counter-singleton')
      .withProps(Props.create(() => new CounterSingleton(NODE_NAME))),
  );
  logger.info('ClusterSingleton manager started', { typeName: 'counter-singleton' });

  // ClusterSharding — every node hosts a ShardRegion for the
  // `counter` type; the leader runs the coordinator which assigns
  // shards to regions.  Each ShardedCounter entity is constructed
  // with NODE_NAME so the Who-query reveals the entity's host.
  // numShards=32 gives a reasonable spread across 5 nodes (~6 each).
  const shardingRegion = ClusterSharding.get(system, cluster).start<ShardedCommand>(
    StartShardingOptions.create<ShardedCommand>()
      .withTypeName(SHARDING_TYPE_NAME)
      .withEntityProps(Props.create(() => new ShardedCounter(NODE_NAME)))
      .withExtractEntityId((message) => message.entityId)
      .withNumShards(32),
  );
  logger.info('ClusterSharding region started', { typeName: SHARDING_TYPE_NAME, numShards: 32 });

  // Pre-register shutdown-trace hooks in TWO different phases so
  // scenario 13 can verify the pipeline actually progressed
  // through both — early (`BeforeServiceUnbind`, phase 1 of 12)
  // and late (`BeforeActorSystemTerminate`, phase 11 of 12).
  // Both markers POST to peers via fetch — the outbound HTTP
  // client survives even after this node's own HTTP server closes
  // in the intermediate `ServiceUnbind` phase.
  const coordinatedShutdown = system.extension(CoordinatedShutdownId);
  const postShutdownMarker = async (phase: string): Promise<void> => {
    const peers = PEERS.filter((p) => p !== NODE_NAME);
    if (peers.length === 0) return;
    await Promise.allSettled(peers.map((p) =>
      fetch(`http://${p}:${CONTROL_PORT}/test/shutdown-trace/record?from=${encodeURIComponent(NODE_NAME)}&phase=${phase}`, {
        method: 'POST',
        signal: AbortSignal.timeout(1_000),
      }).catch(() => null),
    ));
    logger.info('shutdown-trace marker posted to peers', { phase, peers });
  };
  coordinatedShutdown.addTask(Phases.BeforeServiceUnbind, 'integration-early-marker', async () => {
    await postShutdownMarker('BeforeServiceUnbind');
  });
  coordinatedShutdown.addTask(Phases.BeforeActorSystemTerminate, 'integration-late-marker', async () => {
    await postShutdownMarker('BeforeActorSystemTerminate');
  });

  // Persistence — wire an InMemoryJournal + InMemorySnapshotStore
  // so PersistentActor scenarios (11) can persist events + take
  // snapshots without a real backend.  Journal lives in this
  // node-runner process — PoisonPilling the actor stops the
  // instance but events stay in memory, which is exactly what
  // scenario 11 needs to verify the replay path.
  const persistence = system.extension(PersistenceExtensionId);
  persistence.setJournal(new InMemoryJournal());
  persistence.setSnapshotStore(new InMemorySnapshotStore());
  logger.info('PersistenceExtension wired (InMemoryJournal + InMemorySnapshotStore)');

  // ClusterClientReceptionist — accepts wire frames from EXTERNAL
  // (non-cluster-member) `ClusterClient` connections.  The handler
  // routes by actor path; scenario 09 asks `/user/echo` which
  // is spawned just below.
  system.extension(ClusterClientReceptionistId).start(cluster);
  // Echo actor at `/user/echo` so external ClusterClient asks work.
  // The actor's host-node identity is in its reply so the scenario
  // can verify the request actually hit the cluster (not a stub).
  system.spawn(Props.create<{ kind: 'ping' }>(() => new EchoActor(NODE_NAME)), 'echo');
  logger.info('ClusterClientReceptionist + /user/echo ready');

  // Management HTTP — auth on so the test exercises the #312 path.
  // IpAllowlist runs against the real socket peer (now that the
  // backends populate `req.remoteAddress`) — the docker bridge
  // network's CIDR is covered by the standard RFC1918 ranges.
  // ::ffff: prefixes from dual-stack listeners are handled by
  // IpAllowlist's IPv4-mapped IPv6 normalisation.
  const { routes: mgmtRoutes } = managementRoutes(system, cluster, {
    enableLeaveEndpoint: true,
    enableDownEndpoint: true,
    enableMetricsEndpoint: true,
    auth: BearerTokenAuth({ tokens: [MGMT_TOKEN] }),
    ipAllowlist: IpAllowlist({
      allow: [
        '10.0.0.0/8',
        '172.16.0.0/12',     // docker's default bridge address pool
        '192.168.0.0/16',
        '127.0.0.0/8',
        '::1/128',
      ],
    }),
  });
  const http = system.extension(HttpExtensionId);
  const mgmtBinding = await http.newServerAt('0.0.0.0', MGMT_PORT).bind(mgmtRoutes);
  logger.info('management HTTP listening', { port: MGMT_PORT });

  // Test-control HTTP — no auth, port is only reachable inside the
  // compose network.  Passes deps for scenario primitives bootstrapped
  // above (Receptionist + DDdata are read directly from
  // `system.extension(...)`; the singleton proxy goes through `deps`
  // because the proxy is an ActorRef the route module receives).
  const controlRoutes = makeControlRoutes(system, cluster, {
    singletonProxy: singleton.proxy,
    shardingRegion,
  });
  const controlBinding = await http.newServerAt('0.0.0.0', CONTROL_PORT).bind(controlRoutes);
  logger.info('test-control HTTP listening', { port: CONTROL_PORT });

  logger.info('node ready', { node: NODE_NAME });

  // Stay alive until SIGTERM / SIGINT.
  const shutdown = async (signal: string): Promise<void> => {
    logger.warn('shutdown signal received', { signal });
    try { await mgmtBinding.unbind(); } catch (e) { logger.error('mgmt unbind failed', e as Error); }
    try { await controlBinding.unbind(); } catch (e) { logger.error('control unbind failed', e as Error); }
    try { await cluster.leave(); } catch (e) { logger.error('cluster leave failed', e as Error); }
    try { await system.terminate(); } catch (e) { logger.error('system terminate failed', e as Error); }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  console.error('node-runner fatal:', e);
  process.exit(1);
});
