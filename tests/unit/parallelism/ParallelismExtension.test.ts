import { describe, expect, test } from 'bun:test';
import { ActorOptions } from '../../../src/ActorOptions.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LocalActorRef } from '../../../src/internal/LocalActorRef.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { ParallelismExtensionId } from '../../../src/parallelism/ParallelismExtension.js';
import { ParallelismOptions, type ParallelismOptionsBuilder } from '../../../src/parallelism/ParallelismOptions.js';
import { PendingRemoteActorRef } from '../../../src/parallelism/PendingRemoteActorRef.js';
import { stoppingStrategy } from '../../../src/Supervision.js';
import { DeadLetter } from '../../../src/SystemMessages.js';
import { TestProbe } from '../../../src/testkit/TestProbe.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import type { ModuleImporter } from '../../../src/worker/WorkerMeshBootstrap.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { FakeWorkerBackend, hostMeshNode } from '../worker/__fixtures__/InMemoryWorkerThread.js';
import { Counter, Lifecycle, Where, setups, stopped } from './__fixtures__/actors.js';
import { Stranger } from './__fixtures__/unexported.js';

/**
 * Transparent placement (#1563) on the in-process rig: every "worker" is a
 * `FakeWorker` hosting a real cluster node through `hostMeshNode`, so the
 * production bootstrap, the spawn protocol, the pending refs and the remote
 * refs all run — on this thread, with no OS thread anywhere.  The thread
 * itself is `tests/multi-node/Parallelism.test.ts`'s business.
 *
 * The actor module is a real file, because the main thread learns each
 * class's export name through a real `import()`; the fake workers import the
 * same file, so the module instance is shared and its arrays are readable.
 */

const ACTORS = new URL('./__fixtures__/actors.ts', import.meta.url);
const SWALLOWING = new URL('./__fixtures__/swallowing.ts', import.meta.url);
const MISSING = new URL('./__fixtures__/does-not-exist.ts', import.meta.url);

type Rig = {
  readonly system: ActorSystem;
  readonly backend: FakeWorkerBackend;
  /** The systems the fake workers host, as they come up. */
  readonly hosted: Array<Promise<{ readonly system: ActorSystem }>>;
};

type RigOptions = {
  readonly configure?: (options: ParallelismOptionsBuilder) => ParallelismOptionsBuilder;
  readonly importer?: ModuleImporter;
  readonly config?: Record<string, unknown>;
  readonly name?: string;
  /** Leave `workers` to the config file instead of the builder. */
  readonly workersFromConfig?: boolean;
};

const realImport: ModuleImporter = (href) => import(href) as Promise<Record<string, unknown>>;

function rig(options: RigOptions = {}): Rig {
  const importer = options.importer ?? realImport;
  const hosted: Array<Promise<{ readonly system: ActorSystem }>> = [];
  const backend = new FakeWorkerBackend({ onSpawn: (worker) => { hosted.push(hostMeshNode(worker, importer).node); } });
  const base = ParallelismOptions.create().withModule(ACTORS).withBackend(backend);
  const parallelism = (options.configure ?? ((o) => o))(options.workersFromConfig ? base : base.withWorkers(2));
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig({ 'actor-ts': { cluster: { 'gossip-interval': '25ms' }, ...(options.config ?? {}) } })
    .withParallelism(parallelism);
  const system = ActorSystem.create(options.name ?? 'para', systemOptions);
  return { system, backend, hosted };
}

const whereIs = (ref: { ask<T>(m: { kind: 'where' }): Promise<T> }): Promise<string> => ref.ask<string>({ kind: 'where' });

