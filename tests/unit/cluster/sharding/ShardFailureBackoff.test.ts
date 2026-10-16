/**
 * A shard that stops unexpectedly is backed off before its region re-creates
 * it (#1437, the respawn half of #849's "failure backoffs are honoured on the
 * respawn paths").
 *
 * "Unexpectedly" is every stop but the three the region asks for itself — a
 * hand-off, a passivation and a release.  Without a wait, such a shard came
 * straight back on the next message, and under `rememberEntities` it did not
 * even need one: the region asked the coordinator for the shard's registry on
 * every death and re-created the shard on the answer, so a shard whose entity
 * failed its start looped thousands of times a second with no traffic at all.
 *
 * The options half is pinned here too, rather than in
 * `tests/unit/options/NonBrokerOptionsValidators.test.ts`: the four fields
 * exist for the mechanism below, and their rules are what keeps it a backoff.
 *
 * ## The harness
 *
 * The one `ShardRegionBuffer.test.ts` built: a real single-node cluster, and a
 * region spawned by hand whose directives — a placement, a hand-off, a
 * registry — this file mints itself, attributed to the node the region already
 * trusts as the coordinator's.  Two additions:
 *
 *   - **The coordinator is a recording probe.**  The resolver hands the region
 *     a probe for the coordinator's path, so what the region asks for — a
 *     registry, a home, a hand-off's completion — can be counted rather than
 *     inferred.  The probe answers nothing; the test plays the coordinator.
 *   - **The backoff's timer is captured.**  Every mechanism case runs at
 *     random-factor 0, so the only waits the region can arm are the doublings
 *     of an odd first wait up to an odd ceiling, and the scheduler holds back
 *     a one-shot with one of those delays instead of arming it.  A shard
 *     therefore comes back when, and only when, a test fires its timer — so
 *     "not re-created inside its window" is an assertion about every door into
 *     the shard, not a race against 300 ms.  A `ManualScheduler` would freeze
 *     the cluster itself (see `EntityRecoveryPacing.test.ts`); capturing a few
 *     delays leaves every other timer running for real.
 *
 * A shard is killed the way #894's test kills one, by stopping it from
 * outside, which is a stop the region did not ask for.  The case that makes
 * an entity's failure the cause — and with it the supervision the region
 * applies to its shards — is the last one.
 *
 * Fences are a `GetShardRegionStats` round trip through the probe: the region
 * answers only after everything sent to it before the question, and a shard it
 * creates is in the actor tree from the moment of the spawn — so once the
 * answer is in, a door that wrongly re-created the shard has already done so.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../../src/Actor.js';
import { ActorOptions } from '../../../../src/ActorOptions.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { Config } from '../../../../src/config/Config.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { hashShardId } from '../../../../src/cluster/sharding/ShardAllocator.js';
import { coordinatorPath, shardName, ShardRegion } from '../../../../src/cluster/sharding/ShardRegion.js';
import { ShardingOptionsValidator } from '../../../../src/cluster/sharding/ShardingOptions.js';
import type { ShardingOptionsType } from '../../../../src/cluster/sharding/ShardingOptions.js';
import {
  AuthenticatedShardingMessage,
  type ShardingMessage,
  type ShardRegionStats,
} from '../../../../src/cluster/sharding/ShardingProtocol.js';
import {
  readShardingOptionsFromConfig,
  StartShardingOptionsValidator,
} from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { Scheduler, type Cancellable } from '../../../../src/Scheduler.js';
import { escalatingStrategy } from '../../../../src/Supervision.js';
import { DeadLetter } from '../../../../src/SystemMessages.js';
import { mergeOptions } from '../../../../src/util/OptionsMerge.js';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';
import { RecordingLogger } from '../../../util/RecordingLogger.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

class NoopEntity extends Actor<unknown> {
  override onReceive(): void { /* never told anything */ }
}

/** The three fields every non-proxy region must have, so only the backoff is under test. */
const REQUIRED: ShardingOptionsType<unknown> = {
  typeName: 'entity',
  entityActor: NoopEntity,
  extractEntityId: (message: unknown) => String(message),
};

/** The error `ShardingOptionsValidator` throws for `settings`, or `null` when it accepts them. */
function refusalOf(settings: Partial<ShardingOptionsType<unknown>>): OptionsError | null {
  try {
    new ShardingOptionsValidator<unknown>().validate({ ...REQUIRED, ...settings });
    return null;
  } catch (error) {
    if (error instanceof OptionsError) return error;
    throw error;
  }
}

