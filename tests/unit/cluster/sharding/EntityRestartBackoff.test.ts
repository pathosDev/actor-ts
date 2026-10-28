/**
 * An entity that stops without being passivated is backed off before its shard
 * re-creates it (#1437, the entity half of #849's "failure backoffs are honoured
 * on the respawn paths").
 *
 * Once a shard's restart budget is spent it stops the failing entity, and the
 * next message for the entity used to create a fresh one: an entity failing on
 * every message was re-created per message, thirty instances for thirty
 * messages.  The shard cannot see why an entity stopped — `Terminated` carries
 * no cause, and the supervision decision is taken in the shard's own cell — so
 * a stop the shard did not ask for is the signal, whatever caused it.
 *
 * The options half is pinned here too, beside the mechanism its four fields
 * exist for, the way `ShardFailureBackoff.test.ts` pins the region half's: their
 * rules are what keeps it a backoff.
 *
 * ## The harnesses
 *
 * Most cases drive a `Shard` on its own, the layer `ShardStopTimeout.test.ts`
 * uses, under a parent that stands where the region would and records what the
 * shard reports up.  No cluster, so a `ManualScheduler` can run the system:
 * the backoff reads `system.clock` and arms its one-shots on `system.scheduler`,
 * so a window ends when, and only when, a case advances the clock past it, and
 * "not re-created inside its window" is an assertion rather than a race.  The
 * entities stop on a failure (`stoppingStrategy`) or fail their start, rather
 * than spend a restart budget, because that budget's window reads the wall
 * clock, not the scheduler.
 *
 * Fences are a `GetShardStats` round trip: the shard answers after everything
 * sent to it before the question, and the entity ids it lists are the ones it
 * has created — the map a re-creation writes to synchronously.
 *
 * The last describe runs the whole path once through `cluster.sharding.start`,
 * under the default supervision and the shipped backoff, on real time.
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
import { Passivate } from '../../../../src/cluster/sharding/Passivate.js';
import { Shard, ShardPassivationDeclined, ShardPassivationRequest } from '../../../../src/cluster/sharding/Shard.js';
import type { ShardConfig, ShardInbox } from '../../../../src/cluster/sharding/Shard.js';
import { ShardingOptionsValidator } from '../../../../src/cluster/sharding/ShardingOptions.js';
import type { ShardingOptionsType } from '../../../../src/cluster/sharding/ShardingOptions.js';
import type {
  EntityEnvelope,
  EntityStarted,
  EntityStopped,
  GetShardStats,
  PassivateEntity,
  ShardStats,
  StartEntities,
  StartEntity,
} from '../../../../src/cluster/sharding/ShardingProtocol.js';
import {
  readShardingOptionsFromConfig,
  StartShardingOptions,
  StartShardingOptionsValidator,
} from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { Scheduler, type Cancellable } from '../../../../src/Scheduler.js';
import { stoppingStrategy } from '../../../../src/Supervision.js';
import { DeadLetter, Terminated } from '../../../../src/SystemMessages.js';
import { ManualScheduler } from '../../../../src/testkit/ManualScheduler.js';
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

describe('ShardingOptionsValidator — the entity restart backoff (#1437)', () => {
  test('the shipped defaults and a legal set are accepted', () => {
    expect(refusalOf({})).toBeNull();
    expect(refusalOf({
      entityRestartBackoffMinMs: 50,
      entityRestartBackoffMaxMs: 50,
      entityRestartBackoffRandomFactor: 0,
      entityRestartBackoffResetAfterMs: 1,
    })).toBeNull();
    // Both ends of the jitter range are real values: 0 makes every wait exact,
    // 1 lets a wait fall anywhere between nothing and twice its length.
    expect(refusalOf({ entityRestartBackoffRandomFactor: 1 })).toBeNull();
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'a first wait of %p is refused, naming the field',
    (value) => {
      // Zero is the one that matters: every later wait is a multiple of it, so
      // a zero first wait re-creates the entity per message again.
      const refusal = refusalOf({ entityRestartBackoffMinMs: value });

      expect(refusal?.field).toBe('entityRestartBackoffMinMs');
      expect(refusal?.message).toMatch(/^ShardingOptions: entityRestartBackoffMinMs must be a positive finite number/);
    },
  );

  test.each([0, -5, Number.NaN])('a reset window of %p is refused, naming the field', (value) => {
    // A zero window would count every stop as the first, so the wait would never grow.
    const refusal = refusalOf({ entityRestartBackoffResetAfterMs: value });

    expect(refusal?.field).toBe('entityRestartBackoffResetAfterMs');
    expect(refusal?.message).toMatch(/must be a positive finite number/);
  });

  test.each([-0.1, 1.5, Number.NaN])('a random factor of %p is refused, naming the field', (value) => {
    const refusal = refusalOf({ entityRestartBackoffRandomFactor: value });

    expect(refusal?.field).toBe('entityRestartBackoffRandomFactor');
    expect(refusal?.message).toMatch(/must be a number in \[0, 1\]/);
  });

  test('a ceiling below the first wait is refused, naming the ceiling', () => {
    const refusal = refusalOf({ entityRestartBackoffMinMs: 5_000, entityRestartBackoffMaxMs: 1_000 });

    expect(refusal?.field).toBe('entityRestartBackoffMaxMs');
    expect(refusal?.message).toMatch(/must be a finite number >= entityRestartBackoffMinMs \(5000\)/);
  });

  test('the pair is checked as resolved, so one field cannot cross the other\'s default', () => {
    // A first wait above the shipped 10 s ceiling, with the ceiling left unset —
    // and the mirror image.  Checked one field at a time, both would pass, and
    // every shard of the type would run a ceiling below its first wait.
    expect(refusalOf({ entityRestartBackoffMinMs: 20_000 })?.field).toBe('entityRestartBackoffMaxMs');
    expect(refusalOf({ entityRestartBackoffMaxMs: 100 })?.field).toBe('entityRestartBackoffMaxMs');
  });

  test('an unbounded ceiling is refused: the doubling needs somewhere to stop', () => {
    expect(refusalOf({ entityRestartBackoffMaxMs: Number.POSITIVE_INFINITY })?.field)
      .toBe('entityRestartBackoffMaxMs');
  });

  test('the shard failure backoff\'s rules do not stand in for these', () => {
    // The two backoffs are separate settings with separate rules: a legal shard
    // backoff says nothing about the entity one, and the other way round.
    expect(refusalOf({ shardFailureBackoffMinMs: 50, entityRestartBackoffMinMs: 0 })?.field)
      .toBe('entityRestartBackoffMinMs');
    expect(refusalOf({ shardFailureBackoffMinMs: 0, entityRestartBackoffMinMs: 50 })?.field)
      .toBe('shardFailureBackoffMinMs');
  });

  test('a value from HOCON is refused the same way at start, since the reader leaves the bound to the validator', () => {
    // `readShardingOptionsFromConfig` reads `random-factor` as a plain number and
    // checks nothing; what `ClusterSharding.start` validates is the merged
    // options, so a file value outside the range is refused there, by name.
    const fromConfig = readShardingOptionsFromConfig(
      Config.parseString('actor-ts.sharding.entity-restart-backoff.random-factor = 1.5'),
    );
    const merged = mergeOptions<ShardingOptionsType<unknown>>({}, fromConfig, REQUIRED);

    expect(() => new StartShardingOptionsValidator<unknown>().validate(merged))
      .toThrow(/^StartShardingOptions: entityRestartBackoffRandomFactor must be a number in \[0, 1\] \(got 1\.5\)/);
  });
});

/* ------------------------- the mechanism, on one shard ------------------------- */

