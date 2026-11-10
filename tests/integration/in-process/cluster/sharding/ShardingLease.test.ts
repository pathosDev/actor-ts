/**
 * ClusterSharding + Lease integration tests (#60).
 *
 * Three single-node scenarios cover the coordinator's lease state
 * machine.  The multi-node split-brain test lives in
 * `tests/multi-node/sharding-lease-split-brain.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { AskTimeoutError } from '../../../../../src/SystemMessages.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { ClusterSharding } from '../../../../../src/cluster/sharding/ClusterSharding.js';
import { StartShardingOptions } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import type { StartShardingOptionsBuilder } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { Config } from '../../../../../src/config/Config.js';
import { _substituteLeaseBackendForTest } from '../../../../../src/coordination/LeaseFromConfig.js';
import type { ConfiguredLeaseOptions } from '../../../../../src/coordination/LeaseFromConfig.js';
import {
  InMemoryLease,
  inMemoryLeaseStore,
} from '../../../../../src/coordination/leases/InMemoryLease.js';
import { LeaseOptions } from '../../../../../src/coordination/LeaseOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

type Command = { id: string; kind: 'ping' };

class Entity extends Actor<Command> {
  override onReceive(m: Command): void {
    if (m.kind === 'ping') this.sender.forEach((s) => s.tell('pong'));
  }
}

/**
 * Kept as a name so every call site here stays unchanged; the body forwards to
 * the shared helper (#418), which names the awaited state in its timeout message
 * and — unlike the deadline loop it replaces — cannot fall through silently.
 */
const waitFor = (
  predicate: () => boolean,
  timeoutMs = 3_000,
  stepMs = 25,
  label = 'the awaited sharding-lease state',
): Promise<void> => awaitCondition(predicate, { timeoutMs, intervalMs: stepMs, label });

type Node = {
  sys: ActorSystem;
  cluster: Cluster;
  region: ActorRef<Command>;
};

