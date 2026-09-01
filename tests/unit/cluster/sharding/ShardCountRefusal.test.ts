/**
 * What a `numShards` refusal has to reach to be a fix (#633).
 *
 * The mechanism itself landed earlier and is covered by
 * `tests/integration/in-process/cluster/sharding/ShardCountMismatch.test.ts`:
 * the count travels in `RegisterRegion`, the coordinator refuses a region that
 * disagrees, and a refused region is neither a placement candidate nor answered
 * by `onGetShardHome`.  Three things it did not reach are pinned here.
 *
 * **The diagnostic.**  Refusing is only useful if the operator can act on it,
 * and the whole of that is one `error` line on the region.  It named
 * `actor-ts.sharding.num-shards`, a key that exists nowhere — `reference.conf`
 * ships `number-of-shards`.  Nothing caught it: no test looked at the message
 * (`ShardCountMismatch.test.ts` runs a `NoopLogger` at `LogLevel.Off`, so the
 * line is never even produced) and `NoDeadConfigKeys` walks `reference.conf` →
 * `ConfigKeys`, so an *invented* key inside a free-text string is outside its
 * direction of travel.
 *
 * **The coordinator-state snapshot.**  `loadCoordinatorState` wrote regions
 * straight from the snapshot into `regions`, filtered only by current
 * membership and by "already known via `Register`".  `candidates()` is built
 * from `regions` and `tryAllocate` pushes a `ShardHome` at whoever the strategy
 * picks, so with a `coordinatorStateStore` configured the refusal was bypassed
 * outright: a leader change to a differently-configured node adopts the
 * previous leader's map and re-establishes the split routing through the load
 * path, where the `Register` handshake never runs.
 *
 * **The shards the region already hosts.**  Refusing a registration closes the
 * front door and nothing else: `onRegisterRefused` set a flag and logged, so a
 * region accepted by leader N and refused by leader N+1 kept the `localShards`
 * and `shardHomes` the first coordinator gave it and kept delivering out of
 * that cache — and could not be relieved of them either, since
 * `ShardCoordinator.beginHandOff` only writes to regions it has in `regions`.
 * The refusal now releases them.
 *
 * These run against a real single-node cluster and reach the coordinator and
 * the region by path.  Single node on purpose: this node is its own leader, so
 * the coordinator's node — the one origin a region accepts a directive from,
 * and the one a coordinator accepts a claim from — is this address, and a frame
 * the test wraps itself is exactly what the genuine local leg produces.
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
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { hashShardId } from '../../../../src/cluster/sharding/ShardAllocator.js';
import {
  AuthenticatedShardingMessage,
  type ShardingMessage,
} from '../../../../src/cluster/sharding/ShardingProtocol.js';
import type {
  CoordinatorStateData,
  CoordinatorStateStore,
} from '../../../../src/cluster/sharding/CoordinatorState.js';
import { ShardRegionRegistrationRefused } from '../../../../src/cluster/ClusterEvents.js';
import { MetricsExtensionId, metricsOf } from '../../../../src/metrics/MetricsExtension.js';
import { ConfigKeys } from '../../../../src/config/ConfigKeys.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import type { LogContextData } from '../../../../src/LogContext.js';
import { LogLevel, type Logger } from '../../../../src/Logger.js';
import { coordinatorSegments, regionSegments } from '../../../util/SystemPaths.js';
import { awaitCondition, sleep } from '../../../util/AwaitCondition.js';

type WorkCommand = { id: string; kind: 'work' };

type Command = WorkCommand;

const TYPE_NAME = 'entity';
const NUM_SHARDS = 8;
const ENTITY_ID = 'user-1';
/** A region path no actor occupies, so only the snapshot can put it in `regions`. */
const GHOST_PATH = '/system/cluster/sharding/region-ghost';

let delivered = 0;

class Entity extends Actor<Command> {
  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  private onWork(): void { delivered++; }
}

type LogRecord = { readonly level: string; readonly message: string };

