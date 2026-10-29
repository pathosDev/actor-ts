import { describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { StartShardingOptions } from '../../../src/cluster/sharding/StartShardingOptions.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { Config } from '../../../src/config/Config.js';
import {
  ClusterLeavingReason,
  CoordinatedShutdownId,
  Phases,
} from '../../../src/CoordinatedShutdown.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { regionSegments } from '../../util/SystemPaths.js';

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

  test('an opted-in terminate() leaves the cluster before the system goes', async () => {
    const system = newSystem('leave-on-terminate');
    const cluster = await joinNode(system, 27_106);
    const selfStatus = (): string | undefined => cluster
      .getMembers()
      .find((member) => member.address.equals(cluster.selfAddress))
      ?.status;
    expect(selfStatus()).toBe('up');

    const observed: string[] = [];
    system.extension(CoordinatedShutdownId).addTask(
      Phases.BeforeActorSystemTerminate,
      'observe',
      () => { observed.push(`${selfStatus()} terminated=${system.isTerminated}`); },
    );

    // The call a program makes, not the extension's `run()`: a plain
    // `terminate()` runs no phase, so the node would stop with its peers
    // still counting it `up` (#1455).
    await system.terminate({ runCoordinatedShutdown: true });

    // Gone from the cluster while its actors were still running — the order
    // a rolling deploy needs, not merely the end state.
    expect(observed).toEqual(['leaving terminated=false']);
    expect(leaveTaskNames(system)).toEqual([]);
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

/**
 * `Phases.ClusterShardingShutdownRegion` was empty as well: nothing handed a
 * node's shards off on the way out, and `leave()` did not either, so the
 * regions and coordinators the node had started kept running after it left
 * (#1465).  The phase runs before `cluster-leave`, so the shards are gone
 * before the leave is even begun.
 */
describe('the sharding hand-off is a shutdown phase task (#1465)', () => {
  type PingCommand = { readonly kind: 'ping'; readonly id: string };

  class Pinged extends Actor<PingCommand> {
    override onReceive(message: PingCommand): void {
      match(message)
        .with({ kind: 'ping' }, () => this.onPing())
        .exhaustive();
    }

    private onPing(): void { /* nothing to do */ }
  }

  const TYPE_NAME = 'orders';

  const shardingTaskNames = (system: ActorSystem): string[] => {
    const registry = system.extension(CoordinatedShutdownId) as unknown as {
      tasks: Map<string, ReadonlyArray<{ name: string }>>;
    };
    return (registry.tasks.get(Phases.ClusterShardingShutdownRegion) ?? []).map((task) => task.name);
  };

  test('Cluster.join registers one, and leave() takes it back out for a re-join', async () => {
    const system = newSystem('sharding-task-registered');
    expect(shardingTaskNames(system)).toEqual([]);

    const cluster = await joinNode(system, 27_110);
    expect(shardingTaskNames(system)).toEqual(['cluster-sharding-shutdown-region']);

    await cluster.leave();
    expect(shardingTaskNames(system)).toEqual([]);

    // A duplicate name within a phase is refused, so this join would throw.
    await joinNode(system, 27_111);
    expect(shardingTaskNames(system)).toEqual(['cluster-sharding-shutdown-region']);

    await system.terminate();
  });

  test('running the pipeline stops the sharding before the cluster-leave phase begins', async () => {
    const system = newSystem('sharding-task-runs');
    const cluster = await joinNode(system, 27_112);
    const shardingOptions = StartShardingOptions.create<PingCommand>()
      .withTypeName(TYPE_NAME)
      .withEntityActor(Pinged)
      .withExtractEntityId((message) => message.id);
    cluster.sharding.start<PingCommand>(shardingOptions);
    const regionRunning = (): boolean => system._resolvePath(regionSegments(system.name, TYPE_NAME)).isSome();
    expect(regionRunning()).toBe(true);

    // In the phase after it, beside the leave itself: a leave that only began
    // the hand-off here would still find the region running.
    const observed: boolean[] = [];
    system.extension(CoordinatedShutdownId).addTask(
      Phases.ClusterLeave,
      'observe',
      () => { observed.push(regionRunning()); },
    );

    await system.extension(CoordinatedShutdownId).run(ClusterLeavingReason.instance);

    expect(observed).toEqual([false]);
    expect(system.isTerminated).toBe(true);
  });

  test('a node that gives its join up stops its sharding as well, with the phase task already gone', async () => {
    // The give-up leaves at once — its departure is synchronous and waits for
    // no hand-off — and takes the phase's task out with the leave's own.  The
    // run it starts here terminates nothing, so if this leave did not stop the
    // sharding itself, nothing would.
    const scheduler = new ManualScheduler();
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withScheduler(scheduler)
      .withConfig(Config.parseString('actor-ts.coordinated-shutdown.terminate-actor-system = off'));
    const system = ActorSystem.create('sharding-give-up', systemOptions);
    const address = new NodeAddress(system.name, HOST, 27_113);
    const clusterOptions = ClusterOptions.create()
      .withHost(HOST)
      .withPort(27_113)
      .withTransport(new InMemoryTransport(address))
      .withSeeds([`${system.name}@10.0.152.2:27113`])
      .withSeedRetryIntervalMs(100)
      .withShutdownAfterUnsuccessfulJoinMs(1_000)
      .withGossipIntervalMs(60_000);
    const cluster = await Cluster.join(system, clusterOptions);
    const shardingOptions = StartShardingOptions.create<PingCommand>()
      .withTypeName(TYPE_NAME)
      .withEntityActor(Pinged)
      .withExtractEntityId((message) => message.id);
    cluster.sharding.start<PingCommand>(shardingOptions);
    const regionRunning = (): boolean => system._resolvePath(regionSegments(system.name, TYPE_NAME)).isSome();
    expect(regionRunning()).toBe(true);

    scheduler.advance(1_000);

    expect(shardingTaskNames(system)).toEqual([]);
    await awaitCondition(() => !regionRunning(), {
      timeoutMs: 4_000,
      label: 'the region of the node that gave its join up stopped',
    });
    await system.terminate();
  });
});
