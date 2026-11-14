/**
 * A shard says why an entity stopped, and brings a remembered one back on its
 * own (#954).
 *
 * `Shard.onEntityTerminated` reported every stop as a bare `EntityStopped`, and
 * under `rememberEntities` the coordinator persists that as a `stopped` event:
 * an entity that exhausted its restart budget, or failed once under
 * `stoppingStrategy`, was dropped from the durable registry and not revived
 * after the next node failure — the one case remember-entities exists for.
 * The shard already holds what tells the two apart — `passivating` is non-null
 * only on the stop it asked for — so the report now carries
 * `reason: 'passivated' | 'unrequested'`, and the coordinator forgets only the
 * first.  Under `rememberEntities` the shard re-creates an entity that stopped
 * unasked at the end of its restart backoff (#1437), instead of leaving it
 * down until a message happens to arrive.
 *
 * The harness is the one `EntityRestartBackoff.test.ts` uses, cut down: a
 * `Shard` under a stand-in region that records its reports, on a
 * `ManualScheduler`, so the end of a wait is a clock step and "not re-created"
 * is an assertion rather than a race.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../../src/Actor.js';
import { ActorOptions } from '../../../../src/ActorOptions.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { Passivate } from '../../../../src/cluster/sharding/Passivate.js';
import { Shard } from '../../../../src/cluster/sharding/Shard.js';
import type { ShardConfig, ShardInbox } from '../../../../src/cluster/sharding/Shard.js';
import type {
  EntityEnvelope,
  EntityStarted,
  EntityStopped,
  GetShardStats,
  PassivateEntity,
  ShardStats,
} from '../../../../src/cluster/sharding/ShardingProtocol.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { stoppingStrategy } from '../../../../src/Supervision.js';
import { ManualScheduler } from '../../../../src/testkit/ManualScheduler.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

/** The first restart wait — odd, so no other timer of the system shares it. */
const MIN_MS = 307;
/** The failure budget of every wait below, under bun's 5 s per-test cap. */
const WAIT_MS = 4_000;

type FailCommand = { readonly kind: 'fail' };
type StopCommand = { readonly kind: 'stop' };
type CheckoutCommand = { readonly kind: 'checkout' };
type PassivateStopCommand = { readonly kind: 'passivate-stop' };
type PingCommand = { readonly kind: 'ping' };
type Command = FailCommand | StopCommand | CheckoutCommand | PassivateStopCommand | PingCommand;

let started: string[] = [];
let reports: Array<EntityStarted | EntityStopped> = [];
let statsReplies: ShardStats[] = [];
let shardRef: ActorRef<ShardInbox> | null = null;
let running: ActorSystem | null = null;

afterEach(async () => {
  if (running) await running.terminate().catch(() => { /* teardown is best-effort */ });
  running = null;
  started = [];
  reports = [];
  statsReplies = [];
  shardRef = null;
});

class Entity extends Actor<Command> {
  override preStart(): void { started.push(this.entityId); }

  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'fail' }, () => this.onFail())
      .with({ kind: 'stop' }, () => this.onStop())
      .with({ kind: 'checkout' }, () => this.onCheckout())
      .with({ kind: 'passivate-stop' }, () => this.onPassivateStop())
      .with({ kind: 'ping' }, () => this.onPing())
      .exhaustive();
  }

  private onFail(): void { throw new Error(`entity ${this.entityId} failed on purpose`); }

  private onStop(): void { this.context.stopSelf(); }

  private onCheckout(): void {
    const stopMessage: PassivateStopCommand = { kind: 'passivate-stop' };
    this.context.parent.forEach((parent) => parent.tell(new Passivate(stopMessage, this.self) as never, this.self));
  }

  private onPassivateStop(): void { this.context.stopSelf(); }

  private onPing(): void { /* only creates the entity */ }
}

class StatsCollector extends Actor<ShardStats> {
  override onReceive(stats: ShardStats): void { statsReplies.push(stats); }
}

class RegionStandIn extends Actor<EntityStarted | EntityStopped> {
  constructor(private readonly shardConfig: ShardConfig) { super(); }

  override preStart(): void {
    shardRef = this.context.spawn<ShardInbox>(() => new Shard(this.shardConfig), 'shard-0');
  }

  override onReceive(report: EntityStarted | EntityStopped): void { reports.push(report); }
}

type Harness = {
  readonly scheduler: ManualScheduler;
  readonly send: (entityId: string, message: Command) => void;
  readonly passivate: (entityId: string) => void;
  readonly live: () => Promise<readonly string[]>;
  readonly stopped: (entityId: string) => Promise<void>;
};

