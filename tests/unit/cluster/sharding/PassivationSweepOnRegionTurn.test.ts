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
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { Scheduler, type Cancellable } from '../../../../src/Scheduler.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

const TYPE_NAME = 'entity';
const NUM_SHARDS = 4;
const ENTITY_ID = 'user-1';

/**
 * The idle window, and therefore the sweep timer's interval.  Odd on purpose:
 * nothing else a single-node cluster arms runs at this rate, so
 * {@link SweepCapturingScheduler} captures exactly the sweep.  Long enough that
 * two consecutive messages in the region's mailbox are never a window apart.
 */
const SWEEP_WINDOW_MS = 401;

type WorkCommand = { readonly kind: 'work'; readonly id: string };

type Command = WorkCommand;

/** Per entity id: incarnations started, incarnations stopped, messages handled. */
const starts = new Map<string, number>();
const stops = new Map<string, number>();
const handled = new Map<string, number>();

const bump = (counts: Map<string, number>, entityId: string): void => {
  counts.set(entityId, (counts.get(entityId) ?? 0) + 1);
};

class Entity extends Actor<Command> {
  override preStart(): void { bump(starts, this.entityId); }

  override postStop(): void { bump(stops, this.entityId); }

  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  private onWork(): void { bump(handled, this.entityId); }
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
});

async function startNode(systemName: string, port: number): Promise<Node> {
  const scheduler = new SweepCapturingScheduler();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withScheduler(scheduler);
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
    .withPassivationIdleMs(SWEEP_WINDOW_MS)
    // Empty shards are not under test, so the entity window alone sets the pace.
    .withShardPassivationIdleMs(0);
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
    const node = await startNode('sweep-turn', 47_610);
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
