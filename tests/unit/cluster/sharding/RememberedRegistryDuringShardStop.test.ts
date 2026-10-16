/**
 * A remembered registry that reaches a region while the shard it is for is on
 * its way out (#851, the unpaced half).
 *
 * Under `entity-recovery.strategy = all` the region answered every
 * `RememberedEntities` with `ensureShard(shardId).tell(StartEntities)`, and
 * `ensureShard` returns whatever shard actor is registered — including one the
 * region has already told to stop.  The start then sat behind the stop in that
 * actor's mailbox and went with it, so a registry that arrived during a shard
 * passivation was lost: the shard came back empty while the coordinator still
 * listed every entity.  Narrow, because a shard is only passivated while it is
 * empty and an empty shard normally has an empty registry, but reachable: a
 * leader change makes the coordinator ship every registry again, whatever the
 * region is doing with the shard at that moment.
 *
 * The paced strategy had the same defect and lost it first: its drain now
 * holds an entry while the entry's shard passivates and drops it while the
 * shard hands off.  This file holds the unpaced path to the same two rules —
 * a passivation keeps the shard this region's, so the registry is started once
 * the shard is back, and a hand-off gives it away, so the registry is for the
 * new owner, which the coordinator ships it to.
 *
 * ## The harness
 *
 * The one `EntityRecoveryPacing.test.ts` uses, trimmed: a real single-node
 * cluster and a region spawned by hand whose `localResolver` always misses, so
 * a test places shards and ships registries itself; and a scheduler that
 * captures the passivation sweep timer, so a shard passivates when a test fires
 * the sweep and at no other moment.  Firing the sweep and shipping the registry
 * in one synchronous step puts both in the region's mailbox, in that order,
 * before the shard can even begin to stop — so the registry lands while the
 * shard is passivating, every time.
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
import { LogLevel } from '../../../../src/Logger.js';
import { Scheduler, type Cancellable } from '../../../../src/Scheduler.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { hashShardId } from '../../../../src/cluster/sharding/ShardAllocator.js';
import { ShardRegion, shardName } from '../../../../src/cluster/sharding/ShardRegion.js';
import type { ShardingOptionsType } from '../../../../src/cluster/sharding/ShardingOptions.js';
import {
  AuthenticatedShardingMessage,
  type HandOff,
  type RememberedEntities,
  type ShardHome,
} from '../../../../src/cluster/sharding/ShardingProtocol.js';
import { DeadLetter } from '../../../../src/SystemMessages.js';
import { RecordingLogger } from '../../../util/RecordingLogger.js';
import { awaitCondition, sleep } from '../../../util/AwaitCondition.js';

const TYPE_NAME = 'entity';
const NUM_SHARDS = 8;

/**
 * The empty-shard window, and with it the sweep timer's interval.  An odd
 * number so the scheduler below captures exactly that timer; short, because
 * the window is measured on the wall clock and every case waits it out once.
 */
const CAPTURED_SWEEP_MS = 53;

type WorkCommand = { readonly kind: 'work'; readonly id: string };

type Command = WorkCommand;

/** Every entity id that reached `preStart`, in start order. */
let started: string[] = [];

/** Every dead letter the system produced, for the cases that look for a lost start. */
let letters: DeadLetter[] = [];
let subscribed = false;

class Entity extends Actor<Command> {
  override preStart(): void { started.push(this.entityId); }

  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  private onWork(): void { /* the spawn is the whole observation */ }
}

class DeadLetterListener extends Actor<DeadLetter> {
  override preStart(): void {
    this.system.eventStream.subscribe(this.self, DeadLetter);
    subscribed = true;
  }

  override onReceive(letter: DeadLetter): void { letters.push(letter); }
}

/** Captures the region's passivation sweep timer and schedules everything else for real. */
class SweepScheduler extends Scheduler {
  private readonly sweeps: Array<() => void> = [];