/**
 * Collects everything the system logger was told, including through
 * `withSource` — which is the only way the region's own line arrives, since
 * every actor logs through a source-bound child.
 */
class RecordingLogger implements Logger {
  readonly records: LogRecord[] = [];

  constructor(
    readonly level: LogLevel = LogLevel.Debug,
    private readonly root: RecordingLogger | null = null,
  ) {}

  private get sink(): RecordingLogger { return this.root ?? this; }

  private record(level: string, message: string): void {
    this.sink.records.push({ level, message });
  }

  debug(message: string): void { this.record('debug', message); }
  info(message: string): void { this.record('info', message); }
  warn(message: string): void { this.record('warn', message); }
  error(message: string): void { this.record('error', message); }

  withSource(_source: string): Logger { return new RecordingLogger(this.level, this.sink); }
  withFields(_fields: LogContextData): Logger { return new RecordingLogger(this.level, this.sink); }
}

/**
 * A `CoordinatorStateStore` whose `load` can be held open.
 *
 * The gate is what makes the fire-and-forget ordering testable rather than
 * lucky: `onLeaderChanged` starts the load with `void`, so a `Register` refused
 * while the store call is still outstanding is the case a guard hoisted above
 * the loop would miss, and holding `load` reproduces it exactly.
 */
class FakeCoordinatorStateStore implements CoordinatorStateStore {
  loadCalls = 0;
  readonly saved: CoordinatorStateData[] = [];
  private openGate: (() => void) | null = null;
  private readonly gate: Promise<void>;

  constructor(
    private readonly snapshot: CoordinatorStateData | null,
    gated = false,
  ) {
    this.gate = gated
      ? new Promise<void>((resolve) => { this.openGate = resolve; })
      : Promise.resolve();
  }

  async load(): Promise<CoordinatorStateData | null> {
    this.loadCalls++;
    await this.gate;
    return this.snapshot;
  }

  async save(_typeName: string, state: CoordinatorStateData): Promise<void> {
    this.saved.push(state);
  }

  /** Let a gated `load` return. */
  open(): void { this.openGate?.(); }
}

type Node = {
  system: ActorSystem;
  cluster: Cluster;
  region: ActorRef<Command>;
  log: RecordingLogger;
};

/** The coordinator's allocation state, read straight off the actor instance. */
type CoordinatorState = {
  readonly regions: Map<string, { readonly path: string; readonly shards: Set<number> }>;
  readonly shardHome: Map<number, string>;
  readonly refusedRegions: Set<string>;
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

async function startNode(
  systemName: string,
  port: number,
  store?: FakeCoordinatorStateStore,
): Promise<Node> {
  const log = new RecordingLogger();
  const systemOptions = ActorSystemOptions.create().withLogger(log);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);

  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(NUM_SHARDS)
    // A sweep firing mid-test would move ownership for its own reasons.
    .withPassivationIdleMs(0);
  if (store !== undefined) shardingOptions.withCoordinatorStateStore(store);
  const region = cluster.sharding.start<Command>(shardingOptions);

  const node: Node = { system, cluster, region, log };
  running = node;

  if (store !== undefined) {
    // The load is already in flight, and every store here is gated, so it is
    // still outstanding: `Cluster.subscribe` replays the current
    // `LeaderChanged` to a new listener, so a coordinator whose `preStart`
    // lands on the leader takes the "just became leader" branch immediately —
    // the same branch a real leadership move takes, without staging one.
    await awaitCondition(() => store.loadCalls > 0, {
      timeoutMs: 5_000,
      label: 'the coordinator started reading its state snapshot',
    });
  }

  // One real round trip, so both actors have finished `preStart`: the region's
  // registration is what sets the coordinator's node — the one origin a
  // directive is accepted from — and it also proves the matching count passes.
  region.tell({ id: ENTITY_ID, kind: 'work' });
  await awaitCondition(() => delivered === 1, {
    timeoutMs: 5_000,
    label: 'the entity came up, so region and coordinator are both live',
  });
  return node;
}

