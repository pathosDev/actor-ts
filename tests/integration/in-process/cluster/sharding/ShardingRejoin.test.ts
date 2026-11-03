/**
 * Sharding after a leave and a re-join on the same `ActorSystem` (#1465).
 *
 * `cluster.sharding` hands out one memoised facade, and the facade is bound to
 * the `Cluster` it was built for: its regions register through that cluster,
 * subscribe to its events and route over its transport.  It used to be
 * memoised per `ActorSystem`, ignoring the cluster it was asked for, so the
 * first incarnation to touch it kept it.  After `leave()` and a fresh
 * `Cluster.join` on the same system, the new cluster's `sharding` was the
 * facade of the cluster that had left — a region started through it never
 * registered, and a readiness check gating on it stayed red for good.
 *
 * Touching the facade is not something an application has to do on purpose:
 * with `actor-ts.sharding.healthcheck.names` set, `Cluster.join` installs a
 * `shard-region:<type>` check that resolves it at once.  So the first case is
 * the configuration, and the second the same defect reached from code.
 *
 * The second describe block is what a leave does to the sharding it leaves
 * behind (#1465).  The regions and coordinators the left cluster's facade
 * started used to keep running, bound to the cluster that had left, entities
 * and all — so a re-join could not start a type the left incarnation ran:
 * the old actors still held their well-known names and `start` threw "Child
 * name 'coordinator-orders' is not unique".  Leaving now stops them first.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../../../src/Actor.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { StartShardingOptions } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import { Config } from '../../../../../src/config/Config.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { healthChecksOf, isHealthy } from '../../../../../src/management/index.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';
import { coordinatorSegments, regionSegments } from '../../../../util/SystemPaths.js';

type WorkCommand = { readonly id: string; readonly kind: 'work'; readonly note?: string };

class Entity extends Actor<WorkCommand> {
  override onReceive(message: WorkCommand): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  private onWork(): void { /* nothing to do */ }
}

/**
 * What the recording entities of a case did, in order — `started <id>`,
 * `received <note>`, `stopped <id>` — so a case can tell an entity that
 * stopped from one still running for a cluster that has left.
 */
const lifecycle: string[] = [];

class RecordingEntity extends Actor<WorkCommand> {
  override preStart(): void { lifecycle.push(`started ${this.entityId}`); }

  override postStop(): void { lifecycle.push(`stopped ${this.entityId}`); }

  override onReceive(message: WorkCommand): void {
    match(message)
      .with({ kind: 'work' }, (m) => this.onWork(m))
      .exhaustive();
  }

  private onWork(message: WorkCommand): void { lifecycle.push(`received ${message.note ?? message.id}`); }
}

const TYPE_NAME = 'orders';

/**
 * Every turn on its own macrotask.  The parent of a stopped actor frees its
 * name on a later turn than the one that tells a watcher it stopped, and on
 * the default dispatcher both usually land in the same microtask burst — so
 * only here does a `leave()` that returned before the names were free get
 * caught at the very next statement.
 */
const ONE_MACROTASK_PER_TURN = 'actor-ts.dispatcher.default = "immediate"';

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];

afterEach(async () => {
  for (const cluster of clusters.splice(0)) await cluster.leave().catch(() => { /* best-effort */ });
  for (const system of systems.splice(0)) await system.terminate().catch(() => { /* best-effort */ });
  lifecycle.length = 0;
});

function systemWith(name: string, hocon: string): ActorSystem {
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(Config.parseString(hocon));
  const system = ActorSystem.create(name, options);
  systems.push(system);
  return system;
}

async function joinAlone(system: ActorSystem, port: number): Promise<Cluster> {
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withGossipIntervalMs(30)
    .withTransport(new InMemoryTransport(new NodeAddress(system.name, 'h', port)));
  const cluster = await Cluster.join(system, clusterOptions);
  clusters.push(cluster);
  await awaitCondition(
    () => cluster.getMembers().some((member) => member.address.equals(cluster.selfAddress) && member.status === 'up'),
    { timeoutMs: 4_000, label: `the node on port ${port} is up` },
  );
  return cluster;
}

function startOrders(cluster: Cluster): void {
  const shardingOptions = StartShardingOptions.create<WorkCommand>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(8)
    .withPassivationIdleMs(0);
  cluster.sharding.start<WorkCommand>(shardingOptions);
}

