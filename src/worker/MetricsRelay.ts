import { match, P } from 'ts-pattern';
import type { ActorSystem } from '../ActorSystem.js';
import type { Cluster } from '../cluster/Cluster.js';
import { MemberDown, MemberRemoved, type ClusterEvent } from '../cluster/ClusterEvents.js';
import type { NodeAddress } from '../cluster/NodeAddress.js';
import type { WireMessage } from '../cluster/Protocol.js';
import type { Logger } from '../Logger.js';
import {
  PROMETHEUS_LABEL_NAME_PATTERN,
  PROMETHEUS_METRIC_NAME_PATTERN,
  THREAD_LABEL,
} from '../metrics/Constants.js';
import { isCollectable, type MetricSample } from '../metrics/Metrics.js';
import { MetricsExtensionId, withThreadLabel } from '../metrics/MetricsExtension.js';
import type { Cancellable } from '../Scheduler.js';
import {
  MAX_QUOTED_PROBLEM_CHARACTERS,
  MAX_RELAYED_SAMPLES_PER_SNAPSHOT,
  MAX_REPORTED_SNAPSHOT_PROBLEMS_PER_WORKER,
} from './Constants.js';

/**
 * Worker-thread metrics on the main thread's `/metrics` (#1570).
 *
 * Every mesh worker boots its own `ActorSystem` with its own registry and no
 * management endpoint, so an actor placed on a worker used to be invisible to
 * Prometheus.  This is the relay: the **main thread pulls**.  On every tick it
 * sends `worker-mesh-metrics-request` to each live worker; a worker answers
 * with its registry's `collect()` verbatim, and the main side stores the
 * snapshot, stamps `thread="worker-<slot>"` on every sample at export and
 * contributes the result to `MetricsExtension.collectAll`.
 *
 * Pull rather than push, for three reasons that are all about the worker
 * owning nothing.  Nothing ever enables a worker's registry — it is the noop
 * until asked, and the main thread's `enable()` is code that may run after
 * the mesh is up — so **the request is the enable signal**: the first one a
 * worker receives switches its registry on.  A worker owns no timer, so there
 * is nothing on that side to leak on Deno.  And a worker's silence is
 * observable on the main side, which is where the operator is looking.
 *
 * Frames are extension kinds dispatched through `Cluster._onWire`, like the
 * spawn protocol's, and cross the mesh's `MessageChannel` under structured
 * clone — which is why a snapshot may carry a histogram's `+Inf` bucket and
 * must never be routed over a JSON hop.
 */

/* --------------------------------- frames -------------------------------- */

/** Main → worker: answer with your registry's samples; enable it first if it is still the noop. */
export type WorkerMeshMetricsRequestMessage = {
  readonly kind: 'worker-mesh-metrics-request';
};

/** Worker → main: the registry's current state. */
export type WorkerMeshMetricsMessage = {
  readonly kind: 'worker-mesh-metrics';
  /** `registry.collect()` verbatim — structured-clone-safe by construction. */
  readonly samples: ReadonlyArray<MetricSample>;
  /** `isCollectable(registry)` on the worker; `false` means the worker plugged in a write-through registry. */
  readonly collectable: boolean;
};

export type WorkerMeshWireMessage =
  | WorkerMeshMetricsRequestMessage
  | WorkerMeshMetricsMessage;

/** Every kind above, for handler registration and the dead-protocol guard. */
export const WORKER_MESH_WIRE_KINDS: ReadonlyArray<WorkerMeshWireMessage['kind']> = [
  'worker-mesh-metrics-request',
  'worker-mesh-metrics',
];

/* ------------------------------ worker side ------------------------------ */

/** What a worker needs to answer metrics requests: its system, its node, and the one peer allowed to ask. */
export type WorkerMeshMetricsWorkerContext = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  /** Addresses whose requests are honoured — the mesh's seed, i.e. the main thread. */
  readonly trustedPeers: ReadonlyArray<string>;
};

/**
 * The worker's half, installed by the mesh bootstrap beside the spawn
 * protocol.  A request from anyone but the main thread is dropped: it would
 * switch this system's metrics on and hand its registry to whoever asked.
 *
 * Returns the unsubscribe.
 */