function refFor(node: Node, segments: string[]): ActorRef<ShardingMessage | AuthenticatedShardingMessage> {
  const resolved = node.system._resolvePath(segments);
  if (resolved.isNone()) throw new Error(`no actor at ${segments.join('/')}`);
  return resolved.value as ActorRef<ShardingMessage | AuthenticatedShardingMessage>;
}

/** Hand the region a directive the way its own coordinator's local leg would. */
function tellAsCoordinator(node: Node, message: ShardingMessage): void {
  refFor(node, regionSegments(node.system.name, TYPE_NAME))
    .tell(new AuthenticatedShardingMessage(node.cluster.selfAddress, message));
}

/** Hand the coordinator a claim the way a region on this node would. */
function tellAsRegion(node: Node, message: ShardingMessage): void {
  refFor(node, coordinatorSegments(node.system.name, TYPE_NAME))
    .tell(new AuthenticatedShardingMessage(node.cluster.selfAddress, message));
}

/** Whether the shard actor for `shardId` is alive on `node` right now. */
function shardPresent(node: Node, shardId: number): boolean {
  return node.system._resolvePath([
    ...regionSegments(node.system.name, TYPE_NAME),
    `shard-${shardId}`,
  ]).isSome();
}

/** Whether the entity beneath that shard is alive on `node` right now. */
function entityPresent(node: Node, shardId: number): boolean {
  return node.system._resolvePath([
    ...regionSegments(node.system.name, TYPE_NAME),
    `shard-${shardId}`,
    `entity-${ENTITY_ID}`,
  ]).isSome();
}

function coordinatorState(node: Node): CoordinatorState {
  const resolved = node.system._resolvePath(coordinatorSegments(node.system.name, TYPE_NAME));
  if (resolved.isNone()) throw new Error('coordinator actor not found');
  const cell = (resolved.value as unknown as { getCell?: () => { actor?: unknown } }).getCell?.();
  const actor = cell?.actor;
  if (!actor) throw new Error('coordinator cell holds no actor');
  return actor as CoordinatorState;
}

/**
 * The address a node started by {@link startNode} will have.
 *
 * Derived rather than read back off the node, because a snapshot has to exist
 * *before* the coordinator that loads it — the store is constructor-injected.
 */
function addressOf(systemName: string, port: number): NodeAddress {
  return new NodeAddress(systemName, 'h', port);
}

/** The `regionKey` the coordinator derives for a region on `address` at `path`. */
function keyFor(address: NodeAddress, path: string): string {
  return `${address}|${path}`;
}

/**
 * A snapshot naming one region per path on `address`, each owning one shard.
 *
 * `numShards === undefined` produces a snapshot from before the field existed,
 * which is the shape already sitting in a `DistributedData` register on any
 * cluster that opted into the store before this change.
 */
function snapshotNaming(
  address: NodeAddress,
  paths: readonly string[],
  numShards: number | undefined,
): CoordinatorStateData {
  // Shard ids the live entity cannot hash to, so adopting the snapshot never
  // collides with the placement the setup round trip made.
  const firstShardId = (hashShardId(ENTITY_ID, NUM_SHARDS) + 1) % NUM_SHARDS;
  const regions = paths.map((path, index) => ({
    key: keyFor(address, path),
    node: address.toJSON(),
    path,
    proxy: false,
    shards: [(firstShardId + index) % NUM_SHARDS],
  }));
  const base = {
    leader: address.toString(),
    takenAt: Date.now(),
    regions,
    shardHome: regions.map((region) => [region.shards[0]!, region.key] as const),
  };
  return numShards === undefined ? base : { ...base, numShards };
}

