/**
 * `GET /cluster/shards?type=<name>` on a **default-configured** cluster —
 * the acceptance criterion of #682.
 *
 * "Default-configured" is the whole point and it is asserted, not just
 * implied: nothing here starts the DistributedData extension and nothing
 * passes a `coordinatorStateStore`. Until #682 the endpoint read the
 * coordinator's DistributedData snapshot, so both of those were preconditions
 * and their absence produced a 404 — the first one before the shard-map key
 * was ever looked at, because nothing in `src/` starts DistributedData at
 * all. The map now comes from `ClusterSharding.shardMap()`, which every node
 * fills from the `ShardMapChanged` its own region republishes.
 *
 * Two nodes rather than one because that is what the criterion says, and
 * because a single node cannot distinguish "the map is on every node" from
 * "the map is on the leader" — the property that makes an operator's request
 * answerable wherever the load balancer sends it.
 */
import { match } from 'ts-pattern';
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { StartShardingOptions } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import { DistributedDataId } from '../../../../../src/crdt/DistributedData.js';
import { HttpExtensionId } from '../../../../../src/http/HttpExtension.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { managementRoutes } from '../../../../../src/management/index.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import type { ServerBinding } from '../../../../../src/http/backend/HttpServerBackend.js';

type PingCommand = { readonly id: string; readonly kind: 'ping' };

type Command = PingCommand;

class Entity extends Actor<Command> {
  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'ping' }, () => this.onPing())
      .exhaustive();
  }

  private onPing(): void {
    this.sender.forEach((sender) => sender.tell('pong'));
  }
}

const SYSTEM_NAME = 'shardmap';
const TYPE_NAME = 'entity';
const NUM_SHARDS = 8;
/** Enough distinct ids that the hash spreads them over more than one shard. */
const ENTITY_IDS = Array.from({ length: 12 }, (_, index) => `entity-${index}`);

/** The endpoint's response body — the JSON form of `ShardMapView`. */
type ShardMapBody = {
  readonly typeName: string;
  readonly leader: string;
  readonly version: number;
  readonly takenAt: number;
  readonly regions: ReadonlyArray<{
    readonly key: string;
    readonly address: string;
    readonly path: string;
    readonly proxy: boolean;
    readonly shards: ReadonlyArray<number>;
  }>;
  readonly shardHome: ReadonlyArray<{ readonly shard: number; readonly regionKey: string }>;
};

type Node = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly region: ActorRef<Command>;
  readonly binding: ServerBinding;
};

