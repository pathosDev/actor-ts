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
import type { ActorRef } from '../../../src/ActorRef.js';
import type { ActorSystem } from '../../../src/ActorSystem.js';
import type { Cluster } from '../../../src/cluster/Cluster.js';
import { ReceptionistId } from '../../../src/discovery/index.js';
import {
  Find,
  Listing,
} from '../../../src/discovery/ReceptionistMessages.js';
import { ServiceKey } from '../../../src/discovery/ServiceKey.js';
import { DistributedDataId } from '../../../src/crdt/index.js';
import {
  SingletonInc,
  SingletonWho,
  SingletonWhoReply,
  type SingletonMsg,
} from './singleton.js';
import {
  ShardedWhoReply,
  type ShardedCommand,
} from './sharded-counter.js';
import { LWWRegister } from '../../../src/crdt/LWWRegister.js';
import { GCounter } from '../../../src/crdt/GCounter.js';
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
 * convergence.
 *
 * Exported so `node-runner.ts` can do the registration at startup
 * time — earlier iteration relied on a lazy-on-first-hit
 * registration which created a wire-handler race: nodes that never
 * received an HTTP hit had their Receptionist NOT yet subscribed to
 * the `receptionist-gossip` wire kind, so gossip from
 * already-started peers got silently dropped on the receiver side.
 * Same shape for `DistributedDataId` — see `node-runner.ts` for the
 * bootstrap path.
 */
export const WORKER_KEY = ServiceKey.of<unknown>('workers');

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

class SingletonReplyCollector extends Actor<SingletonWhoReply> {
  constructor(private readonly resolve: (r: SingletonWhoReply) => void) { super(); }
  override onReceive(r: SingletonWhoReply): void {
    this.resolve(r);
    this.context.stop(this.context.self);
  }
}

class ShardedReplyCollector extends Actor<ShardedWhoReply> {
  constructor(private readonly resolve: (r: ShardedWhoReply) => void) { super(); }
  override onReceive(r: ShardedWhoReply): void {
    this.resolve(r);
    this.context.stop(this.context.self);
  }
}

export interface ControlDeps {
  /** Singleton proxy from `ClusterSingletonId.start(...)`. */
  readonly singletonProxy: ActorRef<SingletonMsg>;
  /** Shard-region ref from `ClusterSharding.get(...).start(...)`. */
  readonly shardingRegion: ActorRef<ShardedCommand>;
}

