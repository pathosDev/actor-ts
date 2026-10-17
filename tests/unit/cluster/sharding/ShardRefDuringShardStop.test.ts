/**
 * A shard ref, or a `ToShard` frame, that reaches a region while the shard it
 * names is on its way out — handing off, or passivating.
 *
 * `route` buffers in both states: the shard actor has been told to stop, and
 * a message put into its mailbox goes down with it, to dead letters.  The
 * other two doors into a shard did not ask.  `onToShard` — what a
 * `RemoteShardRef` on another node sends, and what the relaying ref of a
 * backing-off shard sends — told the frame straight to `ensureShard`, which
 * returns whatever shard actor is registered, the stopping one included.  And
 * `shardRef` — what `shardRefFor()` answers with — handed out that same
 * stopping actor, so everything a caller told the ref afterwards was a dead
 * letter.  It is the twin of the registry defect `f9a15cfd` fixed for
 * `RememberedEntities`.
 *
 * The fix applies `route`'s rule to both doors: an entity envelope for a
 * stopping shard waits in the region buffer, and a shard ref for one relays
 * through the region, the way a backing-off shard's already does.  A relayed
 * ref has to outlive a hand-off, so a frame for a shard that has since moved
 * away is routed by its entity like any other message, to the shard's next
 * home, rather than dropped.
 *
 * ## The harness
 *
 * `ShardFailureBackoff.test.ts`'s, trimmed: a real single-node cluster, a
 * region spawned by hand, a probe standing at the coordinator's path, and a
 * scheduler that captures the passivation sweep timer.  Telling a hand-off or
 * firing the sweep, and then the frame or the location query, in one
 * synchronous step puts both in the region's mailbox in that order before the
 * shard can even begin to stop — so the second always lands while the shard is
 * on its way out.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { hashShardId } from '../../../../src/cluster/sharding/ShardAllocator.js';
import { coordinatorPath, shardName, ShardRegion } from '../../../../src/cluster/sharding/ShardRegion.js';
import type { ShardingOptionsType } from '../../../../src/cluster/sharding/ShardingOptions.js';
import {
  AuthenticatedShardingMessage,
  type EntityEnvelope,
  type ShardingMessage,
  type StartEntity,
} from '../../../../src/cluster/sharding/ShardingProtocol.js';
import { Scheduler, type Cancellable } from '../../../../src/Scheduler.js';
import { DeadLetter } from '../../../../src/SystemMessages.js';
import { RecordingLogger } from '../../../util/RecordingLogger.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

const TYPE_NAME = 'entity';
const NUM_SHARDS = 8;
/**
 * The empty-shard window, and with it the sweep timer's interval — held back so
 * the sweep runs when a case fires it.  `ShardFailureBackoff.test.ts` and
 * `RememberedRegistryDuringShardStop.test.ts` use the same number.
 */
const CAPTURED_SWEEP_MS = 53;
/** How long a step may take before the test names the one that stalled. */
const WAIT_MS = 2_000;

type WorkCommand = { readonly kind: 'work'; readonly id: string; readonly sequence: number };

/** `id#sequence` of every work command an entity received, in delivery order. */
let delivered: string[] = [];
/** Every frame the region sent the coordinator's path, unwrapped. */
let coordinatorFrames: ShardingMessage[] = [];
let letters: DeadLetter[] = [];
let subscribed = false;

class Entity extends Actor<WorkCommand> {
  override onReceive(message: WorkCommand): void { delivered.push(`${message.id}#${message.sequence}`); }
}

/** Stands at the coordinator's path: records every frame the region sends there and answers none. */
class CoordinatorProbe extends Actor<unknown> {
  override onReceive(message: unknown): void {
    coordinatorFrames.push(
      message instanceof AuthenticatedShardingMessage ? message.message : message as ShardingMessage,
    );
  }
}

class DeadLetterListener extends Actor<DeadLetter> {
  override preStart(): void {
    this.system.eventStream.subscribe(this.self, DeadLetter);
    subscribed = true;
  }

  override onReceive(letter: DeadLetter): void { letters.push(letter); }
}

/** Holds back the passivation sweep timer and schedules everything else for real. */
class SweepScheduler extends Scheduler {
  private readonly sweeps: Array<() => void> = [];

  override scheduleAtFixedRateFunction(initialDelayMs: number, intervalMs: number, task: () => void): Cancellable {
    if (intervalMs !== CAPTURED_SWEEP_MS) return super.scheduleAtFixedRateFunction(initialDelayMs, intervalMs, task);
    this.sweeps.push(task);
    return { cancel: (): boolean => false, get isCancelled(): boolean { return false; } };
  }

