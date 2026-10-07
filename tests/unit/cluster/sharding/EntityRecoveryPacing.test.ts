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
 * so `number-of-entities = 2` means two entity starts per window **for this
 * sharded type on this node** — a node runs one region per sharded type, and
 * each region paces its own queue.  A per-shard reading of the same key is the
 * plausible wrong implementation — it is what Akka does, and it is what putting
 * the queue in `Shard` would produce — and at the shipped defaults it
 * multiplies the configured rate by the number of shards a node happens to
 * hold.  The `Shard` class's own JSDoc already names this failure mode for
 * `maxEntities`: "Keeping it that thin is what lets `maxEntities` go on meaning
 * 'per node' rather than silently becoming 'per shard'".
 *
 * `a per-shard budget would let this through` is the case written to tell the
 * two apart: two shards, three remembered entities each, a budget of two.
 * Region-wide starts 2; per-shard starts 4.  Every test that ships entities for
 * only *one* shard passes under both readings.
 *
 * ## Why the batches are fired by hand
 *
 * Every paced test runs the region at {@link CAPTURED_FREQUENCY_MS}, and the
 * system's scheduler captures the one-shot armed with exactly that delay
 * instead of scheduling it.  A batch after the first therefore runs when, and
 * only when, a test fires it — so "exactly two started" is an assertion about
 * the cap rather than a race against a timer, and "the next batch starts these
 * two" can be said at all.  A `ManualScheduler` would freeze the `Cluster`
 * itself (gossip, heartbeat and the failure detector all come off
 * `system.scheduler`), and the region cannot record a coordinator without a
 * leader; capturing one delay leaves every other timer running for real.  The
 * drain-to-completion case, which genuinely is about elapsed time, uses a
 * short real frequency and waits on the observable end state.
 *
 * ## The canary, and why counting alone would not do
 *
 * `preStart` does not run inside `spawn` — it runs on the entity's own first
 * turn — so a poll on "how many have started" can catch a wrong implementation
 * mid-flight and read the right number by accident.  The capped cases
 * therefore route a real message to one *extra* id after shipping the
 * registries, and wait for that entity instead.
 *
 * The canary is a fence because everything is FIFO behind it: the region takes
 * the routed message only after both `RememberedEntities` turns, it had already
 * told the shards whatever those turns produced, and each spawn is queued
 * before the canary's.  So when the canary has started, so has everything a
 * per-shard or unbounded implementation would have started — and the recorded
 * order says which.  It doubles as the assertion that routing is never
 * throttled: the canary starts at once, long before its batch would be.
 *
 * {@link Harness.entitiesOn} is the same fence without the extra entity: it
 * asks the region where a shard lives, which it answers only after every
 * message ahead of the question, and then asks that shard what it holds, which
 * it answers only after every start the region sent it first.  The shard's own
 * index is written in the same step as the spawn, so the answer is exact.
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
import { Scheduler, type Cancellable } from '../../../../src/Scheduler.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { hashShardId } from '../../../../src/cluster/sharding/ShardAllocator.js';
import { ShardRegion } from '../../../../src/cluster/sharding/ShardRegion.js';
import type { ShardingOptionsType } from '../../../../src/cluster/sharding/ShardingOptions.js';
import {
  AuthenticatedShardingMessage,
  type GetShardLocation,
  type RememberedEntities,
  type ShardHome,
  type ShardStats,
} from '../../../../src/cluster/sharding/ShardingProtocol.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

const TYPE_NAME = 'entity';
const NUM_SHARDS = 8;

/**
 * The recovery frequency of every paced test that fires its batches by hand.
 * An odd number on purpose: nothing else a region, a shard or a single-node
 * cluster schedules is armed with it, so {@link RecoveryBatchScheduler} can
 * capture exactly the recovery one-shot and leave every other timer alone.
 */
const CAPTURED_FREQUENCY_MS = 777_777;

/** How long a fence may take before the test names the step that stalled. */
const ASK_TIMEOUT_MS = 2_000;

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

/** One recovery batch the region armed, held back until a test fires it. */
type ArmedBatch = {
  readonly fire: () => void;
  cancelled: boolean;
  fired: boolean;
};

/**
 * Captures the region's recovery one-shot instead of scheduling it, and
 * schedules everything else for real — the shape `BrokerIdleTimeout.test.ts`
 * uses for its deadlines.
 *
 * Wrapping the `Cancellable` rather than only counting arms is what lets a test
 * assert that `postStop` *disarmed* the batch: a stopped region also refuses a
 * tick that fires anyway, so a test that only looked for the absence of a start
 * would pass against a timer that outlives the region.
 */
