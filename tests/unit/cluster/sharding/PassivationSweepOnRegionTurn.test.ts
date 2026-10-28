/**
 * The passivation sweep decides on the region's own turn.
 *
 * Both sweeps — idle entities, and shards that stood empty — read and write the
 * region's bookkeeping and tell shards to stop.  They used to run inside the
 * scheduler's callback, beside the region's mailbox rather than in it, so a
 * sweep could judge an entity idle while a message for it sat in that mailbox,
 * already sent and not yet routed.  The paced-recovery drain was moved off the
 * same shape for the same reason; the sweep timer's callback now only sends the
 * region a tick, like the recovery timer's.
 *
 * The sweep timer is captured rather than left to fire, so the test fires it at
 * the one moment that tells the two apart: with a message for the entity queued
 * ahead of it.  The idle window itself is real time, because the region stamps
 * activity on the wall clock and nothing observable marks the end of a window,
 * so each sweep waits it out on the wall clock and says so where it does.
 *
 * The empty-shard half has a gap of its own that the turn does not close
 * (#1441).  The region routes a first message to a shard that has stood empty
 * for its window and only learns of the entity that message creates from the
 * shard's spawn report, which comes back behind the tick — so on its own turn
 * the region still saw the shard empty, stopped it, and the entity went down
 * with it before it read its first message.  Those cases fire the sweep in the
 * same synchronous step as that message and watch the entity receive it, through
 * nothing but the public route.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../../src/Actor.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { Passivate } from '../../../../src/cluster/sharding/Passivate.js';
import { hashShardId } from '../../../../src/cluster/sharding/ShardAllocator.js';
import type { ShardInfo } from '../../../../src/cluster/sharding/ShardInfo.js';
import { shardPath } from '../../../../src/cluster/sharding/ShardRegion.js';
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { Scheduler, type Cancellable } from '../../../../src/Scheduler.js';
import { ActorStopped } from '../../../../src/SystemMessages.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

const TYPE_NAME = 'entity';
const NUM_SHARDS = 4;
const ENTITY_ID = 'user-1';
/** The entity a message creates in the empty-shard cases — new to its shard. */
const NEWCOMER = 'user-1';

/**
 * The idle window, and therefore the sweep timer's interval.  Odd on purpose:
 * nothing else a single-node cluster arms runs at this rate, so
 * {@link SweepCapturingScheduler} captures exactly the sweep.  Long enough that
 * two consecutive messages in the region's mailbox are never a window apart.
 */
const SWEEP_WINDOW_MS = 401;

type WorkCommand = { readonly kind: 'work'; readonly id: string };

/** Ask to be passivated, the way an entity that is done with its work does. */
type LeaveCommand = { readonly kind: 'leave'; readonly id: string };

/** The stop-message the shard hands back once it grants the passivation. */
type StopCommand = { readonly kind: 'stop'; readonly id: string };

type Command = WorkCommand | LeaveCommand | StopCommand;

/** Per entity id: incarnations started, incarnations stopped, messages handled. */
const starts = new Map<string, number>();
const stops = new Map<string, number>();
const handled = new Map<string, number>();

/** The path of every actor that stopped, in the order the event stream published them. */
const stoppedActors: string[] = [];

const bump = (counts: Map<string, number>, entityId: string): void => {
  counts.set(entityId, (counts.get(entityId) ?? 0) + 1);
};

/**
 * Records every actor stop the event stream publishes — how a case sees a
 * shard go without asking the region, whose `shards()` answer would
 * re-create a passivated shard to hand out its ref.
 */
class StopListener extends Actor<ActorStopped> {
  override preStart(): void { this.system.eventStream.subscribe(this.self, ActorStopped); }

  override onReceive(event: ActorStopped): void { stoppedActors.push(event.actor.path.toString()); }
}

class Entity extends Actor<Command> {
  override preStart(): void { bump(starts, this.entityId); }

  override postStop(): void { bump(stops, this.entityId); }

  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .with({ kind: 'leave' }, () => this.onLeave())
      .with({ kind: 'stop' }, () => this.onStop())
      .exhaustive();
  }

  private onWork(): void { bump(handled, this.entityId); }

  private onLeave(): void {
    const stopCommand: StopCommand = { kind: 'stop', id: this.entityId };
    this.context.parent.forEach((parent) =>
      parent.tell(new Passivate(stopCommand, this.self) as never, this.self));
  }

  private onStop(): void { this.context.stopSelf(); }
}

/**
 * Captures the region's sweep timer instead of arming it, and schedules
 * everything else for real — a `ManualScheduler` would freeze the cluster the
 * region needs for its coordinator.
 */
class SweepCapturingScheduler extends Scheduler {
  private readonly sweeps: Array<() => void> = [];

