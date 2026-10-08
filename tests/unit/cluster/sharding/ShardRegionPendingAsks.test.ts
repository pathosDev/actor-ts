/**
 * `ShardRegion` forgets the callers it can no longer answer (#1436).
 *
 * The region keeps three tables of callers waiting on somebody else: remote
 * entity asks keyed by correlation, `shards()` queries keyed by correlation,
 * and `shardRefFor()` callers keyed by shard.  Only the first carried an
 * expiry, so a query nobody ever answered — a shard id outside the type's
 * range, a coordinator in the middle of an election, a proxy-only type — kept
 * its caller for the life of the region.  One sweep now drains all three, on
 * the region's own turn, at a lifetime no shorter than the deadline the caller
 * itself is waiting out.
 *
 * ## The harness
 *
 * A real single-node cluster, and a region spawned by hand whose
 * `localResolver` misses the coordinator — the shape
 * `ShardRegionBuffer.test.ts` documents — so nothing the region asks for is
 * answered unless this test answers it.  The scheduler is the wall clock with
 * two changes: the time `system.clock` reports can be moved forward, and the
 * region's sweep timer is captured instead of armed, so a test fires it at the
 * moment it means.  A `ManualScheduler` would freeze the cluster the region
 * needs, which is why this is not one.
 *
 * The captured interval doubles as an assertion: the timer runs at the
 * lifetime, so a region that arms it anywhere else fails `fireSweep` by name.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../../src/Actor.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Config } from '../../../../src/config/Config.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { ShardRegion, type ShardRegionConfig } from '../../../../src/cluster/sharding/ShardRegion.js';
import type { ShardingOptionsType } from '../../../../src/cluster/sharding/ShardingOptions.js';
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import {
  AuthenticatedShardingMessage,
  type ClusterShardingStats,
  type GetShardLocation,
  type GetShards,
  type ShardHome,
  type ShardingMessage,
} from '../../../../src/cluster/sharding/ShardingProtocol.js';
import { Scheduler, type Cancellable } from '../../../../src/Scheduler.js';
import { RecordingLogger } from '../../../util/RecordingLogger.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

const TYPE_NAME = 'pending';
const NUM_SHARDS = 8;

/** Placed by every harness, so asking for it is an answer that comes back at once. */
const FENCE_SHARD = 0;

/** The region's lifetime for an unanswered caller when nothing configured asks for longer. */
const LIFETIME_FLOOR_MS = 60_000;

type WorkCommand = { readonly kind: 'work'; readonly id: string };

type Command = WorkCommand;

class Entity extends Actor<Command> {
  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  private onWork(): void { /* nothing to do — no test routes to an entity */ }
}

const PING = 'ping';
const PONG = 'pong';

/** Everything each recorder was told, by label. */
const answers = new Map<string, unknown[]>();

/**
 * A caller of `shards()` / `shardRefFor()` that keeps what it is told, so a
 * late answer reaching it — or not — is something a test can read.
 */
class Recorder extends Actor<unknown> {
  constructor(private readonly label: string) { super(); }

  override preStart(): void { answers.set(this.label, []); }

  override onReceive(message: unknown): void {
    if (message === PING) {
      this.onPing();
      return;
    }
    this.onAnswer(message);
  }

  /** Answered behind everything already in the mailbox — the recorder's fence. */
  private onPing(): void { this.sender.forEach((sender) => sender.tell(PONG)); }

  private onAnswer(message: unknown): void { answers.get(this.label)?.push(message); }
}

/**
 * The wall clock, except that `now()` can be moved forward and one fixed-rate
 * timer — the region's sweep — is captured instead of armed.
 *
 * Capture is switched on just before the region is spawned, so only a timer the
 * region arms in `preStart` can be caught; the cluster armed its own long before.
 */
class SweepClockScheduler extends Scheduler {
  private offsetMs = 0;
  private captureIntervalMs: number | null = null;
  private readonly sweeps: Array<() => void> = [];

  override now(): number { return super.now() + this.offsetMs; }

  /** Move the time every `system.clock` reader sees forward by `ms`. */
  advance(ms: number): void { this.offsetMs += ms; }