async function startNode(
  port: number,
  seeds: ReadonlyArray<string>,
  proxy = false,
): Promise<Node> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(SYSTEM_NAME, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([...seeds])
    .withTransport(new InMemoryTransport(new NodeAddress(SYSTEM_NAME, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  // No `withCoordinatorStateStore`, and DistributedData is never started —
  // that omission is the test.
  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(NUM_SHARDS);
  const region = proxy
    ? cluster.sharding.startProxy<Command>(shardingOptions)
    : cluster.sharding.start<Command>(shardingOptions);
  const binding = await system.extension(HttpExtensionId)
    .newServerAt('127.0.0.1', 0)
    .bind(managementRoutes(system, cluster));
  return { system, cluster, region, binding };
}

async function stopAll(nodes: ReadonlyArray<Node>): Promise<void> {
  for (const node of nodes) {
    await node.binding.unbind();
    await node.cluster.leave();
    await node.system.terminate();
  }
}

async function fetchShardMap(node: Node, typeName = TYPE_NAME): Promise<Response> {
  return await fetch(
    `http://127.0.0.1:${node.binding.port}/cluster/shards?type=${encodeURIComponent(typeName)}`,
  );
}

describe('GET /cluster/shards on a default-configured cluster (#682)', () => {
  test('a two-node cluster returns a real shard map from either node', async () => {
    const base = 45_820;
    const seed = await startNode(base, []);
    const second = await startNode(base + 1, [`${SYSTEM_NAME}@h:${base}`]);
    const nodes = [seed, second];
    try {
      await awaitCondition(
        () => nodes.every((node) => node.cluster.upMembers().length === 2),
        { timeoutMs: 4_000, label: 'both nodes see a two-member cluster' },
      );

      // The coordinator allocates a shard when something asks for one, so a
      // map with placements needs traffic first — `regions` fills on
      // registration, `shardHome` only here.
      for (const id of ENTITY_IDS) {
        expect(await seed.region.ask<string>({ id, kind: 'ping' }, 4_000)).toBe('pong');
      }

      // Both regions registered and the coordinator broadcast the result; the
      // broadcast is coalesced behind a 50 ms timer, so poll for it.
      //
      // The predicate names *both* halves the assertions below read, and that
      // is not belt-and-braces: registration and allocation are two separate
      // broadcasts, so a node can legitimately hold one carrying two regions
      // and an empty `shardHome` while the next one is still in flight. A
      // predicate on `regions` alone let that snapshot through and the
      // `shardHome` assertion failed on whichever node was one broadcast
      // behind.
      const bodies = new Map<number, ShardMapBody>();
      await awaitCondition(
        async () => {
          for (const node of nodes) {
            const response = await fetchShardMap(node);
            if (response.status !== 200) return false;
            bodies.set(node.binding.port, await response.json() as ShardMapBody);
          }
          // `leader` is in here for the same reason: a node stamps the view
          // with the leader it knew when the map arrived, and a registration
          // broadcast can beat local leader election, leaving it ''.
          return [...bodies.values()].every((body) =>
            body.regions.length === 2 && body.shardHome.length > 0 && body.leader !== '');
        },
        {
          timeoutMs: 4_000,
          label: 'both nodes answer 200 with a two-region map holding placed shards',
        },
      );

      expect(bodies.size).toBe(2);
      for (const [port, body] of bodies) {
        const where = `port ${port}`;
        expect(body.typeName, where).toBe(TYPE_NAME);
        expect(body.leader, where).toContain(`${SYSTEM_NAME}@h:`);
        expect(body.version, where).toBeGreaterThan(0);
        expect(body.takenAt, where).toBeGreaterThan(0);
        // A real map: both nodes' regions in it, at one address each.
        expect(new Set(body.regions.map((region) => region.address)).size, where).toBe(2);
        expect(body.regions.every((region) => region.proxy === false), where).toBe(true);
        // Placed shards, and every one of them on a listed region.
        expect(body.shardHome.length, where).toBeGreaterThan(0);
        const regionKeys = new Set(body.regions.map((region) => region.key));
        expect(body.shardHome.every((entry) => regionKeys.has(entry.regionKey)), where).toBe(true);
        expect(
          body.shardHome.every((entry) => entry.shard >= 0 && entry.shard < NUM_SHARDS),
          where,
        ).toBe(true);
        // The per-region id lists and the assignment map are two views of one
        // allocation, so they have to agree.
        const grouped = new Map<string, number[]>();
        for (const entry of body.shardHome) {
          const owned = grouped.get(entry.regionKey) ?? [];
          owned.push(entry.shard);
          grouped.set(entry.regionKey, owned);
        }
        for (const region of body.regions) {
          expect([...region.shards].sort((a, b) => a - b), `${where} ${region.key}`)
            .toEqual((grouped.get(region.key) ?? []).sort((a, b) => a - b));
        }
      }

      // The one thing "default-configured" has to mean here: the old data
      // source is still switched off, so the 200s above did not come from it.
      for (const node of nodes) {
        expect(node.system.extension(DistributedDataId).isStarted()).toBe(false);
      }
    } finally {
      await stopAll(nodes);
    }
  }, 30_000);

  test('a proxy-only node answers too — it hosts nothing and still sees the map', async () => {
    const base = 45_860;
    const host = await startNode(base, []);
    const proxy = await startNode(base + 1, [`${SYSTEM_NAME}@h:${base}`], true);
    const nodes = [host, proxy];
    try {
      await awaitCondition(
        () => nodes.every((node) => node.cluster.upMembers().length === 2),
        { timeoutMs: 4_000, label: 'both nodes see a two-member cluster' },
      );
      // Routed through the proxy on purpose: it has to reach a shard it does
      // not host for the map to be worth anything on this node.
      expect(await proxy.region.ask<string>({ id: ENTITY_IDS[0]!, kind: 'ping' }, 4_000)).toBe('pong');

      let body: ShardMapBody | null = null;
      await awaitCondition(
        async () => {
          const response = await fetchShardMap(proxy);
          if (response.status !== 200) return false;
          body = await response.json() as ShardMapBody;
          // Both halves, for the same reason as above: registration and
          // allocation arrive as two broadcasts.
          return body.regions.length === 2 && body.shardHome.length > 0;
        },
        {
          timeoutMs: 4_000,
          label: 'the proxy node answers 200 with both regions and a placed shard',
        },
      );

      // The precondition the endpoint documents is "a region *or a proxy* for
      // the type", which only holds if the coordinator broadcasts to proxies.
      const proxyRegions = body!.regions.filter((region) => region.proxy);
      expect(proxyRegions).toHaveLength(1);
      expect(proxyRegions[0]!.shards).toEqual([]);
      // Placed shards exist, and none of them landed on the proxy.
      expect(body!.shardHome.length).toBeGreaterThan(0);
      expect(body!.shardHome.some((entry) => entry.regionKey === proxyRegions[0]!.key)).toBe(false);
    } finally {
      await stopAll(nodes);
    }
  }, 30_000);

  test('a type this node does not participate in is a 404, not an empty map', async () => {
    const seed = await startNode(45_840, []);
    try {
      const response = await fetchShardMap(seed, 'never-started');
      expect(response.status).toBe(404);
      // An empty 200 would read as "that type has no shards", which is a
      // different and wrong answer.
      expect(await response.text()).toContain('never-started');
    } finally {
      await stopAll([seed]);
    }
  }, 30_000);

  test('shardMap() is the accessor behind the route, and is null before the first publish', async () => {
    const seed = await startNode(45_850, []);
    try {
      expect(seed.cluster.sharding.shardMap('never-started')).toBeNull();

      expect(await seed.region.ask<string>({ id: ENTITY_IDS[0]!, kind: 'ping' }, 4_000)).toBe('pong');
      await awaitCondition(
        () => seed.cluster.sharding.shardMap(TYPE_NAME) !== null,
        { timeoutMs: 4_000, label: 'the coordinator published a shard map for the type' },
      );

      const view = seed.cluster.sharding.shardMap(TYPE_NAME)!;
      const body = await (await fetchShardMap(seed)).json() as ShardMapBody;
      // The route serialises the accessor's value and adds nothing of its own.
      expect(body.typeName).toBe(view.typeName);
      expect(body.regions.map((region) => region.key)).toEqual(view.regions.map((region) => region.key));
      expect(body.shardHome).toEqual(view.shardHome.map((entry) => ({ ...entry })));
    } finally {
      await stopAll([seed]);
    }
  }, 30_000);
});