const TYPE_NAME = 'entity';

/** The first wait of the mechanism cases — odd, so no other timer of the system shares it. */
const MIN_MS = 307;
/** The ceiling — below the second doubling (1 228), so reaching it shows. */
const MAX_MS = 1_009;
/** How long an entity has to go without stopping unasked, since it came back, to start again at {@link MIN_MS}. */
const RESET_AFTER_MS = 5_003;
/** The failure budget of every wait below, under bun's 5 s per-test cap. */
const WAIT_MS = 4_000;

type WorkCommand = { readonly kind: 'work'; readonly id: string; readonly sequence: number };

/** Throw — a failure the entity's supervision then decides on. */
type FailCommand = { readonly kind: 'fail'; readonly id: string };

/** Stop itself — a stop nobody asked for, the shape a swallowed recovery failure or a lost lease takes. */
type StopCommand = { readonly kind: 'stop'; readonly id: string };

/** Ask the shard to passivate it — the one stop that is on purpose. */
type CheckoutCommand = { readonly kind: 'checkout'; readonly id: string };

/** The stop-message the `Passivate` hands back to the entity. */
type PassivateStopCommand = { readonly kind: 'passivate-stop'; readonly id: string };

type Command = WorkCommand | FailCommand | StopCommand | CheckoutCommand | PassivateStopCommand;

/** What a work command answers its sender with — what shows a held message kept the sender it arrived with. */
type WorkDoneReply = { readonly kind: 'work-done'; readonly id: string; readonly sequence: number };

/** The id of every entity instance that reached `preStart`, in start order. */
let started: string[] = [];
/** `id#sequence` of every work command an entity received, in delivery order. */
let delivered: string[] = [];
/** `id#sequence` of every reply, at the sender the work command arrived with. */
let replies: string[] = [];
/** Every lifecycle report the shard sent its parent. */
let reports: Array<EntityStarted | EntityStopped> = [];
/** How many passivation requests the shard declined. */
let declines = 0;
/** How many stats replies reached the stand-in region — see `ShardHarness.reported`. */
let reportFences = 0;
/** Whether the shard actor has stopped. */
let shardTerminated = false;
let statsReplies: ShardStats[] = [];
let letters: DeadLetter[] = [];
let subscribed = false;
/** How many more starts {@link FailingStartEntity} fails before one succeeds. */
let failingStarts = 0;
let shardRef: ActorRef<ShardInbox> | null = null;
let shardInstance: Shard | null = null;
let running: ActorSystem | null = null;
let runningCluster: { system: ActorSystem; cluster: Cluster } | null = null;

afterEach(async () => {
  if (running) {
    await running.terminate().catch(() => { /* teardown is best-effort */ });
    running = null;
  }
  if (runningCluster) {
    await runningCluster.cluster.leave().catch(() => { /* teardown is best-effort */ });
    await runningCluster.system.terminate().catch(() => { /* teardown is best-effort */ });
    runningCluster = null;
  }
  started = [];
  delivered = [];
  replies = [];
  reports = [];
  declines = 0;
  reportFences = 0;
  shardTerminated = false;
  statsReplies = [];
  letters = [];
  subscribed = false;
  failingStarts = 0;
  shardRef = null;
  shardInstance = null;
  poisonInstances = 0;
  poisonReceived = [];
});

class Entity extends Actor<Command> {
  override preStart(): void { started.push(this.entityId); }

  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, (m) => this.onWork(m))
      .with({ kind: 'fail' }, (m) => this.onFail(m))
      .with({ kind: 'stop' }, () => this.onStop())
      .with({ kind: 'checkout' }, () => this.onCheckout())
      .with({ kind: 'passivate-stop' }, () => this.onPassivateStop())
      .exhaustive();
  }

  private onWork(message: WorkCommand): void {
    delivered.push(`${message.id}#${message.sequence}`);
    const reply: WorkDoneReply = { kind: 'work-done', id: message.id, sequence: message.sequence };
    this.sender.toNullable()?.tell(reply);
  }

  private onFail(message: FailCommand): void {
    throw new Error(`entity ${message.id} failed on purpose`);
  }

  private onStop(): void { this.context.stopSelf(); }

  private onCheckout(): void {
    const stopMessage: PassivateStopCommand = { kind: 'passivate-stop', id: this.entityId };
    this.context.parent.forEach((parent) =>
      parent.tell(new Passivate(stopMessage, this.self) as never, this.self));
  }

  private onPassivateStop(): void { this.context.stopSelf(); }
}

/** Fails its start until {@link failingStarts} runs out — a recovery that keeps failing, then recovers. */
class FailingStartEntity extends Entity {
  override preStart(): void {
    super.preStart();
    if (failingStarts <= 0) return;
    failingStarts--;
    throw new Error(`entity ${this.entityId} failed to start`);
  }
}

/** The sender a held message has to keep. */
class ReplyCollector extends Actor<WorkDoneReply> {
  override onReceive(reply: WorkDoneReply): void { replies.push(`${reply.id}#${reply.sequence}`); }
}

class StatsCollector extends Actor<ShardStats> {
  override onReceive(stats: ShardStats): void { statsReplies.push(stats); }
}

class DeadLetterListener extends Actor<DeadLetter> {
  override preStart(): void {
    this.system.eventStream.subscribe(this.self, DeadLetter);
    subscribed = true;
  }

  override onReceive(letter: DeadLetter): void { letters.push(letter); }
}

/**
 * Stands where a region would: the shard's parent, so every `EntityStarted`
 * and `EntityStopped` the shard reports up lands here — and so does the answer
 * to a passivation request it declines.  It watches the shard, which is how a
 * case sees one it asked to passivate go.
 */
class RegionStandIn extends Actor<EntityStarted | EntityStopped | ShardStats | ShardPassivationDeclined | Terminated> {
  constructor(private readonly shardConfig: ShardConfig) { super(); }

