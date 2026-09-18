import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { CoordinatedShutdownId } from '../../../src/CoordinatedShutdown.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { LogLevel, NoopLogger, type Logger } from '../../../src/Logger.js';
import type { MetricSample } from '../../../src/metrics/Metrics.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { WorkerMesh } from '../../../src/worker/WorkerMesh.js';
import type { ModuleImporter, WorkerMeshSetupContext } from '../../../src/worker/WorkerMeshBootstrap.js';
import { WorkerMeshOptions } from '../../../src/worker/WorkerMeshOptions.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';
import { FakeWorkerBackend, hostMeshNode } from './__fixtures__/InMemoryWorkerThread.js';

/**
 * `WorkerMesh` (#1562) on the in-process rig: every "worker" is a
 * `FakeWorker` hosting a real cluster node through `hostMeshNode`, so the
 * production bootstrap, cluster, transport and refs all run — on this thread,
 * with no OS thread anywhere.  What is *not* under test here is the thread
 * itself; `tests/multi-node/WorkerMesh.test.ts` spawns real ones.
 */

const MODULE_URL = 'file:///mesh/actors.js';

type EchoCommand = { readonly kind: 'echo'; readonly text: string; readonly replyTo: ActorRef<string> };

class Echo extends Actor<EchoCommand> {
  override onReceive(command: EchoCommand): void {
    command.replyTo.tell(`${this.context.self.path.toString()} says ${command.text}`);
  }
}

class Idle extends Actor<never> {
  override onReceive(): void { /* nothing */ }
}

/** What every worker's `setup` observed — readable because the workers are in-process. */
type Observed = { readonly self: string; readonly gossipIntervalMs: number; readonly roles: string[] };

/**
 * A module the importer hands back instead of loading a file: two actor
 * classes, a value that is not one, and a `setup` that spawns an `Echo` and
 * records what it saw.
 */
function actorsModule(observed: Observed[]): Record<string, unknown> {
  return {
    Echo,
    Idle,
    NOT_AN_ACTOR: 42,
    setup(context: WorkerMeshSetupContext): void {
      context.system.spawn(Echo, 'echo');
      observed.push({
        self: context.selfAddress.toString(),
        gossipIntervalMs: context.system.config.getDuration('actor-ts.cluster.gossip-interval'),
        roles: [...context.cluster.selfRoles].sort(),
      });
    },
  };
}

type Rig = {
  readonly system: ActorSystem;
  readonly backend: FakeWorkerBackend;
  readonly observed: Observed[];
  readonly importer: ModuleImporter;
  /** The systems the fake workers host, as they come up — readable because the workers are in-process. */
  readonly hosted: Array<Promise<{ readonly system: ActorSystem; readonly cluster: Cluster }>>;
};

function rig(
  modules: Record<string, Record<string, unknown>> = {},
  systemName = 'mesh',
  logger: Logger = new NoopLogger(),
): Rig {
  const observed: Observed[] = [];
  const catalogue: Record<string, Record<string, unknown>> = { [MODULE_URL]: actorsModule(observed), ...modules };
  const importer: ModuleImporter = async (href) => {
    const module = catalogue[href];
    if (module === undefined) throw new Error(`no such module in this test: ${href}`);
    return module;
  };
  const hosted: Rig['hosted'] = [];
  const backend = new FakeWorkerBackend({ onSpawn: (worker) => { hosted.push(hostMeshNode(worker, importer).node); } });
  // An explicit logger wins outright in `resolveLogger`, so the `Off` level
  // below gates nothing when a test hands in a recording one.
  const systemOptions = ActorSystemOptions.create()
    .withLogger(logger)
    .withLogLevel(LogLevel.Off)
    // Builder-set, never in a file — so a worker that ran with anything but
    // the effective config would read the reference default instead.
    .withConfig({ 'actor-ts': { cluster: { 'gossip-interval': '25ms' } } });
  const system = ActorSystem.create(systemName, systemOptions);
  return { system, backend, observed, importer, hosted };
}

function meshOptions(r: Rig, workers = 2): WorkerMeshOptions {
  return WorkerMeshOptions.create()
    .withModule(MODULE_URL)
    .withWorkers(workers)
    .withBackend(r.backend)
    .withReadyTimeoutMs(8_000);
}

