/**
 * `actor-ts.sharding.role` has to change **placement**, not just an options
 * object (#847).
 *
 * The exact-object assertions in `ShardingConfigDefaults.test.ts` prove the
 * reader returns `{ role: 'backend' }`, and `NoDeadConfigKeys` proves something
 * under `src/` mentions the key — but for this leaf that second proof is close
 * to worthless: its read-check is `includes('ConfigKeys.sharding')` and
 * `includes('.role')` in one file, and `.role` is a substring almost any file
 * could carry. So the real gate is here: a role that only ever existed in a
 * config file must reach `ShardCoordinator.candidates()` and remove a member
 * that does not carry it.
 *
 * `candidates()` is asserted directly, off the coordinator instance, *and*
 * through the observable consequence (an entity that does or does not receive
 * its message). Neither alone is enough. The private read is deterministic but
 * would pass for a filter nothing calls; the delivery check is the property
 * users have but cannot distinguish "excluded by role" from "still starting
 * up", which is why the negative case waits on the coordinator's warning rather
 * than on a bare sleep.
 *
 * Single node throughout: one node is enough to make the filter's verdict
 * total, and a second one would add a rebalance pass whose hand-offs look like
 * the thing under test.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { Config } from '../../../../src/config/Config.js';
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';
import { LogLevel } from '../../../../src/Logger.js';
import { coordinatorSegments } from '../../../util/SystemPaths.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';
import { RecordingLogger } from '../../../util/RecordingLogger.js';

type WorkMessage = { readonly id: string; readonly kind: 'work' };

type Message = WorkMessage;

const TYPE_NAME = 'placed';
const NUM_SHARDS = 4;
const ENTITY_ID = 'user-1';

let delivered = 0;

class Entity extends Actor<Message> {
  override onReceive(message: Message): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  private onWork(): void { delivered++; }
}

/** A registry entry as the coordinator keeps it — enough to fabricate one. */
type RegionInfo = {
  readonly node: NodeAddress;
  readonly path: string;
  readonly proxy: boolean;
  readonly shards: Set<number>;
  lastSeenAtMs: number;
  lastHeartbeatAtMs: number | null;
};

/** What the coordinator instance exposes to a test that reaches in. */
interface CoordinatorInternals {
  readonly options: { readonly role?: string; readonly acquireRetryIntervalMs?: number };
  readonly regions: Map<string, RegionInfo>;
  readonly shardHome: Map<number, string>;
  /** `GetShardHome` requests waiting for an allocation, by shard id. */
  readonly pending: Map<number, unknown[]>;
  candidates(): NodeAddress[];
  tryAllocate(shardId: number): void;
}

type Node = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly region: ReturnType<Cluster['sharding']['start']>;
  readonly log: RecordingLogger;
};

type NodeSpec = {
  readonly name: string;
  readonly port: number;
  /** Application-level HOCON, layered over `reference.conf` exactly as at runtime. */
  readonly hocon?: string;
  /**
   * Roles this node declares for itself, through `ClusterOptions.withRoles`
   * here — `actor-ts.cluster.roles` is the config-file way to the same thing.
   */
  readonly roles?: string[];
  /** An explicit `withRole`, to test that it beats the configured one. */
  readonly explicitRole?: string;
  /** Start the type with `startProxy`: a region that routes and never hosts. */
  readonly proxy?: boolean;
};

let running: Node | null = null;

afterEach(async () => {
  if (running) {
    await running.cluster.leave().catch(() => { /* best-effort */ });
    await running.system.terminate().catch(() => { /* best-effort */ });
    running = null;
  }
  delivered = 0;
});

