import type { ManagementRoutesOptions, ManagementRoutesOptionsType } from './ManagementRoutesOptions.js';
import type { ActorSystem } from '../ActorSystem.js';
import type { Cluster } from '../cluster/Cluster.js';
import { DistributedDataId } from '../crdt/DistributedData.js';
import { LWWRegister } from '../crdt/LWWRegister.js';
import {
  complete,
  completeJson,
  concat,
  get,
  path,
  post,
  Status,
  withMiddleware,
  type Middleware,
  type Route,
} from '../http/index.js';
import { exportPrometheus } from '../metrics/PrometheusExporter.js';
import { metricsOf } from '../metrics/MetricsExtension.js';
import { CLUSTER_MEMBERSHIP_CHECK_NAME } from '../cluster/ClusterHealthChecks.js';
import { isHealthy } from './HealthCheck.js';
import { healthChecksOf } from './HealthCheckExtension.js';


/**
 * Build a Route tree exposing cluster-management HTTP endpoints.  The
 * caller binds the returned routes into their HTTP server — management
 * usually lives on a separate port so it can be firewalled off the public one.
 *
 * Endpoints:
 *   - `GET /cluster/members`                  →  current membership JSON
 *   - `GET /cluster/leader`                   →  leader info
 *   - `GET /cluster/shards?type=<typeName>`   →  shard-to-region map for one type (#56)
 *   - `GET /health`                           →  liveness (200 iff all checks pass)
 *   - `GET /ready`                            →  readiness (200 iff all checks pass)
 *   - `POST /cluster/leave`                   →  graceful leave (optional, off by default)
 *   - `POST /cluster/down`  body `{address}`  →  force-down a peer (optional, off by default) (#56)
 *   - `GET /metrics`                          →  Prometheus text format (optional, off by default) (#56)
 *
 * The checks behind `/health` and `/ready` come from
 * `healthChecksOf(system)`; this function only *reads* that registry, it
 * does not own one.  Register application checks on it whenever you like —
 * before this call or long after — and the framework's own are already in
 * it, put there by the components that can observe them (#655).
 *
 * Which means the `cluster` argument selects which endpoints exist, not
 * what readiness means: passing `null` on a system that *did* join a
 * cluster still leaves `/ready` gated on that cluster's checks.  Deliberate
 * — readiness is a property of the node, and a second answer that differs
 * from the one the gRPC health service gives is the failure mode this
 * whole seam exists to prevent.
 */
