import { match } from 'ts-pattern';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { clusterOf } from '../../../../src/cluster/ClusterExtension.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import type { ActorRef } from '../../../../src/ActorRef.js';

type ReportCommand = { readonly kind: 'report'; readonly id: string };
type Command = ReportCommand;

/** What the probe sees when it asks for its cluster, by all three routes. */
type ClusterReport = {
  /** `this.context.cluster.isSome()` — the non-throwing question. */
  readonly hasCluster: boolean;
  /** Address via the `Option`, `null` when there is no cluster. */
  readonly optionalAddress: string | null;
  /** Address via the unwrapped `this.cluster`, `null` when it threw. */
  readonly unwrappedAddress: string | null;
  /** Message `this.cluster` threw with, `null` when it did not throw. */
  readonly error: string | null;
  /** Same, but read in `preStart` — before the first message. */
  readonly addressSeenInPreStart: string | null;
};

/**
 * Reads its cluster the way user code would: nothing is passed in, and
 * nothing about the spawn tells it whether a cluster exists.
 */
class ClusterProbeActor extends Actor<Command> {
  private addressSeenInPreStart: string | null = null;

  override preStart(): void {
    this.addressSeenInPreStart = this.context.cluster
      .fold(() => null, (cluster) => cluster.selfAddress.toString());
  }

  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'report' }, () => this.onReport())
      .exhaustive();
  }

  private onReport(): void {
    this.sender.forEach((sender) => sender.tell(this.describe()));
  }

  private describe(): ClusterReport {
    const optional = this.context.cluster;
    let unwrappedAddress: string | null = null;
    let error: string | null = null;
    try {
      unwrappedAddress = this.cluster.selfAddress.toString();
    } catch (e) {
      error = (e as Error).message;
    }
    return {
      hasCluster: optional.isSome(),
      optionalAddress: optional.fold(() => null, (cluster) => cluster.selfAddress.toString()),
      unwrappedAddress,
      error,
      addressSeenInPreStart: this.addressSeenInPreStart,
    };
  }
}

function quietSystem(name: string): ActorSystem {
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, options);
}

function clusterOptions(systemName: string, host: string, port: number): ClusterOptions {
  return ClusterOptions.create()
    .withHost(host)
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, host, port)))
    .withGossipIntervalMs(30);
}

describe('a system that never joined a cluster', () => {
  let system: ActorSystem;

  beforeAll(() => { system = quietSystem('no-cluster'); });
  afterAll(async () => { await system.terminate(); });

  test('reports no cluster rather than creating one', () => {
    expect(system.cluster.isSome()).toBe(false);
    expect(clusterOf(system).isSome()).toBe(false);
  });

  test('an actor gets None from the context and a pointed error from `this.cluster`', async () => {
    const probe = system.spawn(ClusterProbeActor, 'probe');

    const report = await probe.ask<ClusterReport>({ kind: 'report', id: 'n/a' }, 3_000);

    expect(report.hasCluster).toBe(false);
    expect(report.optionalAddress).toBeNull();
    expect(report.unwrappedAddress).toBeNull();
    // The error has to name the way out, not just the symptom.
    expect(report.error).toContain('has no Cluster');
    expect(report.error).toContain('Cluster.join');
    expect(report.error).toContain('this.context.cluster');
  });
});