  /** Capture, rather than arm, any fixed-rate timer armed from here on at `intervalMs`. */
  captureFixedRate(intervalMs: number): void { this.captureIntervalMs = intervalMs; }

  override scheduleAtFixedRateFunction(
    initialDelayMs: number,
    intervalMs: number,
    task: () => void,
  ): Cancellable {
    if (intervalMs !== this.captureIntervalMs) {
      return super.scheduleAtFixedRateFunction(initialDelayMs, intervalMs, task);
    }
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

  /** How many timers have been captured so far. */
  capturedTimers(): number { return this.sweeps.length; }

  /** Fire the region's sweep timer exactly as it would have fired itself. */
  fireSweep(): void {
    if (this.sweeps.length !== 1) {
      throw new Error(
        `expected one sweep timer captured at ${this.captureIntervalMs} ms, found ${this.sweeps.length}`,
      );
    }
    this.sweeps[0]!();
  }
}

type HarnessOptions = {
  readonly systemName: string;
  readonly port: number;
  /** The interval the region is expected to arm its sweep at — its lifetime for a caller. */
  readonly lifetimeMs: number;
  /** HOCON for the system, for a configured `actor-ts.actor.ask-timeout`. */
  readonly hocon?: string;
  /** What `ClusterSharding.start` adds on top of `settingsToConfig`. */
  readonly regionConfig?: Partial<ShardRegionConfig<Command>>;
};

type Harness = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly scheduler: SweepClockScheduler;
  readonly log: RecordingLogger;
  readonly region: ActorRef<unknown>;
  /** The region actor itself — read only where behaviour cannot show a fact. */
  readonly instance: () => ShardRegion<Command>;
  readonly recorder: (label: string) => ActorRef<unknown>;
  /** Tell the region the coordinator placed `shardId` on it, which answers its callers. */
  readonly place: (shardId: number) => void;
  /** Answer the `shards()` query carrying `correlationId`, with an empty map. */
  readonly answerStats: (correlationId: number) => void;
  /** Resolve once the region has handled everything told to it before this call. */
  readonly fence: () => Promise<void>;
  /** Fire the sweep timer and wait until the region has acted on it. */
  readonly sweep: () => Promise<void>;
};

let running: { cluster: Cluster; system: ActorSystem } | null = null;

afterEach(async () => {
  if (running) {
    await running.cluster.leave().catch(() => { /* teardown is best-effort */ });
    await running.system.terminate().catch(() => { /* teardown is best-effort */ });
    running = null;
  }
  answers.clear();
});

type Node = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly scheduler: SweepClockScheduler;
  readonly log: RecordingLogger;
};

/** A single-node cluster on the capturing scheduler, already its own leader. */
async function joinCluster(systemName: string, port: number, hocon?: string): Promise<Node> {
  const log = new RecordingLogger();
  const scheduler = new SweepClockScheduler();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(log)
    .withScheduler(scheduler);
  if (hocon !== undefined) systemOptions.withConfig(Config.parseString(hocon));
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  running = { cluster, system };

  // The region reads the leader in `preStart`; without one it would not record
  // a coordinator node and would refuse every placement this test mints.
  await awaitCondition(() => !cluster.leader().isNone(), {
    timeoutMs: 4_000,
    label: 'the single-node cluster elected itself leader',
  });
  return { system, cluster, scheduler, log };
}