  override preStart(): void {
    shardRef = this.context.spawn<ShardInbox>(
      () => (shardInstance = new Shard(this.shardConfig)),
      'shard-0',
    );
    this.context.watch(shardRef);
  }

  override onReceive(report: EntityStarted | EntityStopped | ShardStats | ShardPassivationDeclined | Terminated): void {
    if (report instanceof ShardPassivationDeclined) {
      declines++;
      return;
    }
    if (report instanceof Terminated) {
      shardTerminated = true;
      return;
    }
    if (report.kind === 'sharding.ShardStats') {
      reportFences++;
      return;
    }
    reports.push(report);
  }
}

/**
 * Most entities here stop on a failure, so a stop is one throw — no restart
 * budget in between, whose window reads the wall clock rather than the
 * scheduler.
 */
const stopOnFailure: ActorOptions<unknown> = ActorOptions.create().withSupervisorStrategy(stoppingStrategy);

/** A shard of {@link Entity}s at this file's waits, exact ones, with `overrides` on top. */
function backoffConfig(overrides: Partial<ShardConfig> = {}): ShardConfig {
  return {
    typeName: TYPE_NAME,
    shardId: 0,
    entityActor: Entity,
    entityOptions: stopOnFailure,
    entityRestartBackoffMinMs: MIN_MS,
    entityRestartBackoffMaxMs: MAX_MS,
    entityRestartBackoffRandomFactor: 0,
    entityRestartBackoffResetAfterMs: RESET_AFTER_MS,
    ...overrides,
  };
}

type ShardHarness = {
  readonly scheduler: ManualScheduler;
  readonly log: RecordingLogger;
  readonly shard: ActorRef<ShardInbox>;
  readonly instance: Shard;
  /** Where `ReplyCollector` lives — the sender a held message has to keep. */
  readonly collector: ActorRef<unknown>;
  readonly send: (message: Command, sender?: ActorRef<unknown>) => void;
  /** The ids of the entities the shard is running, once it has handled everything sent to it before. */
  readonly live: () => Promise<readonly string[]>;
  /** Resolve once the shard has seen `entityId` stop. */
  readonly stopped: (entityId: string) => Promise<void>;
  /**
   * Resolve once the stand-in region has every report the shard sent it before
   * now — a stats reply addressed to the stand-in, which arrives behind them.
   * The fence a "nothing was reported" assertion needs: a reply to anybody
   * else can overtake a report still in the stand-in's mailbox.
   */
  readonly reported: () => Promise<void>;
};

async function startShard(config: ShardConfig): Promise<ShardHarness> {
  const scheduler = new ManualScheduler();
  const log = new RecordingLogger();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(log)
    .withScheduler(scheduler);
  const system = ActorSystem.create('entity-restart-backoff', systemOptions);
  running = system;
  system.spawn(DeadLetterListener, 'dead-letter-listener');
  await awaitCondition(() => subscribed, { timeoutMs: WAIT_MS, label: 'the dead-letter listener subscribed' });
  const collector = system.spawn(ReplyCollector, 'reply-collector') as ActorRef<unknown>;
  const statsCollector = system.spawn(StatsCollector, 'stats-collector');
  const standIn = system.spawn(() => new RegionStandIn(config), 'region') as ActorRef<unknown>;
  await awaitCondition(() => shardRef !== null && shardInstance !== null, {
    timeoutMs: WAIT_MS,
    label: 'the shard is up under its stand-in region',
  });
  const shard = shardRef!;

  const send = (message: Command, sender?: ActorRef<unknown>): void => {
    const envelope: EntityEnvelope<Command> = { kind: 'sharding.EntityEnvelope', entityId: message.id, message };
    shard.tell(envelope as ShardInbox, sender ?? null);
  };
  const live = async (): Promise<readonly string[]> => {
    const asked = statsReplies.length;
    const query: GetShardStats = { kind: 'sharding.GetShardStats', replyTo: statsCollector };
    shard.tell(query as ShardInbox);
    await awaitCondition(() => statsReplies.length > asked, { timeoutMs: WAIT_MS, label: 'the shard answered a stats query' });
    return statsReplies[asked]!.entityIds;
  };
  const stopped = async (entityId: string): Promise<void> => {
    await awaitCondition(async () => !(await live()).includes(entityId), {
      timeoutMs: WAIT_MS,
      label: `the shard saw '${entityId}' stop`,
    });
  };
  const reported = async (): Promise<void> => {
    const asked = reportFences;
    const query: GetShardStats = { kind: 'sharding.GetShardStats', replyTo: standIn };
    shard.tell(query as ShardInbox);
    await awaitCondition(() => reportFences > asked, { timeoutMs: WAIT_MS, label: 'the shard answered its stand-in region' });
  };

  return { scheduler, log, shard, instance: shardInstance!, collector, send, live, stopped, reported };
}

const work = (id: string, sequence: number): WorkCommand => ({ kind: 'work', id, sequence });
const fail = (id: string): FailCommand => ({ kind: 'fail', id });

async function replied(entry: string): Promise<void> {
  await awaitCondition(() => replies.includes(entry), { timeoutMs: WAIT_MS, label: `the reply ${entry} arrived` });
}

function stoppedReports(entityId: string): number {
  return reports.filter((report) => report.kind === 'sharding.EntityStopped' && report.entityId === entityId).length;
}

/** The work commands that went to dead letters, as `id#sequence`, in the order they went. */
function deadWork(): string[] {
  return letters
    .filter((letter) => (letter.message as { kind?: unknown }).kind === 'work')
    .map((letter) => `${(letter.message as WorkCommand).id}#${(letter.message as WorkCommand).sequence}`);
}

/**
 * Fail `entityId`, hold one message for it, and show its wait is exactly
 * `windowMs`: still down one millisecond short of it, back on it.
 */
async function stopAndMeasure(
  harness: ShardHarness,
  entityId: string,
  sequence: number,
  windowMs: number,
): Promise<void> {
  harness.send(fail(entityId));
  await harness.stopped(entityId);
  harness.send(work(entityId, sequence), harness.collector);
  harness.scheduler.advance(windowMs - 1);
  expect(await harness.live()).not.toContain(entityId);
  harness.scheduler.advance(1);
  await replied(`${entityId}#${sequence}`);
}

