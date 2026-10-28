/**
 * What the sharding actors decline is observable (#1441).
 *
 * A declined message goes through `Actor.unhandled`: it becomes a `DeadLetter`
 * naming the actor that declined it, and it ticks
 * `actor_unhandled_total{class}` — the one rate signal that is there by
 * default, since the dead-letter store, and with it `actor_dead_letters_total`,
 * is `off` unless a deployment turns it on.  Each class's `.otherwise` arm used
 * to drop in silence; `tests/multi-node/ShardingUnhandledArms.test.ts` is the
 * other half, showing healthy traffic never reaches those arms.
 *
 * The node is a single-member cluster, so it is its own leader and hosts the
 * coordinator, and the region accepts directives from this node only.  Frames
 * from elsewhere come from a bare transport under its own address, the way
 * `ShardingAuthority.test.ts` forges them: `handleWire` applies no membership
 * check to an envelope, so its sender is an authenticated peer, which is what
 * a newer member of the cluster looks like.  On that path a letter's sender is
 * empty — the frame is re-enqueued without one, and the peer travels only as
 * the wrapper's attribution.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../../src/Actor.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { hashShardId } from '../../../../src/cluster/sharding/ShardAllocator.js';
import { coordinatorPath } from '../../../../src/cluster/sharding/ShardRegion.js';
import type { ShardStats } from '../../../../src/cluster/sharding/ShardingProtocol.js';
import type { WireMessage } from '../../../../src/cluster/Protocol.js';
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { NoopLogger } from '../../../../src/Logger.js';
import { MetricsExtensionId } from '../../../../src/metrics/MetricsExtension.js';
import type { MetricsRegistry } from '../../../../src/metrics/Metrics.js';
import { DeadLetter } from '../../../../src/SystemMessages.js';
import { TestKit } from '../../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../../src/testkit/TestKitOptions.js';
import type { TestProbe } from '../../../../src/testkit/TestProbe.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

const TYPE_NAME = 'entity';
const NUM_SHARDS = 4;

/** How long a fence or a dead letter may take before the test names the step. */
const RECEIVE_TIMEOUT_MS = 2_000;

type WorkCommand = { readonly kind: 'work'; readonly id: string };

type Command = WorkCommand;

/** Every entity id that reached `preStart`, in start order. */
let started: string[] = [];

class Entity extends Actor<Command> {
  override preStart(): void { started.push(this.entityId); }

  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  private onWork(): void { /* the spawn is the whole observation */ }
}

type Node = {
  readonly kit: TestKit;
  readonly cluster: Cluster;
  readonly registry: MetricsRegistry;
  readonly probe: TestProbe;
  readonly region: ActorRef<Command>;
};

const nodes: Node[] = [];
const peers: InMemoryTransport[] = [];

afterEach(async () => {
  await Promise.all(peers.splice(0).map((peer) => peer.shutdown().catch(() => { /* best-effort */ })));
  for (const node of nodes.splice(0)) {
    await node.cluster.leave().catch(() => { /* teardown is best-effort */ });
    await node.kit.system.terminate().catch(() => { /* teardown is best-effort */ });
  }
  started = [];
});

const address = (name: string, port: number): NodeAddress => new NodeAddress(name, 'h', port);