async function startRegion(options: HarnessOptions): Promise<Harness> {
  const { system, cluster, scheduler, log } = await joinCluster(options.systemName, options.port, options.hocon);

  const shardingOptions: ShardingOptionsType<Command> = {
    typeName: TYPE_NAME,
    entityActor: Entity,
    extractEntityId: (message) => message.id,
    numShards: NUM_SHARDS,
  };
  // `() => null`: `ensureRegistered` records this node as the coordinator's
  // before it resolves the ref, so the region trusts the placements minted below
  // while having nobody to send a request to.
  const config: ShardRegionConfig<Command> = {
    ...ShardRegion.settingsToConfig<Command>(shardingOptions, cluster, () => null),
    ...options.regionConfig,
  };

  let instance: ShardRegion<Command> | null = null;
  scheduler.captureFixedRate(options.lifetimeMs);
  const region = system.spawn<unknown>(() => {
    instance = new ShardRegion<Command>(config);
    return instance as unknown as Actor<unknown>;
  }, 'region');

  const authenticated = (message: ShardingMessage): AuthenticatedShardingMessage =>
    new AuthenticatedShardingMessage(cluster.selfAddress, message);

  const place = (shardId: number): void => {
    const home: ShardHome = {
      kind: 'sharding.ShardHome',
      shardId,
      region: region.path.toString(),
      node: cluster.selfAddress.toJSON(),
    };
    region.tell(authenticated(home));
  };

  const answerStats = (correlationId: number): void => {
    const stats: ClusterShardingStats = { kind: 'sharding.ClusterShardingStats', correlationId, shards: [] };
    region.tell(authenticated(stats));
  };

  const fence = async (): Promise<void> => {
    await region.ask(locationQuery(FENCE_SHARD), 2_000);
  };

  const recorder = (label: string): ActorRef<unknown> =>
    system.spawn<unknown>(() => new Recorder(label), `recorder-${label}`);

  const harness: Harness = {
    system,
    cluster,
    scheduler,
    log,
    region,
    instance: () => {
      if (instance === null) throw new Error('the region has not been constructed');
      return instance;
    },
    recorder,
    place,
    answerStats,
    fence,
    sweep: async () => {
      scheduler.fireSweep();
      await fence();
    },
  };

  // The fence shard is placed first, so every later fence is answered at once —
  // and the first one also proves `preStart` ran, which is where the sweep timer
  // is armed.
  place(FENCE_SHARD);
  await fence();
  return harness;
}

const locationQuery = (shardId: number): GetShardLocation => ({ kind: 'sharding.GetShardLocation', shardId });

const statsQuery = (timeoutMs = 1_000): GetShards => ({ kind: 'sharding.GetShards', timeoutMs });

/** Resolve once `recorder` has handled everything told to it before this call. */
async function drain(recorder: ActorRef<unknown>): Promise<void> {
  await recorder.ask(PING, 2_000);
}

const answersOf = (label: string): unknown[] => answers.get(label) ?? [];

/** How many answers reached `label` — a count, so a failure does not print a whole actor ref. */
const answerCountOf = (label: string): number => answersOf(label).length;

const debugLines = (log: RecordingLogger, fragment: string): string[] =>
  log.records.filter((r) => r.level === 'debug' && r.message.includes(fragment)).map((r) => r.message);

/** The location table, read directly: an emptied key and a deleted one behave alike. */
const pendingLocationsOf = (region: ShardRegion<Command>): ReadonlyMap<number, readonly unknown[]> =>
  (region as unknown as { readonly pendingLocationAsks: ReadonlyMap<number, readonly unknown[]> })
    .pendingLocationAsks;