class RecoveryBatchScheduler extends Scheduler {
  readonly armed: ArmedBatch[] = [];

  override scheduleOnceFunction(delayMs: number, task: () => void): Cancellable {
    if (delayMs !== CAPTURED_FREQUENCY_MS) return super.scheduleOnceFunction(delayMs, task);
    const batch: ArmedBatch = { fire: task, cancelled: false, fired: false };
    this.armed.push(batch);
    return {
      cancel: (): boolean => {
        if (batch.cancelled || batch.fired) return false;
        batch.cancelled = true;
        return true;
      },
      get isCancelled(): boolean { return batch.cancelled || batch.fired; },
    };
  }

  /** Fire the batch the region armed last, exactly as its timer would have. */
  fireNext(): void {
    const batch = this.armed[this.armed.length - 1];
    if (!batch || batch.fired || batch.cancelled) throw new Error('no recovery batch is armed');
    batch.fired = true;
    batch.fire();
  }
}

/**
 * The two parts of the region the paced queue keeps that have no outside
 * symptom.  Read through this view only where the test says why.
 */
type RegionInternals = {
  readonly entityRecoveryQueue: readonly unknown[];
  readonly entityRecoveryHead: number;
};

type Harness = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly region: ActorRef<Command>;
  readonly scheduler: RecoveryBatchScheduler;
  /** The region actor itself; constructed on its first turn, hence a function. */
  readonly internals: () => RegionInternals;
  /** Tell the region the coordinator placed `shardId` here. */
  readonly place: (shardId: number) => void;
  /** Tell the region the coordinator placed `shardId` on another node. */
  readonly moveAway: (shardId: number) => void;
  /** Ship `shardId`'s remembered registry, the way the coordinator does. */
  readonly remember: (shardId: number, entityIds: string[]) => void;
  /** Route a real message, which creates its entity on demand. */
  readonly send: (entityId: string) => void;
  /** The local shard actor for `shardId`, after every message sent before it. */
  readonly shardRef: (shardId: number) => Promise<ActorRef<unknown>>;
  /** The entities `shardId` holds, after every message sent before the question. */
  readonly entitiesOn: (shardId: number) => Promise<string[]>;
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

type RecoverySettings = Pick<
  ShardingOptionsType<Command>,
  'entityRecoveryStrategy' | 'entityRecoveryConstantRateFrequencyMs' | 'entityRecoveryConstantRateNumberOfEntities'
>;

/** `constant-rate` at `numberOfEntities` a batch, every batch after the first fired by hand. */
function paced(numberOfEntities: number): RecoverySettings {
  return {
    entityRecoveryStrategy: 'constant-rate',
    entityRecoveryConstantRateFrequencyMs: CAPTURED_FREQUENCY_MS,
    entityRecoveryConstantRateNumberOfEntities: numberOfEntities,
  };
}

/** What a shard says it holds, sorted so the comparison ignores spawn order. */
async function entityIdsOf(shard: ActorRef<unknown>): Promise<string[]> {
  const stats = await shard.ask<ShardStats>({ kind: 'sharding.GetShardStats' }, ASK_TIMEOUT_MS);
  return [...stats.entityIds].sort();
}

