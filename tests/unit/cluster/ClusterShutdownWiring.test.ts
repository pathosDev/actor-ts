import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import {
  ClusterLeavingReason,
  CoordinatedShutdownId,
  Phases,
} from '../../../src/CoordinatedShutdown.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';

/**
 * `Phases.ClusterLeave` was empty in every deployment: `grep addTask src/`
 * returned three sites and none of them was in `src/cluster/` (#549).  A
 * SIGTERM therefore took a node down while its peers still counted it a
 * member and kept routing to it until the failure detector gave up.
 *
 * Note what is deliberately NOT asserted here: that peers have *acknowledged*
 * the departure.  `Cluster.leave()` is one best-effort broadcast with no
 * leader-sequenced removal behind it, so a task in `Phases.ClusterExiting`
 * would have nothing to await — that is #1189, and this suite would be lying
 * if it implied otherwise.
 */

const HOST = '127.0.0.1';

const newSystem = (name: string): ActorSystem => {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, systemOptions);
};

async function joinNode(system: ActorSystem, port: number): Promise<Cluster> {
  const address = new NodeAddress(system.name, HOST, port);
  const clusterOptions = ClusterOptions.create()
    .withHost(HOST)
    .withPort(port)
    .withTransport(new InMemoryTransport(address))
    .withGossipIntervalMs(60_000)
    .withTombstonePruneIntervalMs(60_000);
  return Cluster.join(system, clusterOptions);
}

const leaveTaskNames = (system: ActorSystem): string[] => {
  const registry = system.extension(CoordinatedShutdownId) as unknown as {
    tasks: Map<string, ReadonlyArray<{ name: string }>>;
  };
  return (registry.tasks.get(Phases.ClusterLeave) ?? []).map((task) => task.name);
};

describe('cluster leave is a shutdown phase task', () => {
  test('Cluster.join registers one in cluster-leave', async () => {
    const system = newSystem('leave-registered');
    expect(leaveTaskNames(system)).toEqual([]);

    await joinNode(system, 27_101);
    expect(leaveTaskNames(system)).toEqual(['cluster-leave']);

    await system.terminate();
  });

  test('running the pipeline leaves the cluster before the system goes', async () => {
    const system = newSystem('leave-runs');
    const cluster = await joinNode(system, 27_102);
    const selfStatus = (): string | undefined => cluster
      .getMembers()
      .find((member) => member.address.equals(cluster.selfAddress))
      ?.status;
    expect(selfStatus()).toBe('up');

    const observed: Array<string | undefined> = [];
    system.extension(CoordinatedShutdownId).addTask(
      Phases.BeforeActorSystemTerminate,
      'observe',
      () => { observed.push(selfStatus()); },
    );

    await system.extension(CoordinatedShutdownId).run(ClusterLeavingReason.instance);

    // Ordering is the whole point: by the time the pipeline reaches the
    // terminate phases the node has already announced its departure, so its
    // actors finish what they hold while peers already know it is going.
    expect(observed).toEqual(['leaving']);
    expect(system.isTerminated).toBe(true);
  });

  test('leave() takes its own task back out, so a re-join can register again', async () => {
    const system = newSystem('leave-rejoin');
    const cluster = await joinNode(system, 27_103);
    await cluster.leave();
    expect(leaveTaskNames(system)).toEqual([]);

    // Without the removal this second join throws: `addTask` rejects a
    // duplicate name within a phase.
    await joinNode(system, 27_104);
    expect(leaveTaskNames(system)).toEqual(['cluster-leave']);

    await system.terminate();
  });

  test('auto-register-tasks = false leaves the phase to the application', async () => {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({ 'actor-ts': { 'coordinated-shutdown': { 'auto-register-tasks': false } } });
    const system = ActorSystem.create('leave-opt-out', systemOptions);

    await joinNode(system, 27_105);
    expect(leaveTaskNames(system)).toEqual([]);

    await system.terminate();
  });
});