async function startNode(spec: NodeSpec): Promise<Node> {
  const log = new RecordingLogger();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(log)
    .withLogLevel(LogLevel.Debug);
  // `Config.parseString` and not `Config.fromObject({'actor-ts.x': …})`: the
  // latter keeps the dotted string as one literal top-level key, so `hasPath`
  // would go on resolving the nested reference.conf value and the test would
  // assert nothing.
  if (spec.hocon !== undefined) systemOptions.withConfig(Config.parseString(spec.hocon));
  const system = ActorSystem.create(spec.name, systemOptions);

  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(spec.port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(spec.name, 'h', spec.port)))
    .withGossipIntervalMs(30);
  if (spec.roles !== undefined) clusterOptions.withRoles(spec.roles);
  const cluster = await Cluster.join(system, clusterOptions);

  const shardingOptions = StartShardingOptions.create<Message>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(NUM_SHARDS)
    .withRebalanceIntervalMs(600_000)
    .withPassivationIdleMs(0);
  if (spec.explicitRole !== undefined) shardingOptions.withRole(spec.explicitRole);
  const region = spec.proxy === true
    ? cluster.sharding.startProxy<Message>(shardingOptions)
    : cluster.sharding.start<Message>(shardingOptions);

  const node: Node = { system, cluster, region, log };
  running = node;
  return node;
}

function coordinator(node: Node): CoordinatorInternals {
  const resolved = node.system._resolvePath(coordinatorSegments(node.system.name, TYPE_NAME));
  if (resolved.isNone()) throw new Error('coordinator actor not found');
  const cell = (resolved.value as unknown as { getCell?: () => { actor?: unknown } }).getCell?.();
  const actor = cell?.actor;
  if (!actor) throw new Error('coordinator cell holds no actor');
  return actor as unknown as CoordinatorInternals;
}

/** Non-proxy regions the coordinator has recorded — the set `candidates()` filters. */
function registeredRegions(node: Node): number {
  return Array.from(coordinator(node).regions.values()).filter((info) => !info.proxy).length;
}

function roleWarnings(node: Node): string[] {
  return node.log.records
    .filter((record) => record.level === 'warn' && record.message.includes('carries role'))
    .map((record) => record.message);
}

describe('actor-ts.sharding.role reaches shard placement (#847)', () => {
  test('a configured role excludes a member that does not carry it', async () => {
    const node = await startNode({
      name: 'sharding-role-excluded',
      port: 48_401,
      hocon: 'actor-ts.sharding.role = "backend"',
      // The node declares no roles at all — the other half of the setup, and
      // the half an operator who sets only the sharding role leaves out.
    });

    node.region.tell({ id: ENTITY_ID, kind: 'work' });

    // Wait on the coordinator's own verdict rather than on a sleep: reaching
    // the warning means `tryAllocate` ran, found the region registered, and
    // still had no candidate — which is exactly the claim.
    await awaitCondition(() => roleWarnings(node).length === 1, {
      timeoutMs: 4_000,
      label: 'the coordinator reported that no member carries the configured role',
    });

    expect(registeredRegions(node)).toBe(1);
    expect(coordinator(node).candidates()).toEqual([]);
    expect(delivered).toBe(0);
    expect(roleWarnings(node)[0]).toContain('"backend"');
    // The remedy names both places a node's roles come from. An operator who
    // set the role from a config file is the likeliest reader of this line,
    // and may have no code to change at all. The key has to sit in the same
    // sentence as the advice to declare the role — merely mentioning it
    // somewhere in the line would also pass for a sentence saying it is not
    // read.
    expect(roleWarnings(node)[0]).toMatch(/declare(?:(?!\. ).)*\bactor-ts\.cluster\.roles(?![\w-])/);
    expect(roleWarnings(node)[0]).toContain('ClusterOptions.withRoles');

    // One line per episode, not one per shard id: a region under load asks for
    // a home on every message, and a warning per ask would be the noise that
    // gets the whole line filtered out.
    node.region.tell({ id: 'user-2', kind: 'work' });
    node.region.tell({ id: 'user-3', kind: 'work' });
    await awaitCondition(() => registeredRegions(node) === 1, { label: 'the coordinator kept running' });
    expect(roleWarnings(node)).toHaveLength(1);
  });

  test('the same configured role places shards on a member that does carry it', async () => {
    // The positive control. Without it the test above passes for a role filter
    // that excludes everyone, a coordinator that never allocates, and a broken
    // harness alike.
    const node = await startNode({
      name: 'sharding-role-matched',
      port: 48_402,
      hocon: 'actor-ts.sharding.role = "backend"',
      roles: ['backend'],
    });

    node.region.tell({ id: ENTITY_ID, kind: 'work' });
    await awaitCondition(() => delivered === 1, {
      timeoutMs: 4_000,
      label: 'the entity took traffic on the node carrying the configured role',
    });

    expect(coordinator(node).options.role).toBe('backend');
    expect(coordinator(node).candidates()).toHaveLength(1);
    expect(roleWarnings(node)).toEqual([]);
  });

  test('an explicit withRole beats the configured one', async () => {
    // Precedence, observed where it matters rather than on a merged object:
    // HOCON says `backend`, the code says `gpu`, and the node carries only
    // `gpu`. Delivery is therefore possible under exactly one of the two.
    const node = await startNode({
      name: 'sharding-role-explicit-wins',
      port: 48_403,
      hocon: 'actor-ts.sharding.role = "backend"',
      roles: ['gpu'],
      explicitRole: 'gpu',
    });

    node.region.tell({ id: ENTITY_ID, kind: 'work' });
    await awaitCondition(() => delivered === 1, {
      timeoutMs: 4_000,
      label: 'the explicit role decided placement',
    });

    expect(coordinator(node).options.role).toBe('gpu');
  });

  test('the shipped empty placeholder leaves the role unset and placement unrestricted', async () => {
    // What every node that configured nothing runs: `reference.conf` merges
    // under everything, so `role = ""` is present and `hasPath` is true. Read
    // without the empty-string skip it becomes `role: ''` on every options
    // object — which `candidates()` happens to treat as unrestricted, but which
    // would also shadow an explicit `withRole` on the layer above.
    const node = await startNode({ name: 'sharding-role-placeholder', port: 48_404 });

    node.region.tell({ id: ENTITY_ID, kind: 'work' });
    await awaitCondition(() => delivered === 1, {
      timeoutMs: 4_000,
      label: 'an unconfigured node still hosts its own shards',
    });

    expect(coordinator(node).options.role).toBeUndefined();
    expect(roleWarnings(node)).toEqual([]);
  });
});