  override scheduleAtFixedRateFunction(
    initialDelayMs: number,
    intervalMs: number,
    task: () => void,
  ): Cancellable {
    if (intervalMs !== SWEEP_WINDOW_MS) return super.scheduleAtFixedRateFunction(initialDelayMs, intervalMs, task);
    this.sweeps.push(task);
    let cancelled = false;
    return {
      cancel: (): boolean => {
        if (cancelled) return false;
        cancelled = true;
        return true;
      },
      get isCancelled(): boolean { return cancelled; },
    };
  }

  /** Fire the region's sweep timer, exactly as it would have fired itself. */
  fireSweep(): void {
    if (this.sweeps.length !== 1) throw new Error(`expected one captured sweep timer, found ${this.sweeps.length}`);
    this.sweeps[0]!();
  }
}

type Node = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly scheduler: SweepCapturingScheduler;
  readonly region: ActorRef<Command>;
};

let running: Node | null = null;

afterEach(async () => {
  if (running) {
    await running.cluster.leave().catch(() => { /* teardown is best-effort */ });
    await running.system.terminate().catch(() => { /* teardown is best-effort */ });
    running = null;
  }
  starts.clear();
  stops.clear();
  handled.clear();
  stoppedActors.length = 0;
});

/** Which of the two sweeps a node arms, and how long each window is. */
type SweepWindows = {
  readonly passivationIdleMs: number;
  readonly shardPassivationIdleMs: number;
};

/** Empty shards are not under test, so the entity window alone sets the pace. */
const IDLE_ENTITIES_ONLY: SweepWindows = { passivationIdleMs: SWEEP_WINDOW_MS, shardPassivationIdleMs: 0 };

/** Entity idleness is not under test, so the shard window alone sets the pace. */
const EMPTY_SHARDS_ONLY: SweepWindows = { passivationIdleMs: 0, shardPassivationIdleMs: SWEEP_WINDOW_MS };

async function startNode(systemName: string, port: number, windows: SweepWindows): Promise<Node> {
  const scheduler = new SweepCapturingScheduler();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withScheduler(scheduler);
  const system = ActorSystem.create(systemName, systemOptions);
  system.spawn(StopListener, 'stop-listener');
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
    .withPassivationIdleMs(windows.passivationIdleMs)
    .withShardPassivationIdleMs(windows.shardPassivationIdleMs);
  const region = cluster.sharding.start<Command>(shardingOptions);
  running = { system, cluster, scheduler, region };
  return running;
}

/** The region's set of entities it has asked a shard to passivate. */
function passivatingOf(region: ActorRef<Command>): ReadonlySet<string> {
  const cell = (region as unknown as { getCell?: () => { actor?: { passivating?: Set<string> } } }).getCell?.();
  const passivating = cell?.actor?.passivating;
  if (passivating === undefined) throw new Error('the region actor is not materialised');
  return passivating;
}

/**
 * Let a whole idle window pass on the wall clock, measured from now — call it
 * after a fence that proves the region has stamped the entity's last activity.
 * The region reads `Date.now()`, so no virtual clock can stand in for this.
 */
async function idleForAWindow(): Promise<void> {
  const from = Date.now();
  await awaitCondition(() => Date.now() - from > SWEEP_WINDOW_MS, {
    timeoutMs: 2_000,
    intervalMs: 20,
    label: 'a whole idle window passed on the wall clock',
  });
}

describe('ShardRegion — the passivation sweep runs on the region turn', () => {
  test('a message queued before the sweep timer fired is routed before the sweep decides', async () => {
    const node = await startNode('sweep-turn', 47_610, IDLE_ENTITIES_ONLY);
    node.region.tell({ id: ENTITY_ID, kind: 'work' });
    await awaitCondition(() => handled.get(ENTITY_ID) === 1, {
      timeoutMs: 4_000,
      label: 'the entity handled its first message',
    });
    await idleForAWindow();

    // One synchronous step: the message is in the region's mailbox before the
    // sweep timer fires, so the region has not routed it yet.
    node.region.tell({ id: ENTITY_ID, kind: 'work' });
    node.scheduler.fireSweep();
    // The timer decided nothing by itself — whatever it asked for is queued
    // behind the message.
    expect(passivatingOf(node.region).has(ENTITY_ID)).toBe(false);

    await awaitCondition(() => handled.get(ENTITY_ID) === 2, {
      timeoutMs: 4_000,
      label: 'the entity handled the queued message',
    });
    // Handled by the incarnation that was already running: the sweep saw the
    // queued message's activity and let the entity be.
    expect(starts.get(ENTITY_ID)).toBe(1);
    expect(stops.get(ENTITY_ID) ?? 0).toBe(0);

    // With nothing queued ahead of it, the same tick still sweeps.
    await idleForAWindow();
    node.scheduler.fireSweep();
    await awaitCondition(() => stops.get(ENTITY_ID) === 1, {
      timeoutMs: 4_000,
      label: 'the idle entity was passivated on the next sweep',
    });
    expect(starts.get(ENTITY_ID)).toBe(1);
  }, 15_000);
});

