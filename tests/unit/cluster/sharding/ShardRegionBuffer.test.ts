/**
 * `ShardRegion`'s routing buffer is bounded (#849, and #461 which folded into
 * it).  `bufferShard` used to be an unconditional `queue.push` into a
 * `Map<shardId, Array<…>>`, and two of the three `route` branches that reach it
 * mean "the coordinator has not answered yet" — a state that does not have to
 * end.  No leader, a lease the coordinator cannot acquire, or a registration it
 * refused while the region keeps taking traffic all leave the region buffering
 * for as long as they last, and remote peers can drive it through
 * `onRemoteEnvelope`.  Unbounded, the region's answer to a coordinator that
 * never replies is to consume the heap.
 *
 * **The cap is a region-wide total, and that is the assertion that matters.**
 * The buffer is keyed by shard id, so a per-queue cap admits
 * `numShards × bufferSize` — 64 × 100 000 at the shipped defaults — and every
 * test that only ever fills *one* shard passes under both readings.
 * `a per-shard cap would let this through` is the case written to tell them
 * apart: two shards each half-full, and the next message to *either* is
 * dropped.
 *
 * ## The harness
 *
 * A real single-node cluster, and a region spawned by hand with a
 * `localResolver` that always misses.  `ensureRegistered` records the leader as
 * the coordinator's node *before* it resolves the ref, so the region ends up
 * believing in a coordinator it can never reach: nothing is registered, nothing
 * is asked, and every message buffers — while a `ShardHome` this test mints
 * still passes `fromCoordinator`, because it arrives attributed to the node the
 * region already trusts.  That is placement on demand, which is what lets the
 * replay be asserted exactly.
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
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { hashShardId } from '../../../../src/cluster/sharding/ShardAllocator.js';
import { ShardRegion } from '../../../../src/cluster/sharding/ShardRegion.js';
import {
  DEFAULT_REGISTER_RETRY_INTERVAL_MS,
  DEFAULT_SHARD_REGION_BUFFER_SIZE,
} from '../../../../src/cluster/sharding/ShardingOptions.js';
import type { ShardingOptionsType } from '../../../../src/cluster/sharding/ShardingOptions.js';
import {
  AuthenticatedShardingMessage,
  type ShardHome,
} from '../../../../src/cluster/sharding/ShardingProtocol.js';
import { DeadLetter } from '../../../../src/SystemMessages.js';
import { RecordingLogger } from '../../../util/RecordingLogger.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

const TYPE_NAME = 'entity';
const NUM_SHARDS = 8;

type WorkCommand = { readonly kind: 'work'; readonly id: string; readonly sequence: number };

type Command = WorkCommand;

/** Every sequence number that reached an entity, in delivery order. */
let delivered: number[] = [];

class Entity extends Actor<Command> {
  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, (m) => this.onWork(m))
      .exhaustive();
  }

  private onWork(message: WorkCommand): void { delivered.push(message.sequence); }
}

/** Somebody to be the sender, so a dropped message has one to name. */
class Bystander extends Actor<unknown> {
  override onReceive(): void { /* never told anything */ }
}

/** Collects dead letters, plus a fence that proves the burst has landed. */
class DeadLetterListener extends Actor<DeadLetter> {
  override preStart(): void {
    this.system.eventStream.subscribe(this.self, DeadLetter);
    subscribed = true;
  }
  override onReceive(letter: DeadLetter): void { letters.push(letter); }
}

const FENCE = 'fence — every earlier letter is already queued';

let letters: DeadLetter[] = [];
let subscribed = false;

type Harness = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly region: ActorRef<Command>;
  readonly log: RecordingLogger;
  readonly bystander: ActorRef<unknown>;
  /** Send `count` messages for `entityId`, numbered from `from`. */
  readonly send: (entityId: string, from: number, count: number) => void;
  /** Tell the region the coordinator placed `shardId` here, which drains it. */
  readonly place: (shardId: number) => void;
  /** Resolve once every dead letter produced so far has reached the listener. */
  readonly settle: () => Promise<void>;
};

let running: { cluster: Cluster; system: ActorSystem } | null = null;

afterEach(async () => {
  if (running) {
    await running.cluster.leave().catch(() => { /* teardown is best-effort */ });
    await running.system.terminate().catch(() => { /* teardown is best-effort */ });
    running = null;
  }
  delivered = [];
  letters = [];
  subscribed = false;
});

/**
 * A region that can never reach its coordinator, so everything routed through
 * it buffers until this test places a shard by hand.
 */