describe('Shard — an entity that stopped without being passivated (#1437)', () => {
  test('is not re-created inside its wait; what arrives is held and delivered after it, in order, to the sender it came with', async () => {
    const harness = await startShard(backoffConfig());
    harness.send(work('e-1', 1), harness.collector);
    await replied('e-1#1');

    harness.send(fail('e-1'));
    await harness.stopped('e-1');
    // The region still hears of the stop, as before the backoff existed.
    await awaitCondition(() => stoppedReports('e-1') === 1, { timeoutMs: WAIT_MS, label: 'the stop was reported up' });
    for (const sequence of [2, 3, 4]) harness.send(work('e-1', sequence), harness.collector);

    // One millisecond short of the wait: three messages in, and still no entity.
    harness.scheduler.advance(MIN_MS - 1);
    expect(await harness.live()).toEqual([]);
    expect(started).toEqual(['e-1']);

    harness.scheduler.advance(1);
    await replied('e-1#4');
    expect(started).toEqual(['e-1', 'e-1']);
    expect(delivered).toEqual(['e-1#1', 'e-1#2', 'e-1#3', 'e-1#4']);
    expect(replies).toEqual(['e-1#1', 'e-1#2', 'e-1#3', 'e-1#4']);
  });

  test('an entity whose start keeps failing is backed off the same way, under the default supervision', async () => {
    // The first start and its ten restarts inside the shard's budget all fail —
    // at once, as supervision grants them — and the eleventh failure stops it.
    failingStarts = 11;
    const harness = await startShard(backoffConfig({ entityActor: FailingStartEntity, entityOptions: undefined }));
    harness.send(work('e-1', 1), harness.collector);
    await awaitCondition(() => started.length === 11, { timeoutMs: WAIT_MS, label: 'the start failed eleven times' });
    await harness.stopped('e-1');

    harness.send(work('e-1', 2), harness.collector);
    harness.send(work('e-1', 3), harness.collector);
    harness.scheduler.advance(MIN_MS - 1);
    expect(await harness.live()).toEqual([]);
    expect(started).toHaveLength(11);

    harness.scheduler.advance(1);
    await replied('e-1#3');
    expect(started).toHaveLength(12);
    expect(replies).toEqual(['e-1#2', 'e-1#3']);
  });

  test('with random-factor 0 the waits grow min, 2·min … up to max, and start again at min once the entity stayed up reset-after', async () => {
    const harness = await startShard(backoffConfig());
    harness.send(work('e-1', 0), harness.collector);
    await replied('e-1#0');

    await stopAndMeasure(harness, 'e-1', 1, MIN_MS);
    await stopAndMeasure(harness, 'e-1', 2, MIN_MS * 2);
    // Four times the first wait is past the ceiling, and the ceiling holds.
    await stopAndMeasure(harness, 'e-1', 3, MAX_MS);
    await stopAndMeasure(harness, 'e-1', 4, MAX_MS);

    // Up for reset-after since it came back: the next stop starts over.
    harness.scheduler.advance(RESET_AFTER_MS);
    await stopAndMeasure(harness, 'e-1', 5, MIN_MS);
    await stopAndMeasure(harness, 'e-1', 6, MIN_MS * 2);
  });

  test('a new incarnation is judged by how long the entity went without stopping since it came back, not by its own age', async () => {
    // The rule the shard failure backoff follows.  An entity re-created by a
    // message long after its last wait ended stops a few milliseconds into its
    // new incarnation however long it had gone without stopping, and judged by
    // those milliseconds it would go on doubling from a run that ended long ago.
    const harness = await startShard(backoffConfig());
    harness.send(work('e-1', 0), harness.collector);
    await replied('e-1#0');
    await stopAndMeasure(harness, 'e-1', 1, MIN_MS);
    await stopAndMeasure(harness, 'e-1', 2, MIN_MS * 2);

    // A third stop, whose wait ends with nothing held — and then a quiet spell
    // longer than reset-after in which nothing comes for the entity at all.
    harness.send(fail('e-1'));
    await harness.stopped('e-1');
    harness.scheduler.advance(MAX_MS + RESET_AFTER_MS);

    // The wait is long over, so a message creates the entity at once ...
    harness.send(work('e-1', 3), harness.collector);
    await replied('e-1#3');
    // ... and its next stop waits the first wait again, not the ceiling.
    await stopAndMeasure(harness, 'e-1', 4, MIN_MS);
  });

  test('a passivation in between is not a failure, so it does not restart the count', async () => {
    const harness = await startShard(backoffConfig());
    harness.send(work('e-1', 0), harness.collector);
    await replied('e-1#0');
    await stopAndMeasure(harness, 'e-1', 1, MIN_MS);

    // Passivated well inside reset-after, and re-created by the next message at once.
    harness.send({ kind: 'checkout', id: 'e-1' });
    await harness.stopped('e-1');
    harness.send(work('e-1', 2), harness.collector);
    await replied('e-1#2');

    // The run of stops went on: the second one waits twice the first.
    await stopAndMeasure(harness, 'e-1', 3, MIN_MS * 2);
  });

  test('a Passivate\'d entity is re-created on the next message without any wait; one that stopped itself is backed off', async () => {
    const harness = await startShard(backoffConfig());
    harness.send(work('e-1', 1), harness.collector);
    await replied('e-1#1');

    harness.send({ kind: 'checkout', id: 'e-1' });
    await harness.stopped('e-1');
    harness.send(work('e-1', 2), harness.collector);
    // No clock moved: there was no wait to end.
    await replied('e-1#2');
    expect(started).toEqual(['e-1', 'e-1']);

    // The same stop with nobody asking for it — the shape a recovery failure
    // swallowed by the entity, or a lost lease, takes.
    harness.send({ kind: 'stop', id: 'e-1' });
    await harness.stopped('e-1');
    harness.send(work('e-1', 3), harness.collector);
    expect(await harness.live()).toEqual([]);
    harness.scheduler.advance(MIN_MS);
    await replied('e-1#3');
  });

  test('StartEntity and StartEntities inside a wait re-create the entity at the wait\'s end, not before', async () => {
    const harness = await startShard(backoffConfig());
    harness.send(work('e-1', 1), harness.collector);
    await replied('e-1#1');
    harness.send(fail('e-1'));
    await harness.stopped('e-1');

    const startOne: StartEntity = { kind: 'sharding.StartEntity', entityId: 'e-1' };
    harness.shard.tell(startOne as ShardInbox);
    // e-2 never stopped, so the same batch creates it at once.
    const startBoth: StartEntities = { kind: 'sharding.StartEntities', entityIds: ['e-1', 'e-2'] };
    harness.shard.tell(startBoth as ShardInbox);
    expect(await harness.live()).toEqual(['e-2']);

    harness.scheduler.advance(MIN_MS - 1);
    expect(await harness.live()).toEqual(['e-2']);
    harness.scheduler.advance(1);
    expect([...(await harness.live())].sort()).toEqual(['e-1', 'e-2']);
  });

  test('a PassivateEntity for an entity backing off is answered with EntityStopped, and what it holds still arrives', async () => {
    const harness = await startShard(backoffConfig());
    harness.send(work('e-1', 1), harness.collector);
    await replied('e-1#1');
    harness.send(fail('e-1'));
    await harness.stopped('e-1');
    harness.send(work('e-1', 2), harness.collector);
    expect(await harness.live()).toEqual([]);

    // The region counted the entity resident when it routed that message, and
    // only an EntityStopped releases the slot; there is nothing here to stop.
    const passivate: PassivateEntity = { kind: 'sharding.PassivateEntity', entityId: 'e-1' };
    harness.shard.tell(passivate as ShardInbox);
    await awaitCondition(() => stoppedReports('e-1') === 2, { timeoutMs: WAIT_MS, label: 'the PassivateEntity was answered' });
    expect(await harness.live()).toEqual([]);

    harness.scheduler.advance(MIN_MS);
    await replied('e-1#2');
  });

  // One stop is reported once (#1437).  The region sends a `PassivateEntity`
  // for an entity it counts resident, so one can be on its way while the
  // entity stops by itself — and the stop has been reported by then.  An
  // answer is owed only when the region has counted the entity resident again
  // since, which it does on routing it a message.

  const passivateEntity = (entityId: string): PassivateEntity => ({ kind: 'sharding.PassivateEntity', entityId });

  test.each([
    { when: 'after the stop and its wait', advanceMs: MIN_MS },
    { when: 'inside the wait', advanceMs: 0 },
  ])('a PassivateEntity reaching the shard $when, with no message for the entity since, is not answered: one stop, one EntityStopped', async ({ advanceMs }) => {
    const harness = await startShard(backoffConfig());
    harness.send(work('e-1', 1), harness.collector);
    await replied('e-1#1');
    harness.send(fail('e-1'));
    await harness.stopped('e-1');
    harness.scheduler.advance(advanceMs);

    harness.shard.tell(passivateEntity('e-1') as ShardInbox);
    await harness.reported();
    expect(stoppedReports('e-1')).toBe(1);
    expect(await harness.live()).toEqual([]);
  });

  test('a release is answered once: a second PassivateEntity for the same residency gets nothing', async () => {
    const harness = await startShard(backoffConfig());
    harness.send(work('e-1', 1), harness.collector);
    await replied('e-1#1');
    harness.send(fail('e-1'));
    await harness.stopped('e-1');
    harness.send(work('e-1', 2), harness.collector);
    harness.shard.tell(passivateEntity('e-1') as ShardInbox);
    await awaitCondition(() => stoppedReports('e-1') === 2, { timeoutMs: WAIT_MS, label: 'the PassivateEntity was answered' });

    harness.shard.tell(passivateEntity('e-1') as ShardInbox);
    await harness.reported();
    expect(stoppedReports('e-1')).toBe(2);

    // A message after the answer counts the entity resident again, and so
    // makes the next one owed.
    harness.send(work('e-1', 3), harness.collector);
    harness.shard.tell(passivateEntity('e-1') as ShardInbox);
    await awaitCondition(() => stoppedReports('e-1') === 3, { timeoutMs: WAIT_MS, label: 'the next PassivateEntity was answered' });
    harness.scheduler.advance(MIN_MS);
    await replied('e-1#2');
    await replied('e-1#3');
  });

  test('a message past buffer-size still counts the entity resident, so the release is answered', async () => {
    const harness = await startShard(backoffConfig({ bufferSize: 1 }));
    for (const id of ['e-1', 'e-2']) {
      harness.send(work(id, 1), harness.collector);
      await replied(`${id}#1`);
      harness.send(fail(id));
      await harness.stopped(id);
    }
    // e-1's message fills the cap, so e-2's goes to dead letters — after the
    // region had counted e-2 resident to route it.
    harness.send(work('e-1', 2), harness.collector);
    harness.send(work('e-2', 2), harness.collector);
    await awaitCondition(() => deadWork().includes('e-2#2'), { timeoutMs: WAIT_MS, label: "e-2's message went over the cap" });

    harness.shard.tell(passivateEntity('e-2') as ShardInbox);
    await awaitCondition(() => stoppedReports('e-2') === 2, { timeoutMs: WAIT_MS, label: 'the PassivateEntity for e-2 was answered' });
  });

  test('an entity created since its last message is reported by its own stop, so a stale PassivateEntity after it gets nothing', async () => {
    const harness = await startShard(backoffConfig());
    harness.send(work('e-1', 1), harness.collector);
    await replied('e-1#1');
    harness.send(fail('e-1'));
    await harness.stopped('e-1');
    // Held inside the wait — the shard has it before the clock moves on — and
    // handed over by the incarnation the end of the wait creates.
    harness.send(work('e-1', 2), harness.collector);
    expect(await harness.live()).toEqual([]);
    harness.scheduler.advance(MIN_MS);
    await replied('e-1#2');

    // Back, then passivated on its own request: that stop is reported, and
    // nothing has reached the entity since.
    harness.send({ kind: 'checkout', id: 'e-1' });
    await awaitCondition(() => stoppedReports('e-1') === 2, { timeoutMs: WAIT_MS, label: 'the passivation was reported' });
    harness.shard.tell(passivateEntity('e-1') as ShardInbox);
    await harness.reported();
    expect(stoppedReports('e-1')).toBe(2);
  });

  test('past buffer-size the newest held message is dead-lettered with its sender, counted across the shard\'s entities', async () => {
    const harness = await startShard(backoffConfig({ bufferSize: 2 }));
    const warnings = (): number =>
      harness.log.records.filter((record) => record.level === 'warn' && record.message.includes('buffer-size')).length;
    const stopBoth = async (): Promise<void> => {
      for (const id of ['e-1', 'e-2']) {
        harness.send(fail(id));
        await harness.stopped(id);
      }
    };
    for (const id of ['e-1', 'e-2']) {
      harness.send(work(id, 1), harness.collector);
      await replied(`${id}#1`);
    }
    await stopBoth();

    harness.send(work('e-1', 2), harness.collector);
    harness.send(work('e-2', 2), harness.collector);
    // The cap is full now, across both entities: the next two go.
    harness.send(work('e-1', 3), harness.collector);
    harness.send(work('e-2', 3), harness.collector);
    await awaitCondition(() => deadWork().length === 2, { timeoutMs: WAIT_MS, label: 'the two over the cap were dead-lettered' });
    expect(deadWork()).toEqual(['e-1#3', 'e-2#3']);
    for (const letter of letters.filter((each) => (each.message as { kind?: unknown }).kind === 'work')) {
      expect(letter.sender?.path.toString()).toBe(harness.collector.path.toString());
      expect(letter.recipient.path.toString()).toBe(harness.shard.path.toString());
    }
    // One warning for the episode, not one per message.
    expect(warnings()).toBe(1);

    harness.scheduler.advance(MIN_MS);
    await replied('e-1#2');
    await replied('e-2#2');
    expect(delivered.filter((entry) => entry.endsWith('#3'))).toEqual([]);

    // Drained, so the next overflow is a new episode with its own warning.
    await stopBoth();
    for (const sequence of [4, 5, 6]) harness.send(work('e-1', sequence), harness.collector);
    await awaitCondition(() => deadWork().length === 3, { timeoutMs: WAIT_MS, label: 'the third over the cap was dead-lettered' });
    expect(warnings()).toBe(2);
  });

  test('a shard stopping with held messages dead-letters them with their senders, and leaves no wait armed', async () => {
    const harness = await startShard(backoffConfig());
    harness.send(work('e-1', 1), harness.collector);
    await replied('e-1#1');
    const armedBefore = harness.scheduler.pendingCount;
    harness.send(fail('e-1'));
    await harness.stopped('e-1');
    harness.send(work('e-1', 2), harness.collector);
    harness.send(work('e-1', 3), harness.collector);
    expect(await harness.live()).toEqual([]);
    expect(harness.scheduler.pendingCount).toBe(armedBefore + 1);

    harness.shard.stop();
    await awaitCondition(() => deadWork().length === 2, { timeoutMs: WAIT_MS, label: 'the held messages were dead-lettered' });
    expect(deadWork()).toEqual(['e-1#2', 'e-1#3']);
    for (const letter of letters.filter((each) => (each.message as { kind?: unknown }).kind === 'work')) {
      expect(letter.sender?.path.toString()).toBe(harness.collector.path.toString());
    }
    expect(harness.scheduler.pendingCount).toBe(armedBefore);
    harness.scheduler.advance(MIN_MS);
    expect(started).toEqual(['e-1']);
  });

  test('a ShardConfig that names none of the new fields runs with the built-in defaults', async () => {
    // The literal an application could have written against the previous
    // release.  Absent means the shipped backoff — a first wait of 200 ms
    // spread by 20 % — and a hold capped at the shipped buffer-size, not "off".
    const config: ShardConfig = { typeName: TYPE_NAME, shardId: 0, entityActor: Entity, entityOptions: stopOnFailure };
    const harness = await startShard(config);
    harness.send(work('e-1', 1), harness.collector);
    await replied('e-1#1');
    harness.send(fail('e-1'));
    await harness.stopped('e-1');
    harness.send(work('e-1', 2), harness.collector);

    // Short of the shortest first wait the jitter allows ...
    harness.scheduler.advance(159);
    expect(await harness.live()).toEqual([]);
    // ... and past the longest: held, not dead-lettered, and delivered.
    harness.scheduler.advance(81);
    await replied('e-1#2');
    expect(deadWork()).toEqual([]);
  });

  test('a ShardConfig that sets only a first wait above the default ceiling runs that wait rather than failing to start', async () => {
    // A ceiling below the first wait — one field set, the other defaulted — is
    // raised to the first wait: a shard has no caller to refuse it to.
    const config: ShardConfig = {
      typeName: TYPE_NAME,
      shardId: 0,
      entityActor: Entity,
      entityOptions: stopOnFailure,
      entityRestartBackoffMinMs: 20_000,
      entityRestartBackoffRandomFactor: 0,
    };
    const harness = await startShard(config);
    harness.send(work('e-1', 1), harness.collector);
    await replied('e-1#1');
    await stopAndMeasure(harness, 'e-1', 2, 20_000);
  });

  test('records of entities that stopped and were never addressed again do not outlive reset-after', async () => {
    const harness = await startShard(backoffConfig());
    const ids = ['e-1', 'e-2', 'e-3', 'e-4', 'e-5'];
    for (const id of ids) {
      harness.send(work(id, 1), harness.collector);
      await replied(`${id}#1`);
    }
    for (const id of ids) {
      harness.send(fail(id));
      await harness.stopped(id);
    }
    expect(harness.instance._restartRecordCount).toBe(5);

    // Their waits end with nothing held, and nothing ever comes for them again.
    harness.scheduler.advance(MAX_MS + RESET_AFTER_MS);
    harness.send(work('e-6', 1), harness.collector);
    await replied('e-6#1');
    harness.send(fail('e-6'));
    await harness.stopped('e-6');
    expect(harness.instance._restartRecordCount).toBe(1);
  });
});

