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
  Deregister,
  Find,
  Listing,
  Register,
  Subscribe,
} from '../../../src/discovery/ReceptionistMessages.js';
import { ServiceKey } from '../../../src/discovery/ServiceKey.js';
import { DistributedDataId } from '../../../src/crdt/index.js';
import {
  type SingletonMsg,
  type SingletonWhoReply,
} from './singleton.js';
import {
  ShardedWhoReply,
  type ShardedCommand,
} from './sharded-counter.js';
import {
  PersistentCounter,
  type CounterCmd,
  type CounterStateReply,
} from './persistent-counter.js';
import { PoisonPill } from '../../../src/SystemMessages.js';
import { DistributedPubSubId } from '../../../src/cluster/pubsub/DistributedPubSubExtension.js';
import {
  Publish as PubSubPublish,
  Subscribe as PubSubSubscribe,
} from '../../../src/cluster/pubsub/Messages.js';
import { CoordinatedShutdownId } from '../../../src/CoordinatedShutdown.js';
import { exportPrometheus } from '../../../src/metrics/PrometheusExporter.js';
import { metricsOf } from '../../../src/metrics/MetricsExtension.js';
import { DnsSeedProvider } from '../../../src/discovery/DnsSeedProvider.js';
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

/**
 * Reply from `ContinuousSubscriber` carrying the most recent
 * Listing it has observed plus the update count (number of
 * Listings it has received since it started subscribing).
 */
class SubscriberSnapshot {
  constructor(
    public readonly refs: ReadonlyArray<string>,
    public readonly updates: number,
  ) {}
}

/** Query message — replied to with a `SubscriberSnapshot`. */
class GetSnapshot {
  constructor(public readonly replyTo: ActorRef<SubscriberSnapshot>) {}
}

type SubscriberMsg = Listing | GetSnapshot;

/**
 * Long-lived subscriber for scenario 08.  Maintains the most recent
 * Listing it has received (Receptionist sends one immediately on
 * Subscribe with the current set, then every time the set changes —
 * register, deregister, peer leaves).  Reachable via a `GetSnapshot`
 * message so the HTTP route can read the state without breaking the
 * actor encapsulation.
 */
class ContinuousSubscriber extends Actor<SubscriberMsg> {
  private latest: Listing | null = null;
  private updates = 0;
  override onReceive(m: SubscriberMsg): void {
    if (m instanceof Listing) {
      this.latest = m;
      this.updates += 1;
    } else if (m instanceof GetSnapshot) {
      const refs = this.latest ? this.latest.refs.map((r) => r.toString()) : [];
      m.replyTo.tell(new SubscriberSnapshot(refs, this.updates));
    }
  }
}

class SnapshotCollector extends Actor<SubscriberSnapshot> {
  constructor(private readonly resolve: (s: SubscriberSnapshot) => void) { super(); }
  override onReceive(s: SubscriberSnapshot): void {
    this.resolve(s);
    this.context.stop(this.context.self);
  }
}

/**
 * Plain spawnable IdleWorker used by scenarios 08 to add/remove
 * registrations on demand.  Same shape as the auto-registered
 * worker in `node-runner.ts` — duplicated here because the worker
 * type there is a closure-local class.
 */
class ExtraWorker extends Actor<unknown> {
  override onReceive(_m: unknown): void { /* noop */ }
}

/**
 * Deliberately-slow actor used by scenario 14 to overflow its
 * bounded mailbox.  `process` messages sleep N ms before
 * completing — bombarding it with more messages than the default
 * capacity (10 000) triggers the drop-head overflow policy,
 * which increments `actor_mailbox_dropped_total` via the
 * `onDrop` callback wired in `ActorCell` (#310).
 */