export function serveWorkerMeshMetrics(context: WorkerMeshMetricsWorkerContext): () => void {
  const service = new WorkerMeshMetricsService(context);
  return context.cluster._onWire('worker-mesh-metrics-request', (message, from) =>
    service.onMetricsRequest(message as unknown as WorkerMeshMetricsRequestMessage, from),
  );
}

class WorkerMeshMetricsService {
  constructor(private readonly context: WorkerMeshMetricsWorkerContext) {}

  onMetricsRequest(_message: WorkerMeshMetricsRequestMessage, from: NodeAddress): void {
    if (!this.isTrusted(from)) return;
    // Idempotent: the first request installs a real registry, every later one
    // returns the same instance — and a registry the module's `setup` plugged
    // in with `useRegistry` is left alone, since it is not the noop.
    const registry = this.context.system.extension(MetricsExtensionId).enable();
    const snapshot: WorkerMeshMetricsMessage = {
      kind: 'worker-mesh-metrics',
      samples: registry.collect(),
      collectable: isCollectable(registry),
    };
    this.context.cluster._sendWire(from, snapshot as unknown as WireMessage);
  }

  private isTrusted(from: NodeAddress): boolean {
    return this.context.trustedPeers.includes(from.toString());
  }
}

/* ------------------------------- main side ------------------------------- */

/** What the relay needs to know about a worker: its slot and where it is. */
export type RelayedWorker = {
  readonly id: number;
  readonly address: NodeAddress;
};

export type MetricsRelayContext = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  /**
   * The mesh's live workers.  A function, re-read on every tick and on every
   * snapshot, because the set moves: a crashed slot is spliced out and its
   * replacement pushed back in under the same address.
   */
  readonly workers: () => ReadonlyArray<RelayedWorker>;
  readonly intervalMs: number;
};

type Snapshot = {
  readonly slot: number;
  readonly samples: ReadonlyArray<MetricSample>;
  /** `system.clock` time the snapshot arrived — what the age gauge measures from. */
  readonly receivedAt: number;
};

const SNAPSHOT_AGE_HELP = 'Seconds since the main thread last received a metrics snapshot from this worker. '
  + 'Rises while a worker is silent; its series is removed when the worker leaves the mesh.';

/** The `thread` label value of a worker's samples — the thread's own name, `worker-<slot>`. */
export function workerThreadLabelValue(slot: number): string {
  return `worker-${slot}`;
}

/**
 * The main thread's half: asks, stores, stamps, retires.
 *
 * One instance per mesh, started by `WorkerMesh.start` once every member is
 * up and stopped by `terminate()`.  Nothing here caches the registry: the
 * extension is asked for it on every use, so a registry `enable()`d or
 * swapped after the mesh started is the one written to.
 */
export class MetricsRelay {
  private readonly snapshots = new Map<string, Snapshot>();
  /** Problem texts already reported, per worker address — the once-per-problem bound. */
  private readonly reportedProblems = new Map<string, Set<string>>();
  private readonly log: Logger;
  private ticker: Cancellable | null = null;
  private unsubscribeWire: (() => void) | null = null;
  private unsubscribeMembership: (() => void) | null = null;
  private removeSource: (() => void) | null = null;

  constructor(private readonly context: MetricsRelayContext) {
    this.log = context.system.log;
  }

  /**
   * Register the wire handler, the membership listener and the sample source,
   * arm the tick, and ask once right away.  The immediate request matters for
   * the parallelism extension: frames are ordered on one channel, so a request
   * sent before the first spawn frame reaches the worker's registry before the
   * first offloaded actor does, and that actor's first message is counted.
   */
  start(): void {
    if (this.ticker !== null) return;
    const { system, cluster, intervalMs } = this.context;
    this.unsubscribeWire = cluster._onWire('worker-mesh-metrics', (message, from) =>
      this.onSnapshot(message as unknown as WorkerMeshMetricsMessage, from),
    );
    this.unsubscribeMembership = cluster.subscribe((event) => this.onClusterEvent(event));
    this.removeSource = system.extension(MetricsExtensionId)._addSampleSource(() => this.samples());
    this.ticker = system.scheduler.scheduleAtFixedRateFunction(intervalMs, intervalMs, () => this.onTick());
    this.onTick();
  }