/**
 * The region's empty-shard sweep only asks; the shard decides (#1441).  The
 * region judges "empty" by its own index, which learns of an entity from the
 * shard's spawn report — so the shard reads the request behind whatever it
 * was handed first, and that order is what these cases fix.
 */
describe('Shard — asked to passivate by its region (#1441)', () => {
  test('an empty shard stops, and a message queued behind the request starts nothing and is a dead letter', async () => {
    const harness = await startShard(backoffConfig());
    // One synchronous step: the request, and a message told straight to the
    // shard's ref behind it — the region buffers its own traffic from the
    // moment it asks, so only a ref holder can put anything there.
    harness.shard.tell(new ShardPassivationRequest(0) as ShardInbox);
    harness.send(work('e-1', 1), harness.collector);

    await awaitCondition(() => shardTerminated, { timeoutMs: WAIT_MS, label: 'the empty shard stopped' });
    const isTheEnvelope = (letter: DeadLetter): boolean => {
      const envelope = letter.message as Partial<EntityEnvelope<Command>>;
      return envelope.kind === 'sharding.EntityEnvelope' && envelope.entityId === 'e-1';
    };
    await awaitCondition(() => letters.some(isTheEnvelope), {
      timeoutMs: WAIT_MS,
      label: 'the message behind the request was dead-lettered',
    });
    // Dead-lettered by the shard as it stopped, never handed to an entity.
    expect(letters.find(isTheEnvelope)?.recipient.path.toString()).toBe(harness.shard.path.toString());
    expect(started).toEqual([]);
    expect(declines).toBe(0);
  });

  test('a shard asked right behind the message that creates its first entity declines, and the entity takes it', async () => {
    const harness = await startShard(backoffConfig());
    harness.send(work('e-1', 1), harness.collector);
    harness.shard.tell(new ShardPassivationRequest(0) as ShardInbox);

    await awaitCondition(() => declines === 1, { timeoutMs: WAIT_MS, label: 'the shard declined the request' });
    await replied('e-1#1');
    expect(await harness.live()).toEqual(['e-1']);
    expect(shardTerminated).toBe(false);
  });

  test('a shard asked right behind a start declines, and the started entity keeps running', async () => {
    const harness = await startShard(backoffConfig());
    const start: StartEntity = { kind: 'sharding.StartEntity', entityId: 'e-1' };
    harness.shard.tell(start as ShardInbox);
    harness.shard.tell(new ShardPassivationRequest(0) as ShardInbox);

    await awaitCondition(() => declines === 1, { timeoutMs: WAIT_MS, label: 'the shard declined the request' });
    expect(await harness.live()).toEqual(['e-1']);
    expect(started).toEqual(['e-1']);
    expect(shardTerminated).toBe(false);
  });

  // An entity backing off is not running, and its region's index has had the
  // `EntityStopped` — so nothing the region sees keeps such a shard, and it is
  // the shard that has to (#1437).

  test('a shard holding a message for an entity in its wait declines, and hands it over when the wait ends', async () => {
    const harness = await startShard(backoffConfig());
    harness.send(work('e-1', 1), harness.collector);
    await replied('e-1#1');
    harness.send(fail('e-1'));
    await harness.stopped('e-1');
    harness.send(work('e-1', 2), harness.collector);
    harness.shard.tell(new ShardPassivationRequest(0) as ShardInbox);

    await awaitCondition(() => declines === 1, { timeoutMs: WAIT_MS, label: 'the shard declined the request' });
    expect(await harness.live()).toEqual([]);
    harness.scheduler.advance(MIN_MS);
    await replied('e-1#2');
    expect(shardTerminated).toBe(false);
    expect(deadWork()).toEqual([]);
  });

  test('a shard whose entity a start is waiting to bring back declines, and the entity comes back when the wait ends', async () => {
    const harness = await startShard(backoffConfig());
    harness.send(work('e-1', 1), harness.collector);
    await replied('e-1#1');
    harness.send(fail('e-1'));
    await harness.stopped('e-1');
    const start: StartEntity = { kind: 'sharding.StartEntity', entityId: 'e-1' };
    harness.shard.tell(start as ShardInbox);
    harness.shard.tell(new ShardPassivationRequest(0) as ShardInbox);

    await awaitCondition(() => declines === 1, { timeoutMs: WAIT_MS, label: 'the shard declined the request' });
    harness.scheduler.advance(MIN_MS);
    expect(await harness.live()).toEqual(['e-1']);
    expect(started).toEqual(['e-1', 'e-1']);
  });

  test('a shard whose entity\'s armed return is due, its tick not yet read, declines, and the entity comes back', async () => {
    const harness = await startShard(backoffConfig());
    harness.send(work('e-1', 1), harness.collector);
    await replied('e-1#1');
    harness.send(fail('e-1'));
    await harness.stopped('e-1');
    const start: StartEntity = { kind: 'sharding.StartEntity', entityId: 'e-1' };
    harness.shard.tell(start as ShardInbox);
    expect(await harness.live()).toEqual([]);

    // One synchronous step: the request, then the clock past the wait — whose
    // tick goes in behind the request.  The wait is over and nothing is held
    // when the shard reads the request, but the start it armed is still owed.
    harness.shard.tell(new ShardPassivationRequest(0) as ShardInbox);
    harness.scheduler.advance(MIN_MS);
    await awaitCondition(() => declines === 1 || shardTerminated, {
      timeoutMs: WAIT_MS,
      label: 'the shard answered the request',
    });
    expect(declines).toBe(1);
    expect(await harness.live()).toEqual(['e-1']);
  });

  test('a shard whose entity is inside its wait with nothing held declines and keeps the wait; once the wait is over it stops', async () => {
    const harness = await startShard(backoffConfig());
    harness.send(work('e-1', 1), harness.collector);
    await replied('e-1#1');
    harness.send(fail('e-1'));
    await harness.stopped('e-1');
    harness.shard.tell(new ShardPassivationRequest(0) as ShardInbox);
    await awaitCondition(() => declines === 1, { timeoutMs: WAIT_MS, label: 'the shard declined the request' });

    // The record went nowhere: a message inside the wait is still held, not
    // handed to an entity created at once.
    harness.send(work('e-1', 2), harness.collector);
    expect(await harness.live()).toEqual([]);
    harness.scheduler.advance(MIN_MS);
    await replied('e-1#2');

    // Stopped again, and this time the wait runs out with nothing held: a
    // record that decides nothing any more does not keep the shard.
    harness.send(fail('e-1'));
    await harness.stopped('e-1');
    harness.scheduler.advance(MIN_MS * 2);
    harness.shard.tell(new ShardPassivationRequest(0) as ShardInbox);
    await awaitCondition(() => shardTerminated, { timeoutMs: WAIT_MS, label: 'the shard stopped' });
    expect(declines).toBe(1);
  });
});