describe('the asks sweep forgets the callers nobody answers (#1436)', () => {
  test('a shards() query past its lifetime is dropped, one asked later still answers', async () => {
    const harness = await startRegion({ systemName: '1436-stats', port: 45_736, lifetimeMs: LIFETIME_FLOOR_MS });
    const early = harness.recorder('early');
    const later = harness.recorder('later');

    // A fresh region numbers its `shards()` queries from 1.
    harness.region.tell(statsQuery(), early);
    await harness.fence();
    harness.scheduler.advance(30_000);
    harness.region.tell(statsQuery(), later);
    await harness.fence();
    // Query 1 is now past the lifetime; query 2, asked half a lifetime later, is not.
    harness.scheduler.advance(30_001);
    await harness.sweep();

    harness.answerStats(1);
    harness.answerStats(2);
    await harness.fence();
    await drain(early);
    await drain(later);

    expect(answerCountOf('early')).toBe(0);
    // The control: the same minted answer does reach a caller that was kept.
    expect(answersOf('later')).toEqual([[]]);
    const swept = debugLines(harness.log, 'shards() query');
    expect(swept).toHaveLength(1);
    expect(swept[0]).toMatch(/query 1 of 'pending'/);
  }, 20_000);

  test('shardRefFor() callers past their lifetime are dropped one by one, and an emptied shard with them', async () => {
    const harness = await startRegion({ systemName: '1436-location', port: 45_737, lifetimeMs: LIFETIME_FLOOR_MS });
    const first = harness.recorder('first');
    const second = harness.recorder('second');
    const alone = harness.recorder('alone');
    const later = harness.recorder('later');

    harness.region.tell(locationQuery(5), first);
    harness.region.tell(locationQuery(5), second);
    harness.region.tell(locationQuery(6), alone);
    await harness.fence();
    harness.scheduler.advance(30_000);
    // A younger caller on the same shard as two that are about to expire.
    harness.region.tell(locationQuery(5), later);
    await harness.fence();
    harness.scheduler.advance(30_001);
    await harness.sweep();

    // Shard 6 lost its only caller, so the shard goes too; shard 5 keeps the one
    // caller still inside its lifetime.
    const pending = pendingLocationsOf(harness.instance());
    expect([...pending.keys()]).toEqual([5]);
    expect(pending.get(5)).toHaveLength(1);

    harness.place(5);
    harness.place(6);
    await harness.fence();
    for (const recorder of [first, second, alone, later]) await drain(recorder);

    expect(answerCountOf('first')).toBe(0);
    expect(answerCountOf('second')).toBe(0);
    expect(answerCountOf('alone')).toBe(0);
    expect(answerCountOf('later')).toBe(1);
    expect(String((answersOf('later')[0] as ActorRef<unknown>).path)).toContain('shard-5');

    const swept = debugLines(harness.log, 'shardRefFor()');
    expect(swept).toHaveLength(2);
    expect(swept.find((line) => line.includes('shard 5 '))).toMatch(/2 unanswered shardRefFor\(\) caller\(s\) of shard 5 of 'pending'/);
    expect(swept.find((line) => line.includes('shard 6 '))).toMatch(/1 unanswered shardRefFor\(\) caller\(s\) of shard 6 of 'pending'/);
  }, 20_000);

  test('an answer already queued when the sweep fires is delivered — the sweep runs on the region\'s turn', async () => {
    const harness = await startRegion({ systemName: '1436-turn', port: 45_738, lifetimeMs: LIFETIME_FLOOR_MS });
    const caller = harness.recorder('caller');

    harness.region.tell(locationQuery(5), caller);
    await harness.fence();
    harness.scheduler.advance(LIFETIME_FLOOR_MS + 1);
    // The answer is in the region's mailbox before the sweep's timer fires.  A
    // sweep that ran in the timer's callback would drop the caller first.
    harness.place(5);
    harness.scheduler.fireSweep();
    await harness.fence();
    await drain(caller);

    expect(answerCountOf('caller')).toBe(1);
    expect(debugLines(harness.log, 'shardRefFor()')).toEqual([]);
  }, 20_000);
});

