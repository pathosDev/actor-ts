import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { Cluster } from '../../../src/cluster/Cluster.js';
import { MemberDown, MemberRemoved, MemberUp, type ClusterEvent } from '../../../src/cluster/ClusterEvents.js';
import { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import { wireFrameProblem } from '../../../src/cluster/WireValidation.js';
import { LogLevel, NoopLogger, type Logger } from '../../../src/Logger.js';
import {
  DefaultMetricsRegistry,
  type Counter,
  type CounterOptions,
  type Gauge,
  type GaugeOptions,
  type Histogram,
  type HistogramOptions,
  type Labels,
  type MetricSample,
  type MetricsRegistry,
} from '../../../src/metrics/Metrics.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';
import { renderPrometheusSamples } from '../../../src/metrics/PrometheusExporter.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';
import {
  MAX_RELAYED_SAMPLES_PER_SNAPSHOT,
  MAX_REPORTED_SNAPSHOT_PROBLEMS_PER_WORKER,
} from '../../../src/worker/Constants.js';
import {
  MetricsRelay,
  WORKER_MESH_WIRE_KINDS,
  describeMetricsSnapshotProblem,
  serveWorkerMeshMetrics,
  type RelayedWorker,
  type WorkerMeshMetricsMessage,
} from '../../../src/worker/MetricsRelay.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

/**
 * Both halves of the metrics relay (#1570) against a stand-in cluster: what a
 * worker answers and whom it listens to, and what the main side accepts,
 * stamps, refuses and retires.  The two halves over a real mesh — in-process
 * and on real threads — are `WorkerMesh.test.ts`'s and
 * `tests/multi-node/WorkerMeshMetricsRelay.test.ts`'s.
 */

type Sent = { readonly to: string; readonly message: Record<string, unknown> };

type StubCluster = {
  readonly cluster: Cluster;
  readonly sent: Sent[];
  readonly handlers: Map<string, (m: WireMessage, from: NodeAddress) => void>;
  readonly listeners: Array<(event: ClusterEvent) => void>;
  /** What `getMembers()` answers — a test sets it to take a member down. */
  members: Member[];
};

function stubCluster(self: NodeAddress): StubCluster {
  const sent: Sent[] = [];
  const handlers = new Map<string, (m: WireMessage, from: NodeAddress) => void>();
  const listeners: Array<(event: ClusterEvent) => void> = [];
  const stub: StubCluster = {
    sent,
    handlers,
    listeners,
    members: [],
    cluster: {
      selfAddress: self,
      _onWire(kind: string, handler: (m: WireMessage, from: NodeAddress) => void): () => void {
        handlers.set(kind, handler);
        return () => { handlers.delete(kind); };
      },
      _sendWire(to: NodeAddress, message: WireMessage): void {
        sent.push({ to: to.toString(), message: message as unknown as Record<string, unknown> });
      },
      subscribe(listener: (event: ClusterEvent) => void): () => void {
        listeners.push(listener);
        return () => { listeners.splice(listeners.indexOf(listener), 1); };
      },
      getMembers(): ReadonlyArray<Member> { return stub.members; },
    } as unknown as Cluster,
  };
  return stub;
}

const MAIN = new NodeAddress('relay', 'main', 1);
const WORKER_0 = new NodeAddress('relay', 'worker', 2);
const WORKER_1 = new NodeAddress('relay', 'worker', 3);
const STRANGER = new NodeAddress('relay', 'elsewhere', 9);

const memberUp = (address: NodeAddress): Member => new Member(address, 'up', 1, []);

function systemWith(logger: Logger, scheduler?: ManualScheduler): ActorSystem {
  const options = ActorSystemOptions.create()
    .withLogger(logger)
    .withLogLevel(LogLevel.Off);
  if (scheduler !== undefined) options.withScheduler(scheduler);
  return ActorSystem.create('relay', options);
}

/** A registry whose writes go somewhere this process cannot read back — the `promClientRegistry` shape (#744). */
class WriteThroughRegistry implements MetricsRegistry {
  readonly collectable = false;
  private readonly foreign = new DefaultMetricsRegistry();
  counter(name: string, labels?: Labels, options?: CounterOptions): Counter { return this.foreign.counter(name, labels, options); }
  gauge(name: string, labels?: Labels, options?: GaugeOptions): Gauge { return this.foreign.gauge(name, labels, options); }
  histogram(name: string, labels?: Labels, options?: HistogramOptions): Histogram { return this.foreign.histogram(name, labels, options); }
  collect(): ReadonlyArray<MetricSample> { return []; }
  remove(name: string, labels?: Labels): boolean { return this.foreign.remove(name, labels); }
  clear(): void { this.foreign.clear(); }
}

/* ------------------------------- wire kinds ------------------------------ */

describe('worker-mesh wire kinds', () => {
  test('both kinds are extension kinds: the core validator passes them through to the registered handler', () => {
    expect(WORKER_MESH_WIRE_KINDS).toHaveLength(2);
    for (const kind of WORKER_MESH_WIRE_KINDS) expect(wireFrameProblem({ kind })).toBeNull();
  });
});

/* ------------------------------- worker side ----------------------------- */

describe('the worker side of the metrics relay', () => {
  async function withService(body: (context: {
    system: ActorSystem;
    sent: Sent[];
    request: (from?: NodeAddress) => void;
  }) => Promise<void>): Promise<void> {
    const system = systemWith(new NoopLogger());
    const { cluster, sent, handlers } = stubCluster(WORKER_0);
    const unsubscribe = serveWorkerMeshMetrics({ system, cluster, trustedPeers: [MAIN.toString()] });
    try {
      await body({
        system,
        sent,
        request: (from = MAIN) =>
          handlers.get('worker-mesh-metrics-request')!({ kind: 'worker-mesh-metrics-request' } as unknown as WireMessage, from),
      });
    } finally {
      unsubscribe();
      expect(handlers.size).toBe(0);
      await system.terminate();
    }
  }

  test('a request from anyone but the main thread is dropped, and the registry stays the noop', () => withService(async ({ system, sent, request }) => {
    request(STRANGER);
    expect(sent).toEqual([]);
    expect(system.extension(MetricsExtensionId).isEnabled()).toBe(false);
  }));

  test('the first request from the main thread enables the registry and is answered with collect() verbatim', () => withService(async ({ system, sent, request }) => {
    const metrics = system.extension(MetricsExtensionId);
    expect(metrics.isEnabled()).toBe(false);

    request();

    expect(metrics.isEnabled()).toBe(true);
    const registry = metrics.get();
    registry.counter('relayed_total', { side: 'worker' }).inc(3);
    request();

    expect(sent).toHaveLength(2);
    expect(sent.every((s) => s.to === MAIN.toString())).toBe(true);
    const second = sent[1]!.message as unknown as WorkerMeshMetricsMessage;
    expect(second.kind).toBe('worker-mesh-metrics');
    expect(second.collectable).toBe(true);
    expect(second.samples).toEqual(registry.collect());
    expect(second.samples.some((s) => s.name === 'relayed_total' && s.value === 3)).toBe(true);
    // The same registry every time — the enable is idempotent.
    expect(metrics.get()).toBe(registry);
  }));

  test('a worker whose module plugged in a write-through registry answers collectable: false', () => withService(async ({ system, sent, request }) => {
    const foreign = new WriteThroughRegistry();
    system.extension(MetricsExtensionId).useRegistry(foreign);
    request();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toEqual({ kind: 'worker-mesh-metrics', samples: [], collectable: false });
    // Left alone: a real registry is not replaced by the enable.
    expect(system.extension(MetricsExtensionId).get()).toBe(foreign);
  }));
});

/* -------------------------------- main side ------------------------------ */

type Rig = {
  readonly system: ActorSystem;
  readonly scheduler: ManualScheduler;
  readonly logger: RecordingLogger;
  readonly stub: StubCluster;
  readonly relay: MetricsRelay;
  /** The live worker set the relay reads — mutable so a test can take a slot away. */
  workers: RelayedWorker[];
  /** Deliver a snapshot frame as the wire would. */
  readonly snapshot: (message: unknown, from: NodeAddress) => void;
  readonly warnings: () => string[];
};

const INTERVAL_MS = 1_000;

function rig(enableMetrics = true): Rig {
  const scheduler = new ManualScheduler();
  const logger = new RecordingLogger();
  const system = systemWith(logger, scheduler);
  if (enableMetrics) system.extension(MetricsExtensionId).enable();
  const stub = stubCluster(MAIN);
  stub.members = [memberUp(MAIN), memberUp(WORKER_0), memberUp(WORKER_1)];
  const r: Rig = {
    system,
    scheduler,
    logger,
    stub,
    workers: [{ id: 0, address: WORKER_0 }, { id: 1, address: WORKER_1 }],
    relay: null as unknown as MetricsRelay,
    snapshot: (message, from) => stub.handlers.get('worker-mesh-metrics')!(message as WireMessage, from),
    warnings: () => logger.records.filter((record) => record.level === 'warn').map((record) => record.message),
  };
  (r as { relay: MetricsRelay }).relay = new MetricsRelay({
    system,
    cluster: stub.cluster,
    workers: () => r.workers,
    intervalMs: INTERVAL_MS,
  });
  return r;
}

function snapshotOf(...samples: Partial<MetricSample>[]): WorkerMeshMetricsMessage {
  return {
    kind: 'worker-mesh-metrics',
    collectable: true,
    samples: samples.map((sample) => ({
      name: 'relayed_total', help: 'relayed', kind: 'counter', labels: {}, value: 1, ...sample,
    })),
  };
}

const requestsSent = (r: Rig): string[] =>
  r.stub.sent.filter((s) => s.message.kind === 'worker-mesh-metrics-request').map((s) => s.to);

const threadsIn = (samples: ReadonlyArray<MetricSample>): string[] =>
  samples.map((s) => String(s.labels.thread));

const ageSeries = (r: Rig): MetricSample[] =>
  r.system.extension(MetricsExtensionId).get().collect().filter((s) => s.name === 'worker_mesh_snapshot_age_seconds');

describe('the main side of the metrics relay — asking', () => {
  test('start() asks every live worker at once and on every tick, and registers itself with the extension', async () => {
    const r = rig();
    try {
      r.relay.start();
      expect(requestsSent(r)).toEqual([WORKER_0.toString(), WORKER_1.toString()]);
      r.scheduler.advance(INTERVAL_MS);
      expect(requestsSent(r)).toHaveLength(4);
      // The contributor is wired: with a source registered, the main thread's
      // own samples come back stamped.
      r.system.extension(MetricsExtensionId).get().counter('main_total').inc();
      const merged = r.system.extension(MetricsExtensionId).collectAll();
      expect(merged.find((s) => s.name === 'main_total')!.labels).toEqual({ thread: 'main' });
    } finally {
      r.relay.stop();
      await r.system.terminate();
    }
  });

  test('start() twice is start() once — one ask per worker, one source, one listener — and stop() leaves nothing behind', async () => {
    // `MetricsRelay` is a public export of `actor-ts/worker`, so the guard is
    // API, not an internal nicety: a second `start()` that registered a second
    // source and armed a second ticker would double every relayed row and
    // every request, and `stop()` — which unhooks one of each — would leave
    // the first ticker firing into the cluster after the mesh is gone.
    const r = rig();
    try {
      r.relay.start();
      r.relay.start();
      expect(requestsSent(r)).toEqual([WORKER_0.toString(), WORKER_1.toString()]);
      r.scheduler.advance(INTERVAL_MS);
      expect(requestsSent(r)).toHaveLength(4);
      expect(r.stub.listeners).toHaveLength(1);
      r.snapshot(snapshotOf({ value: 7 }), WORKER_0);
      const merged = r.system.extension(MetricsExtensionId).collectAll();
      expect(merged.filter((s) => s.name === 'relayed_total')).toHaveLength(1);

      r.relay.stop();
      expect(r.stub.listeners).toHaveLength(0);
      const before = r.stub.sent.length;
      r.scheduler.advance(INTERVAL_MS * 2);
      expect(r.stub.sent).toHaveLength(before);
    } finally {
      r.relay.stop();
      await r.system.terminate();
    }
  });

  test('nothing is asked while the main thread’s metrics are off — enabling them is what starts the pull', async () => {
    const r = rig(false);
    try {
      r.relay.start();
      r.scheduler.advance(INTERVAL_MS * 3);
      expect(requestsSent(r)).toEqual([]);
      r.system.extension(MetricsExtensionId).enable();
      r.scheduler.advance(INTERVAL_MS);
      expect(requestsSent(r)).toEqual([WORKER_0.toString(), WORKER_1.toString()]);
    } finally {
      r.relay.stop();
      await r.system.terminate();
    }
  });

  test('a write-through main registry is not asked for either — the scrape is a 503 anyway', async () => {
    const r = rig(false);
    try {
      r.system.extension(MetricsExtensionId).useRegistry(new WriteThroughRegistry());
      r.relay.start();
      r.scheduler.advance(INTERVAL_MS);
      expect(requestsSent(r)).toEqual([]);
    } finally {
      r.relay.stop();
      await r.system.terminate();
    }
  });

  test('stop() cancels the tick, unhooks the wire handler and leaves collectAll() equal to collect()', async () => {
    const r = rig();
    r.relay.start();
    // A main-thread series of its own, so the equality below is not over two
    // empty lists — a stamp left behind after stop() has something to land on.
    r.system.extension(MetricsExtensionId).get().counter('main_total').inc();
    r.snapshot(snapshotOf({ value: 7 }), WORKER_0);
    expect(r.relay.samples()).toHaveLength(1);
    r.relay.stop();
    const before = r.stub.sent.length;
    r.scheduler.advance(INTERVAL_MS * 2);
    expect(r.stub.sent).toHaveLength(before);
    expect(r.stub.handlers.size).toBe(0);
    expect(r.stub.listeners).toHaveLength(0);
    expect(r.relay.samples()).toEqual([]);
    const metrics = r.system.extension(MetricsExtensionId);
    expect(metrics.collectAll()).toEqual(metrics.get().collect());
    expect(metrics.collectAll().map((s) => s.name)).toEqual(['main_total']);
    expect(threadsIn(metrics.collectAll())).not.toContain('main');
    await r.system.terminate();
  });
});

describe('the main side of the metrics relay — accepting', () => {
  test('a snapshot from a live worker is stamped thread=worker-<slot>, in slot order whatever the arrival order', async () => {
    const r = rig();
    try {
      r.relay.start();
      r.snapshot(snapshotOf({ value: 11, labels: { class: 'B' } }), WORKER_1);
      r.snapshot(snapshotOf({ value: 10, labels: { class: 'A' } }), WORKER_0);
      const samples = r.relay.samples();
      expect(samples.map((s) => [s.labels.thread, s.labels.class, s.value])).toEqual([
        ['worker-0', 'A', 10],
        ['worker-1', 'B', 11],
      ]);
      // Stamped on a copy: the stored frame is untouched.
      const merged = r.system.extension(MetricsExtensionId).collectAll();
      expect(threadsIn(merged.filter((s) => s.name === 'relayed_total'))).toEqual(['worker-0', 'worker-1']);
      // One family, one TYPE line, three label sets when rendered.
      r.system.extension(MetricsExtensionId).get().counter('relayed_total', {}, { help: 'relayed' }).inc(5);
      const text = renderPrometheusSamples(r.system.extension(MetricsExtensionId).collectAll());
      expect(text.match(/# TYPE relayed_total counter/g)).toHaveLength(1);
      expect(text).toContain('relayed_total{thread="main"} 5');
      expect(text).toContain('relayed_total{class="A",thread="worker-0"} 10');
      expect(text).toContain('relayed_total{class="B",thread="worker-1"} 11');
    } finally {
      r.relay.stop();
      await r.system.terminate();
    }
  });

  test('stamping never mutates the stored sample or its labels', async () => {
    const r = rig();
    try {
      r.relay.start();
      const frame = snapshotOf({ labels: { class: 'A' } });
      const labels = frame.samples[0]!.labels;
      r.snapshot(frame, WORKER_0);
      r.relay.samples();
      r.system.extension(MetricsExtensionId).collectAll();
      expect(labels).toEqual({ class: 'A' });
      expect(frame.samples[0]!.labels).toBe(labels);
    } finally {
      r.relay.stop();
      await r.system.terminate();
    }
  });

  test('a later snapshot from the same worker replaces the earlier one', async () => {
    const r = rig();
    try {
      r.relay.start();
      r.snapshot(snapshotOf({ value: 1 }), WORKER_0);
      r.snapshot(snapshotOf({ value: 2 }), WORKER_0);
      expect(r.relay.samples().map((s) => s.value)).toEqual([2]);
    } finally {
      r.relay.stop();
      await r.system.terminate();
    }
  });

  test('a snapshot from an address that is not a live worker is dropped without a word', async () => {
    const r = rig();
    try {
      r.relay.start();
      r.snapshot(snapshotOf({ value: 1 }), STRANGER);
      r.snapshot(snapshotOf({ value: 1 }), MAIN);
      expect(r.relay.samples()).toEqual([]);
      expect(r.warnings()).toEqual([]);
    } finally {
      r.relay.stop();
      await r.system.terminate();
    }
  });

  test('a worker answering collectable: false contributes nothing and is reported once', async () => {
    const r = rig();
    try {
      r.relay.start();
      const frame: WorkerMeshMetricsMessage = { kind: 'worker-mesh-metrics', samples: [], collectable: false };
      r.snapshot(frame, WORKER_0);
      r.snapshot(frame, WORKER_0);
      expect(r.relay.samples()).toEqual([]);
      expect(r.warnings()).toHaveLength(1);
      expect(r.warnings()[0]).toContain('relay@worker:2');
      expect(r.warnings()[0]).toContain('not collectable');
      // Alive, though: it has an age series like any answering worker.
      expect(ageSeries(r).map((s) => s.labels)).toEqual([{ worker: 'worker-0' }]);
    } finally {
      r.relay.stop();
      await r.system.terminate();
    }
  });
});

describe('the main side of the metrics relay — refusing', () => {
  /** Each shape is dropped whole: nothing from that frame reaches the exposition, and one warning names it. */
  const REFUSED: ReadonlyArray<[label: string, frame: unknown, problem: string]> = [
    ['a non-object frame', null, 'is not an object'],
    ['a missing collectable flag', { kind: 'worker-mesh-metrics', samples: [] }, 'collectable flag'],
    ['samples that are not an array', { kind: 'worker-mesh-metrics', collectable: true, samples: {} }, 'not an array'],
    ['a sample that is not an object', snapshotOf() && { kind: 'worker-mesh-metrics', collectable: true, samples: [42] }, 'not an object'],
    ['a forged metric name', snapshotOf({ name: 'evil{x="1"} 1\nforged_total' }), 'metric-name grammar'],
    ['a metric name with a space', snapshotOf({ name: 'not valid' }), 'metric-name grammar'],
    ['a forged label key', snapshotOf({ labels: { 'k"} 1\nforged': 'v' } }), 'label-name grammar'],
    ['a label key outside ASCII', snapshotOf({ labels: { 'schlüssel': 'v' } }), 'label-name grammar'],
    ['a label key with a leading digit', snapshotOf({ labels: { '1st': 'v' } }), 'label-name grammar'],
    ['a numeric metric name', snapshotOf({ name: 42 as never }), 'metric-name grammar'],
    ['a metric name with a trailing newline', snapshotOf({ name: 'ok_total\n' }), 'metric-name grammar'],
    ['the reserved thread label', snapshotOf({ labels: { thread: 'worker-7' } }), 'reserved label "thread"'],
    ['a label value that is an object', snapshotOf({ labels: { class: { nested: true } as never } }), 'not a string, number or boolean'],
    ['a missing help string', snapshotOf({ help: undefined as never }), 'no help string'],
    ['an unknown kind', snapshotOf({ kind: 'summary' as never }), 'not counter, gauge or histogram'],
    ['labels that are an array', snapshotOf({ labels: [] as never }), 'no labels object'],
    ['a non-numeric value', snapshotOf({ value: '1' as never }), 'no numeric value'],
    ['a non-numeric bucket', snapshotOf({ kind: 'histogram', bucket: 'inf' as never }), 'bucket that is not a number'],
    ['a non-numeric count', snapshotOf({ kind: 'histogram', count: null as never }), 'count that is not a number'],
    ['a non-numeric sum', snapshotOf({ kind: 'histogram', sum: {} as never }), 'sum that is not a number'],
  ];

  test.each(REFUSED)('%s drops the snapshot whole and is reported once', async (_label, frame, problem) => {
    const r = rig();
    try {
      r.relay.start();
      // A good sample rides in the same frame where the frame has samples: it
      // must not be merged either — the good rows are the cover.
      const carried = frame !== null && typeof frame === 'object' && Array.isArray((frame as WorkerMeshMetricsMessage).samples)
        ? { ...(frame as WorkerMeshMetricsMessage), samples: [...(frame as WorkerMeshMetricsMessage).samples, ...snapshotOf({ name: 'good_total' }).samples] }
        : frame;
      r.snapshot(carried, WORKER_0);
      r.snapshot(carried, WORKER_0);
      expect(r.relay.samples()).toEqual([]);
      expect(ageSeries(r)).toEqual([]);
      expect(r.warnings()).toHaveLength(1);
      expect(r.warnings()[0]).toContain(problem);
      expect(r.warnings()[0]).toContain('relay@worker:2');
      // And the report quotes the offending string through JSON, so a newline
      // in a forged name cannot forge a log line.
      expect(r.warnings()[0]!.includes('\n')).toBe(false);
    } finally {
      r.relay.stop();
      await r.system.terminate();
    }
  });

  test('the sample count is bounded, and a snapshot at the bound is accepted', async () => {
    const r = rig();
    try {
      r.relay.start();
      const sample: MetricSample = { name: 'bulk_total', help: '', kind: 'counter', labels: {}, value: 1 };
      const atBound: WorkerMeshMetricsMessage = {
        kind: 'worker-mesh-metrics', collectable: true, samples: Array(MAX_RELAYED_SAMPLES_PER_SNAPSHOT).fill(sample),
      };
      r.snapshot(atBound, WORKER_0);
      expect(r.relay.samples()).toHaveLength(MAX_RELAYED_SAMPLES_PER_SNAPSHOT);
      const overBound: WorkerMeshMetricsMessage = { ...atBound, samples: [...atBound.samples, sample] };
      r.snapshot(overBound, WORKER_1);
      expect(r.relay.samples()).toHaveLength(MAX_RELAYED_SAMPLES_PER_SNAPSHOT);
      expect(r.warnings()).toHaveLength(1);
      expect(r.warnings()[0]).toContain(`more than the ${MAX_RELAYED_SAMPLES_PER_SNAPSHOT} allowed`);
    } finally {
      r.relay.stop();
      await r.system.terminate();
    }
  });

  test('a __proto__ label key is inside the grammar and pollutes nothing when stamped', async () => {
    // Prometheus strips `__`-prefixed label names at ingestion, so the key is
    // harmless downstream; what matters here is that copying a label object
    // carrying it as an *own* property (which is what structured clone
    // delivers) defines a property named `__proto__` rather than setting the
    // prototype of the stamped copy or of anything else.
    const r = rig();
    try {
      r.relay.start();
      // An object under `__proto__` is refused on the value rule before any copy is made.
      const objectValued = JSON.parse('{"__proto__": {"polluted": true}, "class": "A"}') as Record<string, unknown>;
      r.snapshot(snapshotOf({ labels: objectValued as never }), WORKER_0);
      expect(r.relay.samples()).toEqual([]);
      expect(r.warnings()).toHaveLength(1);
      expect(r.warnings()[0]).toContain('"__proto__"');
      // A string under it is inside the grammar; the stamped copy carries it as
      // an own property and its prototype is untouched.
      const stringValued = JSON.parse('{"__proto__": "x", "class": "A"}') as Record<string, unknown>;
      r.snapshot(snapshotOf({ labels: stringValued as never }), WORKER_0);
      const [stamped] = r.relay.samples();
      expect(stamped).toBeDefined();
      expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
      expect(Object.getPrototypeOf(stamped!.labels)).toBe(Object.prototype);
      expect(Object.keys(stamped!.labels).sort()).toEqual(['__proto__', 'class', 'thread']);
      expect(Object.getOwnPropertyDescriptor(stamped!.labels, '__proto__')?.value).toBe('x');
    } finally {
      r.relay.stop();
      await r.system.terminate();
    }
  });

  test('the histogram shape the registry really produces is accepted, +Inf bucket and NaN included', () => {
    const registry = new DefaultMetricsRegistry();
    registry.histogram('latency_seconds', { route: '/a' }).observe(0.2);
    registry.gauge('ratio').set(0);
    const samples = [...registry.collect(), { name: 'nan_gauge', help: '', kind: 'gauge' as const, labels: {}, value: Number.NaN }];
    expect(samples.some((s) => s.bucket === Number.POSITIVE_INFINITY)).toBe(true);
    expect(describeMetricsSnapshotProblem({ kind: 'worker-mesh-metrics', collectable: true, samples })).toBeNull();
  });

  test('reports are once per problem text per worker, and capped per worker', async () => {
    const r = rig();
    try {
      r.relay.start();
      for (let i = 0; i < MAX_REPORTED_SNAPSHOT_PROBLEMS_PER_WORKER + 5; i++) {
        r.snapshot(snapshotOf({ name: `bad name ${i}` }), WORKER_0);
      }
      expect(r.warnings()).toHaveLength(MAX_REPORTED_SNAPSHOT_PROBLEMS_PER_WORKER);
      // A second worker has its own budget.
      r.snapshot(snapshotOf({ name: 'bad name 0' }), WORKER_1);
      expect(r.warnings()).toHaveLength(MAX_REPORTED_SNAPSHOT_PROBLEMS_PER_WORKER + 1);
      expect(r.warnings().at(-1)).toContain('relay@worker:3');
    } finally {
      r.relay.stop();
      await r.system.terminate();
    }
  });

  test('a quoted name is clipped, so an enormous forged name is not echoed in full', async () => {
    const r = rig();
    try {
      r.relay.start();
      r.snapshot(snapshotOf({ name: `x${'y'.repeat(10_000)} ` }), WORKER_0);
      expect(r.warnings()).toHaveLength(1);
      expect(r.warnings()[0]!.length).toBeLessThan(400);
    } finally {
      r.relay.stop();
      await r.system.terminate();
    }
  });
});

describe('the main side of the metrics relay — departure and silence', () => {
  test('a slot no longer among the live workers is retired on the next tick, age series included', async () => {
    const r = rig();
    try {
      r.relay.start();
      r.snapshot(snapshotOf({ value: 1 }), WORKER_0);
      r.snapshot(snapshotOf({ value: 2 }), WORKER_1);
      r.relay.samples();
      expect(ageSeries(r).map((s) => s.labels.worker)).toEqual(['worker-0', 'worker-1']);

      r.workers = [{ id: 1, address: WORKER_1 }];
      r.scheduler.advance(INTERVAL_MS);

      expect(threadsIn(r.relay.samples())).toEqual(['worker-1']);
      expect(ageSeries(r).map((s) => s.labels.worker)).toEqual(['worker-1']);
      // The departed slot is not asked either.
      const lastRound = requestsSent(r).slice(-1);
      expect(lastRound).toEqual([WORKER_1.toString()]);
    } finally {
      r.relay.stop();
      await r.system.terminate();
    }
  });

  test('a member the cluster takes down is retired at once, even while its handle is still in the set (#1284)', async () => {
    const r = rig();
    try {
      r.relay.start();
      r.snapshot(snapshotOf({ value: 1 }), WORKER_0);
      r.snapshot(snapshotOf({ value: 2 }), WORKER_1);
      r.relay.samples();

      const downed = new Member(WORKER_0, 'down', 2, []);
      for (const listener of r.stub.listeners) listener(new MemberDown(downed));

      expect(threadsIn(r.relay.samples())).toEqual(['worker-1']);
      expect(ageSeries(r).map((s) => s.labels.worker)).toEqual(['worker-1']);
      // An event about a member that is not a worker changes nothing.
      for (const listener of r.stub.listeners) listener(new MemberRemoved(new Member(STRANGER, 'removed', 1, [])));
      for (const listener of r.stub.listeners) listener(new MemberUp(memberUp(WORKER_1)));
      expect(threadsIn(r.relay.samples())).toEqual(['worker-1']);
    } finally {
      r.relay.stop();
      await r.system.terminate();
    }
  });

  test('a member that reads down on a tick is retired even when no event was delivered', async () => {
    const r = rig();
    try {
      r.relay.start();
      r.snapshot(snapshotOf({ value: 1 }), WORKER_0);
      r.stub.members = [memberUp(MAIN), new Member(WORKER_0, 'down', 2, []), memberUp(WORKER_1)];
      r.scheduler.advance(INTERVAL_MS);
      expect(r.relay.samples()).toEqual([]);
    } finally {
      r.relay.stop();
      await r.system.terminate();
    }
  });

  test('a member that reads down is not asked either, while its handle is still among the live workers (#1284)', async () => {
    // Under `restartPolicy 'never'` a dead worker keeps its handle, so its
    // address stays in `workers()` for the life of the mesh while the failure
    // detector holds its member `down`.  Retiring the snapshot is half of the
    // departure; the other half is not sending a request into a port nobody
    // reads, every interval, until the mesh terminates.
    const r = rig();
    try {
      r.relay.start();
      r.snapshot(snapshotOf({ value: 1 }), WORKER_0);
      r.stub.members = [memberUp(MAIN), new Member(WORKER_0, 'down', 2, []), memberUp(WORKER_1)];
      r.scheduler.advance(INTERVAL_MS);
      expect(r.relay.samples()).toEqual([]);
      expect(requestsSent(r).slice(2)).toEqual([WORKER_1.toString()]);
      // The set is re-read on every tick: a slot whose address comes back `up`
      // — a respawn re-joining under the same address — is asked again.
      r.stub.members = [memberUp(MAIN), memberUp(WORKER_0), memberUp(WORKER_1)];
      r.scheduler.advance(INTERVAL_MS);
      expect(requestsSent(r).slice(3)).toEqual([WORKER_0.toString(), WORKER_1.toString()]);
    } finally {
      r.relay.stop();
      await r.system.terminate();
    }
  });

  test('a live worker that stops answering keeps its last snapshot, and its age gauge climbs on the main registry', async () => {
    const r = rig();
    try {
      r.relay.start();
      r.snapshot(snapshotOf({ value: 42 }), WORKER_0);
      r.snapshot(snapshotOf({ value: 43 }), WORKER_1);
      const ageOf = (worker: string): number => {
        r.relay.samples();
        return ageSeries(r).find((s) => s.labels.worker === worker)!.value;
      };
      expect(ageOf('worker-0')).toBe(0);

      // Three ticks of silence from worker-0; worker-1 keeps answering.
      for (let i = 0; i < 3; i++) {
        r.scheduler.advance(INTERVAL_MS);
        r.snapshot(snapshotOf({ value: 43 + i }), WORKER_1);
      }
      expect(r.relay.samples().map((s) => s.value)).toEqual([42, 45]);
      expect(ageOf('worker-0')).toBe(3);
      expect(ageOf('worker-1')).toBe(0);
      // The age is read at export, not at the tick: half an interval later it says so.
      r.scheduler.advance(INTERVAL_MS / 2);
      expect(ageOf('worker-0')).toBe(3.5);
      // And the exposition carries it as the main thread's own series.
      const rendered = renderPrometheusSamples(r.system.extension(MetricsExtensionId).collectAll());
      expect(rendered).toContain('worker_mesh_snapshot_age_seconds{thread="main",worker="worker-0"} 3.5');
    } finally {
      r.relay.stop();
      await r.system.terminate();
    }
  });
});