describe('ParallelismExtension — actors on workers from config alone (#1563)', () => {
  test('spawn() returns a pending ref with the local path, and the actor answers from a worker', async () => {
    const r = rig();
    try {
      const ref = r.system.spawn(Where, 'where');
      expect(ref).toBeInstanceOf(PendingRemoteActorRef);
      expect(ref.path.toString()).toBe('actor-ts://para/user/where');
      expect(ref.toString()).toBe('actor-ts://para/user/where');
      expect((ref as PendingRemoteActorRef).isResolved).toBe(false);

      const address = await whereIs(ref);
      expect(address.startsWith('para@worker:')).toBe(true);
      expect((ref as PendingRemoteActorRef).isResolved).toBe(true);
      expect(ref.toString()).toContain(address);
      expect(ref.toString()).toContain('/user/where');
      // Not in this thread's tree: the actor lives on the worker.
      expect(r.system._inspectTree().some((cell) => cell.path === ref.path.toString())).toBe(false);
      const extension = r.system.extension(ParallelismExtensionId);
      expect(extension.enabled).toBe(true);
      expect([...extension.exportedActors].sort()).toEqual(['Counter', 'Echo', 'Lifecycle', 'Registered', 'Where']);
      expect(setups.filter((s) => s.startsWith('para@')).length).toBeGreaterThanOrEqual(2);
    } finally {
      await r.system.terminate();
    }
  }, 20_000);

  test('workers from HOCON alone: the mesh comes up, and the workers — built from that same config — start no mesh of their own', async () => {
    const r = rig({ workersFromConfig: true, config: { parallelism: { workers: 2 } } });
    try {
      expect((await whereIs(r.system.spawn(Where, 'where'))).startsWith('para@worker:')).toBe(true);
      expect(r.hosted).toHaveLength(2);
      for (const node of r.hosted) {
        const worker = await node;
        expect(worker.system.config.getInt('actor-ts.parallelism.workers')).toBe(2);
        expect(worker.system.extension(ParallelismExtensionId).enabled).toBe(false);
      }
    } finally {
      await r.system.terminate();
    }
  }, 20_000);

  test('messages sent before the mesh is up are delivered in order, after the spawn', async () => {
    const r = rig();
    try {
      const counter = r.system.spawn(Counter, 'counter');
      const values = Array.from({ length: 50 }, (_, i) => i + 1);
      for (const value of values) counter.tell({ kind: 'add', value });
      const totals = await counter.ask<{ total: number; order: number[] }>({ kind: 'total' });
      expect(totals.total).toBe(1275);
      expect(totals.order).toEqual(values);
    } finally {
      await r.system.terminate();
    }
  }, 20_000);

  test('spawnAnonymous is placed too, under a name the main thread generated', async () => {
    const r = rig();
    try {
      const ref = r.system.spawnAnonymous(Where);
      expect(ref).toBeInstanceOf(PendingRemoteActorRef);
      expect(ref.path.name.startsWith('$')).toBe(true);
      expect(ref.path.parent!.toString()).toBe('actor-ts://para/user');
      expect((await whereIs(ref)).startsWith('para@worker:')).toBe(true);
    } finally {
      await r.system.terminate();
    }
  }, 20_000);

  test('a narrower offload leaves unmatched names at home, as local refs in the local tree', async () => {
    const r = rig({ configure: (o) => o.withOffload(['/user/remote-*']) });
    try {
      const home = r.system.spawn(Where, 'home');
      const away = r.system.spawn(Where, 'remote-1');
      const anonymous = r.system.spawnAnonymous(Where);
      expect(home).toBeInstanceOf(LocalActorRef);
      expect(anonymous).toBeInstanceOf(LocalActorRef);
      expect(away).toBeInstanceOf(PendingRemoteActorRef);
      await r.system.extension(ParallelismExtensionId).whenReady();
      expect(await whereIs(home)).toBe('para@main:1');
      expect((await whereIs(away)).startsWith('para@worker:')).toBe(true);
      expect(r.system._inspectTree().some((cell) => cell.path === home.path.toString())).toBe(true);
    } finally {
      await r.system.terminate();
    }
  }, 20_000);

  test('the factory form is refused with the two ways out named', async () => {
    const r = rig();
    try {
      expect(() => r.system.spawn(() => new Where(), 'w')).toThrow(/factory.*cannot cross a thread/);
      expect(() => r.system.spawn(() => new Where(), 'w')).toThrow(/actor-ts\.parallelism\.offload/);
      // A bad name fails here, on the caller's stack, not on the worker.
      expect(() => r.system.spawn(Where, '$reserved')).toThrow(/reserved for framework-generated/);
    } finally {
      await r.system.terminate();
    }
  }, 20_000);

  test('a class the module does not export: refused on the stack once the modules are loaded, dead-lettered before', async () => {
    const r = rig({ configure: (o) => o.withOffload(['/user/remote-*']) });
    try {
      const probe = new TestProbe(r.system);
      r.system.eventStream.subscribe(probe, DeadLetter);
      const early = r.system.spawn(Stranger, 'remote-early');
      early.tell(undefined as never);
      const letter = await probe.receiveOne(10_000) as DeadLetter;
      expect(letter.recipient.path.toString()).toBe(early.path.toString());

      await r.system.extension(ParallelismExtensionId).whenReady();
      let caught: unknown;
      try { r.system.spawn(Stranger, 'remote-late'); } catch (error) { caught = error; }
      const message = (caught as Error).message;
      expect(message).toContain('Stranger');
      expect(message).toContain('actors.ts');
      expect(message).toContain('actor-ts.parallelism.offload');
    } finally {
      await r.system.terminate();
    }
  }, 20_000);

  test('ActorOptions cross the thread as data, and are refused when they carry code', async () => {
    const r = rig();
    try {
      const withData = r.system.spawn(Counter, 'bounded', ActorOptions.create().withMailboxCapacity(64));
      withData.tell({ kind: 'add', value: 1 });
      expect((await withData.ask<{ total: number }>({ kind: 'total' })).total).toBe(1);
      const withCode = ActorOptions.create<never>().withSupervisorStrategy(stoppingStrategy);
      expect(() => r.system.spawn(Lifecycle, 'supervised', withCode)).toThrow(/cannot cross a thread/);
      expect(() => r.system.spawn(Lifecycle, 'supervised', withCode)).toThrow(/supervisorStrategy/);
    } finally {
      await r.system.terminate();
    }
  }, 20_000);

  test('round-robin alternates over the workers; consistent-hash spreads by name and repeats for a name', async () => {
    const r = rig({ configure: (o) => o.withPlacement('round-robin') });
    try {
      const homes: string[] = [];
      for (let i = 0; i < 4; i++) homes.push(await whereIs(r.system.spawn(Where, `rr-${i}`)));
      expect(homes[0]).not.toBe(homes[1]);
      expect(homes[0]).toBe(homes[2]);
      expect(homes[1]).toBe(homes[3]);
    } finally {
      await r.system.terminate();
    }
    const hashed = rig({ name: 'hashed' });
    const twin = rig({ name: 'hashed' });
    try {
      const names = Array.from({ length: 10 }, (_, i) => `actor-${i}`);
      const first = await Promise.all(names.map((name) => whereIs(hashed.system.spawn(Where, name))));
      const second = await Promise.all(names.map((name) => whereIs(twin.system.spawn(Where, name))));
      expect(first).toEqual(second);
      expect(new Set(first).size).toBe(2);
    } finally {
      await hashed.system.terminate();
      await twin.system.terminate();
    }
  }, 30_000);

  test('the spawn deadline fails the ref, and what it held goes to dead letters', async () => {
    const r = rig({
      configure: (o) => o.withModule(SWALLOWING).withOffload(['/user/remote-*']).withSpawnTimeoutMs(200),
    });
    try {
      const probe = new TestProbe(r.system);
      r.system.eventStream.subscribe(probe, DeadLetter);
      const ref = r.system.spawn(Where, 'remote-silent');
      ref.tell({ kind: 'where', replyTo: probe });
      const letter = await probe.receiveOne(10_000) as DeadLetter;
      expect(letter.recipient.path.toString()).toBe(ref.path.toString());
      expect((ref as PendingRemoteActorRef).isResolved).toBe(false);
    } finally {
      await r.system.terminate();
    }
  }, 20_000);

  test('the buffer is bounded across every pending spawn: past the cap, messages are dead letters', async () => {
    const r = rig({ configure: (o) => o.withOffload(['/user/remote-*']).withBufferSize(2) });
    try {
      const probe = new TestProbe(r.system);
      r.system.eventStream.subscribe(probe, DeadLetter);
      const counter = r.system.spawn(Counter, 'remote-counter');
      for (const value of [1, 2, 3]) counter.tell({ kind: 'add', value });
      const letter = await probe.receiveOne(10_000) as DeadLetter;
      expect(letter.message).toEqual({ kind: 'add', value: 3 });
      // The ask would be the fourth message into a full buffer; once the
      // worker has acknowledged, the two that fit have been delivered.
      await awaitCondition(() => (counter as PendingRemoteActorRef).isResolved, { timeoutMs: 12_000, label: 'spawn acknowledged' });
      expect((await counter.ask<{ total: number }>({ kind: 'total' })).total).toBe(3);
    } finally {
      await r.system.terminate();
    }
  }, 20_000);

  test('leader = "worker" puts the coordinator on a worker, under the compute hostname', async () => {
    const r = rig({ configure: (o) => o.withLeader('worker').withWorkers(1) });
    try {
      const extension = r.system.extension(ParallelismExtensionId);
      await extension.whenReady();
      const mesh = extension.workerMesh!;
      expect(mesh.cluster.isLeader()).toBe(false);
      expect(mesh.cluster.leader().map((m) => m.address.toString()).getOrElse('none')).toBe('para@compute:2');
      expect((await whereIs(r.system.spawn(Where, 'w'))).startsWith('para@compute:')).toBe(true);
    } finally {
      await r.system.terminate();
    }
  }, 20_000);

  test('hostnames an operator set are kept, and refused when they contradict the leader', () => {
    const contradiction = rig.bind(null, {
      configure: (o) => o.withLeader('worker'),
      config: { 'worker-mesh': { 'worker-hostname': 'zeta' } },
    });
    expect(contradiction).toThrow(OptionsError);
    expect(contradiction).toThrow(/sorts before 'zeta'/);
    const agreement = rig({
      configure: (o) => o.withLeader('worker').withWorkers(1),
      config: { 'worker-mesh': { 'worker-hostname': 'alpha' } },
    });
    return agreement.system.extension(ParallelismExtensionId).whenReady()
      .then(() => {
        const leader = agreement.system.extension(ParallelismExtensionId).workerMesh!.cluster.leader();
        expect(leader.map((m) => m.address.toString()).getOrElse('none')).toBe('para@alpha:2');
      })
      .finally(() => agreement.system.terminate());
  }, 20_000);

  test('terminate() takes the workers’ systems down first, so an offloaded actor gets its postStop', async () => {
    const r = rig();
    const before = stopped.length;
    try {
      const ref = r.system.spawn(Lifecycle, 'lifecycle');
      await r.system.extension(ParallelismExtensionId).whenReady();
      await awaitCondition(() => (ref as PendingRemoteActorRef).isResolved, { timeoutMs: 12_000, label: 'spawn acknowledged' });
    } finally {
      await r.system.terminate();
    }
    expect(stopped.slice(before)).toContain('actor-ts://para/user/lifecycle');
    expect(r.backend.spawned.every((worker) => worker.terminated)).toBe(true);
  }, 20_000);

  test('terminate() before the mesh is up still tears the workers down and fails what was waiting', async () => {
    const r = rig();
    const ref = r.system.spawn(Where, 'never');
    await r.system.terminate();
    expect(r.backend.spawned.every((worker) => worker.terminated)).toBe(true);
    expect((ref as PendingRemoteActorRef).isResolved).toBe(false);
  }, 20_000);

  test('a mesh that fails to start fails every offloaded spawn from then on, naming the cause', async () => {
    const r = rig({ configure: (o) => o.withModule(MISSING) });
    try {
      const extension = r.system.extension(ParallelismExtensionId);
      await expect(extension.whenReady()).rejects.toThrow();
      expect(() => r.system.spawn(Where, 'w')).toThrow(/failed to start/);
    } finally {
      await r.system.terminate();
    }
  }, 20_000);
});