describe('a numShards refusal names a key that exists (#633)', () => {
  test('the refusal tells the operator the real HOCON key', async () => {
    const node = await startNode('refusal-diagnostic', 47_600);

    // The frame the coordinator sends when it refuses. Delivered through the
    // region's own accept path — wrapped, from the coordinator's node — because
    // an unattributed one is dropped by the origin gate (#584) before any
    // diagnostic is produced.
    tellAsCoordinator(node, {
      kind: 'sharding.RegisterRefused',
      coordinator: '/system/cluster/sharding/coordinator-entity',
      numShards: NUM_SHARDS,
      regionNumShards: NUM_SHARDS + 1,
    });

    await awaitCondition(
      () => node.log.records.some((record) => record.message.includes('refused to register region')),
      { timeoutMs: 4_000, label: 'the region logged the refusal' },
    );
    const refusal = node.log.records.find((record) =>
      record.message.includes('refused to register region'))!;

    expect(refusal.level).toBe('error');
    // The point of the whole line: the operator can paste this into a config
    // file. `actor-ts.sharding.num-shards` cannot be pasted anywhere.
    expect(refusal.message).toContain('actor-ts.sharding.number-of-shards');
    expect(refusal.message).not.toContain('actor-ts.sharding.num-shards)');
    // And that string is the key `reference.conf` actually ships, not a second
    // spelling that happens to look right.
    expect(ConfigKeys.sharding.numberOfShards).toBe('actor-ts.sharding.number-of-shards');
  }, 20_000);
});

describe('a refused region gives up the shards it already hosts (#633)', () => {
  test('the refusal stops the hosted shard and nothing routes there afterwards', async () => {
    const node = await startNode('refusal-release', 47_606);
    // `startNode`'s round trip allocated this shard here and brought the
    // entity up under it, so the refusal below has something to release —
    // which is the whole difference from a region refused at startup.
    const shardId = hashShardId(ENTITY_ID, NUM_SHARDS);
    expect(shardPresent(node, shardId)).toBe(true);
    expect(entityPresent(node, shardId)).toBe(true);

    // The frame a coordinator on a differently-configured node sends the
    // moment leadership reaches it. Wrapped and from the coordinator's node,
    // because the origin gate (#584) drops an unattributed one.
    tellAsCoordinator(node, {
      kind: 'sharding.RegisterRefused',
      coordinator: '/system/cluster/sharding/coordinator-entity',
      numShards: NUM_SHARDS,
      regionNumShards: NUM_SHARDS + 1,
    });

    // The shard actor's stop is what makes the entity really gone: the runtime
    // reports `Terminated` only once every child has stopped, so the entity
    // cannot outlive the shard here the way a fire-and-forget stop would let
    // it.
    await awaitCondition(() => !shardPresent(node, shardId), {
      timeoutMs: 4_000,
      label: 'the refused region stopped the shard it was hosting',
    });
    expect(entityPresent(node, shardId)).toBe(false);

    // And it stays given up.
    node.region.tell({ id: ENTITY_ID, kind: 'work' });
    // An absence, so a window is the only instrument: both assertions below
    // hold at t=0 and a poll would return on the first tick having proved
    // nothing. Before the fix this message was delivered locally out of the
    // surviving `localShards`/`shardHomes` cache — the second live instance
    // the refusal exists to prevent.
    await sleep(300);
    expect(delivered).toBe(1);
    expect(shardPresent(node, shardId)).toBe(false);
  }, 20_000);
});

/** Refusals recorded for `TYPE_NAME` on this node, as the metric sees them. */
function refusalsCounted(node: Node): number {
  return metricsOf(node.system)
    .counter('cluster_sharding_registrations_refused_total', {
      type: TYPE_NAME, reason: 'num-shards-mismatch',
    }).value;
}