describe('ShardingOptionsValidator — the shard failure backoff (#1437)', () => {
  test('the shipped defaults and a legal set are accepted', () => {
    expect(refusalOf({})).toBeNull();
    expect(refusalOf({
      shardFailureBackoffMinMs: 50,
      shardFailureBackoffMaxMs: 50,
      shardFailureBackoffRandomFactor: 0,
      shardFailureBackoffResetAfterMs: 1,
    })).toBeNull();
    // Both ends of the jitter range are real values: 0 makes every wait exact,
    // 1 lets a wait fall anywhere between nothing and twice its length.
    expect(refusalOf({ shardFailureBackoffRandomFactor: 1 })).toBeNull();
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'a first wait of %p is refused, naming the field',
    (value) => {
      // Zero is the one that matters: every later wait is a multiple of it, so
      // a zero first wait is the loop the backoff exists to end.
      const refusal = refusalOf({ shardFailureBackoffMinMs: value });

      expect(refusal?.field).toBe('shardFailureBackoffMinMs');
      expect(refusal?.message).toMatch(/^ShardingOptions: shardFailureBackoffMinMs must be a positive finite number/);
    },
  );

  test.each([0, -5, Number.NaN])('a reset window of %p is refused, naming the field', (value) => {
    // A zero window would count every death as the first, so the wait would never grow.
    const refusal = refusalOf({ shardFailureBackoffResetAfterMs: value });

    expect(refusal?.field).toBe('shardFailureBackoffResetAfterMs');
    expect(refusal?.message).toMatch(/must be a positive finite number/);
  });

  test.each([-0.1, 1.5, Number.NaN])('a random factor of %p is refused, naming the field', (value) => {
    const refusal = refusalOf({ shardFailureBackoffRandomFactor: value });

    expect(refusal?.field).toBe('shardFailureBackoffRandomFactor');
    expect(refusal?.message).toMatch(/must be a number in \[0, 1\]/);
  });

  test('a ceiling below the first wait is refused, naming the ceiling', () => {
    const refusal = refusalOf({ shardFailureBackoffMinMs: 5_000, shardFailureBackoffMaxMs: 1_000 });

    expect(refusal?.field).toBe('shardFailureBackoffMaxMs');
    expect(refusal?.message).toMatch(/must be a finite number >= shardFailureBackoffMinMs \(5000\)/);
  });

  test('the pair is checked as resolved, so one field cannot cross the other\'s default', () => {
    // A first wait above the shipped 10 s ceiling, with the ceiling left unset —
    // and the mirror image.  Checked one field at a time, both would pass and the
    // policy the region builds from the resolved pair would throw at its start.
    expect(refusalOf({ shardFailureBackoffMinMs: 20_000 })?.field).toBe('shardFailureBackoffMaxMs');
    expect(refusalOf({ shardFailureBackoffMaxMs: 100 })?.field).toBe('shardFailureBackoffMaxMs');
  });

  test('an unbounded ceiling is refused: the doubling needs somewhere to stop', () => {
    expect(refusalOf({ shardFailureBackoffMaxMs: Number.POSITIVE_INFINITY })?.field)
      .toBe('shardFailureBackoffMaxMs');
  });

  test('a value from HOCON is refused the same way at start, since the reader leaves the bound to the validator', () => {
    // `readShardingOptionsFromConfig` reads `random-factor` as a plain number and
    // checks nothing; what `ClusterSharding.start` validates is the merged
    // options, so a file value outside the range is refused there, by name.
    const fromConfig = readShardingOptionsFromConfig(
      Config.parseString('actor-ts.sharding.shard-failure-backoff.random-factor = 1.5'),
    );
    const merged = mergeOptions<ShardingOptionsType<unknown>>({}, fromConfig, REQUIRED);

    expect(() => new StartShardingOptionsValidator<unknown>().validate(merged))
      .toThrow(/^StartShardingOptions: shardFailureBackoffRandomFactor must be a number in \[0, 1\] \(got 1\.5\)/);
  });
});

/* ------------------------------ the mechanism ------------------------------ */

const TYPE_NAME = 'entity';
const NUM_SHARDS = 8;

/** The first wait of every mechanism case — odd, so nothing else the system arms shares it. */
const MIN_MS = 307;
/** The ceiling — below the fourth doubling (2 456), so reaching it shows; odd for the same reason. */
const MAX_MS = 1_999;
/** Every wait a region can arm at random-factor 0 with these two: what the scheduler holds back. */
const BACKOFF_WAITS: ReadonlySet<number> = new Set([MIN_MS, MIN_MS * 2, MIN_MS * 4, MAX_MS]);
/**
 * The paced-recovery frequency of the one case that runs `constant-rate`, held
 * back the same way so a batch runs when the test fires it — the device
 * `EntityRecoveryPacing.test.ts` uses, with its number.
 */
const RECOVERY_FREQUENCY_MS = 777_777;
/** How long a round trip through the region may take before the test names the step that stalled. */
const ASK_TIMEOUT_MS = 2_000;

type WorkCommand = { readonly kind: 'work'; readonly id: string; readonly sequence: number };

/** Answer the sender — what shows a held message kept the sender it arrived with. */
type EchoCommand = { readonly kind: 'echo'; readonly id: string };

/** Throw — a failure the entity's own strategy then decides on. */
type FailCommand = { readonly kind: 'fail'; readonly id: string };

type Command = WorkCommand | EchoCommand | FailCommand;

type EchoedReply = { readonly kind: 'echoed'; readonly id: string };

/** The id of every entity that reached `preStart`, in start order. */
let started: string[] = [];
/** `id#sequence` of every work command an entity received, in delivery order. */
let delivered: string[] = [];
/** The ids every echo was answered for, at the sender it arrived with. */
let replies: string[] = [];
/** Every frame the region sent the coordinator's path, unwrapped. */
let coordinatorFrames: ShardingMessage[] = [];
let letters: DeadLetter[] = [];
let subscribed = false;

class Entity extends Actor<Command> {
  override preStart(): void { started.push(this.entityId); }

  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, (m) => this.onWork(m))
      .with({ kind: 'echo' }, (m) => this.onEcho(m))
      .with({ kind: 'fail' }, (m) => this.onFail(m))
      .exhaustive();
  }

  private onWork(message: WorkCommand): void { delivered.push(`${message.id}#${message.sequence}`); }

  private onEcho(message: EchoCommand): void {
    const reply: EchoedReply = { kind: 'echoed', id: message.id };
    this.sender.toNullable()?.tell(reply);
  }

  private onFail(message: FailCommand): void {
    throw new Error(`entity ${message.id} failed on purpose`);
  }
}