type SlowSinkMsg = { kind: 'process'; sleepMs: number };
class SlowSink extends Actor<SlowSinkMsg> {
  override async onReceive(msg: SlowSinkMsg): Promise<void> {
    if (msg.sleepMs > 0) {
      await new Promise<void>((r) => setTimeout(r, msg.sleepMs));
    }
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

class CounterStateCollector extends Actor<CounterStateReply> {
  constructor(private readonly resolve: (r: CounterStateReply) => void) { super(); }
  override onReceive(r: CounterStateReply): void {
    this.resolve(r);
    this.context.stop(this.context.self);
  }
}

/**
 * PubSub message envelope as the test publishes it.  Plain object
 * (kind: 'event', seq, text) so it survives wire-serialisation
 * to remote mediators without prototype loss.
 */
interface PubSubEvent {
  readonly kind: 'event';
  readonly seq: number;
  readonly text: string;
}

interface PubSubSnapshotQuery {
  readonly kind: 'snapshot';
  readonly replyTo: ActorRef<PubSubSnapshot>;
}

interface PubSubSnapshot {
  readonly received: number;
  readonly lastSeq: number;
  readonly lastText: string | null;
}

/**
 * Long-lived PubSub subscriber for scenario 12.  Accumulates every
 * `PubSubEvent` it receives on the `events` topic, exposes the
 * count + most-recent message via a `PubSubSnapshotQuery`.
 */
class PubSubReceiver extends Actor<PubSubEvent | PubSubSnapshotQuery> {
  private received = 0;
  private lastSeq = -1;
  private lastText: string | null = null;
  override onReceive(m: PubSubEvent | PubSubSnapshotQuery): void {
    if (m.kind === 'event') {
      this.received += 1;
      this.lastSeq = m.seq;
      this.lastText = m.text;
    } else if (m.kind === 'snapshot') {
      m.replyTo.tell({
        received: this.received,
        lastSeq: this.lastSeq,
        lastText: this.lastText,
      });
    }
  }
}

class PubSubSnapshotCollector extends Actor<PubSubSnapshot> {
  constructor(private readonly resolve: (s: PubSubSnapshot) => void) { super(); }
  override onReceive(s: PubSubSnapshot): void {
    this.resolve(s);
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

  // Long-lived Subscribe-based listener for scenario 08.  Issued
  // immediately at route-build time so the subscriber has time to
  // accumulate updates before any scenario polls it.  Listings are
  // dispatched to the subscriber actor's mailbox; scenarios query
  // its current state via the `GetSnapshot` message.
  const subscriberRef = system.spawnAnonymous(Props.create<SubscriberMsg>(() =>
    new ContinuousSubscriber(),
  )) as ActorRef<SubscriberMsg>;
  receptionistRef.tell(new Subscribe(
    // Same key the node-runner registered the auto-IdleWorker under.
    new ServiceKey('workers'),
    // Cast: Receptionist expects `ActorRef<Listing>`, our actor
    // also handles GetSnapshot.  Same underlying mailbox.
    subscriberRef as unknown as ActorRef<Listing>,
  ));

  // Track scenario-08's extra worker registration so a follow-up
  // /deregister can remove it.  Closure-local so multiple
  // /register hits on the same node replace (not stack).
  let extraWorkerRef: ActorRef | null = null;

  // DistributedPubSub mediator + persistent local subscriber on
  // the `events` topic.  Like Receptionist + DDdata, this is wired
  // BEFORE the HTTP server binds so the mediator's wire-handlers
  // are registered before any peer publishes.
  const pubsubMediator = system.extension(DistributedPubSubId).start(cluster);
  const pubsubReceiver = system.spawnAnonymous(
    Props.create<PubSubEvent | PubSubSnapshotQuery>(() => new PubSubReceiver()),
  ) as ActorRef<PubSubEvent | PubSubSnapshotQuery>;
  pubsubMediator.tell(new PubSubSubscribe(
    'events',
    pubsubReceiver as unknown as ActorRef,
  ));

  // Lazy-spawned SlowSink registry for scenario 14.  Bombarding
  // a SlowSink with > 10 000 messages triggers `drop-head`
  // overflow on its bounded default mailbox (#310) and the
  // `actor_mailbox_dropped_total` counter ticks.
  let slowSinkRef: ActorRef<SlowSinkMsg> | null = null;
  const ensureSlowSink = (): ActorRef<SlowSinkMsg> => {
    if (slowSinkRef) return slowSinkRef;
    slowSinkRef = system.spawnAnonymous(
      Props.create<SlowSinkMsg>(() => new SlowSink()),
    ) as ActorRef<SlowSinkMsg>;
    return slowSinkRef;
  };

  // Cross-node shutdown trace markers (scenario 13).  Each node's
  // pre-registered shutdown hook POSTs to a peer's /test/shutdown-
  // trace/record before this node's HTTP server closes, so the
  // controller can later verify that hooks fired even though the
  // sender node is now offline.
  const shutdownTrace: Array<{ from: string; phase: string; ts: number }> = [];

  // Persistent-counter registry for scenario 11.  Each `id` (the
  // persistenceId) is materialised by an ActorRef on first hit.
  // PoisonPill clears the entry so the next hit re-spawns (which
  // triggers journal replay).
  const persistentCounters = new Map<string, ActorRef<CounterCmd>>();
  const ensurePersistentCounter = (id: string): ActorRef<CounterCmd> => {
    const existing = persistentCounters.get(id);
    if (existing) return existing;
    // spawnAnonymous (auto-incremented name) so a freshly-killed
    // counter can be re-spawned without a name collision.  The
    // PersistentActor's `persistenceId` is what binds it to its
    // journal entries — the actor path doesn't matter.
    const ref = system.spawnAnonymous(
      Props.create<CounterCmd>(() => new PersistentCounter(id)),
    ) as ActorRef<CounterCmd>;
    persistentCounters.set(id, ref);
    return ref;
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

    // GET /test/leader — what does THIS node think the current
    // cluster leader is?  Diagnostic endpoint used by scenarios
    // to verify leader-election convergence (every node should
    // agree on the leader within a few gossip ticks).
    path('leader', get(async () => completeJson(Status.OK, {
      self: cluster.selfAddress.toString(),
      leader: cluster.leader().fold(
        () => null as string | null,
        (m) => m.address.toString(),
      ),
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

    // ============== Receptionist Subscribe (#313 — scenario 08) ==============

    // GET /test/receptionist/subscribed
    // Asks the local long-lived ContinuousSubscriber for the most
    // recent Listing it has observed plus the number of updates
    // received since startup.  Polled by scenario 08 to verify
    // initial-Listing arrival, register-triggered updates, and
    // deregister-triggered updates.
    path('receptionist', path('subscribed', get(async () => {
      try {
        const snapshot = await new Promise<SubscriberSnapshot>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('subscribed snapshot timeout')), 5_000);
          const collector = system.spawnAnonymous(Props.create<SubscriberSnapshot>(() =>
            new SnapshotCollector((s) => {
              clearTimeout(timer);
              resolve(s);
            }),
          )) as ActorRef<SubscriberSnapshot>;
          subscriberRef.tell(new GetSnapshot(collector));
        });
        return completeJson(Status.OK, {
          refs: snapshot.refs,
          count: snapshot.refs.length,
          updates: snapshot.updates,
        });
      } catch (e) {
        return completeJson(Status.InternalServerError, { error: (e as Error).message });
      }
    }))),

    // POST /test/receptionist/register-extra
    // Spawns and registers an EXTRA worker on this node under the
    // shared `workers` key.  Triggers a Listing-change notification
    // on every subscriber across the cluster (via receptionist
    // gossip).  Idempotent: a second hit replaces the prior extra
    // worker (deregisters the old, registers a fresh one) so the
    // total count stays at `original + 1` per node.
    path('receptionist', path('register-extra', post(async () => {
      if (extraWorkerRef) {
        receptionistRef.tell(new Deregister(new ServiceKey('workers'), extraWorkerRef));
      }
      extraWorkerRef = system.spawnAnonymous(Props.create<unknown>(() => new ExtraWorker()));
      receptionistRef.tell(new Register(new ServiceKey('workers'), extraWorkerRef));
      return completeJson(Status.OK, { registered: extraWorkerRef.toString() });
    }))),

    // POST /test/receptionist/deregister-extra
    // Removes the previously-registered extra worker.  Idempotent:
    // calling without a prior /register-extra is a no-op.
    path('receptionist', path('deregister-extra', post(async () => {
      if (!extraWorkerRef) return completeJson(Status.OK, { wasRegistered: false });
      receptionistRef.tell(new Deregister(new ServiceKey('workers'), extraWorkerRef));
      const removed = extraWorkerRef.toString();
      extraWorkerRef = null;
      return completeJson(Status.OK, { deregistered: removed });
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
      deps.singletonProxy.tell({ kind: 'inc' });
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
          deps.singletonProxy.tell({ kind: 'who', replyTo: collector });
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

    // ============== Persistence scenario (#313 — scenario 11) ==============

    // POST /test/persistence/inc?id=X — sends an `inc` command to
    // the PersistentCounter with persistenceId X.  Spawns the actor
    // on first hit (which loads/replays journal events).  Subsequent
    // hits route to the cached ActorRef.
    path('persistence', path('inc', post(async (req) => {
      const id = queryParam(req, 'id');
      if (!id) return complete(Status.BadRequest, 'missing ?id=');
      ensurePersistentCounter(id).tell({ kind: 'inc' });
      return completeJson(Status.OK, { sent: { id, op: 'inc' } });
    }))),

    // GET /test/persistence/state?id=X — sends `get-state` to the
    // counter; replies with `{ count: N }`.  If the actor was
    // PoisonPilled, this implicitly triggers a respawn → replay.
    path('persistence', path('state', get(async (req) => {
      const id = queryParam(req, 'id');
      if (!id) return complete(Status.BadRequest, 'missing ?id=');
      try {
        const state = await new Promise<CounterStateReply>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('counter get-state timeout')), 5_000);
          const collector = system.spawnAnonymous(Props.create<CounterStateReply>(() =>
            new CounterStateCollector((s) => {
              clearTimeout(timer);
              resolve(s);
            }),
          )) as ActorRef<CounterStateReply>;
          ensurePersistentCounter(id).tell({ kind: 'get-state', replyTo: collector });
        });
        return completeJson(Status.OK, { id, count: state.count });
      } catch (e) {
        return completeJson(Status.InternalServerError, { error: (e as Error).message });
      }
    }))),

    // POST /test/persistence/kill?id=X — PoisonPills the counter
    // and drops it from the registry.  The next /inc or /state on
    // the same id will re-spawn → replay from journal.
    path('persistence', path('kill', post(async (req) => {
      const id = queryParam(req, 'id');
      if (!id) return complete(Status.BadRequest, 'missing ?id=');
      const ref = persistentCounters.get(id);
      if (!ref) return completeJson(Status.OK, { id, wasAlive: false });
      ref.tell(PoisonPill.instance as never);
      persistentCounters.delete(id);
      return completeJson(Status.OK, { id, wasAlive: true });
    }))),

    // ============== DistributedPubSub scenario (#313 — scenario 12) ==============

    // POST /test/pubsub/publish?topic=T&seq=N&text=M
    // Publish a `PubSubEvent` on `topic`.  Mediator fans out
    // locally + gossips/forwards to remote mediators which fan
    // out on their nodes.  Every subscribed node receives one
    // copy.
    path('pubsub', path('publish', post(async (req) => {
      const topic = queryParam(req, 'topic') ?? 'events';
      const seq = Number(queryParam(req, 'seq') ?? '0');
      const text = queryParam(req, 'text') ?? '';
      const event: PubSubEvent = { kind: 'event', seq, text };
      pubsubMediator.tell(new PubSubPublish(topic, event));
      return completeJson(Status.OK, { published: { topic, seq, text } });
    }))),

    // GET /test/pubsub/received
    // Returns the local subscriber's view: how many events it has
    // received, plus the most-recent (seq, text).  The scenario
    // polls this on every node to verify fan-out.
    path('pubsub', path('received', get(async () => {
      try {
        const snapshot = await new Promise<PubSubSnapshot>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('pubsub snapshot timeout')), 5_000);
          const collector = system.spawnAnonymous(
            Props.create<PubSubSnapshot>(() => new PubSubSnapshotCollector((s) => {
              clearTimeout(timer);
              resolve(s);
            })),
          ) as ActorRef<PubSubSnapshot>;
          pubsubReceiver.tell({ kind: 'snapshot', replyTo: collector });
        });
        return completeJson(Status.OK, snapshot);
      } catch (e) {
        return completeJson(Status.InternalServerError, { error: (e as Error).message });
      }
    }))),

