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
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../../../src/Actor.js';
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

type WorkCommand = { readonly id: string; readonly kind: 'work' };

class Entity extends Actor<WorkCommand> {
  override onReceive(message: WorkCommand): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  private onWork(): void { /* nothing to do */ }
}

const TYPE_NAME = 'orders';

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];

afterEach(async () => {
  for (const cluster of clusters.splice(0)) await cluster.leave().catch(() => { /* best-effort */ });
  for (const system of systems.splice(0)) await system.terminate().catch(() => { /* best-effort */ });
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