/* -------------------- end to end, under the default supervision -------------------- */

type PoisonCommand = { readonly kind: 'poison'; readonly id: string; readonly sequence: number };

/** Counted in the constructor, so a restart and a re-creation each count once. */
let poisonInstances = 0;
/** The sequence of every poison command an instance received before throwing on it. */
let poisonReceived: number[] = [];

class PoisonedEntity extends Actor<PoisonCommand> {
  constructor() {
    super();
    poisonInstances++;
  }

  override onReceive(command: PoisonCommand): void {
    poisonReceived.push(command.sequence);
    throw new Error(`entity ${command.id} cannot take command ${command.sequence}`);
  }
}

const POISON_MESSAGES = 30;
const POISON_SPACING_MS = 5;
/** The default strategy's restarts a minute — every entity of a shard draws on them. */
const SHARD_RESTART_BUDGET = 10;
/** The shipped `entity-restart-backoff.min` and `random-factor`. */
const SHIPPED_MIN_MS = 200;
const SHIPPED_RANDOM_FACTOR = 0.2;

/**
 * How many shipped waits can end inside `trafficMs`, at their shortest and
 * counted from the first message — earlier than the first wait can start, so
 * the count is an upper bound.
 */
function waitsInside(trafficMs: number): number {
  let waits = 0;
  let elapsed = 0;
  for (let attempt = 0; attempt < 32; attempt++) {
    elapsed += SHIPPED_MIN_MS * 2 ** attempt * (1 - SHIPPED_RANDOM_FACTOR);
    if (elapsed > trafficMs) break;
    waits++;
  }
  return waits;
}