async function startRegion(systemName: string, port: number, bufferSize: number): Promise<Harness> {
  const log = new RecordingLogger();
  const system = ActorSystem.create(systemName, ActorSystemOptions.create().withLogger(log));
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  running = { cluster, system };

  // The region reads the leader once, in `preStart`; without one it would not
  // record a coordinator node and would refuse the placements below.
  await awaitCondition(() => !cluster.leader().isNone(), {
    timeoutMs: 4_000,
    label: 'the single-node cluster elected itself leader',
  });

  system.spawn(DeadLetterListener, 'dead-letter-listener');
  await awaitCondition(() => subscribed, {
    timeoutMs: 4_000,
    label: 'the dead-letter listener subscribed',
  });
  const bystander = system.spawn(Bystander, 'bystander');

  const options: ShardingOptionsType<Command> = {
    typeName: TYPE_NAME,
    entityActor: Entity,
    extractEntityId: (message) => message.id,
    numShards: NUM_SHARDS,
    bufferSize,
  };
  // `() => null` is the whole trick: `ensureRegistered` sets `coordinatorNode`
  // to the leader before it resolves the ref, so the region trusts this node's
  // directives while having nothing to send a `Register` to.
  const config = ShardRegion.settingsToConfig<Command>(options, cluster, () => null);
  const region = system.spawn<Command>(
    () => new ShardRegion<Command>(config) as unknown as Actor<Command>,
    'region',
  );

  const send = (entityId: string, from: number, count: number): void => {
    for (let index = 0; index < count; index++) {
      region.tell({ kind: 'work', id: entityId, sequence: from + index }, bystander);
    }
  };

  const settle = async (): Promise<void> => {
    system.deadLetters.tell(FENCE);
    await awaitCondition(() => letters.some((l) => l.message === FENCE), {
      timeoutMs: 4_000,
      label: 'the fence letter came back',
    });
  };

  const place = (shardId: number): void => {
    const home: ShardHome = {
      kind: 'sharding.ShardHome',
      shardId,
      region: region.path.toString(),
      node: cluster.selfAddress.toJSON(),
    };
    (region as ActorRef<unknown>).tell(new AuthenticatedShardingMessage(cluster.selfAddress, home));
  };

  return { system, cluster, region, log, bystander, send, place, settle };
}

/** The payloads that were actually dead-lettered, fence excluded. */
const dropped = (): WorkCommand[] =>
  letters.filter((l) => l.message !== FENCE).map((l) => l.message as WorkCommand);

const bufferFullWarnings = (log: RecordingLogger): string[] =>
  log.records.filter((r) => r.level === 'warn' && r.message.includes('buffer')).map((r) => r.message);

/** Any entity id whose shard differs from `other`'s — the region-total case needs two. */
function idOnAnotherShard(other: string): string {
  const otherShard = hashShardId(other, NUM_SHARDS);
  for (let index = 0; index < 1_000; index++) {
    const candidate = `user-${index}`;
    if (hashShardId(candidate, NUM_SHARDS) !== otherShard) return candidate;
  }
  throw new Error('no second shard found in 1000 candidate ids');
}

const ID_A = 'user-a';
const ID_B = idOnAnotherShard(ID_A);
const SHARD_A = hashShardId(ID_A, NUM_SHARDS);
const SHARD_B = hashShardId(ID_B, NUM_SHARDS);

