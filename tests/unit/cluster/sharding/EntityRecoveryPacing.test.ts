/**
 * Remembered-entity recovery can be paced (#851).
 *
 * Under `rememberEntities`, a region handed a shard is shipped that shard's
 * whole registry and, before this, spawned every entity in it at once — for
 * every shard it was given.  A node restart or a rebalance therefore opened one
 * journal replay per remembered entity, all in the same tick.
 * `entity-recovery.strategy = constant-rate` spreads those starts instead.
 *
 * ## The assertion that matters is that the budget is REGION-WIDE
 *
 * The queue is fed by every shard the region owns and drained from one front,
 * so `number-of-entities = 2` means two entity starts per window **on this
 * node**.  A per-shard reading of the same key is the plausible wrong
 * implementation — it is what Akka does, and it is what putting the queue in
 * `Shard` would produce — and at the shipped defaults it multiplies the
 * configured rate by the number of shards a node happens to hold.  The `Shard`
 * class's own JSDoc already names this failure mode for `maxEntities`:
 * "Keeping it that thin is what lets `maxEntities` go on meaning 'per node'
 * rather than silently becoming 'per shard'".
 *
 * `a per-shard budget would let this through` is the case written to tell the
 * two apart: two shards, three remembered entities each, a budget of two.
 * Region-wide starts 2; per-shard starts 4.  Every test that ships entities for
 * only *one* shard passes under both readings.
 *
 * ## Why there is no manual clock here
 *
 * The frequency is set to ten minutes, so the *second* batch provably cannot
 * fire inside the test — which makes "exactly two started" an assertion about
 * the cap rather than a race against a timer.  A `ManualScheduler` would freeze
 * the `Cluster` itself (gossip, heartbeat and the failure detector all come off
 * `system.scheduler`), and the region cannot record a coordinator without a
 * leader.  The drain-to-completion case, which genuinely is about elapsed time,
 * uses a short frequency and waits on the observable end state.
 *
 * ## The canary, and why counting alone would not do
 *
 * `preStart` does not run inside `spawn` — it runs on the entity's own first
 * turn — so a poll on "how many have started" can catch a wrong implementation
 * mid-flight and read the right number by accident.  Every capped case
 * therefore routes a real message to one *extra* id after shipping the
 * registries, and waits for that entity instead.
 *
 * The canary is a fence because everything is FIFO behind it: the region takes
 * the routed message only after both `RememberedEntities` turns, it had already
 * told the shards whatever those turns produced, and each spawn is queued
 * before the canary's.  So when the canary has started, so has everything a
 * per-shard or unbounded implementation would have started — and the recorded
 * order says which.  It doubles as the assertion that routing is never
 * throttled: the canary starts at once, ten minutes before its batch would be.
 *
 * ## The harness
 *
 * Lifted from `ShardRegionBuffer.test.ts` (#849), which needed the same thing:
 * a real single-node cluster and a region spawned by hand whose `localResolver`
 * always misses.  `ensureRegistered` records the leader as the coordinator's
 * node *before* it resolves the ref, so the region trusts directives attributed
 * to this node while having nothing to send a `Register` to — which lets a test
 * place a shard and ship it a registry, in that order, by hand.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { NoopLogger } from '../../../../src/Logger.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { hashShardId } from '../../../../src/cluster/sharding/ShardAllocator.js';
import { ShardRegion } from '../../../../src/cluster/sharding/ShardRegion.js';
import type { ShardingOptionsType } from '../../../../src/cluster/sharding/ShardingOptions.js';
import {
  AuthenticatedShardingMessage,
  type RememberedEntities,
  type ShardHome,
} from '../../../../src/cluster/sharding/ShardingProtocol.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

const TYPE_NAME = 'entity';
const NUM_SHARDS = 8;

/**
 * Long enough that no second batch can fire while a test runs, so a count read
 * after the first one is a statement about the cap and not about timing.
 */
const NEVER_AGAIN_MS = 600_000;

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

type Harness = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly region: ActorRef<Command>;
  /** Tell the region the coordinator placed `shardId` here. */
  readonly place: (shardId: number) => void;
  /** Ship `shardId`'s remembered registry, the way the coordinator does. */
  readonly remember: (shardId: number, entityIds: string[]) => void;
  /** Route a real message, which creates its entity on demand. */
  readonly send: (entityId: string) => void;
};