export function managementRoutes(
  system: ActorSystem,
  cluster: Cluster | null,
  optionsInput: ManagementRoutesOptions = {},
): Route {
  const options = optionsInput as ManagementRoutesOptionsType;
  const health = healthChecksOf(system);

  const clusterMembers = get(async () => {
    if (!cluster) return complete(Status.ServiceUnavailable, 'no cluster');
    return completeJson(Status.OK, {
      members: cluster.getMembers().map((m) => ({
        address: m.address.toString(),
        status: m.status,
        version: m.version,
        roles: Array.from(m.roles),
      })),
      self: cluster.selfAddress.toString(),
    });
  });

  const clusterLeader = get(async () => {
    if (!cluster) return complete(Status.ServiceUnavailable, 'no cluster');
    const leader = cluster.leader();
    return completeJson(Status.OK, {
      leader: leader.fold(() => null as string | null, (m) => m.address.toString()),
      isSelf: leader.exists((m) => m.address.equals(cluster.selfAddress)),
    });
  });

  const liveness = get(async () => {
    const results = await health.checkLiveness();
    const ok = isHealthy(results);
    return completeJson(ok ? Status.OK : Status.ServiceUnavailable, {
      status: ok ? 'UP' : 'DOWN',
      checks: results,
    });
  });

  /**
   * `clusterReady` is *read back out of* the aggregate rather than
   * recomputed here.  `Cluster._start` registers the membership check
   * itself (#655), so evaluating the same predicate a second time in this
   * handler would give the endpoint a private answer that the gRPC health
   * service — which sees only the registry — could contradict.
   *
   * The check is absent only on a system that never joined a cluster, and
   * there cluster membership is not a constraint on readiness at all —
   * hence `true`.  It is *not* absent on a node that has left: leaving
   * leaves both cluster checks registered and failing, which is what stops
   * a drained node reporting itself ready (#655).
   *
   * `ok` comes from {@link isHealthy}, the same rule the gRPC health
   * service applies, so the two probes cannot diverge.
   */
  const readiness = get(async () => {
    const results = await health.checkReadiness();
    const membership = results.find((r) => r.name === CLUSTER_MEMBERSHIP_CHECK_NAME);
    const clusterReady = membership === undefined ? true : membership.status;
    const ok = isHealthy(results);
    return completeJson(ok ? Status.OK : Status.ServiceUnavailable, {
      status: ok ? 'UP' : 'DOWN',
      clusterReady,
      checks: results,
    });
  });

  const leaveRoute: Route = options.enableLeaveEndpoint && cluster
    ? post(async () => {
      // Fire-and-forget leave — the caller typically uses this as a PreStop
      // hook and doesn't wait for completion in-request.  We do await one
      // microtask so the intent is registered before returning 202.
      void cluster.leave();
      return complete(Status.Accepted, 'leaving');
    })
    : get(async () => complete(Status.NotFound, 'leave endpoint disabled'));

  /**
   * GET /cluster/shards?type=<typeName> — returns the current shard map
   * for one sharded type as recorded by the coordinator in DistributedData.
   * Backed by the same store the coordinator reads on leader failover
   * (`sharding-coordinator-state|<typeName>`), so the view is at most
   * one gossip-tick stale.  Returns 404 if DD isn't started or the
   * type isn't known.
   */
  const clusterShards = get(async (request) => {
    if (!cluster) return complete(Status.ServiceUnavailable, 'no cluster');
    const typeRaw = request.query['type'];
    const typeName = Array.isArray(typeRaw) ? typeRaw[0] : typeRaw;
    if (!typeName) {
      return complete(Status.BadRequest, 'missing query param `type`');
    }
    const dd = system.extension(DistributedDataId);
    if (!dd.isStarted()) {
      return complete(Status.NotFound, 'DistributedData not started — shard map unavailable');
    }
    const reg = dd.get().get<LWWRegister<{
      leader: string;
      takenAt: number;
      regions: ReadonlyArray<{
        key: string; node: { systemName: string; host: string; port: number };
        path: string; proxy: boolean; shards: ReadonlyArray<number>;
      }>;
      shardHome: ReadonlyArray<readonly [number, string]>;
    }>>(`sharding-coordinator-state|${typeName}`);
    const state = reg?.value();
    if (!state) {
      return complete(Status.NotFound, `no shard-map recorded for type "${typeName}" yet`);
    }
    return completeJson(Status.OK, {
      typeName,
      leader: state.leader,
      takenAt: state.takenAt,
      regions: state.regions.map((r) => ({
        key: r.key,
        address: `${r.node.systemName}@${r.node.host}:${r.node.port}`,
        path: r.path,
        proxy: r.proxy,
        shards: r.shards,
      })),
      shardHome: state.shardHome.map(([shard, regionKey]) => ({ shard, regionKey })),
    });
  });

  /**
   * POST /cluster/down — operator-initiated force-down.  Request body
   * must be JSON `{ "address": "<system>@<host>:<port>" }`.  Returns
   * 202 if the member was downed, 404 if the address is unknown or
   * already terminal.  Disabled by default; flip `enableDownEndpoint`
   * after auth has been wired up at the proxy/ingress layer.
   */
  const downRoute: Route = options.enableDownEndpoint && cluster
    ? post(async (request) => {
      if (!request.body) return complete(Status.BadRequest, 'missing JSON body');
      let parsed: { address?: string };
      try {
        parsed = JSON.parse(new TextDecoder().decode(request.body));
      } catch (e) {
        return complete(Status.BadRequest, `invalid JSON: ${(e as Error).message}`);
      }
      if (!parsed.address || typeof parsed.address !== 'string') {
        return complete(Status.BadRequest, 'body must contain a string `address` field');
      }
      const ok = cluster.down(parsed.address);
      return ok
        ? completeJson(Status.Accepted, { downed: parsed.address })
        : complete(Status.NotFound, `no member at ${parsed.address}`);
    })
    : get(async () => complete(Status.NotFound, 'down endpoint disabled'));

  /** GET /metrics — Prometheus text format. */
  const metricsRoute: Route = options.enableMetricsEndpoint
    ? get(async () => ({
      status: Status.OK,
      body: exportPrometheus(metricsOf(system)),
      contentType: 'text/plain; version=0.0.4; charset=utf-8',
    }))
    : get(async () => complete(Status.NotFound, 'metrics endpoint disabled'));

  let clusterSubtree: Route = path('cluster', concat(
    path('members', clusterMembers),
    path('leader', clusterLeader),
    path('shards', clusterShards),
    path('leave', leaveRoute),
    path('down', downRoute),
  ));

  // Apply bearer-token (or similar) auth to the cluster subtree if
  // configured.  Health/ready stay anonymous by default (Kubernetes
  // probes can't attach credentials); `authProtectHealth: true`
  // flips that for deployments where probes do present a token.
  if (options.auth) {
    clusterSubtree = withMiddleware(options.auth, clusterSubtree);
  }

  let healthSubtree: Route = concat(
    path('health', liveness),
    path('ready', readiness),
  );
  if (options.auth && options.authProtectHealth === true) {
    healthSubtree = withMiddleware(options.auth, healthSubtree);
  }

  // Compose with the top-level health endpoints.  Metrics endpoint
  // sits OUTSIDE the cluster subtree historically, so it gets the
  // auth wrap only when explicitly configured (no policy distinction
  // between metrics and cluster routes).
  let metricsSubtree: Route = path('metrics', metricsRoute);
  if (options.auth) {
    metricsSubtree = withMiddleware(options.auth, metricsSubtree);
  }

  let all: Route = concat(clusterSubtree, healthSubtree, metricsSubtree);

  // IP allowlist wraps EVERY management endpoint, including health/
  // ready — network-level isolation is independent of who's allowed
  // to authenticate.  Probes that should reach the endpoint despite
  // the allowlist must come from an allowed network; behind a reverse
  // proxy that means naming the proxy in the allowlist's
  // `trustedProxies` so the client's own address is resolved instead
  // of the proxy's.
  if (options.ipAllowlist) {
    all = withMiddleware(options.ipAllowlist, all);
  }

  return all;
}