describe('ClusterSharding — an entity failing on every message, under the default supervision (#1437)', () => {
  test('thirty messages create clearly fewer than thirty instances: the restarts inside the budget, then one per wait', async () => {
    const systemName = 'entity-restart-poison';
    const port = 53_417;
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create(systemName, systemOptions);
    const clusterOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(port)
      .withSeeds([])
      .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
      .withGossipIntervalMs(30);
    const cluster = await Cluster.join(system, clusterOptions);
    runningCluster = { system, cluster };
    system.spawn(DeadLetterListener, 'dead-letter-listener');
    await awaitCondition(() => subscribed, { timeoutMs: WAIT_MS, label: 'the dead-letter listener subscribed' });

    // No entity options and no backoff options: the default supervision and the
    // shipped `entity-restart-backoff`, read from reference.conf.
    const shardingOptions = StartShardingOptions.create<PoisonCommand>()
      .withTypeName('poisoned')
      .withEntityActor(PoisonedEntity)
      .withExtractEntityId((command) => command.id);
    const region = cluster.sharding.start(shardingOptions);

    let sent = 0;
    let trafficMs = 0;
    const trafficStart = performance.now();
    const pacer = system.scheduler.scheduleAtFixedRateFunction(0, POISON_SPACING_MS, () => {
      if (sent >= POISON_MESSAGES) return;
      sent++;
      region.tell({ kind: 'poison', id: 'p-1', sequence: sent });
      if (sent === POISON_MESSAGES) trafficMs = performance.now() - trafficStart;
    });
    await awaitCondition(() => sent === POISON_MESSAGES, { timeoutMs: WAIT_MS, label: 'all thirty messages were sent' });
    pacer.cancel();

    // Every message ends one of two ways: an instance received it and threw, or
    // it was still in the mailbox of an instance that was stopped and went to
    // dead letters.  Once all thirty are accounted for, nothing is left to
    // create another instance.
    const poisonLetters = (): number =>
      letters.filter((letter) => (letter.message as { kind?: unknown }).kind === 'poison').length;
    await awaitCondition(() => poisonReceived.length + poisonLetters() === POISON_MESSAGES, {
      timeoutMs: WAIT_MS,
      label: 'every message was received or dead-lettered',
    });

    // The first instance and its restarts inside the budget, one re-creation per
    // wait that could end inside the traffic, and the one the last wait ends in.
    const bound = 1 + SHARD_RESTART_BUDGET + waitsInside(trafficMs) + 1;
    expect(poisonInstances).toBeLessThan(POISON_MESSAGES);
    expect(poisonInstances).toBeLessThanOrEqual(bound);
    // At least one re-creation: what waited for the entity was handed to it.
    expect(poisonInstances).toBeGreaterThanOrEqual(1 + SHARD_RESTART_BUDGET + 1);
  }, 15_000);
});