    // ============== Seed Discovery scenario (#313 — scenario 15) ==============

    // GET /test/discovery/dns-lookup?hostname=X[&port=Y]
    // Runs `DnsSeedProvider.lookup()` against docker's embedded
    // DNS for service name X.  Returns the resolved NodeAddress
    // list as JSON.  Exercises the same code path that a real
    // K8s headless-service / DNS-based bootstrap would take.
    path('discovery', path('dns-lookup', get(async (req) => {
      const hostname = queryParam(req, 'hostname');
      const port = Number(queryParam(req, 'port') ?? '9000');
      if (!hostname) return complete(Status.BadRequest, 'missing ?hostname=');
      if (!Number.isInteger(port) || port < 1) return complete(Status.BadRequest, 'port must be a positive integer');
      try {
        const provider = new DnsSeedProvider({
          hostname,
          port,
          systemName: 'integration',
          cacheTtlMs: 0,  // disable cache so each call hits DNS fresh
        });
        const startedAt = Date.now();
        const addresses = await provider.lookup();
        return completeJson(Status.OK, {
          hostname,
          port,
          systemName: 'integration',
          addresses: addresses.map((a) => a.toString()),
          ips: addresses.map((a) => a.host),
          elapsedMs: Date.now() - startedAt,
        });
      } catch (e) {
        return completeJson(Status.InternalServerError, { error: (e as Error).message });
      }
    }))),