describe('how long the region keeps an unanswered caller (#1436)', () => {
  /**
   * Two callers asked together on two shards: the first sweep must keep both,
   * which placing the first shard then shows; the second must drop the other.
   */
  async function keptUntil(harness: Harness, keptAtMs: number, droppedAtMs: number): Promise<void> {
    const kept = harness.recorder('kept');
    const dropped = harness.recorder('dropped');
    harness.region.tell(locationQuery(5), kept);
    harness.region.tell(locationQuery(6), dropped);
    await harness.fence();

    harness.scheduler.advance(keptAtMs);
    await harness.sweep();
    harness.place(5);
    await harness.fence();
    await drain(kept);
    expect(answerCountOf('kept')).toBe(1);
    expect(debugLines(harness.log, 'shardRefFor()')).toEqual([]);

    harness.scheduler.advance(droppedAtMs - keptAtMs);
    await harness.sweep();
    harness.place(6);
    await harness.fence();
    await drain(dropped);
    expect(answerCountOf('dropped')).toBe(0);
    expect(debugLines(harness.log, 'shardRefFor()')).toHaveLength(1);
  }

  test('a minute, with the shipped ask timeout', async () => {
    const harness = await startRegion({ systemName: '1436-floor', port: 45_739, lifetimeMs: LIFETIME_FLOOR_MS });
    await keptUntil(harness, 59_000, LIFETIME_FLOOR_MS + 1);
  }, 20_000);

  test('no less than actor-ts.actor.ask-timeout, when that is longer', async () => {
    // A reply inside the deadline an `ask` arms by default must never find its
    // caller swept — the case a cross-node entity reply under a two-minute
    // ask timeout used to lose.
    const harness = await startRegion({
      systemName: '1436-ask-timeout',
      port: 45_740,
      hocon: 'actor-ts.actor.ask-timeout = 61237ms',
      lifetimeMs: 61_237,
    });
    await keptUntil(harness, 60_500, 61_300);
  }, 20_000);

  test('no less than the type\'s shard-region-query-timeout, when that is longer', async () => {
    // `shards()` and `shardRefFor()` wait this long by default, so the callers
    // they leave in the region must be kept at least as long.
    const harness = await startRegion({
      systemName: '1436-query-timeout',
      port: 45_741,
      regionConfig: { queryTimeoutMs: 90_000 },
      lifetimeMs: 90_000,
    });
    await keptUntil(harness, 89_000, 90_001);
  }, 20_000);

  test('ClusterSharding.start hands the type\'s query timeout to its region', async () => {
    // The test above sets the field by hand; this is the path that sets it in
    // production.  Nothing else a started type arms runs at this interval, so a
    // timer captured there is the region's sweep, moved by the option.
    const node = await joinCluster('1436-start', 45_744);
    const shardingOptions = StartShardingOptions.create<Command>()
      .withTypeName(TYPE_NAME)
      .withEntityActor(Entity)
      .withExtractEntityId((message) => message.id)
      .withShardRegionQueryTimeoutMs(90_000);
    node.scheduler.captureFixedRate(90_000);
    node.cluster.sharding.start<Command>(shardingOptions);

    await awaitCondition(() => node.scheduler.capturedTimers() > 0, {
      timeoutMs: 4_000,
      label: 'the started region armed its sweep at the type\'s query timeout',
    });
    expect(node.scheduler.capturedTimers()).toBe(1);
  }, 20_000);
});

describe('a shard id outside the type\'s range is refused at once (#1436)', () => {
  test('shardRefFor() for it is answered with a RangeError, and nothing is kept', async () => {
    const harness = await startRegion({ systemName: '1436-range', port: 45_742, lifetimeMs: LIFETIME_FLOOR_MS });

    for (const shardId of [NUM_SHARDS, 9_999, -1, 2.5, Number.NaN]) {
      // The deadline is only there to bound the failure: a refusal comes back at
      // once, and an id the coordinator drops would otherwise wait it out.
      const outcome = await harness.region.ask(locationQuery(shardId), 1_000).then(
        () => new Error(`shard id ${shardId} was answered with a ref`),
        (error: unknown) => error,
      );
      expect(outcome).toBeInstanceOf(RangeError);
      expect((outcome as RangeError).message).toContain(`0..${NUM_SHARDS - 1}`);
      expect((outcome as RangeError).message).toContain(`'${TYPE_NAME}'`);
    }

    // Refused, not queued: there is nothing for the sweep to forget.
    expect([...pendingLocationsOf(harness.instance()).keys()]).toEqual([]);
    harness.scheduler.advance(LIFETIME_FLOOR_MS + 1);
    await harness.sweep();
    expect(debugLines(harness.log, 'shardRefFor()')).toEqual([]);
  }, 20_000);

  test('an id inside the range is still queued, not refused', async () => {
    // The control: the refusal is about the range, not about an unplaced shard,
    // which waits for the coordinator exactly as it always did.
    const harness = await startRegion({ systemName: '1436-in-range', port: 45_745, lifetimeMs: LIFETIME_FLOOR_MS });
    const caller = harness.recorder('caller');

    harness.region.tell(locationQuery(NUM_SHARDS - 1), caller);
    await harness.fence();
    await drain(caller);

    expect(answerCountOf('caller')).toBe(0);
    expect([...pendingLocationsOf(harness.instance()).keys()]).toEqual([NUM_SHARDS - 1]);
  }, 20_000);
});