describe('WorkerMesh — the main thread joins its own workers (#1562)', () => {
  test('main and every worker are up, and the mesh reports each worker’s actor classes', async () => {
    const r = rig();
    const mesh = await WorkerMesh.start(r.system, meshOptions(r, 2));
    try {
      expect(mesh.selfAddress.toString()).toBe('mesh@main:1');
      expect(mesh.addresses.map((a) => a.toString())).toEqual(['mesh@worker:2', 'mesh@worker:3']);
      expect(mesh.cluster.upMembers().map((m) => m.address.toString()).sort())
        .toEqual(['mesh@main:1', 'mesh@worker:2', 'mesh@worker:3']);
      expect(mesh.workers.map((w) => [...w.actors].sort())).toEqual([['Echo', 'Idle'], ['Echo', 'Idle']]);
      expect(r.system.cluster.isSome()).toBe(true);
    } finally {
      await mesh.terminate();
      await r.system.terminate();
    }
  }, 20_000);

  test('the main thread leads with the default hostnames, and a worker leads when its hostname sorts first', async () => {
    const r = rig();
    const mesh = await WorkerMesh.start(r.system, meshOptions(r, 1));
    try {
      expect(mesh.cluster.isLeader()).toBe(true);
    } finally {
      await mesh.terminate();
      await r.system.terminate();
    }
    const other = rig({}, 'mesh-led');
    const options = WorkerMeshOptions.create()
      .withModule(MODULE_URL)
      .withWorkers(1)
      .withWorkerHostname('core')
      .withBackend(other.backend)
      .withReadyTimeoutMs(8_000);
    const led = await WorkerMesh.start(other.system, options);
    try {
      expect(led.cluster.isLeader()).toBe(false);
      expect(led.cluster.leader().map((m) => m.address.toString()).getOrElse('none')).toBe('mesh-led@core:2');
    } finally {
      await led.terminate();
      await other.system.terminate();
    }
  }, 20_000);

  test('refFor hands out a ref that asks through to an actor on a worker, bare or full path', async () => {
    const r = rig();
    const mesh = await WorkerMesh.start(r.system, meshOptions(r, 2));
    try {
      const [first, second] = mesh.addresses;
      const bare = mesh.refFor<EchoCommand>(first!, '/user/echo');
      const full = mesh.refFor<EchoCommand>(second!, 'actor-ts://mesh/user/echo');
      expect(await bare.ask<string>({ kind: 'echo', text: 'hi' }, 5_000)).toBe('actor-ts://mesh/user/echo says hi');
      expect(await full.ask<string>({ kind: 'echo', text: 'yo' }, 5_000)).toBe('actor-ts://mesh/user/echo says yo');
      expect(bare.path.toString()).toBe('actor-ts://mesh/user/echo');
    } finally {
      await mesh.terminate();
      await r.system.terminate();
    }
  }, 20_000);

  test('workers run on the main system’s effective config and the roles the options gave them', async () => {
    const r = rig();
    const options = WorkerMeshOptions.create()
      .withModule(MODULE_URL)
      .withWorkers(2)
      .withWorkerRoles(['compute', 'ingest'])
      .withMainRoles(['frontend'])
      .withBackend(r.backend)
      .withReadyTimeoutMs(8_000);
    const mesh = await WorkerMesh.start(r.system, options);
    try {
      expect(r.observed.map((o) => o.self).sort()).toEqual(['mesh@worker:2', 'mesh@worker:3']);
      for (const o of r.observed) {
        expect(o.gossipIntervalMs).toBe(25);
        expect(o.roles).toEqual(['compute', 'ingest']);
      }
      expect([...mesh.cluster.selfRoles]).toEqual(['frontend']);
      expect(mesh.cluster.upMembersWithRole('compute').map((m) => m.address.toString()).sort())
        .toEqual(['mesh@worker:2', 'mesh@worker:3']);
    } finally {
      await mesh.terminate();
      await r.system.terminate();
    }
  }, 20_000);

  test('a setup module is optional, and a non-actor export is not reported', async () => {
    const r = rig({ 'file:///mesh/plain.js': { Idle } });
    const options = WorkerMeshOptions.create()
      .withModule(['file:///mesh/plain.js'])
      .withWorkers(1)
      .withBackend(r.backend)
      .withReadyTimeoutMs(8_000);
    const mesh = await WorkerMesh.start(r.system, options);
    try {
      expect(mesh.workers[0]!.actors).toEqual(['Idle']);
    } finally {
      await mesh.terminate();
      await r.system.terminate();
    }
  }, 20_000);

  test('two modules exporting the same actor name fail the bootstrap, and spawn names the worker', async () => {
    const r = rig({ 'file:///mesh/other.js': { Echo: class extends Actor<never> { override onReceive(): void {} } } });
    const options = WorkerMeshOptions.create()
      .withModule([MODULE_URL, 'file:///mesh/other.js'])
      .withWorkers(1)
      .withBackend(r.backend)
      // The bootstrap throws; the fake surfaces that as a handshake that never
      // completes, so this is what bounds the test.
      .withReadyTimeoutMs(300);
    let failure: Error | null = null;
    try {
      await WorkerMesh.start(r.system, options);
    } catch (error) {
      failure = error as Error;
    } finally {
      await r.system.terminate();
    }
    expect(failure).not.toBeNull();
    expect(failure!.message).toContain('mesh@worker:2');
  }, 20_000);

  test('terminate() takes the workers down before the main thread leaves', async () => {
    const r = rig();
    const mesh = await WorkerMesh.start(r.system, meshOptions(r, 2));
    await mesh.terminate();
    expect(r.backend.spawned.every((w) => w.terminated)).toBe(true);
    expect(mesh.size).toBe(0);
    await r.system.terminate();
  }, 20_000);

  test('coordinated shutdown takes the mesh down with the system', async () => {
    const r = rig();
    await WorkerMesh.start(r.system, meshOptions(r, 2));
    // A plain `terminate()` runs no phases — the cluster's own leave is a
    // phase task too — so the thing to drive is the shutdown itself, which is
    // what a SIGTERM or `runUntilTerminated()` does.
    await r.system.extension(CoordinatedShutdownId).run();
    await awaitCondition(() => r.backend.spawned.every((w) => w.terminated), {
      timeoutMs: 5_000,
      label: 'every worker terminated with the system',
    });
  }, 20_000);

  /**
   * Binds the two places `WorkerMesh.start` threads `system.log` through: the
   * worker cluster (`withLogger`) and the broker it builds first (#1276).  A
   * crash on the in-process rig produces the exit and respawn lines from the
   * first, and — because the main thread keeps gossiping to an address it still
   * believes `up` — an `unknown-destination` line from the second, at `debug`.
   * With a fresh `new WorkerBroker()` in the mesh that last line would go to a
   * `ConsoleLogger` at `Info`, i.e. nowhere a test can see.
   *
   * The replacement is deliberately not the subject: its join is
   * `40-worker-respawn-from-error.mjs`'s to prove on real threads, so the
   * backoff here is long enough that no replacement spawns before `terminate()`
   * cancels the timer.
   */
  test('the mesh reports through system.log — a worker exit, its granted respawn, and the broker drops that follow', async () => {
    const logger = new RecordingLogger();
    const r = rig({}, 'mesh', logger);
    const options = WorkerMeshOptions.create()
      .withModule(MODULE_URL)
      .withWorkers(1)
      .withRestartMinBackoffMs(5_000)
      .withRestartRandomFactor(0)
      .withBackend(r.backend)
      .withReadyTimeoutMs(8_000);
    const mesh = await WorkerMesh.start(r.system, options);
    const crashed = r.backend.spawned[0]!;
    try {
      const workerLines = (): string[] => logger.records
        .filter((record) => record.message.startsWith('[worker]'))
        .map((record) => `${record.level}: ${record.message}`);
      expect(workerLines()).toEqual([]);
      expect(mesh.broker.dropped()).toEqual({ malformed: 0, 'unknown-destination': 0, unroutable: 0 });

      crashed.simulateCrash(1);

      expect(workerLines()).toEqual([
        'warn: [worker] worker 0 (mesh@worker:2) exited with code 1',
        'warn: [worker] respawning worker 0 (mesh@worker:2) in 5000 ms (restart 1 of 10 inside 60000 ms)',
      ]);
      expect(mesh.size).toBe(0);

      await awaitCondition(
        () => logger.records.some((record) => record.level === 'debug'
          && /^\[worker\] broker dropped \d+ frame\(s\) from mesh@main:1 — no worker is registered/.test(record.message)),
        { label: 'the main thread\'s gossip to the dead worker was reported as a broker drop', timeoutMs: 5_000 },
      );
      expect(mesh.broker.dropped()['unknown-destination']).toBeGreaterThan(0);
      expect(mesh.broker.dropped().malformed).toBe(0);
      expect(mesh.broker.dropped().unroutable).toBe(0);
    } finally {
      await mesh.terminate();
      // The crashed slot's worker is spliced out of the pool and never
      // terminated by it; on this rig that worker still hosts a live node.
      await crashed.terminate();
      await r.system.terminate();
    }
  }, 20_000);
});