    // ============== Backpressure scenario (#313 — scenario 14) ==============

    // POST /test/backpressure/bombard?n=N&sleepMs=D
    // Spawns the SlowSink (idempotent) and tells it N messages
    // synchronously in a tight loop.  Each message will sleep
    // `sleepMs` ms inside `onReceive` so the queue fills up.
    // With N > 10 000 (default mailbox capacity), the drop-head
    // policy kicks in.  Returns the count of tells issued (the
    // mailbox stage isn't observable to the caller — it just
    // tells; drops happen inside enqueue).
    path('backpressure', path('bombard', post(async (req) => {
      const n = Number(queryParam(req, 'n') ?? '15000');
      const sleepMs = Number(queryParam(req, 'sleepMs') ?? '50');
      if (!Number.isInteger(n) || n < 1) return complete(Status.BadRequest, 'n must be positive integer');
      if (!Number.isFinite(sleepMs) || sleepMs < 0) return complete(Status.BadRequest, 'sleepMs must be non-negative');
      const sink = ensureSlowSink();
      // Synchronous tight loop — no await between tells, so the
      // entire burst hits the mailbox before the dispatcher has
      // a chance to drain.
      for (let i = 0; i < n; i++) sink.tell({ kind: 'process', sleepMs });
      return completeJson(Status.OK, { sent: n, sleepMs });
    }))),