  /**
   * Cancel the tick, unhook everything, and retire every snapshot — which
   * takes the age series with them.  After this the exposition is the main
   * thread's alone again, byte for byte.
   */
  stop(): void {
    this.ticker?.cancel();
    this.ticker = null;
    this.unsubscribeWire?.();
    this.unsubscribeWire = null;
    this.unsubscribeMembership?.();
    this.unsubscribeMembership = null;
    this.removeSource?.();
    this.removeSource = null;
    for (const key of [...this.snapshots.keys()]) this.retire(key);
    this.reportedProblems.clear();
  }

  /**
   * The contributor: every stored snapshot's samples, stamped with the thread
   * that produced them, in slot order so the exposition is deterministic.
   *
   * Called on every export.  Stamping copies — `withThreadLabel` never touches
   * the stored sample, which on the in-process rig *is* the worker registry's
   * own object.  The age gauge is set here rather than on the tick so the
   * value a scrape carries is the age at that scrape, not at the last tick;
   * `collectAll` reads the sources before its own registry for exactly this.
   */
  samples(): ReadonlyArray<MetricSample> {
    const out: MetricSample[] = [];
    const now = this.context.system.clock.now();
    const registry = this.context.system.extension(MetricsExtensionId).get();
    const ordered = [...this.snapshots.values()].sort((a, b) => a.slot - b.slot);
    for (const snapshot of ordered) {
      const thread = workerThreadLabelValue(snapshot.slot);
      // The family name is a literal here and in `retire`, as `actor_mailbox_size`
      // is in `MailboxDepthSampler`: the stock-metrics inventory reads label
      // sets off the call site and cannot see through a constant.
      registry.gauge('worker_mesh_snapshot_age_seconds', { worker: thread }, { help: SNAPSHOT_AGE_HELP })
        .set(Math.max(0, now - snapshot.receivedAt) / 1000);
      for (const sample of snapshot.samples) out.push(withThreadLabel(sample, thread));
    }
    return out;
  }

  /**
   * One tick: retire what has left, then ask everyone who is still here — but
   * only while the main thread's own metrics are on and readable.  A main
   * registry that is the noop has nothing to merge worker samples into, and
   * asking would switch every worker's registry on for an exposition nobody
   * renders; a write-through one turns `/metrics` into a 503 anyway.  A worker
   * the main stops asking keeps counting, so re-enabling picks up where it
   * left off.
   *
   * "Still here" is membership, not the handle set alone.  Under
   * `restartPolicy 'never'` a dead worker keeps its handle (#1284), so its
   * address stays in `workers()` for the life of the mesh while the failure
   * detector holds its member `down`; the same `down` set that retires its
   * snapshot keeps a request from going into its port every interval.  The
   * set is re-read each tick, so a slot whose address re-joins `up` is asked
   * again without anything else having to notice.
   */
  private onTick(): void {
    const down = this.downMembers();
    this.retireDeparted(down);
    const metrics = this.context.system.extension(MetricsExtensionId);
    if (!metrics.isEnabled() || !isCollectable(metrics.get())) return;
    const request: WorkerMeshMetricsRequestMessage = { kind: 'worker-mesh-metrics-request' };
    for (const worker of this.context.workers()) {
      if (down.has(worker.address.toString())) continue;
      this.context.cluster._sendWire(worker.address, request as unknown as WireMessage);
    }
  }