/** An entity id other than `entityId` that hashes into the same shard. */
function neighbourOf(entityId: string): string {
  const shardId = hashShardId(entityId, NUM_SHARDS);
  for (let index = 0; index < 10_000; index++) {
    const candidate = `user-${index}`;
    if (candidate !== entityId && hashShardId(candidate, NUM_SHARDS) === shardId) return candidate;
  }
  throw new Error(`no other id shares a shard with '${entityId}'`);
}

/** The node's view of one shard, asked through the public `shards()` query. */
async function shardInfoOf(node: Node, shardId: number): Promise<ShardInfo | undefined> {
  const shards = await node.cluster.sharding.shards(TYPE_NAME);
  return shards.find((shard) => shard.shardId === shardId);
}

/**
 * Wait until the newcomer's two messages have an outcome either way: handled,
 * or the entity stopped before it got to them.  Waiting for the handling alone
 * would make the broken case cost the whole budget and say less.
 */
async function newcomerSettled(): Promise<void> {
  await awaitCondition(() => (handled.get(NEWCOMER) ?? 0) >= 2 || (stops.get(NEWCOMER) ?? 0) > 0, {
    timeoutMs: 4_000,
    label: 'the newcomer handled both messages, or stopped first',
  });
}

/**
 * The tail every empty-shard case shares: the sweep still stops the shard once
 * it really is empty, on the very next tick — so a shard the sweep let be is
 * back in the sweep's hands rather than left marked as stopping.
 */
async function sweptOnceEmpty(node: Node, shardId: number): Promise<void> {
  const shard = shardPath(node.region.path.toString(), shardId);
  node.region.tell({ id: NEWCOMER, kind: 'leave' });
  await awaitCondition(async () => (await shardInfoOf(node, shardId))?.entityCount === 0, {
    timeoutMs: 4_000,
    label: 'the region saw the newcomer passivate and the shard empty',
  });
  expect(stoppedActors).not.toContain(shard);
  await idleForAWindow();
  node.scheduler.fireSweep();
  await awaitCondition(() => stoppedActors.includes(shard), {
    timeoutMs: 4_000,
    label: 'the empty shard was passivated on the next sweep',
  });
}

describe('ShardRegion — the empty-shard sweep stops no shard it has just handed work (#1441)', () => {
  test('a shard placed and never used: the first message for a new entity reaches it with the sweep queued behind it', async () => {
    const node = await startNode('sweep-empty-placed', 47_620, EMPTY_SHARDS_ONLY);
    const shardId = hashShardId(NEWCOMER, NUM_SHARDS);
    // Placing the shard creates its actor with nothing in it, which is where
    // its empty clock starts.
    await node.cluster.sharding.shardRefFor(TYPE_NAME, shardId);
    await idleForAWindow();

    // One synchronous step: the first message for an entity the shard does not
    // have yet is in the region's mailbox ahead of the sweep tick, and a second
    // one behind it, which arrives while the sweep's outcome is still open.
    node.region.tell({ id: NEWCOMER, kind: 'work' });
    node.scheduler.fireSweep();
    node.region.tell({ id: NEWCOMER, kind: 'work' });
    await newcomerSettled();

    // Both reached the one incarnation the first message created.
    expect(stops.get(NEWCOMER) ?? 0).toBe(0);
    expect(handled.get(NEWCOMER)).toBe(2);
    expect(starts.get(NEWCOMER)).toBe(1);

    await sweptOnceEmpty(node, shardId);
  }, 15_000);

  test('a shard emptied by its last entity: the first message for a new entity reaches it with the sweep queued behind it', async () => {
    const node = await startNode('sweep-empty-emptied', 47_621, EMPTY_SHARDS_ONLY);
    const shardId = hashShardId(NEWCOMER, NUM_SHARDS);
    const previous = neighbourOf(NEWCOMER);
    node.region.tell({ id: previous, kind: 'work' });
    await awaitCondition(() => handled.get(previous) === 1, {
      timeoutMs: 4_000,
      label: 'the shard\'s only entity handled its message',
    });
    // It passivates, and the region's report of that is where the shard's empty
    // clock starts — so the window is waited out from the region's view of it.
    node.region.tell({ id: previous, kind: 'leave' });
    await awaitCondition(async () => (await shardInfoOf(node, shardId))?.entityCount === 0, {
      timeoutMs: 4_000,
      label: 'the region saw the shard\'s last entity stop',
    });
    await idleForAWindow();

    node.region.tell({ id: NEWCOMER, kind: 'work' });
    node.scheduler.fireSweep();
    node.region.tell({ id: NEWCOMER, kind: 'work' });
    await newcomerSettled();

    expect(stops.get(NEWCOMER) ?? 0).toBe(0);
    expect(handled.get(NEWCOMER)).toBe(2);
    expect(starts.get(NEWCOMER)).toBe(1);

    await sweptOnceEmpty(node, shardId);
  }, 15_000);
});
