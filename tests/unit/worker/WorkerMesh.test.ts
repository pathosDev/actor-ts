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
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { WorkerMesh } from '../../../src/worker/WorkerMesh.js';
import type { ModuleImporter, WorkerMeshSetupContext } from '../../../src/worker/WorkerMeshBootstrap.js';
import { WorkerMeshOptions } from '../../../src/worker/WorkerMeshOptions.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
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
};

function rig(modules: Record<string, Record<string, unknown>> = {}, systemName = 'mesh'): Rig {
  const observed: Observed[] = [];
  const catalogue: Record<string, Record<string, unknown>> = { [MODULE_URL]: actorsModule(observed), ...modules };
  const importer: ModuleImporter = async (href) => {
    const module = catalogue[href];
    if (module === undefined) throw new Error(`no such module in this test: ${href}`);
    return module;
  };
  const backend = new FakeWorkerBackend({ onSpawn: (worker) => { hostMeshNode(worker, importer); } });
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    // Builder-set, never in a file — so a worker that ran with anything but
    // the effective config would read the reference default instead.
    .withConfig({ 'actor-ts': { cluster: { 'gossip-interval': '25ms' } } });
  const system = ActorSystem.create(systemName, systemOptions);
  return { system, backend, observed, importer };
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