/* ------------- end to end: the empty-shard sweep and a backing-off entity ------------- */

/**
 * The empty-shard window of the case below, and with it the sweep timer's
 * interval — odd, so {@link SweepCapturingScheduler} holds back exactly the
 * sweep and schedules everything else for real.
 */
const SWEEP_WINDOW_MS = 53;

/** The case's restart wait, `min` = `max` at random-factor 0 — far longer than the shard's window. */
const LONG_WAIT_MS = 701;

/** When each reply arrived at its collector, by `id#sequence`. */
const replyTimes = new Map<string, number>();

class TimedReplyCollector extends Actor<WorkDoneReply> {
  override onReceive(reply: WorkDoneReply): void {
    replyTimes.set(`${reply.id}#${reply.sequence}`, performance.now());
  }
}

/** Holds back the region's sweep timer, so the case fires the sweep itself. */
class SweepCapturingScheduler extends Scheduler {
  private readonly sweeps: Array<() => void> = [];

  override scheduleAtFixedRateFunction(initialDelayMs: number, intervalMs: number, task: () => void): Cancellable {
    if (intervalMs !== SWEEP_WINDOW_MS) return super.scheduleAtFixedRateFunction(initialDelayMs, intervalMs, task);
    this.sweeps.push(task);
    return { cancel: (): boolean => false, get isCancelled(): boolean { return false; } };
  }

  /** Fire the region's sweep timer, exactly as it would have fired itself. */
  fireSweep(): void {
    if (this.sweeps.length !== 1) throw new Error(`expected one captured sweep timer, found ${this.sweeps.length}`);
    this.sweeps[0]!();
  }
}

describe('ClusterSharding — the empty-shard sweep and an entity backing off (#1437)', () => {
  test('a shard holding messages for an entity in its wait outlives a shorter shard window, and hands them over when the wait ends', async () => {
    replyTimes.clear();
    const systemName = 'entity-restart-sweep';
    const port = 53_418;
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
    runningCluster = { system, cluster };
    system.spawn(DeadLetterListener, 'dead-letter-listener');
    await awaitCondition(() => subscribed, { timeoutMs: WAIT_MS, label: 'the dead-letter listener subscribed' });
    const collector = system.spawn(TimedReplyCollector, 'timed-reply-collector') as ActorRef<unknown>;

    const shardingOptions = StartShardingOptions.create<Command>()
      .withTypeName(TYPE_NAME)
      .withEntityActor(Entity)
      .withEntityOptions(stopOnFailure as ActorOptions<Command>)
      .withExtractEntityId((command) => command.id)
      .withPassivationIdleMs(0)
      .withShardPassivationIdleMs(SWEEP_WINDOW_MS)
      .withEntityRestartBackoffMinMs(LONG_WAIT_MS)
      .withEntityRestartBackoffMaxMs(LONG_WAIT_MS)
      .withEntityRestartBackoffRandomFactor(0);
    const region = cluster.sharding.start(shardingOptions);
    const entityCount = async (): Promise<number> =>
      (await cluster.sharding.shards(TYPE_NAME)).reduce((sum, shard) => sum + shard.entityCount, 0);

    region.tell(work('e-1', 1), collector);
    await awaitCondition(() => replyTimes.has('e-1#1'), { timeoutMs: WAIT_MS, label: 'the entity answered its first message' });
    // The shard's only entity stops unasked, so the shard is empty in its
    // region's index from the report on — and that is where its window starts.
    const stoppedAt = performance.now();
    region.tell(fail('e-1'));
    await awaitCondition(async () => (await entityCount()) === 0, {
      timeoutMs: WAIT_MS,
      label: "the region saw the shard's only entity stop",
    });
    region.tell(work('e-1', 2), collector);
    const from = Date.now();
    await awaitCondition(() => Date.now() - from > SWEEP_WINDOW_MS, {
      timeoutMs: WAIT_MS,
      intervalMs: 5,
      label: 'one shard window passed on the wall clock',
    });

    scheduler.fireSweep();
    // A message sent after the sweep meets the same wait, not a fresh shard
    // that has forgotten it.
    region.tell(work('e-1', 3), collector);
    const isWork = (letter: DeadLetter): boolean => (letter.message as { kind?: unknown }).kind === 'work';
    await awaitCondition(() => (replyTimes.has('e-1#2') && replyTimes.has('e-1#3')) || letters.some(isWork), {
      timeoutMs: WAIT_MS,
      label: 'the held messages were handed over, or dead-lettered',
    });

    expect(deadWork()).toEqual([]);
    // Both waited out the wait the entity's stop began.
    expect(replyTimes.get('e-1#2')! - stoppedAt).toBeGreaterThanOrEqual(LONG_WAIT_MS - 20);
    expect(replyTimes.get('e-1#3')! - stoppedAt).toBeGreaterThanOrEqual(LONG_WAIT_MS - 20);
  }, 15_000);
});
