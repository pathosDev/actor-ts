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
import type { HealthCheckResult } from './HealthCheck.js';
import { HealthCheckRegistry } from './HealthCheck.js';

export interface ManagementRoutesOptionsType {
  /** Set to true to allow POST /cluster/leave (requires cluster). */
  readonly enableLeaveEndpoint?: boolean;
  /**
   * Set to true to allow POST /cluster/down (#56).  Operator-initiated
   * force-down of a remote member by address.  Off by default —
   * production deployments typically gate this behind an auth proxy
   * because it's a destructive action.
   */
  readonly enableDownEndpoint?: boolean;
  /**
   * Set to true to expose `GET /metrics` in Prometheus text format
   * (#56).  Reads from the system's `MetricsRegistry`.  Off by default
   * because most deployments scrape metrics from a separate port.
   */
  readonly enableMetricsEndpoint?: boolean;
  /**
   * Optional authentication middleware applied to the privileged
   * subset of management routes (#312).  When set, every privileged
   * endpoint requires the auth — typically `BearerTokenAuth({...})`
   * or a stack composed via nested `withMiddleware`.
   *
   * Privileged = `/cluster/leave`, `/cluster/down`.  The membership
   * read-only routes (`/cluster/members`, `/cluster/leader`,
   * `/cluster/shards`) are also covered.  Health-check probes
   * (`/health`, `/ready`) are deliberately exempt — Kubernetes
   * liveness/readiness probes cannot easily attach an
   * Authorization header.
   *
   *     auth: BearerTokenAuth({ tokens: [process.env.MGMT_TOKEN!] })
   */
  readonly auth?: Middleware;
  /**
   * Optional IP-allowlist middleware applied to every management
   * endpoint INCLUDING `/health` and `/ready` (#312).  Use this for
   * network-level isolation: only allow probes from inside the
   * cluster's pod CIDR or from the operator's bastion.
   *
   *     ipAllowlist: IpAllowlist({ allow: ['10.0.0.0/8', '127.0.0.1/32'] })
   */
  readonly ipAllowlist?: Middleware;
  /**
   * Set to true to apply the `auth` middleware to `/health` and
   * `/ready` as well (#312).  Default: false — those endpoints are
   * standard liveness/readiness probes and should answer anonymously.
   * Flip this only when the deployment guarantees the probes can
   * present credentials.
   */
  readonly authProtectHealth?: boolean;
}

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
 *   - `GET /ready`                            →  readiness (200 iff cluster is up + all checks pass)
 *   - `POST /cluster/leave`                   →  graceful leave (optional, off by default)
 *   - `POST /cluster/down`  body `{address}`  →  force-down a peer (optional, off by default) (#56)
 *   - `GET /metrics`                          →  Prometheus text format (optional, off by default) (#56)
 */
export function managementRoutes(
  system: ActorSystem,
  cluster: Cluster | null,
  settings: ManagementRoutesOptionsType = {},
): { routes: Route; health: HealthCheckRegistry } {
  const health = new HealthCheckRegistry();

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
    const l = cluster.leader();
    return completeJson(Status.OK, {
      leader: l.fold(() => null as string | null, (m) => m.address.toString()),
      isSelf: l.exists((m) => m.address.equals(cluster.selfAddress)),
    });
  });

  const liveness = get(async () => {
    const results = await health.checkLiveness();
    const ok = results.every((r) => r.status);
    return completeJson(ok ? Status.OK : Status.ServiceUnavailable, {
      status: ok ? 'UP' : 'DOWN',
      checks: results,
    });
  });

  const readiness = get(async () => {
    const results = await health.checkReadiness();
    const clusterReady = cluster
      ? cluster.getMembers().some((m) => m.address.equals(cluster.selfAddress) && m.status === 'up')
      : true;
    const ok = clusterReady && results.every((r) => r.status);
    return completeJson(ok ? Status.OK : Status.ServiceUnavailable, {
      status: ok ? 'UP' : 'DOWN',
      clusterReady,
      checks: results,
    });
  });

  const leaveRoute: Route = settings.enableLeaveEndpoint && cluster
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
  const clusterShards = get(async (req) => {
    if (!cluster) return complete(Status.ServiceUnavailable, 'no cluster');
    const typeRaw = req.query['type'];
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
  const downRoute: Route = settings.enableDownEndpoint && cluster
    ? post(async (req) => {
      if (!req.body) return complete(Status.BadRequest, 'missing JSON body');
      let parsed: { address?: string };
      try {
        parsed = JSON.parse(new TextDecoder().decode(req.body));
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
  const metricsRoute: Route = settings.enableMetricsEndpoint
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
  if (settings.auth) {
    clusterSubtree = withMiddleware(settings.auth, clusterSubtree);
  }

  let healthSubtree: Route = concat(
    path('health', liveness),
    path('ready', readiness),
  );
  if (settings.auth && settings.authProtectHealth === true) {
    healthSubtree = withMiddleware(settings.auth, healthSubtree);
  }

  // Compose with the top-level health endpoints.  Metrics endpoint
  // sits OUTSIDE the cluster subtree historically, so it gets the
  // auth wrap only when explicitly configured (no policy distinction
  // between metrics and cluster routes).
  let metricsSubtree: Route = path('metrics', metricsRoute);
  if (settings.auth) {
    metricsSubtree = withMiddleware(settings.auth, metricsSubtree);
  }

  let all: Route = concat(clusterSubtree, healthSubtree, metricsSubtree);

  // IP allowlist wraps EVERY management endpoint, including health/
  // ready — network-level isolation is independent of who's allowed
  // to authenticate.  Probes that should reach the endpoint despite
  // the allowlist must come from an allowed network or the operator
  // must override `getClientIp` to inspect a trusted header.
  if (settings.ipAllowlist) {
    all = withMiddleware(settings.ipAllowlist, all);
  }

  // Suppress unused warning in case the caller doesn't use the system reference.
  void system;

  return { routes: all, health };
}

export function isHealthy(results: HealthCheckResult[]): boolean {
  return results.every((r) => r.status);
}