/** The sender a held message has to keep. */
class ReplyCollector extends Actor<EchoedReply> {
  override onReceive(reply: EchoedReply): void { replies.push(reply.id); }
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

/** One backoff wait the region armed, held back until a test fires it. */
type ArmedWait = {
  readonly delayMs: number;
  readonly fire: () => void;
  cancelled: boolean;
  fired: boolean;
};

/**
 * Holds back every one-shot armed with a backoff wait and schedules everything
 * else for real.  Wrapping the `Cancellable` is what lets a case assert that a
 * hand-off or a release *disarmed* the wait, rather than only that no shard
 * came back — a stale tick that is refused looks the same from outside.
 */
class BackoffScheduler extends Scheduler {
  readonly armed: ArmedWait[] = [];
  /** Paced recovery batches the region armed, in order — see {@link RECOVERY_FREQUENCY_MS}. */
  readonly recoveryBatches: Array<() => void> = [];

  override scheduleOnceFunction(delayMs: number, task: () => void): Cancellable {
    if (delayMs === RECOVERY_FREQUENCY_MS) {
      this.recoveryBatches.push(task);
      return { cancel: (): boolean => false, get isCancelled(): boolean { return false; } };
    }
    if (!BACKOFF_WAITS.has(delayMs)) return super.scheduleOnceFunction(delayMs, task);
    const wait: ArmedWait = { delayMs, fire: task, cancelled: false, fired: false };
    this.armed.push(wait);
    return {
      cancel: (): boolean => {
        if (wait.cancelled || wait.fired) return false;
        wait.cancelled = true;
        return true;
      },
      get isCancelled(): boolean { return wait.cancelled || wait.fired; },
    };
  }

  /** Every wait the region armed, in order. */
  get delays(): number[] { return this.armed.map((wait) => wait.delayMs); }

  /** Fire the wait armed last, exactly as its timer would have. */
  fireLast(): void {
    const wait = this.armed[this.armed.length - 1];
    if (!wait || wait.fired || wait.cancelled) throw new Error('no backoff wait is armed');
    wait.fired = true;
    wait.fire();
  }