  /**
   * A snapshot arrived.  `from` is channel-derived — the broker re-addresses
   * every frame to the port it arrived on (#774) — so matching it against the
   * mesh's live workers is a sound identity check, not a claim the frame made
   * about itself.  A frame from an address that is not a live worker is
   * dropped silently: it is a departed slot's answer still in flight, and
   * keying a report on a stranger's address would let the report table grow
   * with the strangers.
   *
   * Then the shape.  Relayed samples bypass the registry's grammar checks —
   * `assertValidMetricName` and `assertValidLabelKeys` ran on the worker, if
   * the worker is what it claims — so every name and key is re-checked here
   * against the same patterns, and **any problem drops the snapshot whole**.
   * A partial merge would render the good rows of a frame whose bad rows
   * were an attempt to forge series, and the good rows are the cover.
   */
  onSnapshot(message: WorkerMeshMetricsMessage, from: NodeAddress): void {
    const worker = this.context.workers().find((candidate) => candidate.address.equals(from));
    if (worker === undefined) return;
    const problem = describeMetricsSnapshotProblem(message);
    if (problem !== null) {
      this.reportProblem(from, problem);
      return;
    }
    const receivedAt = this.context.system.clock.now();
    if (!message.collectable) {
      // The worker answered, so it is alive and its age resets — it just has
      // nothing this side can read.  Said once, since it is a wiring choice
      // in the worker's module rather than an event.
      this.reportProblem(from, 'its registry is not collectable — a write-through registry keeps no copy to relay');
      this.snapshots.set(from.toString(), { slot: worker.id, samples: [], receivedAt });
      return;
    }
    this.snapshots.set(from.toString(), { slot: worker.id, samples: message.samples, receivedAt });
  }

  private onClusterEvent(event: ClusterEvent): void {
    // One arm for both, as `RemoteWatcher` does: the two are structurally the
    // same `{ member }` shape, so two `P.instanceOf` arms in a row would
    // narrow the second to the rest of the union.
    match(event)
      .with(
        P.union(P.instanceOf(MemberRemoved), P.instanceOf(MemberDown)),
        (e) => this.onMemberDownOrRemoved(e),
      )
      .otherwise(() => this.onUnrelatedEvent());
  }

  /**
   * Departure through membership, not `mesh.addresses` alone: under
   * `restartPolicy 'never'` a dead worker keeps its handle (#1284), so its
   * address stays in the set while the failure detector takes its member
   * `down`.  Either signal retires the snapshot.
   */
  private onMemberDownOrRemoved(event: MemberDown | MemberRemoved): void {
    this.retire(event.member.address.toString());
  }

  private onUnrelatedEvent(): void {
    /* membership churn that does not end a worker keeps its snapshot */
  }

  /**
   * The tick's half of departure: a slot spliced out for a respawn is gone
   * from `workers()` before any membership event says so, and a member the
   * detector took `down` while no event was delivered is caught here too.  A
   * respawned worker reuses its slot's address, so it re-appears under the
   * same label with counters starting over — a reset Prometheus's `rate()`
   * already handles.
   */
  private retireDeparted(down: ReadonlySet<string>): void {
    const live = new Set(this.context.workers().map((worker) => worker.address.toString()));
    for (const key of [...this.snapshots.keys()]) {
      if (!live.has(key) || down.has(key)) this.retire(key);
    }
  }

  /**
   * The addresses the failure detector currently holds `down`, keyed like the
   * snapshot table.  One record per address — the member table is keyed by
   * `address.toString()` — so a respawned slot re-joining under its old
   * address replaces the `down` record rather than sitting beside it.
   */
  private downMembers(): ReadonlySet<string> {
    return new Set(
      this.context.cluster.getMembers()
        .filter((member) => member.status === 'down')
        .map((member) => member.address.toString()),
    );
  }

  /**
   * Forget a worker's snapshot and remove its age series — the caller-driven
   * eviction `MetricsRegistry.remove` asks for, so a departed slot does not
   * stand at its last reading forever.
   */
  private retire(key: string): void {
    const snapshot = this.snapshots.get(key);
    if (snapshot === undefined) return;
    this.snapshots.delete(key);
    this.reportedProblems.delete(key);
    this.context.system.extension(MetricsExtensionId).get()
      .remove('worker_mesh_snapshot_age_seconds', { worker: workerThreadLabelValue(snapshot.slot) });
  }

  private reportProblem(from: NodeAddress, problem: string): void {
    const key = from.toString();
    let reported = this.reportedProblems.get(key);
    if (reported === undefined) {
      reported = new Set();
      this.reportedProblems.set(key, reported);
    }
    if (reported.has(problem) || reported.size >= MAX_REPORTED_SNAPSHOT_PROBLEMS_PER_WORKER) return;
    reported.add(problem);
    this.log.warn(`[worker] metrics relay dropped a snapshot from ${key} — ${problem}`);
  }
}