  /** Fire the region's passivation sweep, exactly as its timer would have. */
  fireSweep(): void {
    if (this.sweeps.length !== 1) throw new Error(`expected one captured sweep timer, found ${this.sweeps.length}`);
    this.sweeps[0]!();
  }
}

type Harness = {
  readonly scheduler: SweepScheduler;
  readonly place: (shardId: number) => void;
  readonly handOff: (shardId: number) => void;
  readonly toShard: (shardId: number, message: unknown) => void;
  /** `sharding.GetShardLocation`, sent now — what `ClusterSharding.shardRefFor` asks. */
  readonly locate: (shardId: number) => Promise<ActorRef<unknown>>;
  readonly shardIsUp: (shardId: number) => boolean;
  readonly regionPath: string;
};

let running: { cluster: Cluster; system: ActorSystem } | null = null;

afterEach(async () => {
  if (running) {
    await running.cluster.leave().catch(() => { /* teardown is best-effort */ });
    await running.system.terminate().catch(() => { /* teardown is best-effort */ });
    running = null;
  }
  delivered = [];
  coordinatorFrames = [];
  letters = [];
  subscribed = false;
});

async function startRegion(systemName: string, port: number): Promise<Harness> {
  const scheduler = new SweepScheduler();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new RecordingLogger())
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
  system.spawn(DeadLetterListener, 'dead-letter-listener');
  await awaitCondition(() => subscribed, { timeoutMs: WAIT_MS, label: 'the dead-letter listener subscribed' });
  const probe = system.spawn(CoordinatorProbe, 'coordinator-probe');

  const coordinatorLocation = coordinatorPath(systemName, TYPE_NAME);
  // Entities never idle out; only the empty-shard sweep runs, and only when a
  // case fires it.
  const options: ShardingOptionsType<WorkCommand> = {
    typeName: TYPE_NAME,
    entityActor: Entity,
    extractEntityId: (message) => message.id,
    numShards: NUM_SHARDS,
    passivationIdleMs: 0,
    shardPassivationIdleMs: CAPTURED_SWEEP_MS,
  };
  const resolver = (path: string): ActorRef | null =>
    path === coordinatorLocation || path === probe.path.toString() ? probe as ActorRef : null;
  const config = ShardRegion.settingsToConfig<WorkCommand>(options, cluster, resolver);
  const region = system.spawn<WorkCommand>(
    () => new ShardRegion<WorkCommand>(config) as unknown as Actor<WorkCommand>,
    'region',
  );

  const directive = (message: ShardingMessage): void => {
    (region as ActorRef<unknown>).tell(new AuthenticatedShardingMessage(cluster.selfAddress, message));
  };
  const place = (shardId: number): void => {
    directive({ kind: 'sharding.ShardHome', shardId, region: region.path.toString(), node: cluster.selfAddress.toJSON() });
  };
  const handOff = (shardId: number): void => { directive({ kind: 'sharding.HandOff', shardId }); };
  const toShard = (shardId: number, message: unknown): void => {
    (region as ActorRef<unknown>).tell({ kind: 'sharding.ToShard', shardId, message });
  };
  const locate = (shardId: number): Promise<ActorRef<unknown>> =>
    (region as ActorRef<unknown>).ask<ActorRef<unknown>>({ kind: 'sharding.GetShardLocation', shardId }, WAIT_MS);

  // `_resolvePath` walks from the root, so strip `actor-ts://<system>/`.
  const regionSegments = region.path.toString()
    .replace(/^actor-ts:\/\/[^/]+\//, '')
    .split('/')
    .filter((segment) => segment.length > 0);
  const shardIsUp = (shardId: number): boolean =>
    system._resolvePath([...regionSegments, shardName(shardId)]).isSome();

  return { scheduler, place, handOff, toShard, locate, shardIsUp, regionPath: region.path.toString() };
}

/** `count` ids that all hash into `shardId`. */
function idsOnShard(shardId: number, count: number): string[] {
  const found: string[] = [];
  for (let index = 0; found.length < count && index < 10_000; index++) {
    const candidate = `user-${index}`;
    if (hashShardId(candidate, NUM_SHARDS) === shardId) found.push(candidate);
  }
  if (found.length < count) throw new Error(`only ${found.length} of ${count} ids hash into shard ${shardId}`);
  return found;
}

const SHARD = 5;
const [ID, ID_2] = idsOnShard(SHARD, 2) as [string, string];

function envelope(sequence: number): EntityEnvelope<WorkCommand> {
  return { kind: 'sharding.EntityEnvelope', entityId: ID, message: { kind: 'work', id: ID, sequence } };
}

