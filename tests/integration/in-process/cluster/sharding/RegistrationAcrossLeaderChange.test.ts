/**
 * What `ClusterSharding.isRegistered` and `registrationRefusal` report around a
 * leader change and a region stop (#1465, #853).
 *
 * Both feed the `shard-region:<type>` readiness check, so each is a statement a
 * load balancer acts on:
 *
 * - **A leader change is not a loss of registration.**  Every region
 *   re-registers with the new coordinator, and the node keeps reading as
 *   registered while it does — no readiness flap on an election.  Only a
 *   refusal, an eviction or a stop takes the registration away.
 * - **A refusal is a verdict of one leader term.**  The region drops its
 *   refusal latch when the leader changes and asks the new coordinator; the
 *   node's record of the refusal goes with it, so it no longer names a
 *   coordinator that has stopped governing the type.
 * - **A stop leaves a refusal alone.**  A stopped region is not registered, but
 *   the stop says nothing about the shard counts the refusal reports.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../../../src/Actor.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ShardRegionRegistered } from '../../../../../src/cluster/ClusterEvents.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import type { WireMessage } from '../../../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { StartShardingOptions } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { coordinatorSegments, regionSegments } from '../../../../util/SystemPaths.js';
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

const TYPE_NAME = 'entity';

/** How long a case samples a node's registration across a leader handover. */
const HANDOVER_SAMPLE_MS = 500;

/** Can stop delivering this node's `sharding.Register` frames, to hold a re-registration open. */
class RegisterDroppingTransport extends InMemoryTransport {
  dropRegisters = false;

  override send(to: NodeAddress, message: WireMessage): void {
    if (this.dropRegisters && RegisterDroppingTransport.shardingKind(message) === 'sharding.Register') return;
    super.send(to, message);
  }

  private static shardingKind(message: WireMessage): unknown {
    if (message.kind !== 'envelope') return undefined;
    const body = message.body as { kind?: unknown } | null;
    return typeof body === 'object' && body !== null ? body.kind : undefined;
  }
}

type Joined = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly transport: RegisterDroppingTransport;
};

const running: Joined[] = [];

afterEach(async () => {
  for (const node of running.splice(0)) {
    await node.cluster.leave().catch(() => { /* best-effort */ });
    await node.system.terminate().catch(() => { /* best-effort */ });
  }
});

async function joinNode(systemName: string, port: number, seeds: string[]): Promise<Joined> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const transport = new RegisterDroppingTransport(new NodeAddress(systemName, 'h', port));
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds(seeds)
    .withTransport(transport)
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  const node = { system, cluster, transport };
  running.push(node);
  return node;
}

/** Nodes on consecutive ports after `base`, every one seeded from the first. */
async function joinAll(systemName: string, base: number, count: number): Promise<Joined[]> {
  const nodes: Joined[] = [await joinNode(systemName, base, [])];
  for (let index = 1; index < count; index++) {
    nodes.push(await joinNode(systemName, base + index, [`${systemName}@h:${base}`]));
  }
  await awaitCondition(() => nodes.every((node) => node.cluster.upMembers().length === count), {
    timeoutMs: 4_000,
    label: `the ${count}-node cluster converged`,
  });
  return nodes;
}

function startRegion(node: Joined, numShards: number): ActorRef<WorkCommand> {
  const shardingOptions = StartShardingOptions.create<WorkCommand>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(numShards)
    .withPassivationIdleMs(0);
  return node.cluster.sharding.start<WorkCommand>(shardingOptions);
}

function leaderSeenBy(node: Joined): string {
  return node.cluster.leader().fold(() => '', (member) => member.address.toString());
}

/** Whether the coordinator running on `node` holds a registry entry for `address`. */
function coordinatorKnows(node: Joined, address: NodeAddress): boolean {
  const resolved = node.system._resolvePath(coordinatorSegments(node.system.name, TYPE_NAME));
  if (resolved.isNone()) return false;
  const cell = (resolved.value as unknown as { getCell?: () => { actor?: unknown } }).getCell?.();
  const regions = (cell?.actor as { regions?: Map<string, { node: NodeAddress }> } | undefined)?.regions;
  return Array.from(regions?.values() ?? []).some((info) => info.node.equals(address));
}

