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
import { Cluster } from '../../src/cluster/Cluster.js';
import {
  Actor,
  BearerTokenAuth,
  HttpExtensionId,
  IpAllowlist,
  Props,
} from '../../src/index.js';
import { JsonLogger, LogLevel } from '../../src/Logger.js';
import { managementRoutes } from '../../src/management/index.js';
import { ReceptionistId } from '../../src/discovery/index.js';
import { Register } from '../../src/discovery/ReceptionistMessages.js';
import { DistributedDataId } from '../../src/crdt/index.js';
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

  const system = ActorSystem.create(SYSTEM_NAME, { logger });
  const cluster = await Cluster.join(system, {
    host: HOST,
    port: CLUSTER_PORT,
    seeds: SEEDS,
    // Tighter failure detection than the default so scenarios don't
    // wait forever for a partition to register.
    failureDetector: { heartbeatIntervalMs: 200, unreachableAfterMs: 1_500, downAfterMs: 4_000 },
    gossipIntervalMs: 250,
  });

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
  const receptionistRef = system.extension(ReceptionistId).start(cluster, { gossipIntervalMs: 250 });
  class IdleWorker extends Actor<unknown> {
    override onReceive(_m: unknown): void { /* noop */ }
  }
  const worker = system.spawnAnonymous(Props.create<unknown>(() => new IdleWorker()));
  receptionistRef.tell(new Register(WORKER_KEY, worker));
  logger.info('Receptionist started + worker registered', { key: WORKER_KEY.id });

  // DistributedData.  Same gossip-interval tightening.
  system.extension(DistributedDataId).start(cluster, { gossipIntervalMs: 250 });
  logger.info('DistributedData started');

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
  // compose network.  Passes both system + cluster so the
  // route module can lazy-start Receptionist + DistributedData on
  // first hit from a scenario.
  const controlRoutes = makeControlRoutes(system, cluster);
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