/** Place the shard here and wait until its actor is up. */
async function placed(harness: Harness): Promise<void> {
  harness.place(SHARD);
  await awaitCondition(() => harness.shardIsUp(SHARD), { timeoutMs: WAIT_MS, label: 'the placed shard is up' });
}

async function handedOff(): Promise<void> {
  await awaitCondition(
    () => coordinatorFrames.some((frame) => frame.kind === 'sharding.HandOffComplete' && frame.shardId === SHARD),
    { timeoutMs: WAIT_MS, label: 'the hand-off completed' },
  );
}

/** The shard has gone empty, on the wall clock the region measures that with, long enough for the sweep. */
async function emptyLongEnough(): Promise<void> {
  const upSince = Date.now();
  await awaitCondition(() => Date.now() - upSince > CAPTURED_SWEEP_MS, {
    timeoutMs: WAIT_MS,
    intervalMs: 10,
    label: 'the shard stood empty for its passivation window',
  });
}

function deadEnvelopes(): DeadLetter[] {
  return letters.filter((letter) => (letter.message as { kind?: unknown } | null)?.kind === 'sharding.EntityEnvelope');
}

describe('a shard on its way out is no door: ToShard and shard refs wait like routed messages (found while #1437)', () => {
  test('a ToShard frame for a shard handing off waits for the shard\'s next home instead of going down with it', async () => {
    const harness = await startRegion('shard-ref-stop-handoff', 47_470);
    await placed(harness);

    harness.handOff(SHARD);
    harness.toShard(SHARD, envelope(1));
    // Not for an entity, so nothing to route it by: refused where it arrived,
    // by the region, rather than handed to the stopping shard.
    const start: StartEntity = { kind: 'sharding.StartEntity', entityId: ID_2 };
    harness.toShard(SHARD, start);
    await handedOff();

    // The coordinator places the shard here again; what waited goes with it.
    harness.place(SHARD);
    await awaitCondition(() => delivered.includes(`${ID}#1`), { timeoutMs: WAIT_MS, label: 'the held envelope arrived' });
    expect(deadEnvelopes()).toEqual([]);
    const isStart = (letter: DeadLetter): boolean =>
      (letter.message as { kind?: unknown } | null)?.kind === 'sharding.StartEntity';
    await awaitCondition(() => letters.some(isStart), { timeoutMs: WAIT_MS, label: 'the StartEntity was dead-lettered' });
    expect(letters.find(isStart)!.recipient.path.toString()).toBe(harness.regionPath);
  }, 10_000);

  test('a ToShard frame for a passivating shard waits for the shard to come back', async () => {
    const harness = await startRegion('shard-ref-stop-passivation', 47_471);
    await placed(harness);
    await emptyLongEnough();

    harness.scheduler.fireSweep();
    harness.toShard(SHARD, envelope(1));
    await awaitCondition(() => delivered.includes(`${ID}#1`), {
      timeoutMs: WAIT_MS,
      label: 'the held envelope reached the re-created shard',
    });
    expect(deadEnvelopes()).toEqual([]);
  }, 10_000);

  test('shardRefFor() during a hand-off relays through the region, so what it is told follows the shard to its next home', async () => {
    const harness = await startRegion('shard-ref-locate-handoff', 47_472);
    await placed(harness);

    harness.handOff(SHARD);
    const located = harness.locate(SHARD);
    const ref = await located;
    expect(ref.path.toString()).toBe(`${harness.regionPath}/${shardName(SHARD)}`);
    await handedOff();

    // Told after the shard left: the region no longer hosts it, finds where it
    // went, and the message goes there.
    ref.tell(envelope(1));
    harness.place(SHARD);
    await awaitCondition(() => delivered.includes(`${ID}#1`), { timeoutMs: WAIT_MS, label: 'the relayed envelope arrived' });
    expect(deadEnvelopes()).toEqual([]);
  }, 10_000);

  test('shardRefFor() during a passivation relays through the region, so what it is told reaches the re-created shard', async () => {
    const harness = await startRegion('shard-ref-locate-passivation', 47_473);
    await placed(harness);
    await emptyLongEnough();

    harness.scheduler.fireSweep();
    const located = harness.locate(SHARD);
    const ref = await located;
    await awaitCondition(() => !harness.shardIsUp(SHARD), { timeoutMs: WAIT_MS, label: 'the empty shard passivated' });

    ref.tell(envelope(1));
    await awaitCondition(() => delivered.includes(`${ID}#1`), { timeoutMs: WAIT_MS, label: 'the relayed envelope arrived' });
    expect(deadEnvelopes()).toEqual([]);
  }, 10_000);
});