/* ------------------------------- validation ------------------------------ */

const SAMPLE_KINDS: ReadonlySet<string> = new Set(['counter', 'gauge', 'histogram']);

/**
 * Why a `worker-mesh-metrics` frame cannot be merged, or `null` when it can.
 * Mirrors `describeSpawnProblem` on the spawn protocol: the core validates
 * only that a frame has a string `kind`, so every field check lives here.
 *
 * The two grammar checks are the security half (#784 from the worker's side):
 * `renderPrometheusSamples` interpolates names and label keys raw, and a
 * relayed sample never passed the registry that would have refused them.
 * The reserved `thread` key is refused for the same reason one layer up — a
 * sample that arrives already stamped is claiming to be another thread's.
 * `Infinity` is allowed for `bucket` (the `+Inf` row) and `NaN` for `value`
 * (the exporter renders it); everything else numeric has to be a number.
 */
export function describeMetricsSnapshotProblem(message: unknown): string | null {
  if (message === null || typeof message !== 'object') return 'metrics frame is not an object';
  const frame = message as Partial<WorkerMeshMetricsMessage>;
  if (typeof frame.collectable !== 'boolean') return 'metrics frame has no collectable flag';
  if (!Array.isArray(frame.samples)) return 'metrics frame samples are not an array';
  if (frame.samples.length > MAX_RELAYED_SAMPLES_PER_SNAPSHOT) {
    return `metrics frame carries ${frame.samples.length} samples, more than the ${MAX_RELAYED_SAMPLES_PER_SNAPSHOT} allowed`;
  }
  for (const sample of frame.samples as ReadonlyArray<unknown>) {
    const problem = describeSampleProblem(sample);
    if (problem !== null) return problem;
  }
  return null;
}

function describeSampleProblem(sample: unknown): string | null {
  if (sample === null || typeof sample !== 'object' || Array.isArray(sample)) return 'a sample is not an object';
  const candidate = sample as Partial<Record<keyof MetricSample, unknown>>;
  if (typeof candidate.name !== 'string' || !PROMETHEUS_METRIC_NAME_PATTERN.test(candidate.name)) {
    return `a sample's name ${quote(candidate.name)} is outside the Prometheus metric-name grammar`;
  }
  if (typeof candidate.help !== 'string') return `sample ${quote(candidate.name)} has no help string`;
  if (typeof candidate.kind !== 'string' || !SAMPLE_KINDS.has(candidate.kind)) {
    return `sample ${quote(candidate.name)} has kind ${quote(candidate.kind)}, not counter, gauge or histogram`;
  }
  if (candidate.labels === null || typeof candidate.labels !== 'object' || Array.isArray(candidate.labels)) {
    return `sample ${quote(candidate.name)} has no labels object`;
  }
  for (const [key, value] of Object.entries(candidate.labels as Record<string, unknown>)) {
    if (!PROMETHEUS_LABEL_NAME_PATTERN.test(key)) {
      return `sample ${quote(candidate.name)} has label key ${quote(key)} outside the Prometheus label-name grammar`;
    }
    if (key === THREAD_LABEL) {
      return `sample ${quote(candidate.name)} carries the reserved label ${quote(THREAD_LABEL)} — the relay stamps it`;
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return `sample ${quote(candidate.name)} has a label ${quote(key)} whose value is not a string, number or boolean`;
    }
  }
  if (typeof candidate.value !== 'number') return `sample ${quote(candidate.name)} has no numeric value`;
  for (const field of ['bucket', 'count', 'sum'] as const) {
    if (candidate[field] !== undefined && typeof candidate[field] !== 'number') {
      return `sample ${quote(candidate.name)} has a ${field} that is not a number`;
    }
  }
  return null;
}

/**
 * A value for a report, `JSON.stringify`d so the message is not itself an
 * injection point — the same reasoning as `assertValidMetricName` — and cut
 * short so a name chosen to be enormous is not echoed in full.
 */
function quote(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);
  const clipped = text.length > MAX_QUOTED_PROBLEM_CHARACTERS
    ? `${text.slice(0, MAX_QUOTED_PROBLEM_CHARACTERS)}…`
    : text;
  return JSON.stringify(clipped);
}