  override scheduleAtFixedRateFunction(
    initialDelayMs: number,
    intervalMs: number,
    task: () => void,
  ): Cancellable {
    if (intervalMs !== CAPTURED_SWEEP_MS) return super.scheduleAtFixedRateFunction(initialDelayMs, intervalMs, task);
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

type Harness = {
  readonly system: ActorSystem;
  readonly scheduler: SweepScheduler;
  readonly log: RecordingLogger;
  readonly place: (shardId: number) => void;
  readonly moveAway: (shardId: number) => void;
  readonly handOff: (shardId: number) => void;
  readonly remember: (shardId: number, entityIds: string[]) => void;
  readonly shardIsUp: (shardId: number) => boolean;
};

let running: { cluster: Cluster; system: ActorSystem } | null = null;

afterEach(async () => {
  if (running) {
    await running.cluster.leave().catch(() => { /* teardown is best-effort */ });
    await running.system.terminate().catch(() => { /* teardown is best-effort */ });
    running = null;
  }
  started = [];
  letters = [];
  subscribed = false;
});

async function startRegion(systemName: string, port: number): Promise<Harness> {
  const scheduler = new SweepScheduler();
  const log = new RecordingLogger();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(log)
    .withLogLevel(LogLevel.Debug)
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
  await awaitCondition(() => subscribed, { timeoutMs: 4_000, label: 'the dead-letter listener subscribed' });

  const options: ShardingOptionsType<Command> = {
    typeName: TYPE_NAME,
    entityActor: Entity,
    extractEntityId: (message) => message.id,
    numShards: NUM_SHARDS,
    // `all` is the strategy under test, and the default; named so it reads.
    entityRecoveryStrategy: 'all',
    // Entities never idle out here; only the shard sweep runs, on the captured timer.
    passivationIdleMs: 0,
    shardPassivationIdleMs: CAPTURED_SWEEP_MS,
  };
  const config = ShardRegion.settingsToConfig<Command>(options, cluster, () => null);
  const region = system.spawn<Command>(
    () => new ShardRegion<Command>(config) as unknown as Actor<Command>,
    'region',
  );

  const directive = (message: ShardHome | RememberedEntities | HandOff): void => {
    (region as ActorRef<unknown>).tell(new AuthenticatedShardingMessage(cluster.selfAddress, message));
  };
  const place = (shardId: number): void => {
    directive({ kind: 'sharding.ShardHome', shardId, region: region.path.toString(), node: cluster.selfAddress.toJSON() });
  };
  const moveAway = (shardId: number): void => {
    directive({
      kind: 'sharding.ShardHome',
      shardId,
      region: `/system/cluster-sharding/${TYPE_NAME}-region`,
      node: new NodeAddress(`${systemName}-elsewhere`, 'h', port + 1).toJSON(),
    });
  };
  const handOff = (shardId: number): void => { directive({ kind: 'sharding.HandOff', shardId }); };
  const remember = (shardId: number, entityIds: string[]): void => {
    directive({ kind: 'sharding.RememberedEntities', shardId, entityIds });
  };

  // `_resolvePath` walks from the root, so strip `actor-ts://<system>/`.
  const regionSegments = region.path.toString()
    .replace(/^actor-ts:\/\/[^/]+\//, '')
    .split('/')
    .filter((segment) => segment.length > 0);
  const shardIsUp = (shardId: number): boolean =>
    system._resolvePath([...regionSegments, shardName(shardId)]).isSome();

  return { system, scheduler, log, place, moveAway, handOff, remember, shardIsUp };
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

/**
 * Let one empty-shard window pass on the wall clock — the region stamps a
 * shard's emptiness with `Date.now()`, and nothing observable marks the end of
 * a window, so no fence can stand in for this.
 */
async function waitOutSweepWindow(): Promise<void> {
  const from = Date.now();
  await awaitCondition(() => Date.now() - from > CAPTURED_SWEEP_MS, {
    timeoutMs: 2_000,
    intervalMs: 10,
    label: 'one empty-shard window passed on the wall clock',
  });
}

/** Whether the region logged that it passivated `shardId` — the proof the stop really happened. */
function passivated(log: RecordingLogger, shardId: number): boolean {
  return log.records.some((record) => record.message.includes(`passivating empty shard ${shardId} `));
}

/**
 * The entity ids of every dead-lettered `StartEntities` — a start told to a
 * shard that was already stopping.  Ids rather than letters, so a failure
 * prints what was lost instead of the refs around it.
 */
function lostStarts(): string[][] {
  return letters
    .map((letter) => letter.message as { kind?: unknown; entityIds?: string[] } | null)
    .filter((message) => message?.kind === 'sharding.StartEntities')
    .map((message) => [...(message!.entityIds ?? [])]);
}

const SHARD = 3;

describe('a remembered registry under `all` while its shard is stopping (#851)', () => {
  test('one that lands during a passivation is started once the shard is back', async () => {
    const harness = await startRegion('registry-during-passivation', 47_430);
    const ids = idsOnShard(SHARD, 2);
    harness.place(SHARD);
    await awaitCondition(() => harness.shardIsUp(SHARD), { timeoutMs: 2_000, label: 'the placed shard is up' });
    await waitOutSweepWindow();

    // One synchronous step: the sweep tick, then the registry, both queued
    // before the shard can start to stop.
    harness.scheduler.fireSweep();
    harness.remember(SHARD, ids);

    await awaitCondition(() => started.length === ids.length, {
      timeoutMs: 3_000,
      label: 'both remembered entities started in the shard that came back',
    });
    expect([...started].sort()).toEqual([...ids].sort());
    // The discriminator: the shard really did stop in between.  Without it a
    // sweep that passivated nothing would start the registry in the live shard
    // and pass this case for the wrong reason.
    expect(passivated(harness.log, SHARD)).toBe(true);
    expect(lostStarts()).toEqual([]);
  }, 15_000);

  test('one that lands during a hand-off starts nothing here and is not told to the stopping shard', async () => {
    const harness = await startRegion('registry-during-hand-off', 47_431);
    const ids = idsOnShard(SHARD, 2);
    harness.place(SHARD);
    await awaitCondition(() => harness.shardIsUp(SHARD), { timeoutMs: 2_000, label: 'the placed shard is up' });

    harness.handOff(SHARD);
    harness.remember(SHARD, ids);

    await awaitCondition(() => !harness.shardIsUp(SHARD), { timeoutMs: 2_000, label: 'the handed-off shard stopped' });
    // An absence: nothing is meant to start, so a poll would pass on its first
    // read.  The window is what would expose a start the hand-off let through,
    // or a lost one reaching the dead letters on its way out.
    await sleep(200);
    expect(started).toEqual([]);
    expect(lostStarts()).toEqual([]);
  }, 15_000);

  test('one held through a passivation is dropped when the shard moved away in the meantime', async () => {
    const harness = await startRegion('registry-moved-away', 47_432);
    const ids = idsOnShard(SHARD, 2);
    harness.place(SHARD);
    await awaitCondition(() => harness.shardIsUp(SHARD), { timeoutMs: 2_000, label: 'the placed shard is up' });
    await waitOutSweepWindow();

    harness.scheduler.fireSweep();
    harness.remember(SHARD, ids);
    // The coordinator gives the shard to another node while it is stopping
    // here: the registry belongs to that owner now, not to this region.
    harness.moveAway(SHARD);

    await awaitCondition(() => passivated(harness.log, SHARD) && !harness.shardIsUp(SHARD), {
      timeoutMs: 2_000,
      label: 'the shard passivated and stayed down',
    });
    // An absence again: a replay that ignored the move would start both here.
    await sleep(200);
    expect(started).toEqual([]);
    expect(harness.shardIsUp(SHARD)).toBe(false);
  }, 15_000);
});