let running: { cluster: Cluster; system: ActorSystem } | null = null;

afterEach(async () => {
  if (running) {
    await running.cluster.leave().catch(() => { /* teardown is best-effort */ });
    await running.system.terminate().catch(() => { /* teardown is best-effort */ });
    running = null;
  }
  started = [];
});

async function startRegion(
  systemName: string,
  port: number,
  recovery: Pick<
    ShardingOptionsType<Command>,
    'entityRecoveryStrategy'
    | 'entityRecoveryConstantRateFrequencyMs'
    | 'entityRecoveryConstantRateNumberOfEntities'
  >,
): Promise<Harness> {
  const system = ActorSystem.create(systemName, ActorSystemOptions.create().withLogger(new NoopLogger()));
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  running = { cluster, system };

  // The region reads the leader once, in `preStart`; without one it records no
  // coordinator node and refuses every directive below.
  await awaitCondition(() => !cluster.leader().isNone(), {
    timeoutMs: 4_000,
    label: 'the single-node cluster elected itself leader',
  });

  const options: ShardingOptionsType<Command> = {
    typeName: TYPE_NAME,
    entityActor: Entity,
    extractEntityId: (message) => message.id,
    numShards: NUM_SHARDS,
    ...recovery,
  };
  const config = ShardRegion.settingsToConfig<Command>(options, cluster, () => null);
  const region = system.spawn<Command>(
    () => new ShardRegion<Command>(config) as unknown as Actor<Command>,
    'region',
  );

  const place = (shardId: number): void => {
    const home: ShardHome = {
      kind: 'sharding.ShardHome',
      shardId,
      region: region.path.toString(),
      node: cluster.selfAddress.toJSON(),
    };
    (region as ActorRef<unknown>).tell(new AuthenticatedShardingMessage(cluster.selfAddress, home));
  };

  const remember = (shardId: number, entityIds: string[]): void => {
    const remembered: RememberedEntities = { kind: 'sharding.RememberedEntities', shardId, entityIds };
    (region as ActorRef<unknown>)
      .tell(new AuthenticatedShardingMessage(cluster.selfAddress, remembered));
  };

  const send = (entityId: string): void => { region.tell({ kind: 'work', id: entityId }); };

  return { system, cluster, region, place, remember, send };
}

/** `count` ids that all hash into `shardId` — a registry is per shard. */
function idsOnShard(shardId: number, count: number): string[] {
  const found: string[] = [];
  for (let index = 0; found.length < count && index < 10_000; index++) {
    const candidate = `user-${index}`;
    if (hashShardId(candidate, NUM_SHARDS) === shardId) found.push(candidate);
  }
  if (found.length < count) throw new Error(`only ${found.length} of ${count} ids hash into shard ${shardId}`);
  return found;
}

const SHARD_A = 0;
const SHARD_B = 1;