async function startRegion(systemName: string, port: number, recovery: RecoverySettings): Promise<Harness> {
  const scheduler = new RecoveryBatchScheduler();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withScheduler(scheduler);
  const system = ActorSystem.create(systemName, systemOptions);
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
  let instance: ShardRegion<Command> | null = null;
  const region = system.spawn<Command>(
    () => {
      instance = new ShardRegion<Command>(config);
      return instance as unknown as Actor<Command>;
    },
    'region',
  );

  const internals = (): RegionInternals => {
    if (instance === null) throw new Error('the region has not been constructed yet');
    return instance as unknown as RegionInternals;
  };

  const directive = (message: ShardHome | RememberedEntities): void => {
    (region as ActorRef<unknown>).tell(new AuthenticatedShardingMessage(cluster.selfAddress, message));
  };

  const place = (shardId: number): void => {
    directive({
      kind: 'sharding.ShardHome',
      shardId,
      region: region.path.toString(),
      node: cluster.selfAddress.toJSON(),
    });
  };

  const moveAway = (shardId: number): void => {
    directive({
      kind: 'sharding.ShardHome',
      shardId,
      region: `/system/cluster-sharding/${TYPE_NAME}-region`,
      node: new NodeAddress(`${systemName}-elsewhere`, 'h', port + 1).toJSON(),
    });
  };

  const remember = (shardId: number, entityIds: string[]): void => {
    directive({ kind: 'sharding.RememberedEntities', shardId, entityIds });
  };

  const send = (entityId: string): void => { region.tell({ kind: 'work', id: entityId }); };

  const shardRef = async (shardId: number): Promise<ActorRef<unknown>> => {
    const location: GetShardLocation = { kind: 'sharding.GetShardLocation', shardId };
    return await (region as ActorRef<unknown>).ask<ActorRef<unknown>>(location, ASK_TIMEOUT_MS);
  };

  const entitiesOn = async (shardId: number): Promise<string[]> => entityIdsOf(await shardRef(shardId));

  return {
    system, cluster, region, scheduler, internals,
    place, moveAway, remember, send, shardRef, entitiesOn,
  };
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
    const harness = await startRegion('851-region-wide', 45_560, paced(2));
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
    // The next batch only runs when a test fires it, and the canary has settled
    // everything before it, so this reads the cap.  Per-shard it would be two
    // per shard, and `onB`'s first two ids would sit between `onA`'s and the
    // canary.
    expect(started).toEqual([...onA.slice(0, 2), canary]);
  });

  test('the batch is the configured size, not a fixed one', async () => {
    const harness = await startRegion('851-batch-size', 45_561, paced(5));
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
      entityRecoveryConstantRateFrequencyMs: CAPTURED_FREQUENCY_MS,
      entityRecoveryConstantRateNumberOfEntities: 2,
    });
    const remembered = idsOnShard(SHARD_A, 6);

    harness.place(SHARD_A);
    harness.remember(SHARD_A, remembered);

    // Under `constant-rate` with the same frequency this would stop at 2 and
    // wait for a batch nobody fires, so reaching 6 is the strategy switch being
    // observed.
    await awaitCondition(() => started.length === 6, {
      timeoutMs: 4_000,
      label: 'the unpaced registry started every entity at once',
    });
    expect([...started].sort()).toEqual([...remembered].sort());
    // And no batch was ever armed: the burst has nothing left to pace.
    expect(harness.scheduler.armed).toHaveLength(0);
  });

  test('real traffic is never throttled', async () => {
    const harness = await startRegion('851-on-demand', 45_564, paced(1));
    const remembered = idsOnShard(SHARD_A, 3);
    const [first, , third] = remembered as [string, string, string];

    harness.place(SHARD_A);
    harness.remember(SHARD_A, remembered);
    // Third in the queue, so a paced recovery would not reach it for two more
    // batches.  Routing to it must create it now — the queue governs the
    // recovery burst, not the routing path.
    harness.send(third);

    await awaitCondition(() => started.includes(third), {
      timeoutMs: 4_000,
      label: 'the on-demand entity started without waiting for its batch',
    });
    // Exactly two entities exist, in this order: the head of the queue, from
    // the batch of one, and then the on-demand one.  The second of the three
    // remembered ids is still queued behind a batch nobody has fired.
    expect(started).toEqual([first, third]);
  });

  test('an entry for an entity that traffic reached first costs the batch no slot', async () => {
    const harness = await startRegion('851-reached-first', 45_565, paced(2));
    const remembered = idsOnShard(SHARD_A, 5);
    const [, , third, fourth, fifth] = remembered as [string, string, string, string, string];

    harness.place(SHARD_A);
    harness.remember(SHARD_A, remembered);
    // Traffic reaches the fourth while it still waits for the second batch.
    harness.send(fourth);
    await awaitCondition(() => started.includes(fourth), {
      timeoutMs: 4_000,
      label: 'the on-demand entity started',
    });

    harness.scheduler.fireNext();
    // The second batch owes two starts, the third and the fifth.  Charging the
    // fourth's entry to it would make the configured rate mean "at most two",
    // and the fifth would wait for a third batch that need not exist.
    expect(await harness.entitiesOn(SHARD_A)).toEqual([...remembered].sort());
    expect(started.filter((id) => id === third || id === fifth)).toEqual([third, fifth]);
  });

  test('an entry whose shard moved away costs no slot and is never started', async () => {
    const harness = await startRegion('851-moved-away', 45_566, paced(2));
    const onB = idsOnShard(SHARD_B, 3);
    const onA = idsOnShard(SHARD_A, 2);

    harness.place(SHARD_A);
    harness.place(SHARD_B);
    // The first batch starts two of B's; the third waits ahead of both of A's.
    harness.remember(SHARD_B, onB);
    harness.remember(SHARD_A, onA);
    // A rebalance takes B away while its last entity is still queued.  The ref
    // is taken first, while B is still local, so its holdings stay readable.
    const shardB = await harness.shardRef(SHARD_B);
    harness.moveAway(SHARD_B);

    harness.scheduler.fireNext();
    // Both of A's start: B's entry is dropped without spending a slot.
    expect(await harness.entitiesOn(SHARD_A)).toEqual([...onA].sort());
    // And it is dropped, not started — a region that started it would be
    // running an entity of a shard the coordinator has given to someone else.
    expect(await entityIdsOf(shardB)).toEqual(onB.slice(0, 2).sort());
  });

  test('a registry shipped twice is queued once', async () => {
    const harness = await startRegion('851-reshipped', 45_567, paced(2));
    const remembered = idsOnShard(SHARD_A, 6);

    harness.place(SHARD_A);
    harness.remember(SHARD_A, remembered);
    // The first batch has started, and the shard reported both spawns to the
    // region before it answered, so the reports are ahead of the re-ship below.
    expect(await harness.entitiesOn(SHARD_A)).toEqual(remembered.slice(0, 2).sort());

    // Re-shipping is ordinary: a shard that dies outside a handoff asks for its
    // registry again (#894), and a leader change re-registers the region.
    harness.remember(SHARD_A, remembered);
    harness.scheduler.fireNext();
    expect(await harness.entitiesOn(SHARD_A)).toEqual(remembered.slice(0, 4).sort());
    harness.scheduler.fireNext();
    expect(await harness.entitiesOn(SHARD_A)).toEqual([...remembered].sort());

    // Six entities in batches of two: one batch on arrival and two by timer,
    // and no third arm — nothing is owed any more.  The re-shipped entries,
    // had they been queued a second time, would have kept the region arming
    // batches that start nobody.
    expect(harness.scheduler.armed).toHaveLength(2);
  });

  test('stopping the region disarms the batch it was waiting for', async () => {
    const harness = await startRegion('851-stop', 45_568, paced(1));

    harness.place(SHARD_A);
    harness.remember(SHARD_A, idsOnShard(SHARD_A, 3));
    await awaitCondition(() => harness.scheduler.armed.length === 1, {
      timeoutMs: 4_000,
      label: 'the second batch was armed',
    });

    harness.region.stop();
    // The only thing that ever cancels the batch is the region's `postStop`;
    // the drain lets a fired one-shot lapse.  A timer that outlived the region
    // would fire into dead letters on a node that has stopped hosting the type.
    await awaitCondition(() => harness.scheduler.armed[0]!.cancelled, {
      timeoutMs: 4_000,
      label: "the region's postStop cancelled the armed batch",
    });
  });

  test("a batch runs on the region's own turn, never inside the timer callback (#952)", async () => {
    const harness = await startRegion('851-own-turn', 45_569, paced(1));
    const [first, second, canary] = idsOnShard(SHARD_A, 3) as [string, string, string];

    harness.place(SHARD_A);
    harness.remember(SHARD_A, [first, second]);
    await awaitCondition(() => harness.scheduler.armed.length === 1, {
      timeoutMs: 4_000,
      label: 'the second batch was armed',
    });

    // Both in one synchronous step, so the region cannot take a turn between
    // them: the canary is in its mailbox before the timer fires.
    harness.send(canary);
    harness.scheduler.fireNext();

    await awaitCondition(() => started.includes(second) && started.includes(canary), {
      timeoutMs: 4_000,
      label: 'the canary and the second batch both started',
    });
    // On the region's turn the batch queues behind the canary, so the shard
    // spawns the canary first.  A batch run inside the callback would have told
    // the shard before the region even read the canary — and would be reading
    // and mutating the queue concurrently with the mailbox.
    expect(started).toEqual([first, canary, second]);
  });

  test('a drained queue gives its backing array back', async () => {
    const harness = await startRegion('851-release', 45_570, paced(2));
    const remembered = idsOnShard(SHARD_A, 4);

    harness.place(SHARD_A);
    harness.remember(SHARD_A, remembered);
    expect(await harness.entitiesOn(SHARD_A)).toEqual(remembered.slice(0, 2).sort());
    harness.scheduler.fireNext();
    expect(await harness.entitiesOn(SHARD_A)).toEqual([...remembered].sort());

    // Read through the internals because the release has no behavioural
    // symptom: an array that keeps its high-water mark drains exactly like one
    // that does not, and the memory a node handed thousands of remembered
    // entities would keep holding is the whole of the difference.
    const internals = harness.internals();
    expect(internals.entityRecoveryQueue).toHaveLength(0);
    expect(internals.entityRecoveryHead).toBe(0);
  });
});