describe('the region buffer is bounded (#849)', () => {
  test('the two entity ids used below really do land on different shards', () => {
    // The discriminating case is worthless if they collide, and `hashShardId`
    // is free to change — so this is asserted rather than assumed.
    expect(SHARD_A).not.toBe(SHARD_B);
  });

  test('past the cap the newest message is dropped and exactly bufferSize replay', async () => {
    const harness = await startRegion('849-cap', 45_460, 4);

    harness.send(ID_A, 1, 6);
    await harness.settle();

    // Drop-newest: 1..4 kept their place, 5 and 6 lost theirs.
    expect(dropped().map((m) => m.sequence)).toEqual([5, 6]);

    harness.place(SHARD_A);
    await awaitCondition(() => delivered.length === 4, {
      timeoutMs: 4_000,
      label: 'the buffered prefix replayed',
    });
    expect(delivered).toEqual([1, 2, 3, 4]);
  });

  test('a dropped message dead-letters with its original sender and the region as recipient', async () => {
    const harness = await startRegion('849-sender', 45_461, 1);

    harness.send(ID_A, 1, 2);
    await harness.settle();

    const letter = letters.find((l) => (l.message as WorkCommand).sequence === 2);
    expect(letter).toBeDefined();
    expect(letter!.sender?.path.toString()).toBe(harness.bystander.path.toString());
    expect(letter!.recipient.path.toString()).toBe(harness.region.path.toString());
  });

  test('the full-buffer warning is latched — one line per episode, not per drop', async () => {
    const harness = await startRegion('849-latch', 45_462, 2);

    harness.send(ID_A, 1, 12);
    await harness.settle();

    expect(dropped()).toHaveLength(10);
    const warnings = bufferFullWarnings(harness.log);
    expect(warnings).toHaveLength(1);
    // The line has to be actionable: both ways to raise the cap by name.
    expect(warnings[0]).toContain('withBufferSize');
    expect(warnings[0]).toContain('actor-ts.sharding.buffer-size');
  });

  test('the warning unlatches once the buffer drains, so a second stall is reported', async () => {
    const harness = await startRegion('849-unlatch', 45_463, 2);

    harness.send(ID_A, 1, 3);
    await harness.settle();
    expect(bufferFullWarnings(harness.log)).toHaveLength(1);

    // Placing A empties the region entirely — B has nothing buffered yet.
    harness.place(SHARD_A);
    await awaitCondition(() => delivered.length === 2, {
      timeoutMs: 4_000,
      label: 'the first shard replayed',
    });

    harness.send(ID_B, 10, 3);
    await harness.settle();
    expect(bufferFullWarnings(harness.log)).toHaveLength(2);
  });

  test('a per-shard cap would let this through: two half-full shards fill the region', async () => {
    // THE discriminating case.  With `bufferSize` read per queue, all six
    // messages are buffered and all six are delivered; with it read as a
    // region total, the fifth and sixth are dropped.  Nothing else in this
    // file tells the two apart.
    const harness = await startRegion('849-region-total', 45_464, 4);

    harness.send(ID_A, 1, 2);
    harness.send(ID_B, 3, 2);
    // The region now holds four across two shards, so the next message to
    // *either* is over the cap — neither queue is.
    harness.send(ID_A, 5, 1);
    harness.send(ID_B, 6, 1);
    await harness.settle();

    expect(dropped().map((m) => m.sequence).sort()).toEqual([5, 6]);

    harness.place(SHARD_A);
    harness.place(SHARD_B);
    await awaitCondition(() => delivered.length === 4, {
      timeoutMs: 4_000,
      label: 'both shards replayed their halves',
    });
    expect([...delivered].sort()).toEqual([1, 2, 3, 4]);
  });

  test('bufferSize = 0 never buffers — the first message dead-letters at once', async () => {
    const harness = await startRegion('849-zero', 45_465, 0);

    harness.send(ID_A, 1, 3);
    await harness.settle();

    expect(dropped().map((m) => m.sequence)).toEqual([1, 2, 3]);

    // And nothing was held back to replay.  Asserted with a fence rather than a
    // bare `toEqual([])`: one message sent *after* placement travels the same
    // region → shard → entity path a replay would, so its arrival proves the
    // path ran and that the three earlier ones were not on it.
    harness.place(SHARD_A);
    harness.send(ID_A, 99, 1);
    await awaitCondition(() => delivered.includes(99), {
      timeoutMs: 4_000,
      label: 'the post-placement message reached the entity',
    });
    expect(delivered).toEqual([99]);
  });
});

describe('ShardRegion.settingsToConfig — the buffer bound and the register retry', () => {
  const resolve = (
    extra: Partial<ShardingOptionsType<Command>>,
  ): ReturnType<typeof ShardRegion.settingsToConfig<Command>> =>
    ShardRegion.settingsToConfig<Command>(
      {
        typeName: TYPE_NAME,
        entityActor: Entity,
        extractEntityId: (message: Command) => message.id,
        ...extra,
      } as ShardingOptionsType<Command>,
      null as unknown as Cluster,
      () => null,
    );

  test('a directly-constructed region is bounded exactly like a HOCON-fed one', () => {
    // The bound is a safety property, so it may not depend on which door the
    // options came through — `ClusterSharding.start` is not the only one.
    const config = resolve({});

    expect(config.bufferSize).toBe(DEFAULT_SHARD_REGION_BUFFER_SIZE);
    expect(config.registerRetryIntervalMs).toBe(DEFAULT_REGISTER_RETRY_INTERVAL_MS);
  });

  test('`0` is a real bufferSize and must not fall through to the default', () => {
    expect(resolve({ bufferSize: 0 }).bufferSize).toBe(0);
  });

  test('an explicit register retry interval reaches the region config', () => {
    expect(resolve({ registerRetryIntervalMs: 2_000 }).registerRetryIntervalMs).toBe(2_000);
  });
});