describe('the role warning reports a misconfiguration, not a phase of startup (#847)', () => {
  test('a cold start with no hosting region registered yet stays silent', async () => {
    // With no non-proxy region at all the cause of "no candidate" is that
    // nobody has registered yet, and a warning there would fire on every
    // healthy cold start. A node that starts only a proxy for the type is the
    // shape that reaches it — a hosting region registers before it ever asks
    // for a home — and it is exactly a routing node that came up before the
    // hosting nodes did.
    const node = await startNode({
      name: 'sharding-role-cold-start',
      port: 48_408,
      hocon: 'actor-ts.sharding.role = "backend"',
      proxy: true,
    });

    node.region.tell({ id: ENTITY_ID, kind: 'work' });

    // `onGetShardHome` records the request as pending and calls `tryAllocate`
    // in the same turn, so once it is pending the warning has already been
    // either written or withheld.
    await awaitCondition(() => coordinator(node).pending.size === 1, {
      timeoutMs: 4_000,
      label: 'the coordinator took the request for a shard home from the proxy',
    });

    expect(coordinator(node).options.role).toBe('backend');
    // A region did register — the proxy — and none of the registered ones hosts.
    expect(coordinator(node).regions.size).toBe(1);
    expect(registeredRegions(node)).toBe(0);
    expect(coordinator(node).candidates()).toEqual([]);
    expect(roleWarnings(node)).toEqual([]);
  });

  test('a role that stops matching after an allocation succeeded is reported again', async () => {
    // One line per episode, and an allocation that succeeds ends the episode.
    // Without that reset a role that goes wrong a second time — the members
    // carrying it left, say — would meet silence, because the first episode's
    // latch never cleared.
    //
    // On one node the role cannot stop matching by itself: a member's roles
    // are fixed at join. So the episodes are made in the registry instead. A
    // region on a node that is no member carries no role at all; registered,
    // it takes the coordinator past the cold-start guard, and filtered out it
    // leaves nowhere to allocate once the local region is out of the map.
    const node = await startNode({
      name: 'sharding-role-reported-again',
      port: 48_409,
      hocon: 'actor-ts.sharding.role = "backend"',
      roles: ['backend'],
    });
    node.region.tell({ id: ENTITY_ID, kind: 'work' });
    await awaitCondition(() => delivered === 1, {
      timeoutMs: 4_000,
      label: 'the local region registered and hosts the entity',
    });

    const internals = coordinator(node);
    const [localKey, localRegion] = Array.from(internals.regions.entries())[0]!;
    const stray = new NodeAddress('peers', 'stray', 2_551);
    const strayPath = '/system/cluster-sharding/stray-region';
    internals.regions.set(`${stray}|${strayPath}`, {
      node: stray,
      path: strayPath,
      proxy: false,
      shards: new Set<number>(),
      lastSeenAtMs: 0,
      lastHeartbeatAtMs: null,
    });
    const roleStopsMatching = (): void => { internals.regions.delete(localKey); };
    const roleMatchesAgain = (): void => { internals.regions.set(localKey, localRegion); };

    // Episode one, asked twice, so the latch is seen to hold within it.
    roleStopsMatching();
    internals.tryAllocate(1);
    internals.tryAllocate(2);
    expect(roleWarnings(node)).toHaveLength(1);

    // The role matches again and an allocation succeeds: the episode is over.
    roleMatchesAgain();
    internals.tryAllocate(1);
    expect(internals.shardHome.get(1)).toBe(localKey);

    // Episode two.
    roleStopsMatching();
    internals.tryAllocate(2);
    expect(roleWarnings(node)).toHaveLength(2);
    expect(roleWarnings(node)[1]).toContain('"backend"');
  });
});