describe('a refusal is observable without scraping the log (#1300)', () => {
  test('it increments the counter, publishes an event and fills the readout', async () => {
    const node = await startNode('refusal-observable', 47_610);
    // Metrics are off unless a system turns them on, which is also the posture
    // of anyone who would alert on this counter.  Enabling it here is what
    // makes the reading below a measurement rather than a default.
    node.system.extension(MetricsExtensionId).enable();
    const seen: ShardRegionRegistrationRefused[] = [];
    node.cluster.subscribe((event) => {
      if (event instanceof ShardRegionRegistrationRefused) seen.push(event);
    });

    // The counter has to be read *before* the refusal too: a metric that was
    // already non-zero would make the assertion below pass on the wrong thing.
    expect(refusalsCounted(node)).toBe(0);

    tellAsCoordinator(node, {
      kind: 'sharding.RegisterRefused',
      coordinator: '/system/cluster/sharding/coordinator-entity',
      numShards: NUM_SHARDS,
      regionNumShards: NUM_SHARDS + 1,
    });

    await awaitCondition(() => seen.length > 0, {
      timeoutMs: 4_000, label: 'the refusal was published as a cluster event',
    });

    expect(refusalsCounted(node)).toBe(1);
    expect(seen[0]?.type).toBe(TYPE_NAME);
    expect(seen[0]?.reason).toBe('num-shards-mismatch');
    // Both counts, because "refused" on its own is the report that sends an
    // operator back to the log this replaces.
    expect(seen[0]?.regionNumShards).toBe(NUM_SHARDS + 1);
    expect(seen[0]?.coordinatorNumShards).toBe(NUM_SHARDS);

    const readout = node.cluster.sharding.registrationRefusal(TYPE_NAME);
    expect(readout?.reason).toBe('num-shards-mismatch');
    expect(readout?.regionNumShards).toBe(NUM_SHARDS + 1);
    expect(node.cluster.sharding.isRegistered(TYPE_NAME)).toBe(false);
  }, 20_000);

  test('a normal registration does none of it', async () => {
    const node = await startNode('refusal-negative', 47_611);
    // Enabled here too, so the zero below means "counted nothing" rather than
    // "counted nothing because metrics were off" — which is the reading that
    // would make this case pass no matter what the refusal path did.
    node.system.extension(MetricsExtensionId).enable();
    const seen: ShardRegionRegistrationRefused[] = [];
    node.cluster.subscribe((event) => {
      if (event instanceof ShardRegionRegistrationRefused) seen.push(event);
    });

    // Waiting for the *positive* signal is what makes the three absences below
    // mean "the registration path ran and refused nothing" rather than "the
    // registration had not happened yet".
    await awaitCondition(() => node.cluster.sharding.isRegistered(TYPE_NAME), {
      timeoutMs: 4_000, label: 'the region registered with the coordinator',
    });

    expect(refusalsCounted(node)).toBe(0);
    expect(seen).toHaveLength(0);
    expect(node.cluster.sharding.registrationRefusal(TYPE_NAME)).toBeNull();
  }, 20_000);
});