function startRecordingOrders(cluster: Cluster): ActorRef<WorkCommand> {
  const shardingOptions = StartShardingOptions.create<WorkCommand>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(RecordingEntity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(8)
    .withPassivationIdleMs(0);
  return cluster.sharding.start<WorkCommand>(shardingOptions);
}

function work(id: string, note: string): WorkCommand {
  return { id, kind: 'work', note };
}

describe('sharding after a leave and a re-join on one ActorSystem (#1465)', () => {
  test('with the readiness names set, the new incarnation registers and turns ready', async () => {
    const system = systemWith('sharding-rejoin-names', `actor-ts.sharding.healthcheck.names = ["${TYPE_NAME}"]`);
    const first = await joinAlone(system, 62_400);
    await first.leave();
    const second = await joinAlone(system, 62_401);

    startOrders(second);
    await awaitCondition(() => second.sharding.isRegistered(TYPE_NAME), {
      timeoutMs: 4_000,
      label: 'the region started on the new incarnation registered',
    });
    const readiness = await healthChecksOf(system).checkReadiness();
    expect(readiness.find((result) => result.name === `shard-region:${TYPE_NAME}`)?.status).toBe(true);
    expect(isHealthy(readiness)).toBe(true);
    expect(second.sharding.cluster).toBe(second);
  });

  test('a facade the left incarnation built is not the one the new incarnation gets', async () => {
    const system = systemWith('sharding-rejoin-touched', 'actor-ts {}');
    const first = await joinAlone(system, 62_410);
    const left = first.sharding;
    await first.leave();
    const second = await joinAlone(system, 62_411);

    expect(second.sharding).not.toBe(left);
    expect(second.sharding.cluster).toBe(second);
    // Still one facade per incarnation, and reading through the left cluster
    // does not disturb the new one: each keeps the facade it was given.
    const current = second.sharding;
    expect(first.sharding).toBe(left);
    expect(second.sharding).toBe(current);
    startOrders(second);
    await awaitCondition(() => second.sharding.isRegistered(TYPE_NAME), {
      timeoutMs: 4_000,
      label: 'the region started on the new incarnation registered',
    });
  });
});

describe('leaving stops the sharding the left cluster started (#1465)', () => {
  test('leave() stops the region, the coordinator and their entities before it returns', async () => {
    const system = systemWith('sharding-leave-stops', ONE_MACROTASK_PER_TURN);
    const cluster = await joinAlone(system, 62_420);
    startRecordingOrders(cluster).tell(work('order-1', 'before the leave'));
    await awaitCondition(() => lifecycle.includes('received before the leave'), {
      timeoutMs: 4_000,
      label: 'the entity received its message before the leave',
    });

    await cluster.leave();

    // Checked at the very next statement, not polled: a leave that returned
    // with its sharding still stopping would let a re-join collide on the
    // names below, or run the entity beside the member that re-homes it.
    expect(lifecycle).toContain('stopped order-1');
    expect(system._resolvePath(regionSegments(system.name, TYPE_NAME)).isNone()).toBe(true);
    expect(system._resolvePath(coordinatorSegments(system.name, TYPE_NAME)).isNone()).toBe(true);
    expect(cluster.sharding.isRegistered(TYPE_NAME)).toBe(false);
  });

  test('a re-join starts the type the left incarnation ran, and the new region delivers', async () => {
    const system = systemWith('sharding-rejoin-same-type', ONE_MACROTASK_PER_TURN);
    const first = await joinAlone(system, 62_421);
    startRecordingOrders(first).tell(work('order-1', 'before the leave'));
    await awaitCondition(() => lifecycle.includes('received before the leave'), {
      timeoutMs: 4_000,
      label: 'the entity received its message before the leave',
    });
    await first.leave();
    const second = await joinAlone(system, 62_422);

    // Threw "Child name 'coordinator-orders' is not unique" while the left
    // incarnation's coordinator and region still held their names.
    const region = startRecordingOrders(second);
    region.tell(work('order-1', 'after the re-join'));
    await awaitCondition(() => lifecycle.includes('received after the re-join'), {
      timeoutMs: 4_000,
      label: 'the entity received its message through the new incarnation',
    });
    expect(lifecycle.filter((entry) => entry === 'started order-1')).toHaveLength(2);
    await awaitCondition(() => second.sharding.isRegistered(TYPE_NAME), {
      timeoutMs: 4_000,
      label: 'the region started on the new incarnation registered',
    });
  });

  test("the left cluster's facade refuses to start a type again", async () => {
    const system = systemWith('sharding-left-facade', 'actor-ts {}');
    const cluster = await joinAlone(system, 62_423);
    startRecordingOrders(cluster);
    await cluster.leave();

    // Starting through it would bind fresh actors to the cluster that left —
    // the defect again — and take the names a re-join needs.
    expect(() => startRecordingOrders(cluster)).toThrow(/has left/);
    expect(system._resolvePath(coordinatorSegments(system.name, TYPE_NAME)).isNone()).toBe(true);
  });
});