/**
 * The metrics relay (#1570) over the in-process mesh: real bootstrap, real
 * cluster, real frames — the worker registries are the hosted systems' own,
 * readable here because nothing runs on another thread.  The frame-level
 * contract (validation, stamping, retirement) is `MetricsRelay.test.ts`'s;
 * this is the two halves meeting.
 */
describe('WorkerMesh — worker metrics on the main thread (#1570)', () => {
  const RELAY_INTERVAL_MS = 50;

  const delivered = (samples: ReadonlyArray<MetricSample>, thread: string): number | undefined =>
    samples.find((s) => s.name === 'actor_messages_delivered_total' && s.labels.thread === thread)?.value;

  const threadsOf = (samples: ReadonlyArray<MetricSample>): Set<string> =>
    new Set(samples.map((s) => String(s.labels.thread ?? '')));

  async function askEachWorker(mesh: WorkerMesh, times: number): Promise<void> {
    for (const address of mesh.addresses) {
      const echo = mesh.refFor<EchoCommand>(address, '/user/echo');
      for (let i = 0; i < times; i++) await echo.ask<string>({ kind: 'echo', text: `m${i}` }, 5_000);
    }
  }

  test('metrics enabled before the mesh starts: every worker’s registry is switched on and its series reach collectAll(), stamped', async () => {
    const r = rig();
    const metrics = r.system.extension(MetricsExtensionId);
    metrics.enable();
    const options = WorkerMeshOptions.create()
      .withModule(MODULE_URL)
      .withWorkers(2)
      .withMetricsRelayIntervalMs(RELAY_INTERVAL_MS)
      .withBackend(r.backend)
      .withReadyTimeoutMs(8_000);
    const mesh = await WorkerMesh.start(r.system, options);
    try {
      await askEachWorker(mesh, 5);
      // The first request went out inside `start()`, ahead of anything the
      // caller sent — on the one ordered channel to each worker, the request
      // frame precedes the first user envelope, so the registry is live before
      // the first message to a worker actor is counted.
      for (const worker of r.backend.spawned) {
        const payloadKinds = worker.posted
          .map((frame) => (frame as { envelope?: { payload?: { kind?: string } } }).envelope?.payload?.kind)
          .filter((kind): kind is string => typeof kind === 'string');
        expect(payloadKinds.indexOf('worker-mesh-metrics-request')).toBeGreaterThanOrEqual(0);
        expect(payloadKinds.indexOf('worker-mesh-metrics-request')).toBeLessThan(payloadKinds.indexOf('envelope'));
      }
      for (const node of r.hosted) expect((await node).system.extension(MetricsExtensionId).isEnabled()).toBe(true);
      await awaitCondition(
        () => (delivered(metrics.collectAll(), 'worker-0') ?? 0) >= 5 && (delivered(metrics.collectAll(), 'worker-1') ?? 0) >= 5,
        { timeoutMs: 5_000, label: 'both workers’ delivered counters reached the main thread' },
      );
      const merged = metrics.collectAll();
      expect(threadsOf(merged)).toEqual(new Set(['main', 'worker-0', 'worker-1']));
      // Every sample carries the label — including the main thread's own.
      expect(merged.every((s) => typeof s.labels.thread === 'string')).toBe(true);
      // The age series exists per worker, on the main registry, and reads fresh.
      const ages = merged.filter((s) => s.name === 'worker_mesh_snapshot_age_seconds');
      expect(ages.map((s) => s.labels)).toEqual([
        { thread: 'main', worker: 'worker-0' },
        { thread: 'main', worker: 'worker-1' },
      ]);
      for (const age of ages) expect(age.value).toBeLessThan(2);
      // What the relay merged is what the workers hold, sample for sample —
      // once a snapshot has caught up.  `merged` is the tick that carried the
      // fifth delivery, and the worker's registry keeps minting after it (a
      // `cluster_members_up` on a late gossip merge, a histogram on a first
      // observation); a family minted between that tick and a read of the
      // registry here is in the registry and in no snapshot yet.  So the
      // comparison waits for a snapshot taken after the worker's set stopped
      // growing, rather than holding a past snapshot against a live registry
      // — which is what went red twice in 22 whole-file runs under load.
      const hosted = await Promise.all(r.hosted);
      const workerZero = hosted.find((node) => node.cluster.selfAddress.port === 2)!;
      const ownRegistry = workerZero.system.extension(MetricsExtensionId).get();
      const familiesOf = (samples: ReadonlyArray<MetricSample>): string => samples.map((s) => s.name).sort().join('\n');
      const relayedFamilies = (): string => familiesOf(metrics.collectAll().filter((s) => s.labels.thread === 'worker-0'));
      await awaitCondition(
        () => relayedFamilies() === familiesOf(ownRegistry.collect()),
        { timeoutMs: 5_000, label: 'a relayed snapshot caught up with worker-0’s own families' },
      );
      // Not vacuous: the set the two agree on is the worker's stock families.
      expect(relayedFamilies()).toContain('actor_messages_delivered_total');
    } finally {
      await mesh.terminate();
      // Stopped with the mesh: the exposition is the main thread's alone again.
      const after = metrics.collectAll();
      expect(after).toEqual(metrics.get().collect());
      expect(threadsOf(after)).toEqual(new Set(['']));
      expect(after.some((s) => s.name === 'worker_mesh_snapshot_age_seconds')).toBe(false);
      await r.system.terminate();
    }
  }, 20_000);

  test('metrics enabled after the mesh is up: the next request is the enable signal, no restart needed', async () => {
    const r = rig();
    const metrics = r.system.extension(MetricsExtensionId);
    const options = WorkerMeshOptions.create()
      .withModule(MODULE_URL)
      .withWorkers(1)
      .withMetricsRelayIntervalMs(RELAY_INTERVAL_MS)
      .withBackend(r.backend)
      .withReadyTimeoutMs(8_000);
    const mesh = await WorkerMesh.start(r.system, options);
    try {
      await askEachWorker(mesh, 2);
      const worker = (await r.hosted[0]!).system.extension(MetricsExtensionId);
      // Nothing asked yet — the main thread's metrics are off — so the
      // worker's registry is still the noop and the exposition is untouched.
      expect(worker.isEnabled()).toBe(false);
      expect(metrics.collectAll()).toEqual([]);

      metrics.enable();
      await awaitCondition(() => worker.isEnabled(), { timeoutMs: 5_000, label: 'the worker’s registry was switched on by a request' });
      await askEachWorker(mesh, 3);
      await awaitCondition(
        () => (delivered(metrics.collectAll(), 'worker-0') ?? 0) >= 3,
        { timeoutMs: 5_000, label: 'the worker’s deliveries after enable reached the main thread' },
      );
    } finally {
      await mesh.terminate();
      await r.system.terminate();
    }
  }, 20_000);

  test('interval 0 switches the relay off: no request, no worker registry, no thread label — today’s bytes', async () => {
    const r = rig();
    const metrics = r.system.extension(MetricsExtensionId);
    metrics.enable();
    const options = WorkerMeshOptions.create()
      .withModule(MODULE_URL)
      .withWorkers(1)
      .withMetricsRelayIntervalMs(0)
      .withBackend(r.backend)
      .withReadyTimeoutMs(8_000);
    const mesh = await WorkerMesh.start(r.system, options);
    try {
      // Round trips prove frames flow; a request would have arrived before them.
      await askEachWorker(mesh, 3);
      expect((await r.hosted[0]!).system.extension(MetricsExtensionId).isEnabled()).toBe(false);
      const merged = metrics.collectAll();
      expect(merged).toEqual(metrics.get().collect());
      expect(merged.length).toBeGreaterThan(0);
      expect(threadsOf(merged)).toEqual(new Set(['']));
    } finally {
      await mesh.terminate();
      await r.system.terminate();
    }
  }, 20_000);

  test('a crashed worker’s series and age gauge leave the exposition on the next tick', async () => {
    const r = rig();
    const metrics = r.system.extension(MetricsExtensionId);
    metrics.enable();
    const options = WorkerMeshOptions.create()
      .withModule(MODULE_URL)
      .withWorkers(2)
      .withMetricsRelayIntervalMs(RELAY_INTERVAL_MS)
      // Long enough that no replacement comes up before `terminate()` cancels
      // the timer — the respawn is `40-worker-respawn-from-error.mjs`'s to prove.
      .withRestartMinBackoffMs(5_000)
      .withRestartRandomFactor(0)
      .withBackend(r.backend)
      .withReadyTimeoutMs(8_000);
    const mesh = await WorkerMesh.start(r.system, options);
    const crashed = r.backend.spawned[0]!;
    try {
      await askEachWorker(mesh, 1);
      await awaitCondition(
        () => threadsOf(metrics.collectAll()).has('worker-0') && threadsOf(metrics.collectAll()).has('worker-1'),
        { timeoutMs: 5_000, label: 'both workers were relayed' },
      );

      crashed.simulateCrash(1);
      expect(mesh.size).toBe(1);

      await awaitCondition(
        () => !threadsOf(metrics.collectAll()).has('worker-0'),
        { timeoutMs: 5_000, label: 'the crashed slot’s series were retired' },
      );
      const merged = metrics.collectAll();
      expect(threadsOf(merged)).toEqual(new Set(['main', 'worker-1']));
      expect(merged.filter((s) => s.name === 'worker_mesh_snapshot_age_seconds').map((s) => s.labels.worker)).toEqual(['worker-1']);
    } finally {
      await mesh.terminate();
      // The crashed slot's worker is spliced out of the pool and never
      // terminated by it; on this rig that worker still hosts a live node.
      await crashed.terminate();
      await r.system.terminate();
    }
  }, 20_000);

  test('a live worker that stops answering keeps its last series, and its age gauge climbs', async () => {
    const r = rig();
    const metrics = r.system.extension(MetricsExtensionId);
    metrics.enable();
    const options = WorkerMeshOptions.create()
      .withModule(MODULE_URL)
      .withWorkers(1)
      .withMetricsRelayIntervalMs(RELAY_INTERVAL_MS)
      .withBackend(r.backend)
      .withReadyTimeoutMs(8_000);
    const mesh = await WorkerMesh.start(r.system, options);
    try {
      await askEachWorker(mesh, 2);
      await awaitCondition(
        () => (delivered(metrics.collectAll(), 'worker-0') ?? 0) >= 2,
        { timeoutMs: 5_000, label: 'the worker was relayed' },
      );
      // Silence the worker the way a wedged one is silent: `_onWire` is one
      // handler per kind and the last registration wins, so a swallowing
      // handler on the hosted node's cluster eats every further request.
      const hosted = await r.hosted[0]!;
      hosted.cluster._onWire('worker-mesh-metrics-request', () => {});
      const ageOf = (): number =>
        metrics.collectAll().find((s) => s.name === 'worker_mesh_snapshot_age_seconds')?.value ?? -1;
      await awaitCondition(() => ageOf() >= 0.2, { timeoutMs: 5_000, label: 'the snapshot age climbed past 200 ms' });
      // Still there, flat, rather than gone — the #744 failure mode is a series that vanishes.
      expect(delivered(metrics.collectAll(), 'worker-0')).toBeGreaterThanOrEqual(2);
    } finally {
      await mesh.terminate();
      await r.system.terminate();
    }
  }, 20_000);
});