async function startShard(overrides: Partial<ShardConfig> = {}): Promise<Harness> {
  const scheduler = new ManualScheduler();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withScheduler(scheduler);
  const system = ActorSystem.create('shard-stop-reason', systemOptions);
  running = system;
  const statsCollector = system.spawn(StatsCollector, 'stats-collector');
  const config: ShardConfig = {
    typeName: 'entity',
    shardId: 0,
    entityActor: Entity,
    entityOptions: ActorOptions.create().withSupervisorStrategy(stoppingStrategy),
    entityRestartBackoffMinMs: MIN_MS,
    entityRestartBackoffMaxMs: MIN_MS,
    entityRestartBackoffRandomFactor: 0,
    ...overrides,
  };
  system.spawn(() => new RegionStandIn(config), 'region');
  await awaitCondition(() => shardRef !== null, { timeoutMs: WAIT_MS, label: 'the shard is up' });
  const shard = shardRef!;

  const send = (entityId: string, message: Command): void => {
    const envelope: EntityEnvelope<Command> = { kind: 'sharding.EntityEnvelope', entityId, message };
    shard.tell(envelope as ShardInbox);
  };
  const passivate = (entityId: string): void => {
    const request: PassivateEntity = { kind: 'sharding.PassivateEntity', entityId };
    shard.tell(request as ShardInbox);
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
  return { scheduler, send, passivate, live, stopped };
}

/** The reasons the shard reported `entityId` stopped with, in order. */
function stopReasons(entityId: string): Array<string | undefined> {
  return reports
    .filter((report): report is EntityStopped => report.kind === 'sharding.EntityStopped' && report.entityId === entityId)
    .map((report) => report.reason);
}

async function reportedStops(entityId: string, count: number): Promise<void> {
  await awaitCondition(() => stopReasons(entityId).length >= count, {
    timeoutMs: WAIT_MS,
    label: `${count} stop report(s) for '${entityId}'`,
  });
}

describe('Shard — the reason a stop is reported with (#954)', () => {
  test('a failure is reported as unrequested', async () => {
    const harness = await startShard();
    harness.send('e-1', { kind: 'ping' });
    harness.send('e-1', { kind: 'fail' });
    await reportedStops('e-1', 1);

    expect(stopReasons('e-1')).toEqual(['unrequested']);
  });

  test('a plain stopSelf is reported as unrequested too: the shard did not ask for it', async () => {
    const harness = await startShard();
    harness.send('e-1', { kind: 'stop' });
    await reportedStops('e-1', 1);

    expect(stopReasons('e-1')).toEqual(['unrequested']);
  });

  test('a region passivation is reported as passivated', async () => {
    const harness = await startShard();
    harness.send('e-1', { kind: 'ping' });
    await awaitCondition(() => started.length === 1, { timeoutMs: WAIT_MS, label: 'the entity started' });
    harness.passivate('e-1');
    await reportedStops('e-1', 1);

    expect(stopReasons('e-1')).toEqual(['passivated']);
  });

  test('an entity asking for its own passivation is reported as passivated', async () => {
    const harness = await startShard();
    harness.send('e-1', { kind: 'checkout' });
    await reportedStops('e-1', 1);

    expect(stopReasons('e-1')).toEqual(['passivated']);
  });

  test('a passivation that releases a backing-off entity\'s slot is reported as passivated', async () => {
    // The entity failed, then a message arrived inside its wait — the region
    // counts it resident again — and the region passivated it.  The answer is
    // the region's own decision to drop it, so it is the forgetting kind.
    const harness = await startShard();
    harness.send('e-1', { kind: 'fail' });
    await harness.stopped('e-1');
    harness.send('e-1', { kind: 'ping' });
    harness.passivate('e-1');
    await reportedStops('e-1', 2);

    expect(stopReasons('e-1')).toEqual(['unrequested', 'passivated']);
  });
});

describe('Shard — a remembered entity that stopped unasked comes back on its own (#954)', () => {
  test('under rememberEntities it is re-created at the end of its wait, with no message for it', async () => {
    const harness = await startShard({ rememberEntities: true });
    harness.send('e-1', { kind: 'fail' });
    await harness.stopped('e-1');

    harness.scheduler.advance(MIN_MS - 1);
    expect(await harness.live()).toEqual([]);
    harness.scheduler.advance(1);
    await awaitCondition(async () => (await harness.live()).includes('e-1'), {
      timeoutMs: WAIT_MS,
      label: 'the remembered entity came back',
    });
    expect(started).toEqual(['e-1', 'e-1']);
  });

  test('without rememberEntities it stays down until a message asks for it, as before', async () => {
    const harness = await startShard();
    harness.send('e-1', { kind: 'fail' });
    await harness.stopped('e-1');

    harness.scheduler.advance(MIN_MS * 4);
    expect(await harness.live()).toEqual([]);
    expect(started).toEqual(['e-1']);
  });

  test('a passivated remembered entity is not brought back', async () => {
    const harness = await startShard({ rememberEntities: true });
    harness.send('e-1', { kind: 'checkout' });
    await reportedStops('e-1', 1);

    harness.scheduler.advance(MIN_MS * 4);
    expect(await harness.live()).toEqual([]);
    expect(started).toEqual(['e-1']);
  });
});