async function startNode(name: string, port: number): Promise<Node> {
  const kit = TestKit.create(name, TestKitOptions.create().withLogger(new NoopLogger()));
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(address(name, port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(kit.system, clusterOptions);
  const registry = kit.system.extension(MetricsExtensionId).enable();
  const probe = kit.createTestProbe();
  kit.system.eventStream.subscribe(probe, DeadLetter);
  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(NUM_SHARDS)
    // A sweep firing mid-test would stop entities for reasons of its own.
    .withPassivationIdleMs(0);
  const region = cluster.sharding.start<Command>(shardingOptions);
  const node: Node = { kit, cluster, registry, probe, region };
  nodes.push(node);
  return node;
}

function countFor(registry: MetricsRegistry, className: string): number {
  return registry.collect()
    .filter((s) => s.name === 'actor_unhandled_total' && s.labels['class'] === className)
    .reduce((total, sample) => total + sample.value, 0);
}

/** `count` entity ids that all hash into one shard. */
function idsOnOneShard(count: number): string[] {
  const shardId = hashShardId('user-0', NUM_SHARDS);
  const found: string[] = [];
  for (let index = 0; found.length < count && index < 10_000; index++) {
    const candidate = `user-${index}`;
    if (hashShardId(candidate, NUM_SHARDS) === shardId) found.push(candidate);
  }
  if (found.length < count) throw new Error(`only ${found.length} of ${count} ids share a shard`);
  return found;
}

/** A bare transport that speaks the wire under its own identity. */
async function bystanderPeer(name: string, port: number): Promise<InMemoryTransport> {
  const transport = new InMemoryTransport(address(name, port));
  transport.setHandler(() => { /* replies are not under test */ });
  await transport.start();
  peers.push(transport);
  return transport;
}

/** Post `body` to the actor at `to` on `node`, as an envelope from `peer`. */
function sendFromPeer(peer: InMemoryTransport, node: Node, to: string, body: unknown): void {
  peer.send(node.cluster.selfAddress, { kind: 'envelope', to, from: null, body } as unknown as WireMessage);
}

/** Start one entity and hand back the ref to the shard hosting it. */
async function liveShard(node: Node, entityId: string): Promise<ActorRef<unknown>> {
  node.region.tell({ id: entityId, kind: 'work' });
  await awaitCondition(() => started.includes(entityId), {
    timeoutMs: 4_000,
    label: `entity '${entityId}' started in its shard`,
  });
  return await node.cluster.sharding.shardRefFor(TYPE_NAME, hashShardId(entityId, NUM_SHARDS));
}

/** The next dead letter addressed to `recipient` (a ref, or its path) whose message has `kind`. */
async function letterFor(node: Node, recipient: ActorRef<unknown> | string, kind: string): Promise<DeadLetter> {
  const path = typeof recipient === 'string' ? recipient : recipient.path.toString();
  return await node.probe.fishForMessage<DeadLetter>(
    (m) => m instanceof DeadLetter
      && m.recipient.path.toString() === path
      && (m.message as { kind?: unknown } | null)?.kind === kind,
    RECEIVE_TIMEOUT_MS,
  );
}

describe('Shard — a stats query with nowhere to answer is declined', () => {
  test('the shard keeps its entities, and the query is a dead letter naming it', async () => {
    const node = await startNode('unhandled-shard-stats', 47_520);
    const [first, second] = idsOnOneShard(2) as [string, string];
    node.region.tell({ id: first, kind: 'work' });
    node.region.tell({ id: second, kind: 'work' });
    await awaitCondition(() => started.length === 2, {
      timeoutMs: 4_000,
      label: 'both entities started in their shard',
    });
    const shard = await node.cluster.sharding.shardRefFor(TYPE_NAME, hashShardId(first, NUM_SHARDS));

    // A `tell` can leave `replyTo` out, and nothing guarantees what sits there
    // otherwise — the type is a promise the sender keeps, not one the shard
    // can rely on.  Both used to throw inside the shard.
    shard.tell({ kind: 'sharding.GetShardStats' } as never);
    shard.tell({ kind: 'sharding.GetShardStats', replyTo: 'not-a-ref' } as never);

    // Answered after both, by the same shard: a throw would have restarted it,
    // and a restarted shard starts with no entities at all.
    const stats = await shard.ask<ShardStats>({ kind: 'sharding.GetShardStats' }, RECEIVE_TIMEOUT_MS);
    expect([...stats.entityIds].sort()).toEqual([first, second].sort());
    expect([...started].sort()).toEqual([first, second].sort());

    const missing = await letterFor(node, shard, 'sharding.GetShardStats');
    expect(missing.message).toEqual({ kind: 'sharding.GetShardStats' });
    const notARef = await letterFor(node, shard, 'sharding.GetShardStats');
    expect(notARef.message).toEqual({ kind: 'sharding.GetShardStats', replyTo: 'not-a-ref' });
    expect(countFor(node.registry, 'Shard')).toBe(2);
  });

  test('a stats query arriving from another node without a usable reply ref is declined, and the shard keeps every entity running', async () => {
    const node = await startNode('unhandled-shard-stats-peer', 47_522);
    const peer = await bystanderPeer('unhandled-shard-stats-peer-sender', 47_523);
    const [first, second] = idsOnOneShard(2) as [string, string];
    node.region.tell({ id: first, kind: 'work' });
    node.region.tell({ id: second, kind: 'work' });
    await awaitCondition(() => started.length === 2, {
      timeoutMs: 4_000,
      label: 'both entities started in their shard',
    });
    const shard = await node.cluster.sharding.shardRefFor(TYPE_NAME, hashShardId(first, NUM_SHARDS));

    // A stats query relayed through the region from another node, with no
    // reply ref in it.
    sendFromPeer(peer, node, node.region.path.toString(), {
      kind: 'sharding.ToShard',
      shardId: hashShardId(first, NUM_SHARDS),
      message: { kind: 'sharding.GetShardStats' },
    });

    const letter = await letterFor(node, shard, 'sharding.GetShardStats');
    expect(letter.message).toEqual({ kind: 'sharding.GetShardStats' });
    const stats = await shard.ask<ShardStats>({ kind: 'sharding.GetShardStats' }, RECEIVE_TIMEOUT_MS);
    expect([...stats.entityIds].sort()).toEqual([first, second].sort());
    expect([...started].sort()).toEqual([first, second].sort());
    expect(countFor(node.registry, 'Shard')).toBe(1);
  });

  test('a reply ref that is not this module\'s ActorRef but has a tell, an equals and a path is answered', async () => {
    const node = await startNode('unhandled-shard-stats-foreign', 47_524);
    const [first, second] = idsOnOneShard(2) as [string, string];
    node.region.tell({ id: first, kind: 'work' });
    node.region.tell({ id: second, kind: 'work' });
    await awaitCondition(() => started.length === 2, {
      timeoutMs: 4_000,
      label: 'both entities started in their shard',
    });
    const shard = await node.cluster.sharding.shardRefFor(TYPE_NAME, hashShardId(first, NUM_SHARDS));

    // What a ref minted by another copy of this module looks like from here:
    // every member a ref offers, and no instance of this copy's class.
    const answered: unknown[] = [];
    const foreign = {
      tell: (message: unknown): void => { answered.push(message); },
      equals: (other: unknown): boolean => other === foreign,
      path: { name: 'foreign', toString: (): string => 'actor-ts://elsewhere/user/foreign' },
    };
    shard.tell({ kind: 'sharding.GetShardStats', replyTo: foreign } as never);

    await awaitCondition(() => answered.length === 1, { timeoutMs: 4_000, label: 'the shard answered the reply ref' });
    const reply = answered[0] as ShardStats;
    expect(reply.kind).toBe('sharding.ShardStats');
    expect([...reply.entityIds].sort()).toEqual([first, second].sort());
    expect(countFor(node.registry, 'Shard')).toBe(0);
  });

  test('a reply ref with a tell but no equals or no path is declined, and the shard keeps every entity running', async () => {
    const node = await startNode('unhandled-shard-stats-partial', 47_526);
    const [first, second] = idsOnOneShard(2) as [string, string];
    node.region.tell({ id: first, kind: 'work' });
    node.region.tell({ id: second, kind: 'work' });
    await awaitCondition(() => started.length === 2, {
      timeoutMs: 4_000,
      label: 'both entities started in their shard',
    });
    const shard = await node.cluster.sharding.shardRefFor(TYPE_NAME, hashShardId(first, NUM_SHARDS));

    const told: unknown[] = [];
    const tellOnly = { tell: (message: unknown): void => { told.push(message); } };
    const noPath = { tell: (message: unknown): void => { told.push(message); }, equals: (): boolean => false };
    shard.tell({ kind: 'sharding.GetShardStats', replyTo: tellOnly } as never);
    shard.tell({ kind: 'sharding.GetShardStats', replyTo: noPath } as never);

    // Answered after both, by the same shard and its same two entities.
    const stats = await shard.ask<ShardStats>({ kind: 'sharding.GetShardStats' }, RECEIVE_TIMEOUT_MS);
    expect([...stats.entityIds].sort()).toEqual([first, second].sort());
    expect(told).toEqual([]);
    expect((await letterFor(node, shard, 'sharding.GetShardStats')).message).toEqual({
      kind: 'sharding.GetShardStats',
      replyTo: tellOnly,
    });
    expect((await letterFor(node, shard, 'sharding.GetShardStats')).message).toEqual({
      kind: 'sharding.GetShardStats',
      replyTo: noPath,
    });
    expect(countFor(node.registry, 'Shard')).toBe(2);
  });
});

describe('Shard — a message no arm claims is declined', () => {
  test('a stray message and a misdirected sharding kind are dead letters naming the shard', async () => {
    const node = await startNode('unhandled-shard-stray', 47_530);
    const [entityId] = idsOnOneShard(1) as [string];
    const shard = await liveShard(node, entityId);

    // A shard ref is a public handle, so nothing stops a caller telling it
    // something that is not a shard message at all — or a sharding kind that
    // belongs to the region.
    shard.tell({ kind: 'app.stray' } as never);
    shard.tell({
      kind: 'sharding.ShardHome',
      shardId: 0,
      region: 'elsewhere',
      node: node.cluster.selfAddress.toJSON(),
    } as never);

    const stray = await letterFor(node, shard, 'app.stray');
    expect(stray.message).toEqual({ kind: 'app.stray' });
    expect(stray.sender).toBeNull();
    await letterFor(node, shard, 'sharding.ShardHome');
    expect(countFor(node.registry, 'Shard')).toBe(2);
    // Declining is all it does: the shard and its entity carry on.
    const stats = await shard.ask<ShardStats>({ kind: 'sharding.GetShardStats' }, RECEIVE_TIMEOUT_MS);
    expect([...stats.entityIds]).toEqual([entityId]);
  });

  test('a stray message a peer sends through a shard ref is declined by the shard', async () => {
    const node = await startNode('unhandled-shard-peer', 47_540);
    const peer = await bystanderPeer('unhandled-shard-peer-sender', 47_541);
    const [entityId] = idsOnOneShard(1) as [string];
    const shard = await liveShard(node, entityId);

    // What a `RemoteShardRef` on another node sends when it is told something:
    // the owning region forwards the payload to its shard as it is.
    sendFromPeer(peer, node, node.region.path.toString(), {
      kind: 'sharding.ToShard',
      shardId: hashShardId(entityId, NUM_SHARDS),
      message: { kind: 'app.from-a-peer' },
    });

    const letter = await letterFor(node, shard, 'app.from-a-peer');
    expect(letter.message).toEqual({ kind: 'app.from-a-peer' });
    expect(countFor(node.registry, 'Shard')).toBe(1);
    expect(countFor(node.registry, 'ShardRegion')).toBe(0);
  });
});

describe('ShardRegion — a sharding kind no arm claims is declined', () => {
  test('a coordinator-only kind and an unknown kind from a peer are dead letters naming the region', async () => {
    const node = await startNode('unhandled-region-peer', 47_550);
    const peer = await bystanderPeer('unhandled-region-peer-sender', 47_551);
    // A live entity first: the region is registered and routing, so what
    // follows is declined by a working region, not by one still starting.
    await liveShard(node, 'user-0');
    const regionPath = node.region.path.toString();

    // A heartbeat is something only a region says, to the coordinator.
    const heartbeat = {
      kind: 'sharding.RegionHeartbeat',
      region: 'elsewhere',
      node: address('unhandled-region-peer-sender', 47_551).toJSON(),
    };
    sendFromPeer(peer, node, regionPath, heartbeat);
    // Any `sharding.` kind reaches the region's dispatch — a newer member's
    // protocol arrives here as a kind this build has no arm for.
    sendFromPeer(peer, node, regionPath, { kind: 'sharding.FromANewerMember', payload: 1 });

    const coordinatorOnly = await letterFor(node, node.region, 'sharding.RegionHeartbeat');
    expect(coordinatorOnly.message).toEqual(heartbeat);
    expect(coordinatorOnly.sender).toBeNull();
    const unknown = await letterFor(node, node.region, 'sharding.FromANewerMember');
    expect(unknown.message).toEqual({ kind: 'sharding.FromANewerMember', payload: 1 });
    expect(countFor(node.registry, 'ShardRegion')).toBe(2);
  });

  test('a shard message told to the region instead of the shard is a dead letter naming the region', async () => {
    const node = await startNode('unhandled-region-local', 47_560);
    await liveShard(node, 'user-0');

    // Both are shard messages: they belong on a shard ref, and the region does
    // not forward them to one.
    (node.region as ActorRef<unknown>).tell({ kind: 'sharding.StartEntity', entityId: 'user-1' });
    (node.region as ActorRef<unknown>).tell({ kind: 'sharding.GetShardStats', replyTo: node.probe });

    const start = await letterFor(node, node.region, 'sharding.StartEntity');
    expect(start.message).toEqual({ kind: 'sharding.StartEntity', entityId: 'user-1' });
    await letterFor(node, node.region, 'sharding.GetShardStats');
    expect(countFor(node.registry, 'ShardRegion')).toBe(2);
    // Declining starts nothing: the only entity is the one routed to above.
    expect(started).toEqual(['user-0']);
  });
});

describe('ShardCoordinator — a sharding kind no arm claims is declined', () => {
  test("a region-side kind and an unknown kind sent to the leader's coordinator are dead letters naming it", async () => {
    const node = await startNode('unhandled-coordinator', 47_570);
    const peer = await bystanderPeer('unhandled-coordinator-sender', 47_571);
    await liveShard(node, 'user-0');
    const coordinator = coordinatorPath(node.kit.system.name, TYPE_NAME);

    // A shard home is something the coordinator says, to a region.  It names
    // no node the authority gate could compare, so an authenticated peer's
    // frame gets as far as the coordinator's dispatch.
    const shardHome = {
      kind: 'sharding.ShardHome',
      shardId: 0,
      region: 'elsewhere',
      node: address('unhandled-coordinator-sender', 47_571).toJSON(),
    };
    sendFromPeer(peer, node, coordinator, shardHome);
    sendFromPeer(peer, node, coordinator, { kind: 'sharding.FromANewerMember', payload: 2 });

    const regionSide = await letterFor(node, coordinator, 'sharding.ShardHome');
    expect(regionSide.message).toEqual(shardHome);
    expect(regionSide.sender).toBeNull();
    const unknown = await letterFor(node, coordinator, 'sharding.FromANewerMember');
    expect(unknown.message).toEqual({ kind: 'sharding.FromANewerMember', payload: 2 });
    expect(countFor(node.registry, 'ShardCoordinator')).toBe(2);
    // Declining is all it does: the coordinator still places a shard nobody
    // has asked about before.
    const elsewhere = Array.from({ length: 100 }, (_unused, index) => `user-${index}`)
      .find((id) => hashShardId(id, NUM_SHARDS) !== hashShardId('user-0', NUM_SHARDS));
    if (elsewhere === undefined) throw new Error('no id hashes outside the first shard');
    await liveShard(node, elsewhere);
  });
});
