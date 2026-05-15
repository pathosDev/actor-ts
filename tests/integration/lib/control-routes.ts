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
import { Actor } from '../../../src/Actor.js';
import { Props } from '../../../src/Props.js';
import type { ActorSystem } from '../../../src/ActorSystem.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import type { Cluster } from '../../../src/cluster/Cluster.js';
import { ReceptionistId } from '../../../src/discovery/index.js';
import {
  Find,
  Listing,
  Register,
} from '../../../src/discovery/ReceptionistMessages.js';
import { ServiceKey } from '../../../src/discovery/ServiceKey.js';
import { DistributedDataId } from '../../../src/crdt/index.js';
import { LWWRegister } from '../../../src/crdt/LWWRegister.js';
import type { WriteConsistency } from '../../../src/crdt/DistributedData.js';
import {
  clearAll,
  delayAllEgress,
  healPeer,
  partitionPeer,
} from './partition.js';

/**
 * Per-key shared `ServiceKey` for the Receptionist scenarios.  Every
 * node registers its local "worker" ref under the SAME key — the
 * Listing on any node should contain all live registrations after
 * convergence.  Distinct keys per node would test gossip-of-keys but
 * not gossip-of-registrations-under-a-shared-key, which is the more
 * interesting cluster-discovery shape.
 */
const WORKER_KEY = ServiceKey.of<unknown>('workers');

/**
 * One-shot collector actor used to bridge the message-passing
 * Receptionist `Find` API to a `Promise<Listing>`.  Spawned per
 * `/test/receptionist/find` request, receives the Listing, stops
 * itself.  Cheap — these actors are short-lived and unsupervised.
 */
class ListingCollector extends Actor<Listing> {
  constructor(private readonly resolve: (l: Listing) => void) { super(); }
  override onReceive(m: Listing): void {
    this.resolve(m);
    this.context.stop(this.context.self);
  }
}

/**
 * One-shot worker actor.  Receives one ping message kind, has no
 * behaviour beyond existing for the Receptionist to register.  The
 * point of the scenario is the registration's CLUSTER-WIDE
 * VISIBILITY, not anything the worker actually does.
 */
class IdleWorker extends Actor<unknown> {
  override onReceive(_m: unknown): void { /* noop */ }
}

export function makeControlRoutes(
  system: ActorSystem,
  cluster: Cluster,
): Route {
  // Lazy-init both Receptionist and DistributedData on first hit so
  // the node-runner doesn't pay the cost for scenarios that never
  // touch them.  Cached after first init.
  let receptionistRef: ActorRef | null = null;
  const ensureReceptionist = (): ActorRef => {
    if (receptionistRef) return receptionistRef;
    const ext = system.extension(ReceptionistId);
    receptionistRef = ext.start(cluster, { gossipIntervalMs: 250 });
    // Auto-register an IdleWorker under WORKER_KEY so the scenario
    // doesn't need explicit `/register` calls — the node's mere
    // existence puts one ref into the cluster's worker pool.
    const worker = system.spawnAnonymous(Props.create(() => new IdleWorker()));
    receptionistRef.tell(new Register(WORKER_KEY, worker));
    return receptionistRef;
  };

  let ddataStarted = false;
  const ensureDdata = () => {
    const ext = system.extension(DistributedDataId);
    if (!ddataStarted) {
      ext.start(cluster, { gossipIntervalMs: 250 });
      ddataStarted = true;
    }
    return ext;
  };

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

    // ============== Receptionist scenario (#313 — scenario 03) ==============

    // GET /test/receptionist/listing
    // Asks the local Receptionist for the current Listing under the
    // shared "workers" key.  Returns `{ refs: [paths], count }`.
    // First call lazy-starts the Receptionist + auto-registers an
    // IdleWorker, so the node-runner doesn't need a separate
    // registration call.  The scenario polls until each node sees
    // `count === <cluster size>`.
    path('receptionist', path('listing', get(async () => {
      const recRef = ensureReceptionist();
      try {
        const listing = await new Promise<Listing>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('receptionist listing timeout')), 5_000);
          const collector = system.spawnAnonymous(Props.create<Listing>(() =>
            new ListingCollector((l) => {
              clearTimeout(timer);
              resolve(l);
            }),
          ));
          recRef.tell(new Find(WORKER_KEY, collector));
        });
        return completeJson(Status.OK, {
          key: WORKER_KEY.id,
          refs: listing.refs.map((r) => r.toString()),
          count: listing.refs.length,
        });
      } catch (e) {
        return completeJson(Status.InternalServerError, { error: (e as Error).message });
      }
    }))),

    // ============== DistributedData scenario (#313 — scenario 04) ==============

    // POST /test/ddata/write?key=K&value=V[&consistency=majority|local|all]
    // Writes a `LWWRegister<string>` value under `key` with the given
    // consistency level.  The value is stored verbatim as a string —
    // scenarios that need numbers parse on the read side.
    path('ddata', path('write', post(async (req) => {
      const key = queryParam(req, 'key');
      const value = queryParam(req, 'value');
      const consistency = (queryParam(req, 'consistency') ?? 'majority') as WriteConsistency;
      if (!key || value === undefined) {
        return complete(Status.BadRequest, 'missing ?key= or ?value=');
      }
      try {
        const handle = ensureDdata().get();
        const startedAt = Date.now();
        await handle.updateAsync<LWWRegister<string>>(
          key,
          () => LWWRegister.empty<string>(),
          (r: LWWRegister<string>) => r.assign(handle.selfReplicaId(), value),
          { consistency, timeoutMs: 5_000 },
        );
        return completeJson(Status.OK, {
          wrote: { key, value, consistency },
          elapsedMs: Date.now() - startedAt,
        });
      } catch (e) {
        return completeJson(Status.InternalServerError, { error: (e as Error).message });
      }
    }))),

    // GET /test/ddata/read?key=K[&consistency=majority|local|all]
    // Reads back the LWWRegister value under `key`.  Returns
    // `{ value, elapsedMs }` or 404 when the key has never been
    // written (or has been deleted).
    path('ddata', path('read', get(async (req) => {
      const key = queryParam(req, 'key');
      const consistency = (queryParam(req, 'consistency') ?? 'majority') as WriteConsistency;
      if (!key) return complete(Status.BadRequest, 'missing ?key=');
      try {
        const handle = ensureDdata().get();
        const startedAt = Date.now();
        const reg = await handle.getAsync<LWWRegister<string>>(key, {
          consistency,
          timeoutMs: 5_000,
        });
        const elapsedMs = Date.now() - startedAt;
        if (!reg) return completeJson(Status.NotFound, { key, elapsedMs });
        return completeJson(Status.OK, {
          key,
          value: reg.value(),
          consistency,
          elapsedMs,
        });
      } catch (e) {
        return completeJson(Status.InternalServerError, { error: (e as Error).message });
      }
    }))),
  ));
}