describe('actor-ts.sharding.acquire-retry-interval reaches the coordinator (#847)', () => {
  test('a configured interval replaces the built-in five seconds', async () => {
    const node = await startNode({
      name: 'sharding-acquire-retry',
      port: 48_405,
      hocon: 'actor-ts.sharding.acquire-retry-interval = 1500ms',
    });

    expect(coordinator(node).options.acquireRetryIntervalMs).toBe(1_500);
  });

  test('the reference default arrives as a value, not as an absence', async () => {
    // It used to be a bare `?? 5_000` at the retry site, so "configured" and
    // "defaulted" were indistinguishable from outside. The key is what makes
    // the number reachable, and `DocumentedDefaults` is what keeps the two
    // copies of it equal.
    const node = await startNode({ name: 'sharding-acquire-retry-default', port: 48_406 });

    expect(coordinator(node).options.acquireRetryIntervalMs).toBe(5_000);
  });

  test('a non-positive interval from the config file is refused at start', async () => {
    // Validation runs on the *merged* settings, so a value that only ever
    // existed in HOCON is still checked. Pinned because it looks like a
    // regression from the outside — a config file that used to start and now
    // throws — and is not one.
    const log = new RecordingLogger();
    const systemOptions = ActorSystemOptions.create()
      .withLogger(log)
      .withLogLevel(LogLevel.Off)
      .withConfig(Config.parseString('actor-ts.sharding.acquire-retry-interval = 0s'));
    const system = ActorSystem.create('sharding-acquire-retry-zero', systemOptions);
    const clusterOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(48_407)
      .withSeeds([])
      .withTransport(new InMemoryTransport(new NodeAddress('sharding-acquire-retry-zero', 'h', 48_407)))
      .withGossipIntervalMs(30);
    const cluster = await Cluster.join(system, clusterOptions);
    running = { system, cluster, region: null as unknown as Node['region'], log };

    const shardingOptions = StartShardingOptions.create<Message>()
      .withTypeName(TYPE_NAME)
      .withEntityActor(Entity)
      .withExtractEntityId((message) => message.id);

    expect(() => cluster.sharding.start<Message>(shardingOptions)).toThrow(OptionsError);
  });
});