describe('a leader change and the registration a node reports (#1465)', () => {
  test('a node keeps reading as registered while its region re-registers with the new coordinator', async () => {
    // `b` sorts below `c`, so when `a` leaves `b` becomes the leader and its
    // coordinator takes over.  `c`'s `Register` frames are dropped across the
    // handover, which holds its re-registration open: the new coordinator has
    // no entry for it until they flow again.
    const [a, b, c] = await joinAll('registered-across-leader-change', 62_510, 3);
    for (const node of [a!, b!, c!]) startRegion(node, 8);
    await awaitCondition(() => [a!, b!, c!].every((node) => node.cluster.sharding.isRegistered(TYPE_NAME)), {
      timeoutMs: 4_000,
      label: 'every region registered with the first leader',
    });
    const announcements: ShardRegionRegistered[] = [];
    c!.cluster.subscribe((event) => { if (event instanceof ShardRegionRegistered) announcements.push(event); });
    const announcedBefore = announcements.length;

    c!.transport.dropRegisters = true;
    await a!.cluster.leave();
    await awaitCondition(
      () => leaderSeenBy(c!) === b!.cluster.selfAddress.toString() && leaderSeenBy(b!) === b!.cluster.selfAddress.toString(),
      { timeoutMs: 4_000, label: 'the leadership moved to b' },
    );

    const samples: boolean[] = [];
    const sampleUntil = Date.now() + HANDOVER_SAMPLE_MS;
    await awaitCondition(() => {
      samples.push(c!.cluster.sharding.isRegistered(TYPE_NAME), b!.cluster.sharding.isRegistered(TYPE_NAME));
      return Date.now() >= sampleUntil;
    }, { timeoutMs: 4_000, intervalMs: 5, label: 'the handover was sampled' });
    // The precondition that makes the samples mean something: the new
    // coordinator really held no registration for `c` while they were taken.
    expect(coordinatorKnows(b!, c!.cluster.selfAddress)).toBe(false);
    expect(samples.length).toBeGreaterThan(10);
    expect(samples.filter((registered) => !registered)).toEqual([]);

    c!.transport.dropRegisters = false;
    await awaitCondition(() => coordinatorKnows(b!, c!.cluster.selfAddress), {
      timeoutMs: 4_000,
      label: 'c registered with the new coordinator once its frames flowed again',
    });
    expect(c!.cluster.sharding.isRegistered(TYPE_NAME)).toBe(true);
    // And the re-registration announced nothing: no transition happened.
    expect(announcements.length).toBe(announcedBefore);
  }, 20_000);

  test('a refusal on record does not outlive the leader term that refused', async () => {
    // `a` governs the type with 16 shards and refuses `b`'s region, which has
    // 8.  `c` sorts between them and runs nothing for the type, so when `a`
    // leaves the new leader has no coordinator to accept or refuse anything —
    // the case where the old refusal used to stand, naming a coordinator that
    // no longer governs the type.
    const [a, c, b] = await joinAll('refusal-across-leader-change', 62_500, 3);
    startRegion(a!, 16);
    startRegion(b!, 8);
    await awaitCondition(() => b!.cluster.sharding.registrationRefusal(TYPE_NAME) !== null, {
      timeoutMs: 4_000,
      label: 'the first leader refused b\'s region',
    });

    await a!.cluster.leave();
    await awaitCondition(() => leaderSeenBy(b!) === c!.cluster.selfAddress.toString(), {
      timeoutMs: 4_000,
      label: 'b sees the leadership on c',
    });
    const leaderMovedAt = Date.now();
    await awaitCondition(() => b!.cluster.sharding.registrationRefusal(TYPE_NAME) === null, {
      timeoutMs: 2_000,
      label: 'the refusal went with the leader term that issued it',
    });
    expect(Date.now() - leaderMovedAt).toBeLessThan(1_000);
    // Not registered either: nothing has accepted the region yet.
    expect(b!.cluster.sharding.isRegistered(TYPE_NAME)).toBe(false);
  }, 20_000);
});

describe('a region stop and the refusal on record (#853, #1465)', () => {
  test('a stopped refused region keeps its refusal on record', async () => {
    const [a, b] = await joinAll('refusal-survives-stop', 62_520, 2);
    startRegion(a!, 16);
    const refusedRegion = startRegion(b!, 8);
    await awaitCondition(() => b!.cluster.sharding.registrationRefusal(TYPE_NAME) !== null, {
      timeoutMs: 4_000,
      label: 'the coordinator refused b\'s region',
    });
    const refusal = b!.cluster.sharding.registrationRefusal(TYPE_NAME);

    b!.system.stop(refusedRegion);
    await awaitCondition(() => b!.system._resolvePath(regionSegments(b!.system.name, TYPE_NAME)).isNone(), {
      timeoutMs: 4_000,
      label: 'b\'s region stopped',
    });
    expect(b!.cluster.sharding.isRegistered(TYPE_NAME)).toBe(false);
    expect(b!.cluster.sharding.registrationRefusal(TYPE_NAME)).toBe(refusal);
  }, 20_000);
});