describe('a coordinator-state snapshot cannot route around the refusal (#633)', () => {
  test('a snapshot taken under a matching numShards is still adopted', async () => {
    // The positive control for the three cases below: the load path has to keep
    // working, or "not adopted" is satisfied by a coordinator that adopts
    // nothing and the reallocation storm the store exists to avoid is back.
    const address = addressOf('snapshot-agreeing', 47_601);
    const store = new FakeCoordinatorStateStore(
      snapshotNaming(address, [GHOST_PATH], NUM_SHARDS),
      true,
    );
    const node = await startNode('snapshot-agreeing', 47_601, store);

    store.open();
    await awaitCondition(() => coordinatorState(node).regions.has(keyFor(address, GHOST_PATH)), {
      timeoutMs: 4_000,
      label: 'the snapshot region was restored',
    });
  }, 20_000);

  test('a snapshot taken under a different numShards is refused wholesale', async () => {
    // The bypass in one frame. Every shard id in the snapshot was produced by
    // `hash(entityId) % numShards` under the *writer's* count, so adopting the
    // map hands regions shards under two hashes at once — the split the refusal
    // exists to prevent, established through the load path where the `Register`
    // handshake that compares the counts never runs.
    const address = addressOf('snapshot-disagreeing', 47_602);
    const store = new FakeCoordinatorStateStore(
      snapshotNaming(address, [GHOST_PATH], NUM_SHARDS + 1),
      true,
    );
    const node = await startNode('snapshot-disagreeing', 47_602, store);

    store.open();
    // The refusal is logged in the same synchronous block that would otherwise
    // have adopted the regions, so the line arriving *is* the decision having
    // been taken — no fixed delay needed to know the absence below is settled.
    await awaitCondition(
      () => node.log.records.some((record) =>
        record.message.includes('ignoring the coordinator-state snapshot')),
      { timeoutMs: 4_000, label: 'the coordinator said it dropped the snapshot' },
    );

    const state = coordinatorState(node);
    expect(state.regions.has(keyFor(address, GHOST_PATH))).toBe(false);
    expect(Array.from(state.regions.values()).map((info) => info.path)).not.toContain(GHOST_PATH);
  }, 20_000);

  test('a snapshot written before the count was stamped is not adopted either', async () => {
    // Backward compatibility is about *parsing*, not about trusting: a snapshot
    // already sitting in DistributedData from before the field existed states no
    // modulus, so nothing can be checked about it. The fallback is the
    // rebuild-from-`Register` path every default configuration already runs, and
    // the next mutation under this leader writes a stamped snapshot.
    const address = addressOf('snapshot-unstamped', 47_603);
    const store = new FakeCoordinatorStateStore(
      snapshotNaming(address, [GHOST_PATH], undefined),
      true,
    );
    const node = await startNode('snapshot-unstamped', 47_603, store);

    store.open();
    await awaitCondition(
      () => node.log.records.some((record) => record.message.includes('numShards=unstated')),
      { timeoutMs: 4_000, label: 'the coordinator named the unstated modulus' },
    );

    expect(coordinatorState(node).regions.has(keyFor(address, GHOST_PATH))).toBe(false);
  }, 20_000);

  test('a region refused while the load is in flight is not restored by it', async () => {
    // The ordering half. `onLeaderChanged` starts the load with `void`, so a
    // `Register` refused before it resolves leaves `regions.has(key)` false when
    // the loop finally runs — a `refusedRegions` check in front of the loop reads
    // an empty set and lets the entry through. Holding `load` open reproduces
    // that window exactly instead of racing for it.
    const refusedPath = '/system/cluster/sharding/region-refused';
    const keptPath = '/system/cluster/sharding/region-kept';
    const address = addressOf('snapshot-refused-region', 47_604);
    const store = new FakeCoordinatorStateStore(
      snapshotNaming(address, [refusedPath, keptPath], NUM_SHARDS),
      true,
    );
    const node = await startNode('snapshot-refused-region', 47_604, store);

    tellAsRegion(node, {
      kind: 'sharding.Register',
      region: refusedPath,
      node: node.cluster.selfAddress.toJSON(),
      proxy: false,
      hostedShards: [],
      numShards: NUM_SHARDS + 1,
    });
    await awaitCondition(
      () => coordinatorState(node).refusedRegions.has(keyFor(address, refusedPath)),
      { timeoutMs: 4_000, label: 'the mismatching region was refused' },
    );

    store.open();
    // The snapshot's other region is the synchronisation point *and* the
    // discriminator: it lands in the same loop pass, so once it is there the
    // refused one has had its chance and been skipped.
    await awaitCondition(() => coordinatorState(node).regions.has(keyFor(address, keptPath)), {
      timeoutMs: 4_000,
      label: 'the rest of the snapshot was restored',
    });

    const state = coordinatorState(node);
    expect(state.regions.has(keyFor(address, refusedPath))).toBe(false);
    // And it is not a placement candidate through the allocation map either.
    for (const [, key] of state.shardHome) {
      expect(key).not.toBe(keyFor(address, refusedPath));
    }
  }, 20_000);

  test('the snapshot the coordinator writes carries the count it hashed with', async () => {
    // The other end of the same contract: a snapshot with no `numShards` is one
    // this coordinator will refuse next time, so writing one would quietly turn
    // the store off.
    const store = new FakeCoordinatorStateStore(null, true);
    const node = await startNode('snapshot-stamped', 47_605, store);

    await awaitCondition(() => store.saved.length > 0, {
      timeoutMs: 4_000,
      label: 'the coordinator persisted its state at least once',
    });
    for (const snapshot of store.saved) {
      expect(snapshot.numShards).toBe(NUM_SHARDS);
    }
  }, 20_000);
});
