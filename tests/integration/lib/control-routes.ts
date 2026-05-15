/**
 * Test-control HTTP surface exposed by each cluster-node container
 * (#313).  These routes are NOT for production — they exist purely
 * so the controller can coordinate partition/heal/delay from
 * outside the container.  The compose file binds them on a port
 * that's only reachable inside the integration network.
 */

import {
  complete,
  completeJson,
  concat,
  get,
  path,
  post,
  queryParam,
  Status,
  type Route,
} from '../../../src/http/index.js';
import type { Cluster } from '../../../src/cluster/Cluster.js';
import {
  clearAll,
  delayAllEgress,
  healPeer,
  partitionPeer,
} from './partition.js';

export function makeControlRoutes(cluster: Cluster): Route {
  return path('test', concat(
    // GET /test/ping — liveness probe used by docker-compose
    // healthchecks.  Returns 200 once the node-runner's bootstrap
    // has finished and the cluster transport is listening.
    path('ping', get(async () => completeJson(Status.OK, { ok: true }))),

    // GET /test/members — current cluster membership view from
    // this node's perspective.  Convergence scenarios poll this
    // until all nodes see all expected members.
    path('members', get(async () => completeJson(Status.OK, {
      self: cluster.selfAddress.toString(),
      members: cluster.getMembers().map((m) => ({
        address: m.address.toString(),
        status: m.status,
        roles: Array.from(m.roles),
      })),
    }))),

    // POST /test/partition?peer=<host> — drop every packet to/from
    // the named peer.  Hostname is resolved via Docker's embedded
    // DNS; iptables rules are scoped to this container's namespace.
    path('partition', post(async (req) => {
      const peer = queryParam(req, 'peer');
      if (!peer) return complete(Status.BadRequest, 'missing ?peer=');
      try {
        await partitionPeer(peer);
        return completeJson(Status.OK, { partitioned: peer });
      } catch (e) {
        return completeJson(Status.InternalServerError, {
          error: (e as Error).message,
        });
      }
    })),

    // POST /test/heal?peer=<host> — undo every `partition` rule
    // for the named peer (iterative -D so duplicate partitions
    // installed by buggy tests are also cleaned up).
    path('heal', post(async (req) => {
      const peer = queryParam(req, 'peer');
      if (!peer) return complete(Status.BadRequest, 'missing ?peer=');
      try {
        await healPeer(peer);
        return completeJson(Status.OK, { healed: peer });
      } catch (e) {
        return completeJson(Status.InternalServerError, {
          error: (e as Error).message,
        });
      }
    })),

    // POST /test/delay?ms=<N> — apply N ms of outbound latency to
    // ALL peers (whole-egress, not per-peer).  Passing 0 removes
    // any active delay.
    path('delay', post(async (req) => {
      const msRaw = queryParam(req, 'ms');
      const ms = Number(msRaw ?? '0');
      if (!Number.isFinite(ms) || ms < 0) {
        return complete(Status.BadRequest, 'ms must be a non-negative number');
      }
      try {
        await delayAllEgress(ms);
        return completeJson(Status.OK, { delayMs: ms });
      } catch (e) {
        return completeJson(Status.InternalServerError, {
          error: (e as Error).message,
        });
      }
    })),

    // POST /test/clear — reset every partition + delay rule.  The
    // controller calls this between scenarios so each starts from
    // a clean baseline.
    path('clear', post(async () => {
      try {
        await clearAll();
        return completeJson(Status.OK, { cleared: true });
      } catch (e) {
        return completeJson(Status.InternalServerError, {
          error: (e as Error).message,
        });
      }
    })),
  ));
}