    // GET /test/backpressure/dropped
    // Returns the current value of `actor_mailbox_dropped_total`
    // across ALL classes from this node's metrics registry, as a
    // parsed sum.  Scenarios verify this is non-zero after a
    // bombard call.  We expose the parsed total (rather than the
    // full Prometheus text) so scenarios stay terse.
    path('backpressure', path('dropped', get(async () => {
      const text = exportPrometheus(metricsOf(system));
      // Match `actor_mailbox_dropped_total{...} <number>` lines.
      const re = /^actor_mailbox_dropped_total\{[^}]*\}\s+(\d+(?:\.\d+)?)\s*$/gm;
      let total = 0;
      const lines: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const v = Number(m[1]);
        if (Number.isFinite(v)) total += v;
        lines.push(m[0]);
      }
      return completeJson(Status.OK, { total, lines });
    }))),

    // ============== CoordinatedShutdown scenario (#313 — scenario 13) ==============

    // POST /test/shutdown-trace/record?from=X&phase=P
    // A peer's shutdown hook calls this to leave a marker that
    // it fired its hook.  Records into the local in-memory trace.
    path('shutdown-trace', path('record', post(async (req) => {
      const from = queryParam(req, 'from');
      const phase = queryParam(req, 'phase');
      if (!from || !phase) return complete(Status.BadRequest, 'missing ?from= or ?phase=');
      shutdownTrace.push({ from, phase, ts: Date.now() });
      return completeJson(Status.OK, { recorded: { from, phase } });
    }))),

    // GET /test/shutdown-trace
    // Returns the list of markers received so far.
    path('shutdown-trace', get(async () => {
      return completeJson(Status.OK, { markers: shutdownTrace });
    })),

    // POST /test/coordinated-shutdown
    // Triggers `CoordinatedShutdown.run()` on this node.  Returns
    // 202 immediately; the actual shutdown proceeds asynchronously
    // and the HTTP server will close mid-pipeline.  Use peer's
    // `/test/shutdown-trace` to observe the hooks firing.
    path('coordinated-shutdown', post(async () => {
      // Fire-and-forget so we can respond before the server unbinds.
      void system.extension(CoordinatedShutdownId).run();
      return completeJson(Status.Accepted, { triggered: cluster.selfAddress.toString() });
    })),

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