  /**
   * Run the last wait's callback even though it was cancelled: a timer that had
   * already fired when the cancellation came, its tick still in the mailbox.
   */
  fireLastAnyway(): void {
    const wait = this.armed[this.armed.length - 1];
    if (!wait) throw new Error('no backoff wait was ever armed');
    wait.fire();
  }
}

type RegionSettings = Partial<Pick<
  ShardingOptionsType<Command>,
  | 'rememberEntities'
  | 'bufferSize'
  | 'shardFailureBackoffResetAfterMs'
  | 'entityOptions'
  | 'entityRecoveryStrategy'
  | 'entityRecoveryConstantRateFrequencyMs'
  | 'entityRecoveryConstantRateNumberOfEntities'
>>;

type ShardStatsRow = ShardRegionStats['shards'][number];

type Harness = {
  readonly system: ActorSystem;
  readonly scheduler: BackoffScheduler;
  readonly log: RecordingLogger;
  readonly region: ActorRef<Command>;
  /** Where `ReplyCollector` lives — the sender a held message has to keep. */
  readonly collector: ActorRef<unknown>;
  readonly place: (shardId: number) => void;
  readonly handOff: (shardId: number) => void;
  readonly evict: () => void;
  readonly remember: (shardId: number, entityIds: string[]) => void;
  readonly send: (entityId: string, sequence: number, sender?: ActorRef<unknown>) => void;
  readonly echo: (entityId: string) => void;
  readonly toShard: (shardId: number, message: unknown) => void;
  /** `sharding.GetShardLocation` — what `ClusterSharding.shardRefFor` asks. */
  readonly locate: (shardId: number) => Promise<ActorRef<unknown>>;
  readonly shardPath: (shardId: number) => string;
  readonly shardIsUp: (shardId: number) => boolean;
  /** Stop the shard actor from outside — a stop the region did not ask for. */
  readonly killShard: (shardId: number) => void;
  readonly statsOf: (shardId: number) => Promise<ShardStatsRow | undefined>;
  /** Resolve once the region has handled everything sent to it before this call. */
  readonly fence: () => Promise<void>;
};

let running: { cluster: Cluster; system: ActorSystem } | null = null;

afterEach(async () => {
  if (running) {
    await running.cluster.leave().catch(() => { /* teardown is best-effort */ });
    await running.system.terminate().catch(() => { /* teardown is best-effort */ });
    running = null;
  }
  started = [];
  delivered = [];
  replies = [];
  coordinatorFrames = [];
  letters = [];
  subscribed = false;
});

async function startRegion(systemName: string, port: number, settings: RegionSettings = {}): Promise<Harness> {
  const scheduler = new BackoffScheduler();
  const log = new RecordingLogger();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(log)
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
  const collector = system.spawn(ReplyCollector, 'reply-collector') as ActorRef<unknown>;
  const probe = system.spawn(CoordinatorProbe, 'coordinator-probe');

  const coordinatorLocation = coordinatorPath(systemName, TYPE_NAME);
  const probePath = probe.path.toString();
  const options: ShardingOptionsType<Command> = {
    typeName: TYPE_NAME,
    entityActor: Entity,
    extractEntityId: (message) => message.id,
    numShards: NUM_SHARDS,
    shardFailureBackoffMinMs: MIN_MS,
    shardFailureBackoffMaxMs: MAX_MS,
    shardFailureBackoffRandomFactor: 0,
    ...settings,
  };
  // The coordinator's path, and the probe's own for the stats replies, both
  // resolve to the probe: the region registers with it and reports to it.
  const resolver = (path: string): ActorRef | null =>
    path === coordinatorLocation || path === probePath ? probe as ActorRef : null;
  const config = ShardRegion.settingsToConfig<Command>(options, cluster, resolver);
  const region = system.spawn<Command>(
    () => new ShardRegion<Command>(config) as unknown as Actor<Command>,
    'region',
  );

  const directive = (message: ShardingMessage): void => {
    (region as ActorRef<unknown>).tell(new AuthenticatedShardingMessage(cluster.selfAddress, message));
  };
  const place = (shardId: number): void => {
    directive({ kind: 'sharding.ShardHome', shardId, region: region.path.toString(), node: cluster.selfAddress.toJSON() });
  };
  const handOff = (shardId: number): void => { directive({ kind: 'sharding.HandOff', shardId }); };
  const evict = (): void => {
    directive({ kind: 'sharding.RegionEvicted', coordinator: coordinatorLocation, silentForMs: 30_000 });
  };
  const remember = (shardId: number, entityIds: string[]): void => {
    directive({ kind: 'sharding.RememberedEntities', shardId, entityIds });
  };
  const send = (entityId: string, sequence: number, sender?: ActorRef<unknown>): void => {
    region.tell({ kind: 'work', id: entityId, sequence }, sender ?? null);
  };
  const echo = (entityId: string): void => { region.tell({ kind: 'echo', id: entityId }, collector); };
  const toShard = (shardId: number, message: unknown): void => {
    (region as ActorRef<unknown>).tell({ kind: 'sharding.ToShard', shardId, message });
  };
  const locate = async (shardId: number): Promise<ActorRef<unknown>> =>
    await (region as ActorRef<unknown>).ask<ActorRef<unknown>>({ kind: 'sharding.GetShardLocation', shardId }, ASK_TIMEOUT_MS);

  // `_resolvePath` walks from the root, so strip `actor-ts://<system>/`.
  const regionSegments = region.path.toString()
    .replace(/^actor-ts:\/\/[^/]+\//, '')
    .split('/')
    .filter((segment) => segment.length > 0);
  const shardPath = (shardId: number): string => region.path.child(shardName(shardId)).toString();
  const shardIsUp = (shardId: number): boolean =>
    system._resolvePath([...regionSegments, shardName(shardId)]).isSome();
  const killShard = (shardId: number): void => {
    const resolved = system._resolvePath([...regionSegments, shardName(shardId)]);
    if (resolved.isNone()) throw new Error(`shard ${shardId} is not up to be killed`);
    (resolved.value as ActorRef<unknown>).stop();
  };

  let nextQueryId = 0;
  const regionStats = async (): Promise<ShardRegionStats> => {
    const queryId = ++nextQueryId;
    directive({
      kind: 'sharding.GetShardRegionStats',
      queryId,
      requester: probePath,
      requesterNode: cluster.selfAddress.toJSON(),
    });
    let answer: ShardRegionStats | undefined;
    await awaitCondition(() => {
      answer = coordinatorFrames.find((frame): frame is ShardRegionStats =>
        frame.kind === 'sharding.ShardRegionStats' && frame.queryId === queryId);
      return answer !== undefined;
    }, { timeoutMs: ASK_TIMEOUT_MS, label: `the region answered stats query ${queryId}` });
    return answer!;
  };
  const statsOf = async (shardId: number): Promise<ShardStatsRow | undefined> =>
    (await regionStats()).shards.find((row) => row.shardId === shardId);
  const fence = async (): Promise<void> => { await regionStats(); };

  return {
    system, scheduler, log, region, collector,
    place, handOff, evict, remember, send, echo, toShard, locate,
    shardPath, shardIsUp, killShard, statsOf, fence,
  };
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

const SHARD = 2;
const [ID, ID_2, ID_3] = idsOnShard(SHARD, 3) as [string, string, string];

/** Place the shard here and wait until its actor is up. */
async function placed(harness: Harness): Promise<void> {
  harness.place(SHARD);
  await awaitCondition(() => harness.shardIsUp(SHARD), { timeoutMs: ASK_TIMEOUT_MS, label: 'the placed shard is up' });
}

/** Kill the shard and wait until the region has armed its `waits`-th backoff wait. */
async function killed(harness: Harness, waits: number): Promise<void> {
  harness.killShard(SHARD);
  await awaitCondition(() => harness.scheduler.armed.length === waits, {
    timeoutMs: ASK_TIMEOUT_MS,
    label: `the region armed backoff wait ${waits} for the dead shard`,
  });
}

/** How often the region asked the coordinator for `shardId`'s registry. */
function registryRequests(shardId: number): number {
  return coordinatorFrames.filter((frame) =>
    frame.kind === 'sharding.GetRememberedEntities' && frame.shardId === shardId).length;
}

/** The work commands that went to dead letters, by sequence. */
function droppedWork(): DeadLetter[] {
  return letters.filter((letter) => (letter.message as { kind?: unknown } | null)?.kind === 'work');
}

describe('a shard that stops unexpectedly is backed off (#1437)', () => {
  test('it is not re-created inside its window, and the next message waits for it', async () => {
    const harness = await startRegion('backoff-window', 47_440);
    await placed(harness);
    harness.send(ID, 1);
    await awaitCondition(() => delivered.includes(`${ID}#1`), { timeoutMs: ASK_TIMEOUT_MS, label: 'the first message arrived' });

    await killed(harness, 1);
    expect(harness.scheduler.delays).toEqual([MIN_MS]);

    // The door the old code took: the next message re-created the shard on the spot.
    harness.send(ID, 2);
    await harness.fence();
    expect(harness.shardIsUp(SHARD)).toBe(false);
    expect(delivered).toEqual([`${ID}#1`]);

    harness.scheduler.fireLast();
    await awaitCondition(() => delivered.includes(`${ID}#2`), {
      timeoutMs: ASK_TIMEOUT_MS,
      label: 'the held message reached the re-created entity',
    });
    expect(harness.shardIsUp(SHARD)).toBe(true);
    expect(started).toEqual([ID, ID]);
  }, 15_000);

  test('a message held through the window keeps its sender', async () => {
    const harness = await startRegion('backoff-sender', 47_441);
    await placed(harness);
    await killed(harness, 1);

    harness.echo(ID);
    await harness.fence();
    expect(replies).toEqual([]);

    harness.scheduler.fireLast();
    await awaitCondition(() => replies.length === 1, {
      timeoutMs: ASK_TIMEOUT_MS,
      label: 'the entity answered the sender of the held message',
    });
    expect(replies).toEqual([ID]);
  }, 15_000);

  test('what is held counts against buffer-size, and the newest is dead-lettered with its sender', async () => {
    const harness = await startRegion('backoff-buffer-cap', 47_442, { bufferSize: 2 });
    await placed(harness);
    await killed(harness, 1);

    harness.send(ID, 1, harness.collector);
    harness.send(ID, 2, harness.collector);
    harness.send(ID, 3, harness.collector);
    await awaitCondition(() => droppedWork().length === 1, {
      timeoutMs: ASK_TIMEOUT_MS,
      label: 'the message past the cap reached the dead letters',
    });
    const [letter] = droppedWork();
    expect((letter!.message as WorkCommand).sequence).toBe(3);
    expect(letter!.sender?.path.toString()).toBe(harness.collector.path.toString());

    harness.scheduler.fireLast();
    await awaitCondition(() => delivered.length === 2, { timeoutMs: ASK_TIMEOUT_MS, label: 'the two held messages arrived' });
    expect(delivered).toEqual([`${ID}#1`, `${ID}#2`]);
  }, 15_000);

  test('with random-factor 0, deaths in a row wait min, 2 min, 4 min … up to max, one warning each', async () => {
    const harness = await startRegion('backoff-doubling', 47_443);
    harness.place(SHARD);
    for (let death = 1; death <= 5; death++) {
      await awaitCondition(() => harness.shardIsUp(SHARD), { timeoutMs: ASK_TIMEOUT_MS, label: `incarnation ${death} is up` });
      await killed(harness, death);
      harness.scheduler.fireLast();
    }

    expect(harness.scheduler.delays).toEqual([MIN_MS, MIN_MS * 2, MIN_MS * 4, MAX_MS, MAX_MS]);
    const warnings = harness.log.records
      .filter((record) => record.level === 'warn' && record.message.includes('stopped unexpectedly'))
      .map((record) => record.message);
    expect(warnings).toHaveLength(5);
    expect(warnings[2]).toContain('failure 3 in a row');
    expect(warnings[2]).toContain(`re-creating it in ${MIN_MS * 4} ms`);
    expect(warnings[4]).toContain(`re-creating it in ${MAX_MS} ms`);
    // The promise the old line made is the one this replaces.
    expect(harness.log.records.some((record) => record.message.includes('on the next message'))).toBe(false);
  }, 15_000);

  test('a shard that stayed up for reset-after starts again at min', async () => {
    const resetAfterMs = 150;
    const harness = await startRegion('backoff-reset', 47_444, { shardFailureBackoffResetAfterMs: resetAfterMs });
    await placed(harness);
    await killed(harness, 1);
    harness.scheduler.fireLast();
    await awaitCondition(() => harness.shardIsUp(SHARD), { timeoutMs: ASK_TIMEOUT_MS, label: 'the second incarnation is up' });
    // Dies at once: too short-lived to count as stable, so the wait doubles.
    await killed(harness, 2);
    harness.scheduler.fireLast();
    await awaitCondition(() => harness.shardIsUp(SHARD), { timeoutMs: ASK_TIMEOUT_MS, label: 'the third incarnation is up' });
    // The region stamps an incarnation's start on the wall clock, and nothing
    // observable marks the end of the window, so it is waited out, from a
    // moment that is already after that incarnation was created.
    const upSince = Date.now();
    await awaitCondition(() => Date.now() - upSince > resetAfterMs, {
      timeoutMs: ASK_TIMEOUT_MS,
      intervalMs: 10,
      label: 'the third incarnation stayed up for reset-after',
    });
    await killed(harness, 3);

    expect(harness.scheduler.delays).toEqual([MIN_MS, MIN_MS * 2, MIN_MS]);
  }, 15_000);

  test('a ToShard frame, a location query and a registry do not re-create a backing-off shard', async () => {
    const harness = await startRegion('backoff-doors', 47_445);
    await placed(harness);
    await killed(harness, 1);

    // What a `RemoteShardRef` on another node sends: an entity envelope is held
    // like a routed message …
    harness.toShard(SHARD, { kind: 'sharding.EntityEnvelope', entityId: ID, message: { kind: 'work', id: ID, sequence: 1 } });
    // … and any other shard message has nowhere to wait, since the replay
    // routes by entity, so it goes to dead letters instead of reviving the shard.
    harness.toShard(SHARD, { kind: 'sharding.StartEntity', entityId: ID_2 });
    // `shardRefFor` is answered at once, with a ref that relays through this
    // region rather than one that materialised the shard to be handed out.
    const ref = await harness.locate(SHARD);
    expect(ref.path.toString()).toBe(harness.shardPath(SHARD));
    ref.tell({ kind: 'sharding.EntityEnvelope', entityId: ID, message: { kind: 'work', id: ID, sequence: 2 } });
    // A registry shipped meanwhile is what the respawn asks for anyway.
    harness.remember(SHARD, [ID_3]);
    // And a placement the coordinator repeats — every region re-registers on a
    // leader change — keeps the shard where it is rather than re-creating it.
    harness.place(SHARD);
    await harness.fence();

    expect(harness.shardIsUp(SHARD)).toBe(false);
    expect(started).toEqual([]);
    await awaitCondition(
      () => letters.some((letter) => (letter.message as { kind?: unknown } | null)?.kind === 'sharding.StartEntity'),
      { timeoutMs: ASK_TIMEOUT_MS, label: 'the StartEntity told to the backing-off shard was dead-lettered' },
    );

    harness.scheduler.fireLast();
    await awaitCondition(() => delivered.length === 2, { timeoutMs: ASK_TIMEOUT_MS, label: 'both held envelopes arrived' });
    expect(delivered).toEqual([`${ID}#1`, `${ID}#2`]);
    // The dead-lettered start and the skipped registry started nothing.
    expect(started).toEqual([ID]);
    // The relaying ref still works once the shard is back.
    ref.tell({ kind: 'sharding.EntityEnvelope', entityId: ID, message: { kind: 'work', id: ID, sequence: 3 } });
    await awaitCondition(() => delivered.includes(`${ID}#3`), { timeoutMs: ASK_TIMEOUT_MS, label: 'the relayed message arrived' });
  }, 15_000);

  test('under rememberEntities the registry is asked for when the shard comes back, not when it dies', async () => {
    const harness = await startRegion('backoff-remember', 47_446, { rememberEntities: true });
    await placed(harness);
    harness.send(ID, 1);
    await awaitCondition(() => started.length === 1, { timeoutMs: ASK_TIMEOUT_MS, label: 'the entity started' });

    await killed(harness, 1);
    await harness.fence();
    expect(registryRequests(SHARD)).toBe(0);

    harness.scheduler.fireLast();
    await awaitCondition(() => registryRequests(SHARD) === 1, {
      timeoutMs: ASK_TIMEOUT_MS,
      label: 'the re-created shard asked for its registry',
    });
    // The coordinator's answer brings the entity back with no traffic at all.
    harness.remember(SHARD, [ID]);
    await awaitCondition(() => started.length === 2, { timeoutMs: ASK_TIMEOUT_MS, label: 'the remembered entity came back' });
    expect(started).toEqual([ID, ID]);
  }, 15_000);

  test('a paced recovery neither starts into nor queues for a backing-off shard', async () => {
    const harness = await startRegion('backoff-paced', 47_449, {
      rememberEntities: true,
      entityRecoveryStrategy: 'constant-rate',
      entityRecoveryConstantRateFrequencyMs: RECOVERY_FREQUENCY_MS,
      entityRecoveryConstantRateNumberOfEntities: 1,
    });
    await placed(harness);
    // The first batch runs on the registry's own turn and starts one entity;
    // the next is armed and held back.
    harness.remember(SHARD, [ID, ID_2, ID_3]);
    await awaitCondition(() => started.includes(ID), { timeoutMs: ASK_TIMEOUT_MS, label: 'the first paced batch started' });
    expect(harness.scheduler.recoveryBatches).toHaveLength(1);

    await killed(harness, 1);
    // The two entries still owed are for a shard that is backing off: the
    // batch drops them, at no cost to its budget, instead of re-creating the
    // shard to start one — and with nothing left owed, it arms no next batch.
    harness.scheduler.recoveryBatches[0]!();
    await harness.fence();
    expect(harness.shardIsUp(SHARD)).toBe(false);
    expect(harness.scheduler.recoveryBatches).toHaveLength(1);
    expect(started).toEqual([ID]);

    // A registry shipped meanwhile is not even queued, since queueing
    // materialises the shard its entities are owed in.
    harness.remember(SHARD, [ID_2]);
    await harness.fence();
    expect(harness.shardIsUp(SHARD)).toBe(false);
    expect(harness.scheduler.recoveryBatches).toHaveLength(1);

    // The tick asks again, and the answer is what queues them anew.
    harness.scheduler.fireLast();
    await awaitCondition(() => registryRequests(SHARD) === 1, {
      timeoutMs: ASK_TIMEOUT_MS,
      label: 'the re-created shard asked for its registry',
    });
    harness.remember(SHARD, [ID, ID_2, ID_3]);
    await awaitCondition(() => started.length === 2, { timeoutMs: ASK_TIMEOUT_MS, label: 'the re-asked registry started a batch' });
    expect(started).toEqual([ID, ID]);
  }, 15_000);

  test('a hand-off during the window completes at once and no respawn follows', async () => {
    const harness = await startRegion('backoff-hand-off', 47_447);
    await placed(harness);
    await killed(harness, 1);

    harness.handOff(SHARD);
    await awaitCondition(
      () => coordinatorFrames.some((frame) => frame.kind === 'sharding.HandOffComplete' && frame.shardId === SHARD),
      { timeoutMs: ASK_TIMEOUT_MS, label: 'the region completed the hand-off' },
    );
    expect(harness.scheduler.armed[0]!.cancelled).toBe(true);

    // A tick already in the mailbox when the hand-off came is stale.
    harness.scheduler.fireLastAnyway();
    // And a message for the shard now has no home here: it waits for the
    // coordinator's answer instead of reviving the shard.
    harness.send(ID, 1);
    await harness.fence();
    expect(harness.shardIsUp(SHARD)).toBe(false);
    expect(delivered).toEqual([]);
    expect(coordinatorFrames.some((frame) => frame.kind === 'sharding.GetShardHome' && frame.shardId === SHARD)).toBe(true);
  }, 15_000);

  test('a stale tick does not end a later window of the same shard', async () => {
    const harness = await startRegion('backoff-stale-tick', 47_450);
    await placed(harness);
    await killed(harness, 1);
    harness.handOff(SHARD);
    await awaitCondition(
      () => coordinatorFrames.some((frame) => frame.kind === 'sharding.HandOffComplete' && frame.shardId === SHARD),
      { timeoutMs: ASK_TIMEOUT_MS, label: 'the region completed the hand-off' },
    );
    // The coordinator places the shard here again, and it dies again: a new
    // run of deaths, with a new wait.
    await placed(harness);
    await killed(harness, 2);
    expect(harness.scheduler.delays).toEqual([MIN_MS, MIN_MS]);

    // The first wait's tick turns up only now — its timer fired just before
    // the hand-off cancelled it.  It belongs to a run that is over, so the
    // shard stays down for the wait it is actually in.
    harness.scheduler.armed[0]!.fire();
    await harness.fence();
    expect(harness.shardIsUp(SHARD)).toBe(false);

    harness.scheduler.fireLast();
    await awaitCondition(() => harness.shardIsUp(SHARD), { timeoutMs: ASK_TIMEOUT_MS, label: 'its own tick brought it back' });
  }, 15_000);

  test('an entity failure the shard escalates stops the shard: its entities are forgotten, and come back after the backoff', async () => {
    // The supervision the region applies to its shards.  An entity whose own
    // strategy escalates hands its failure to the shard, and the shard hands it
    // to the region.  Restarted in place — the default, ten times a minute on
    // one budget for every shard of the type — the shard came back as a fresh
    // instance that knew none of its entities: every sibling was torn down, no
    // `EntityStopped` reached the region, its index went on claiming all three,
    // and under rememberEntities nothing brought them back.
    const entityOptions = ActorOptions.create<Command>().withSupervisorStrategy(escalatingStrategy);
    const harness = await startRegion('backoff-escalation', 47_451, { rememberEntities: true, entityOptions });
    await placed(harness);
    harness.send(ID, 1);
    harness.send(ID_2, 1);
    harness.send(ID_3, 1);
    await awaitCondition(() => started.length === 3, { timeoutMs: ASK_TIMEOUT_MS, label: 'three entities started' });
    expect(await harness.statsOf(SHARD)).toEqual({ shardId: SHARD, entityCount: 3, resident: true });

    harness.region.tell({ kind: 'fail', id: ID });
    // Stopped, not restarted: the region backs the shard off …
    await awaitCondition(() => harness.scheduler.armed.length === 1, {
      timeoutMs: ASK_TIMEOUT_MS,
      label: 'the escalated failure stopped the shard into its backoff',
    });
    // … and its index no longer claims what died with it.
    expect(await harness.statsOf(SHARD)).toEqual({ shardId: SHARD, entityCount: 0, resident: false });

    harness.scheduler.fireLast();
    await awaitCondition(() => registryRequests(SHARD) === 1, {
      timeoutMs: ASK_TIMEOUT_MS,
      label: 'the re-created shard asked for its registry',
    });
    harness.remember(SHARD, [ID, ID_2, ID_3]);
    await awaitCondition(() => started.length === 6, { timeoutMs: ASK_TIMEOUT_MS, label: 'all three came back' });
    expect([...started].sort()).toEqual([ID, ID, ID_2, ID_2, ID_3, ID_3].sort());
    expect(await harness.statsOf(SHARD)).toEqual({ shardId: SHARD, entityCount: 3, resident: true });
  }, 15_000);

  test('a release during the window drops the backoff with the shard', async () => {
    const harness = await startRegion('backoff-release', 47_448);
    await placed(harness);
    await killed(harness, 1);

    harness.evict();
    await harness.fence();
    expect(harness.scheduler.armed[0]!.cancelled).toBe(true);

    harness.scheduler.fireLastAnyway();
    await harness.fence();
    expect(harness.shardIsUp(SHARD)).toBe(false);
    expect(await harness.statsOf(SHARD)).toBeUndefined();
  }, 15_000);
});
