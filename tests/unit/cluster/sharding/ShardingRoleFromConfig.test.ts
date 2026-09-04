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

/** What the coordinator instance exposes to a test that reaches in. */
type CoordinatorInternals = {
  readonly options: { readonly role?: string; readonly acquireRetryIntervalMs?: number };
  readonly regions: Map<string, { readonly proxy: boolean }>;
  candidates(): NodeAddress[];
};

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
  /** Roles this node declares for itself — code-only, deliberately keyless. */
  readonly roles?: string[];
  /** An explicit `withRole`, to test that it beats the configured one. */
  readonly explicitRole?: string;
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
  const region = cluster.sharding.start<Message>(shardingOptions);

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
      // The node declares no roles at all — the half of the picture that stays
      // in code, and the half an operator who edits only the config file omits.
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

  test('the shipped empty placeholder places nothing anywhere', async () => {
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
