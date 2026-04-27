import type { ActorSystem } from '../ActorSystem.js';
import type { Cluster } from '../cluster/Cluster.js';
import {
  complete,
  completeJson,
  concat,
  del,
  get,
  path,
  post,
  Status,
  type Route,
} from '../http/index.js';
import type { HealthCheckResult } from './HealthCheck.js';
import { HealthCheckRegistry } from './HealthCheck.js';

export interface ManagementRoutesSettings {
  /** Set to true to allow POST /cluster/leave (requires cluster). */
  readonly enableLeaveEndpoint?: boolean;
}

/**
 * Build a Route tree exposing cluster-management HTTP endpoints.  The
 * caller binds the returned routes into their HTTP server — management
 * usually lives on a separate port so it can be firewalled off the public one.
 *
 * Endpoints:
 *   - `GET /cluster/members`  →  current membership JSON
 *   - `GET /cluster/leader`   →  leader info
 *   - `GET /health`           →  liveness (200 iff all checks pass)
 *   - `GET /ready`            →  readiness (200 iff cluster is up + all checks pass)
 *   - `POST /cluster/leave`   →  graceful leave (optional, off by default)
 */
export function managementRoutes(
  system: ActorSystem,
  cluster: Cluster | null,
  settings: ManagementRoutesSettings = {},
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

  const routes = path('cluster', concat(
    path('members', clusterMembers),
    path('leader', clusterLeader),
    path('leave', leaveRoute),
  ));

  // Compose with the top-level health endpoints.
  const all: Route = concat(
    routes,
    path('health', liveness),
    path('ready', readiness),
  );

  // Suppress unused warning in case the caller doesn't use the system reference.
  void system;

  return { routes: all, health };
}

export function isHealthy(results: HealthCheckResult[]): boolean {
  return results.every((r) => r.status);
}