describe('constant-rate entity recovery (#851)', () => {
  test('the two id sets used below really do land on different shards', () => {
    // The region-wide case is worthless if they collide, and `hashShardId` is
    // free to change — so this is asserted rather than assumed.
    for (const id of idsOnShard(SHARD_A, 3)) expect(hashShardId(id, NUM_SHARDS)).toBe(SHARD_A);
    for (const id of idsOnShard(SHARD_B, 3)) expect(hashShardId(id, NUM_SHARDS)).toBe(SHARD_B);
  });

  test('a per-shard budget would let this through: two shards, one budget', async () => {
    const harness = await startRegion('851-region-wide', 45_560, {
      entityRecoveryStrategy: 'constant-rate',
      entityRecoveryConstantRateFrequencyMs: NEVER_AGAIN_MS,
      entityRecoveryConstantRateNumberOfEntities: 2,
    });
    const [...onA] = idsOnShard(SHARD_A, 4);
    const canary = onA.pop()!;
    const onB = idsOnShard(SHARD_B, 3);

    harness.place(SHARD_A);
    harness.place(SHARD_B);
    harness.remember(SHARD_A, onA);
    harness.remember(SHARD_B, onB);
    harness.send(canary);

    await awaitCondition(() => started.includes(canary), {
      timeoutMs: 4_000,
      label: 'the canary started, so every recovery start it fences has too',
    });
    // The next batch is ten minutes out and the canary has settled everything
    // before it, so this reads the cap.  Per-shard it would be two per shard,
    // and `onB`'s first two ids would sit between `onA`'s and the canary.
    expect(started).toEqual([...onA.slice(0, 2), canary]);
  });

  test('the batch is the configured size, not a fixed one', async () => {
    const harness = await startRegion('851-batch-size', 45_561, {
      entityRecoveryStrategy: 'constant-rate',
      entityRecoveryConstantRateFrequencyMs: NEVER_AGAIN_MS,
      entityRecoveryConstantRateNumberOfEntities: 5,
    });
    const [...remembered] = idsOnShard(SHARD_A, 7);
    const canary = remembered.pop()!;

    harness.place(SHARD_A);
    harness.remember(SHARD_A, remembered);
    harness.send(canary);

    await awaitCondition(() => started.includes(canary), {
      timeoutMs: 4_000,
      label: 'the canary started, so the whole first batch has too',
    });
    // Five of the six, and the sixth still queued: an unbounded drain would put
    // it between the fifth and the canary.
    expect(started).toEqual([...remembered.slice(0, 5), canary]);
  });

  test('every remembered entity eventually starts', async () => {
    const harness = await startRegion('851-drain', 45_562, {
      entityRecoveryStrategy: 'constant-rate',
      entityRecoveryConstantRateFrequencyMs: 15,
      entityRecoveryConstantRateNumberOfEntities: 2,
    });
    const onA = idsOnShard(SHARD_A, 3);
    const onB = idsOnShard(SHARD_B, 3);

    harness.place(SHARD_A);
    harness.place(SHARD_B);
    harness.remember(SHARD_A, onA);
    harness.remember(SHARD_B, onB);

    // Pacing spreads recovery, it does not shed it: the backlog drains.
    await awaitCondition(() => started.length === 6, {
      timeoutMs: 4_000,
      label: 'all six remembered entities came back',
    });
    expect([...started].sort()).toEqual([...onA, ...onB].sort());
  });

  test('strategy = all keeps the burst — the behaviour before #851', async () => {
    const harness = await startRegion('851-all', 45_563, {
      entityRecoveryStrategy: 'all',
      entityRecoveryConstantRateFrequencyMs: NEVER_AGAIN_MS,
      entityRecoveryConstantRateNumberOfEntities: 2,
    });
    const remembered = idsOnShard(SHARD_A, 6);

    harness.place(SHARD_A);
    harness.remember(SHARD_A, remembered);

    // Under `constant-rate` with the same frequency this would stop at 2 and
    // wait ten minutes, so reaching 6 is the strategy switch being observed.
    await awaitCondition(() => started.length === 6, {
      timeoutMs: 4_000,
      label: 'the unpaced registry started every entity at once',
    });
    expect([...started].sort()).toEqual([...remembered].sort());
  });

  test('real traffic is never throttled, and takes its entity out of the queue', async () => {
    const harness = await startRegion('851-on-demand', 45_564, {
      entityRecoveryStrategy: 'constant-rate',
      entityRecoveryConstantRateFrequencyMs: NEVER_AGAIN_MS,
      entityRecoveryConstantRateNumberOfEntities: 1,
    });
    const remembered = idsOnShard(SHARD_A, 3);
    const [first, , third] = remembered as [string, string, string];

    harness.place(SHARD_A);
    harness.remember(SHARD_A, remembered);
    // Third in the queue, so a paced recovery would not reach it for twenty
    // minutes.  Routing to it must create it now — the queue governs the
    // recovery burst, not the routing path.
    harness.send(third);

    await awaitCondition(() => started.includes(third), {
      timeoutMs: 4_000,
      label: 'the on-demand entity started without waiting for its batch',
    });
    // Exactly two entities exist, in this order: the head of the queue, from
    // the batch of one, and then the on-demand one.  The second of the three
    // remembered ids is still queued behind a ten-minute timer.
    expect(started).toEqual([first, third]);
  });
});