describe('a system that joined a cluster', () => {
  const SYSTEM_NAME = 'with-cluster';
  const PORT = 46_100;
  const ADDRESS = `${SYSTEM_NAME}@h:${PORT}`;

  let system: ActorSystem;
  let cluster: Cluster;
  let region: ActorRef<Command>;

  beforeAll(async () => {
    system = quietSystem(SYSTEM_NAME);
    cluster = await Cluster.join(system, clusterOptions(SYSTEM_NAME, 'h', PORT));
    const shardingOptions = StartShardingOptions.create<Command>()
      .withTypeName('probe')
      .withEntityActor(ClusterProbeActor)
      .withExtractEntityId((message) => message.id)
      .withNumShards(8);
    region = cluster.sharding.start<Command>(shardingOptions);
  });

  afterAll(async () => {
    await cluster.leave();
    await system.terminate();
  });

  test('hands back the very instance `Cluster.join` returned', () => {
    expect(system.cluster.toNullable()).toBe(cluster);
    expect(clusterOf(system).toNullable()).toBe(cluster);
  });

  test('an actor reaches it without being handed anything', async () => {
    const probe = system.spawn(ClusterProbeActor, 'probe');

    const report = await probe.ask<ClusterReport>({ kind: 'report', id: 'n/a' }, 3_000);

    expect(report.hasCluster).toBe(true);
    expect(report.optionalAddress).toBe(ADDRESS);
    expect(report.unwrappedAddress).toBe(ADDRESS);
    expect(report.error).toBeNull();
    expect(report.addressSeenInPreStart).toBe(ADDRESS);
  });

  test('a sharded entity reaches it, with no call site to thread it through', async () => {
    const report = await region.ask<ClusterReport>({ kind: 'report', id: 'cart-7' }, 3_000);

    expect(report.unwrappedAddress).toBe(ADDRESS);
    // The framework constructed this entity — nothing user-side could
    // have injected a cluster into it.
    expect(report.addressSeenInPreStart).toBe(ADDRESS);
  });
});

describe('an actor that was already running when the system joined', () => {
  const SYSTEM_NAME = 'late-join';
  const PORT = 46_103;

  let system: ActorSystem;
  let cluster: Cluster;
  let probe: ActorRef<Command>;
  let before: ClusterReport;

  beforeAll(async () => {
    system = quietSystem(SYSTEM_NAME);
    probe = system.spawn(ClusterProbeActor, 'probe');
    // Round-trip first, so `preStart` has demonstrably run and seen no
    // cluster — otherwise the join could win the race and the test would
    // prove nothing.
    before = await probe.ask<ClusterReport>({ kind: 'report', id: 'n/a' }, 3_000);
    cluster = await Cluster.join(system, clusterOptions(SYSTEM_NAME, 'h', PORT));
  });

  afterAll(async () => {
    await cluster.leave();
    await system.terminate();
  });

  test('is not stuck with the None it saw at startup', async () => {
    expect(before.hasCluster).toBe(false);
    expect(before.addressSeenInPreStart).toBeNull();

    const after = await probe.ask<ClusterReport>({ kind: 'report', id: 'n/a' }, 3_000);

    // The accessor reads through to the system on every access rather
    // than snapshotting at construction.
    expect(after.hasCluster).toBe(true);
    expect(after.unwrappedAddress).toBe(`${SYSTEM_NAME}@h:${PORT}`);
  });
});

describe('rejoining after leave', () => {
  const SYSTEM_NAME = 'rejoin';

  let system: ActorSystem;
  let first: Cluster;
  let second: Cluster;

  beforeAll(async () => {
    system = quietSystem(SYSTEM_NAME);
    first = await Cluster.join(system, clusterOptions(SYSTEM_NAME, 'h', 46_101));
    await first.leave();
    second = await Cluster.join(system, clusterOptions(SYSTEM_NAME, 'h', 46_102));
  });

  afterAll(async () => {
    await second.leave();
    await system.terminate();
  });

  test('resolves to the new cluster, not the one that left', () => {
    expect(system.cluster.toNullable()).toBe(second);
    expect(system.cluster.toNullable()).not.toBe(first);
  });

  test('an actor follows the swap', async () => {
    const probe = system.spawn(ClusterProbeActor, 'probe');

    const report = await probe.ask<ClusterReport>({ kind: 'report', id: 'n/a' }, 3_000);

    expect(report.unwrappedAddress).toBe(`${SYSTEM_NAME}@h:46102`);
  });
});