export function makeControlRoutes(
  system: ActorSystem,
  cluster: Cluster,
  deps: ControlDeps,
): Route {
  // Both extensions are bootstrapped at node-runner startup so the
  // wire handlers are registered before ANY scenario runs.  Looking
  // them up here is a cheap `Map.get`.
  const receptionistRef = system.extension(ReceptionistId).start(cluster);
  const ddataExt = system.extension(DistributedDataId);

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
    // Receptionist + auto-registered IdleWorker are wired in
    // `node-runner.ts` at boot time so the wire handlers are
    // already subscribed before any scenario runs (no microtask race
    // between lazy-start and incoming gossip).
    path('receptionist', path('listing', get(async () => {
      try {
        const listing = await new Promise<Listing>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('receptionist listing timeout')), 5_000);
          const collector = system.spawnAnonymous(Props.create<Listing>(() =>
            new ListingCollector((l) => {
              clearTimeout(timer);
              resolve(l);
            }),
          ));
          receptionistRef.tell(new Find(WORKER_KEY, collector));
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
        const handle = ddataExt.get();
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
        const handle = ddataExt.get();
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

    // ============== GCounter scenario (#313 — scenario 07) ==============

    // POST /test/ddata/gcounter/inc?key=K&delta=D[&consistency=]
    // Increments the named `GCounter` by `delta` (default 1) on the
    // local replica.  The CRDT's monotonic semantics mean the total
    // converges to the sum of every replica's contribution regardless
    // of merge order — exactly what scenario 07 hammers concurrently
    // from all 5 nodes.
    path('ddata', path('gcounter', path('inc', post(async (req) => {
      const key = queryParam(req, 'key');
      const delta = Number(queryParam(req, 'delta') ?? '1');
      const consistency = (queryParam(req, 'consistency') ?? 'majority') as WriteConsistency;
      if (!key) return complete(Status.BadRequest, 'missing ?key=');
      if (!Number.isFinite(delta) || delta < 0) {
        return complete(Status.BadRequest, 'delta must be a non-negative finite number');
      }
      try {
        const handle = ddataExt.get();
        const startedAt = Date.now();
        await handle.updateAsync<GCounter>(
          key,
          () => GCounter.empty(),
          (c: GCounter) => c.increment(handle.selfReplicaId(), delta),
          { consistency, timeoutMs: 10_000 },
        );
        return completeJson(Status.OK, {
          incremented: { key, delta, consistency },
          elapsedMs: Date.now() - startedAt,
        });
      } catch (e) {
        return completeJson(Status.InternalServerError, { error: (e as Error).message });
      }
    })))),

    // GET /test/ddata/gcounter/value?key=K[&consistency=]
    // Reads the merged GCounter total under `key`.  404 if the key
    // hasn't been touched yet (no replica has incremented it).
    path('ddata', path('gcounter', path('value', get(async (req) => {
      const key = queryParam(req, 'key');
      const consistency = (queryParam(req, 'consistency') ?? 'majority') as WriteConsistency;
      if (!key) return complete(Status.BadRequest, 'missing ?key=');
      try {
        const handle = ddataExt.get();
        const startedAt = Date.now();
        const counter = await handle.getAsync<GCounter>(key, {
          consistency,
          timeoutMs: 10_000,
        });
        const elapsedMs = Date.now() - startedAt;
        if (!counter) return completeJson(Status.NotFound, { key, elapsedMs });
        return completeJson(Status.OK, {
          key,
          value: counter.value(),
          consistency,
          elapsedMs,
        });
      } catch (e) {
        return completeJson(Status.InternalServerError, { error: (e as Error).message });
      }
    })))),

    // ============== Singleton scenario (#313 — scenario 05) ==============

    // POST /test/singleton/inc — fire-and-forget increment via the
    // local proxy.  Every node has a proxy; the singleton itself
    // lives on the cluster leader.  The proxy buffers until the
    // leader is known, then forwards.
    path('singleton', path('inc', post(async () => {
      deps.singletonProxy.tell(new SingletonInc());
      return completeJson(Status.OK, { sent: true });
    }))),

    // GET /test/singleton/who — ask the singleton "who hosts you?"
    // via a one-shot collector.  Reply is `{ nodeName, value }`.
    // The scenario polls this from EVERY node to verify they all
    // route to the same leader.
    path('singleton', path('who', get(async () => {
      try {
        const reply = await new Promise<SingletonWhoReply>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('singleton who timeout')), 5_000);
          const collector = system.spawnAnonymous(Props.create<SingletonWhoReply>(() =>
            new SingletonReplyCollector((r) => {
              clearTimeout(timer);
              resolve(r);
            }),
          )) as ActorRef<SingletonWhoReply>;
          deps.singletonProxy.tell(new SingletonWho(collector));
        });
        return completeJson(Status.OK, {
          host: reply.nodeName,
          value: reply.value,
        });
      } catch (e) {
        return completeJson(Status.InternalServerError, { error: (e as Error).message });
      }
    }))),

    // ============== Sharding scenario (#313 — scenario 06) ==============

    // POST /test/sharding/inc?id=X — increment counter for entity X.
    // The shard region resolves the owning node by hashing X over
    // numShards (32), routes via cluster envelope if owned remotely.
    path('sharding', path('inc', post(async (req) => {
      const id = queryParam(req, 'id');
      if (!id) return complete(Status.BadRequest, 'missing ?id=');
      deps.shardingRegion.tell({ entityId: id, op: 'inc' });
      return completeJson(Status.OK, { sent: { id, op: 'inc' } });
    }))),

    // GET /test/sharding/who?id=X — query which node currently
    // hosts entity X (and the entity's local counter value).
    // Used by scenario 06 to map entities → hosts before + after
    // a node leaves to verify the coordinator rebalances shards.
    path('sharding', path('who', get(async (req) => {
      const id = queryParam(req, 'id');
      if (!id) return complete(Status.BadRequest, 'missing ?id=');
      try {
        const reply = await new Promise<ShardedWhoReply>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('sharding who timeout')), 10_000);
          const collector = system.spawnAnonymous(Props.create<ShardedWhoReply>(() =>
            new ShardedReplyCollector((r) => {
              clearTimeout(timer);
              resolve(r);
            }),
          )) as ActorRef<ShardedWhoReply>;
          deps.shardingRegion.tell({
            entityId: id,
            op: 'who',
            replyTo: collector,
          });
        });
        return completeJson(Status.OK, {
          entityId: reply.entityId,
          host: reply.nodeName,
          value: reply.value,
        });
      } catch (e) {
        return completeJson(Status.InternalServerError, { error: (e as Error).message });
      }
    }))),

    // POST /test/leave — call `cluster.leave()` on this node.  The
    // node initiates a graceful departure; remaining members see
    // `MemberRemoved` for it after gossip propagates.  Used by
    // scenarios that need to verify failover paths under a
    // controlled node exit (not a network partition).
    path('leave', post(async () => {
      // Fire-and-forget — `cluster.leave()` awaits the goodbye
      // round-trip, but the HTTP caller doesn't need that.  We
      // return 202 immediately so the caller can move on; the
      // node will exit the cluster on its own clock.
      void cluster.leave();
      return completeJson(Status.Accepted, { leaving: cluster.selfAddress.toString() });
    })),
  ));
}