async function startNodeWithLease(
  systemName: string, port: number, lease: InMemoryLease,
): Promise<Node> {
  const sysOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const sys = ActorSystem.create(systemName, sysOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(sys, clusterOptions);
  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName('entity')
    .withEntityActor(Entity)
    .withExtractEntityId((m) => m.id)
    .withNumShards(8)
    .withRebalanceIntervalMs(200)
    .withLease(lease)
    .withAcquireRetryIntervalMs(100);
  const region = cluster.sharding.start<Command>(shardingOptions);
  return { sys, cluster, region };
}

async function stop(n: Node): Promise<void> {
  await n.cluster.leave();
  await n.sys.terminate();
}

/**
 * A node whose coordinator lease comes from HOCON alone: the system config
 * names the backend and switches `use-lease` on, and the sharding options say
 * nothing about a lease unless `configure` adds it (#1454).
 */
async function startNodeFromConfig(
  systemName: string,
  port: number,
  hocon: string,
  configure: (options: StartShardingOptionsBuilder<Command>) => void = () => {},
): Promise<Node> {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(Config.parseString(hocon));
  const sys = ActorSystem.create(systemName, sysOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(sys, clusterOptions);
  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName('entity')
    .withEntityActor(Entity)
    .withExtractEntityId((m) => m.id)
    .withNumShards(8)
    .withRebalanceIntervalMs(200)
    .withAcquireRetryIntervalMs(100);
  configure(shardingOptions);
  try {
    const region = cluster.sharding.start<Command>(shardingOptions);
    return { sys, cluster, region };
  } catch (error) {
    await cluster.leave();
    await sys.terminate();
    throw error;
  }
}

/** The configuration every case below shares: a backend, a TTL, the switch on. */
const LEASE_FROM_CONFIG = `
  actor-ts.coordination.lease { backend = kubernetes, ttl = 10s }
  actor-ts.sharding.use-lease = on
`;

describe('ClusterSharding + Lease', () => {
  test('1. acquire blocked by another holder → coordinator does not respond to shard requests', async () => {
    inMemoryLeaseStore._clear();
    // Foreign holder owns the lease before the coordinator boots.
    const foreignOptions = LeaseOptions.create().withName('sharding-lease-1').withOwner('someone-else').withTtlMs(10_000);
    const foreign = new InMemoryLease(foreignOptions);
    expect(await foreign.acquire()).toBe(true);

    const leaseOptions = LeaseOptions.create().withName('sharding-lease-1').withOwner('self').withTtlMs(10_000);
    const lease = new InMemoryLease(leaseOptions);
    const nodeA = await startNodeWithLease('shard-lease-1', 60_101, lease);

    // Coordinator can't acquire — region's GetShardHome ask never
    // gets a ShardHome reply, so any user message into the region
    // sits in its buffer.  An ask with a tight timeout therefore
    // times out instead of returning 'pong'.
    await expect(
      nodeA.region.ask<string>({ id: 'e-1', kind: 'ping' }, 400)
    ).rejects.toBeInstanceOf(AskTimeoutError);

    // Now release the foreign lease — the coordinator's retry tick
    // (100 ms above) catches it and acquires.  Subsequent ask works.
    await foreign.release();
    await waitFor(() => lease.checkAlive(), 2_000);

    const reply = await nodeA.region.ask<string>({ id: 'e-1', kind: 'ping' }, 3_000);
    expect(reply).toBe('pong');

    await stop(nodeA);
  }, 15_000);

  test('2. lost lease stops coordinator activity (asks resume after re-acquire)', async () => {
    inMemoryLeaseStore._clear();
    const leaseOptions = LeaseOptions.create().withName('sharding-lease-2').withOwner('self').withTtlMs(10_000)
      .withRenewalIntervalMs(60);
    const lease = new InMemoryLease(leaseOptions);
    const nodeA = await startNodeWithLease('shard-lease-2', 60_102, lease);

    // Initial ask succeeds — coordinator acquired the lease cleanly.
    await waitFor(() => lease.checkAlive(), 2_000);
    expect(await nodeA.region.ask<string>({ id: 'e-1', kind: 'ping' }, 2_000)).toBe('pong');

    // Force the lease away by clearing the store + having a usurper
    // take it.  The InMemoryLease's renewal loop will fail and fire
    // onLost, which the coordinator handles by stepping down.
    inMemoryLeaseStore._clear();
    const usurperOptions = LeaseOptions.create().withName('sharding-lease-2').withOwner('usurper').withTtlMs(10_000);
    const usurper = new InMemoryLease(usurperOptions);
    expect(await usurper.acquire()).toBe(true);

    // Wait for the local lease renewal to detect the loss + the
    // coordinator's step-down handler to clear regions.
    await waitFor(() => !lease.checkAlive(), 2_000);

    // While the usurper still holds, asks fail — the coordinator
    // is passive even though it's still the cluster leader.
    await expect(
      nodeA.region.ask<string>({ id: 'e-2', kind: 'ping' }, 400)
    ).rejects.toBeInstanceOf(AskTimeoutError);

    // Hand the lease back; the coordinator's retry tick re-acquires.
    await usurper.release();
    await waitFor(() => lease.checkAlive(), 3_000);
    expect(await nodeA.region.ask<string>({ id: 'e-3', kind: 'ping' }, 3_000)).toBe('pong');

    await stop(nodeA);
  }, 20_000);

  test('3. graceful coordinator stop releases the lease', async () => {
    inMemoryLeaseStore._clear();
    const leaseOptions = LeaseOptions.create().withName('sharding-lease-3').withOwner('self').withTtlMs(10_000);
    const lease = new InMemoryLease(leaseOptions);
    const nodeA = await startNodeWithLease('shard-lease-3', 60_103, lease);

    await waitFor(() => lease.checkAlive(), 2_000);
    expect(lease.checkAlive()).toBe(true);

    await nodeA.cluster.leave();
    await nodeA.sys.terminate();

    // postStop releases the lease; allow a tick for the async release.
    await waitFor(() => !lease.checkAlive(), 2_000);
    expect(lease.checkAlive()).toBe(false);
  }, 10_000);
});

describe('ClusterSharding + a lease configured from HOCON alone (#1454)', () => {
  /**
   * The backend seam builds an `InMemoryLease` from exactly what the
   * Kubernetes backend would be handed — the derived name and owner, the
   * system's scheduler and config — since `in-memory` is not selectable and
   * the real backend needs an API server.  Everything up to the wire is the
   * production path: the switch, the backend selector, the TTL from the file.
   */
  const built: ConfiguredLeaseOptions[] = [];
  let restore: () => void = () => {};
  beforeEach(() => {
    inMemoryLeaseStore._clear();
    built.length = 0;
    restore = _substituteLeaseBackendForTest((options, config) => {
      built.push(options);
      return new InMemoryLease(options, config);
    });
  });
  afterEach(() => { restore(); });

  test('4. use-lease = on gates the coordinator on a lease nobody passed in code', async () => {
    // A foreign holder owns the record the configured lease is named after.
    const foreignOptions = LeaseOptions.create()
      .withName('shard-lease-hocon-sharding-entity')
      .withOwner('someone-else')
      .withTtlMs(10_000);
    const foreign = new InMemoryLease(foreignOptions);
    expect(await foreign.acquire()).toBe(true);

    const nodeA = await startNodeFromConfig('shard-lease-hocon', 60_104, LEASE_FROM_CONFIG);
    expect(built.map((options) => options.name)).toEqual(['shard-lease-hocon-sharding-entity']);
    expect(built[0]!.owner).toStartWith('shard-lease-hocon@h:60104#');

    // Blocked exactly as a lease passed in code would block it.
    await expect(
      nodeA.region.ask<string>({ id: 'e-1', kind: 'ping' }, 400),
    ).rejects.toBeInstanceOf(AskTimeoutError);

    await foreign.release();
    expect(await nodeA.region.ask<string>({ id: 'e-1', kind: 'ping' }, 3_000)).toBe('pong');

    await stop(nodeA);
  }, 15_000);

  test('5. withUseLease(false) opts one type out of the deployment-wide switch', async () => {
    const foreignOptions = LeaseOptions.create()
      .withName('shard-lease-optout-sharding-entity')
      .withOwner('someone-else')
      .withTtlMs(10_000);
    const foreign = new InMemoryLease(foreignOptions);
    expect(await foreign.acquire()).toBe(true);

    const nodeA = await startNodeFromConfig(
      'shard-lease-optout', 60_105, LEASE_FROM_CONFIG, (options) => { options.withUseLease(false); },
    );

    // No lease built, so the foreign holder gates nothing.
    expect(built).toEqual([]);
    expect(await nodeA.region.ask<string>({ id: 'e-1', kind: 'ping' }, 3_000)).toBe('pong');

    await foreign.release();
    await stop(nodeA);
  }, 15_000);

  test('6. a lease passed in code wins over the switch', async () => {
    const leaseOptions = LeaseOptions.create().withName('explicit-entity-lease').withOwner('self').withTtlMs(10_000);
    const lease = new InMemoryLease(leaseOptions);
    const nodeA = await startNodeFromConfig(
      'shard-lease-explicit', 60_106, LEASE_FROM_CONFIG, (options) => { options.withLease(lease); },
    );

    expect(built).toEqual([]);
    await waitFor(() => lease.checkAlive(), 2_000);
    expect(await nodeA.region.ask<string>({ id: 'e-1', kind: 'ping' }, 3_000)).toBe('pong');

    await stop(nodeA);
  }, 15_000);

  test('7. use-lease = on with no backend is refused when the type starts', async () => {
    await expect(startNodeFromConfig('shard-lease-none', 60_107, 'actor-ts.sharding.use-lease = on'))
      .rejects.toThrow(/actor-ts\.sharding\.use-lease \(or withUseLease\(true\)\) for sharded type 'entity' asks for a lease built from configuration, but actor-ts\.coordination\.lease\.backend = none/);
  }, 15_000);
});