describe('WorkerMesh — refusals', () => {
  test('a system that already joined a cluster is refused before anything is spawned', async () => {
    const r = rig();
    const address = new NodeAddress('mesh', 'h', 4_711);
    const clusterOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(4_711)
      .withTransport(new InMemoryTransport(address));
    const cluster = await Cluster.join(r.system, clusterOptions);
    try {
      await expect(WorkerMesh.start(r.system, meshOptions(r, 1))).rejects.toBeInstanceOf(OptionsError);
      expect(r.backend.spawned).toHaveLength(0);
    } finally {
      await cluster.leave();
      await r.system.terminate();
    }
  });

  test('the validator refuses a missing module, equal hostnames and a remote module scheme', async () => {
    const r = rig();
    try {
      await expect(WorkerMesh.start(r.system, WorkerMeshOptions.create().withBackend(r.backend)))
        .rejects.toThrow(/module.*required/);
      await expect(WorkerMesh.start(r.system, WorkerMeshOptions.create()
        .withModule(MODULE_URL).withMainHostname('same').withWorkerHostname('same').withBackend(r.backend)))
        .rejects.toThrow(/workerHostname.*must differ/);
      await expect(WorkerMesh.start(r.system, WorkerMeshOptions.create()
        .withModule('https://example.test/actors.js').withBackend(r.backend)))
        .rejects.toThrow(/module.*file:/);
      await expect(WorkerMesh.start(r.system, WorkerMeshOptions.create()
        .withModule('./actors.js').withBackend(r.backend)))
        .rejects.toThrow(/module.*absolute URL/);
      expect(r.backend.spawned).toHaveLength(0);
    } finally {
      await r.system.terminate();
    }
  });
});
