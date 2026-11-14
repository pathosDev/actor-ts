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
 *
 * A shard can also be placed on another node that nobody runs.  An entity
 * message for it goes out in an envelope the transport records, and the
 * correlation in that envelope is what a test answers with — the remote-ask
 * table, the one of the three the lifetime was first raised for.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../../src/Actor.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Config } from '../../../../src/config/Config.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { LeaderChanged } from '../../../../src/cluster/ClusterEvents.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { stageMember } from '../../../util/StagedMember.js';
import type { WireMessage } from '../../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { hashShardId } from '../../../../src/cluster/sharding/ShardAllocator.js';
import { ShardRegion, type ShardRegionConfig } from '../../../../src/cluster/sharding/ShardRegion.js';
import type { ShardingOptionsType } from '../../../../src/cluster/sharding/ShardingOptions.js';
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import {
  AuthenticatedShardingMessage,
  type ClusterShardingStats,
  type GetShardLocation,
  type GetShards,
  type RegisterAcknowledgment,
  type ShardEnvelope,
  type ShardHome,
  type ShardingMessage,
  type ShardReply,
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

/** What the region sent its coordinator, unwrapped. */
let coordinatorFrames: ShardingMessage[] = [];

/**
 * Every entity envelope the node put on the wire for a shard on another
 * node — the correlation in it is the key of the remote-ask table entry its
 * caller is waiting in.
 */
let remoteEnvelopes: ShardEnvelope[] = [];

/** Every `sharding.Reply` the node put on the wire — what a forwarding hop sends back toward its origin. */
let remoteReplies: ShardReply[] = [];

const isShardReply = (body: unknown): body is ShardReply =>
  typeof body === 'object' && body !== null && (body as { kind?: unknown }).kind === 'sharding.Reply';

const isShardEnvelope = (body: unknown): body is ShardEnvelope =>
  typeof body === 'object' && body !== null && (body as { kind?: unknown }).kind === 'sharding.Envelope';

/**
 * Record what the node hands its transport.  The node the envelopes are
 * addressed to has no process behind it — only a transport that drops what
 * it is handed — so the send is where it is seen.
 */
function recordEnvelopes(transport: InMemoryTransport): void {
  const send = transport.send.bind(transport);
  transport.send = (to: NodeAddress, message: WireMessage): void => {
    if (message.kind === 'envelope' && isShardEnvelope(message.body)) remoteEnvelopes.push(message.body);
    if (message.kind === 'envelope' && isShardReply(message.body)) remoteReplies.push(message.body);
    send(to, message);
  };
}

/** Stands in for the coordinator in the one test that needs the region to register. */
class CoordinatorProbe extends Actor<unknown> {
  override onReceive(message: unknown): void {
    if (message instanceof AuthenticatedShardingMessage) {
      this.onFrame(message.message);
      return;
    }
    this.onFrame(message as ShardingMessage);
  }

  private onFrame(frame: ShardingMessage): void { coordinatorFrames.push(frame); }
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
  /** Every fixed-rate interval asked for since capture was switched on, captured or armed. */
  private readonly requestedIntervals: number[] = [];

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
    if (this.captureIntervalMs !== null) this.requestedIntervals.push(intervalMs);
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

  /** Every fixed-rate interval asked for since capture was switched on — what a failure names. */
  fixedRateIntervals(): readonly number[] { return this.requestedIntervals; }

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
  /** Stand a coordinator probe behind the resolver, reachable once `openCoordinator` runs. */
  readonly withCoordinator?: boolean;
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
  /** Tell the region the coordinator placed `shardId` on another node, which nobody listens on. */
  readonly placeRemotely: (shardId: number) => void;
  /** Hand the region the other node's reply for the remote ask carrying `correlationId`. */
  readonly reply: (correlationId: number, message: unknown) => void;
  /** Hand the region a reply for `correlationId` attributed to `peer` — a forgery unless it is the asked node (#1268). */
  readonly replyFrom: (peer: NodeAddress, correlationId: number, message: unknown) => void;
  /** Answer the `shards()` query carrying `correlationId`, with an empty map. */
  readonly answerStats: (correlationId: number) => void;
  /** Answer the `shards()` query carrying `correlationId` from `peer` — a forgery unless it is the coordinator's node (#1268). */
  readonly answerStatsFrom: (peer: NodeAddress, correlationId: number) => void;
  /** A member-like address that is neither this node nor the remote one. */
  readonly bystander: NodeAddress;
  /** The node `placeRemotely` places shards on. */
  readonly remoteNode: NodeAddress;
  /** Resolve once the region has handled everything told to it before this call. */
  readonly fence: () => Promise<void>;
  /** Fire the sweep timer and wait until the region has acted on it. */
  readonly sweep: () => Promise<void>;
  /** Let the region's resolver find the coordinator probe from now on. */
  readonly openCoordinator: () => void;
  /** Tell the region its registration was acknowledged, as the coordinator would. */
  readonly acknowledgeRegistration: () => void;
};

let running: { cluster: Cluster; system: ActorSystem } | null = null;
let remoteListener: InMemoryTransport | null = null;

afterEach(async () => {
  if (running) {
    await running.cluster.leave().catch(() => { /* teardown is best-effort */ });
    await running.system.terminate().catch(() => { /* teardown is best-effort */ });
    running = null;
  }
  if (remoteListener) {
    await remoteListener.shutdown();
    remoteListener = null;
  }
  answers.clear();
  coordinatorFrames = [];
  remoteEnvelopes = [];
  remoteReplies = [];
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
  const transport = new InMemoryTransport(new NodeAddress(systemName, 'h', port));
  recordEnvelopes(transport);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(transport)
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

  // A resolver that misses: `ensureRegistered` records this node as the
  // coordinator's before it resolves the ref, so the region trusts the
  // placements minted below while having nobody to send a request to — until a
  // test that asked for a coordinator probe opens it.
  const coordinator = options.withCoordinator === true ? system.spawn(CoordinatorProbe, 'coordinator-probe') : null;
  let coordinatorReachable = false;
  const resolver = (path: string): ActorRef | null =>
    coordinator !== null && coordinatorReachable && path.includes('coordinator')
      ? (coordinator as unknown as ActorRef)
      : null;

  const shardingOptions: ShardingOptionsType<Command> = {
    typeName: TYPE_NAME,
    entityActor: Entity,
    extractEntityId: (message) => message.id,
    numShards: NUM_SHARDS,
    // Only matters once a coordinator becomes reachable: how soon the region notices.
    registerRetryIntervalMs: 50,
  };
  const config: ShardRegionConfig<Command> = {
    ...ShardRegion.settingsToConfig<Command>(shardingOptions, cluster, resolver),
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

  // The other node of the remote cases: a node nobody runs, so what the
  // region sends it is recorded by `recordEnvelopes` and goes no further.  It
  // still needs a transport the cluster counts as a connected peer — the
  // cluster sends nothing to an address that is neither a member nor
  // connected (#936) — and one that drops what it receives is enough.  And it
  // is staged as a member, because a region refuses a home on a node that is
  // none (#1750).  Its host sorts after this node's, so staging it does not
  // move the leadership — the lowest address leads.
  const remoteNode = stageMember(cluster, new NodeAddress(options.systemName, 'remote', options.port));
  remoteListener = new InMemoryTransport(remoteNode);
  await remoteListener.start();

  const placeRemotely = (shardId: number): void => {
    const home: ShardHome = {
      kind: 'sharding.ShardHome',
      shardId,
      region: region.path.toString(),
      node: remoteNode.toJSON(),
    };
    region.tell(authenticated(home));
  };

  // How a reply arrives: the other node's region tells it back, and the
  // cluster hands it over attributed to the connection it came in on.
  const replyFrom = (peer: NodeAddress, correlationId: number, message: unknown): void => {
    const shardReply: ShardReply = { kind: 'sharding.Reply', correlationId, message };
    region.tell(new AuthenticatedShardingMessage(peer, shardReply));
  };
  const reply = (correlationId: number, message: unknown): void => replyFrom(remoteNode, correlationId, message);

  const answerStatsFrom = (peer: NodeAddress, correlationId: number): void => {
    const stats: ClusterShardingStats = { kind: 'sharding.ClusterShardingStats', correlationId, shards: [] };
    region.tell(new AuthenticatedShardingMessage(peer, stats));
  };
  const answerStats = (correlationId: number): void => answerStatsFrom(cluster.selfAddress, correlationId);

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
    placeRemotely,
    reply,
    replyFrom,
    answerStats,
    answerStatsFrom,
    bystander: new NodeAddress(options.systemName, 'bystander', options.port),
    remoteNode,
    fence,
    sweep: async () => {
      scheduler.fireSweep();
      await fence();
    },
    openCoordinator: () => { coordinatorReachable = true; },
    acknowledgeRegistration: () => {
      const acknowledgment: RegisterAcknowledgment = {
        kind: 'sharding.RegisterAcknowledgment',
        coordinator: 'coordinator-probe',
      };
      region.tell(authenticated(acknowledgment));
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

/** The correlations of the `shards()` queries still waiting, oldest first. */
const statsCorrelationsOf = (region: ShardRegion<Command>): number[] =>
  Array.from((region as unknown as { readonly pendingStatsAsks: ReadonlyMap<number, unknown> }).pendingStatsAsks.keys());

/** The first of `entity-0`, `entity-1`, … that hashes to `shardId`. */
function entityOn(shardId: number): string {
  for (let index = 0; index < 10_000; index++) {
    const entityId = `entity-${index}`;
    if (hashShardId(entityId, NUM_SHARDS) === shardId) return entityId;
  }
  throw new Error(`no entity id among the first 10 000 hashes to shard ${shardId}`);
}

/** A caller waiting on another node, and the correlation its entry in the remote-ask table is keyed by. */
type RemoteAsk = {
  readonly caller: ActorRef<unknown>;
  readonly correlationId: number;
};

/**
 * Send an entity on `shardId`, placed on another node, a message from a
 * recorder labelled `label`.  The region forwards it in an envelope and keeps
 * the recorder in its remote-ask table, under the correlation the envelope
 * carries, until the reply comes back or the sweep forgets it.
 */
async function askRemotely(harness: Harness, label: string, shardId: number): Promise<RemoteAsk> {
  const caller = harness.recorder(label);
  const entityId = entityOn(shardId);
  harness.placeRemotely(shardId);
  const work: WorkCommand = { kind: 'work', id: entityId };
  harness.region.tell(work, caller);
  await harness.fence();
  const correlationId = remoteEnvelopes
    .find((envelope) => (envelope.message as Partial<WorkCommand>).id === entityId)?.correlationId;
  if (correlationId === undefined || correlationId === null) {
    throw new Error(`no envelope carrying a correlation went out for '${entityId}'`);
  }
  return { caller, correlationId };
}

/**
 * {@link keptUntil}'s counterpart for the remote-ask table: two callers waiting
 * on another node, asked together.  A reply for the first after the first
 * sweep must still reach it; a reply for the second after the second sweep
 * must find nobody waiting.
 */
async function remoteKeptUntil(harness: Harness, keptAtMs: number, droppedAtMs: number): Promise<void> {
  const kept = await askRemotely(harness, 'remote-kept', 5);
  const dropped = await askRemotely(harness, 'remote-dropped', 6);

  harness.scheduler.advance(keptAtMs);
  await harness.sweep();
  harness.reply(kept.correlationId, 'answered in time');
  await harness.fence();
  await drain(kept.caller);
  expect(answersOf('remote-kept')).toEqual(['answered in time']);

  harness.scheduler.advance(droppedAtMs - keptAtMs);
  await harness.sweep();
  harness.reply(dropped.correlationId, 'answered too late');
  await harness.fence();
  await drain(dropped.caller);
  expect(answerCountOf('remote-dropped')).toBe(0);
}

/**
 * Start a type through `ClusterSharding.start`, the path production takes,
 * capturing a fixed-rate timer at {@link LIFETIME_FLOOR_MS}, and return once
 * its region has armed every timer `preStart` arms.  A shard id outside the
 * range is refused on the region's own turn, so its answer can only come
 * after `preStart`.
 */
async function startTypeCapturingTheFloor(node: Node, queryTimeoutMs?: number): Promise<void> {
  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id);
  if (queryTimeoutMs !== undefined) shardingOptions.withShardRegionQueryTimeoutMs(queryTimeoutMs);
  node.scheduler.captureFixedRate(LIFETIME_FLOOR_MS);
  const region = node.cluster.sharding.start<Command>(shardingOptions) as unknown as ActorRef<unknown>;
  await region.ask(locationQuery(-1), 2_000).catch(() => undefined);
}

describe('the asks sweep forgets the callers nobody answers (#1436)', () => {
  test('a shards() query past its lifetime is dropped, one asked later still answers', async () => {
    const harness = await startRegion({ systemName: '1436-stats', port: 45_736, lifetimeMs: LIFETIME_FLOOR_MS });
    const early = harness.recorder('early');
    const later = harness.recorder('later');

    // Correlations are random (#1268), so each is read back off the table
    // right after its query was made.
    harness.region.tell(statsQuery(), early);
    await harness.fence();
    const [earlyCorrelation] = statsCorrelationsOf(harness.instance());
    harness.scheduler.advance(30_000);
    harness.region.tell(statsQuery(), later);
    await harness.fence();
    const laterCorrelation = statsCorrelationsOf(harness.instance()).find((id) => id !== earlyCorrelation)!;
    // The early query is now past the lifetime; the later one, asked half a lifetime later, is not.
    harness.scheduler.advance(30_001);
    await harness.sweep();

    harness.answerStats(earlyCorrelation!);
    harness.answerStats(laterCorrelation);
    await harness.fence();
    await drain(early);
    await drain(later);

    expect(answerCountOf('early')).toBe(0);
    // The control: the same minted answer does reach a caller that was kept.
    expect(answersOf('later')).toEqual([[]]);
    const swept = debugLines(harness.log, 'shards() query');
    expect(swept).toHaveLength(1);
    expect(swept[0]).toContain(`query ${earlyCorrelation} of 'pending'`);
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

  test('a query timeout under a minute leaves the lifetime at the minute', async () => {
    // `ClusterSharding.start` always hands its region a query timeout, so a
    // region that took it as the lifetime, rather than as a bound the
    // lifetime may not fall below, would forget every remote ask and every
    // waiting query a second in here.  The query timeout only ever raises it.
    const node = await joinCluster('1436-short-query', 45_747);
    await startTypeCapturingTheFloor(node, 1_000);

    expect(node.scheduler.fixedRateIntervals()).not.toContain(1_000);
    expect(node.scheduler.capturedTimers(), `fixed-rate timers armed: ${node.scheduler.fixedRateIntervals()}`)
      .toBe(1);
  }, 20_000);

  test('and so does the query timeout a type gets when it names none', async () => {
    // Five seconds out of the box — the value every type started without one
    // hands its region.
    const node = await joinCluster('1436-shipped-query', 45_748);
    await startTypeCapturingTheFloor(node);

    expect(node.scheduler.capturedTimers(), `fixed-rate timers armed: ${node.scheduler.fixedRateIntervals()}`)
      .toBe(1);
  }, 20_000);
});

describe('a caller waiting on another node is kept as long, on the same clock (#1436)', () => {
  // The remote-ask table: an entity message whose shard lives on another node
  // goes out in an envelope, and the caller waits here for the reply.  It was
  // the case the lifetime was raised for, and every case above waits on a
  // query instead.
  test('a minute, with the shipped ask timeout', async () => {
    const harness = await startRegion({ systemName: '1436-remote-floor', port: 45_749, lifetimeMs: LIFETIME_FLOOR_MS });
    await remoteKeptUntil(harness, 59_000, LIFETIME_FLOOR_MS + 1);
  }, 20_000);

  test('no less than actor-ts.actor.ask-timeout, when that is longer', async () => {
    // An entity on another node answering inside a long ask's deadline but
    // more than a minute in: the reply has to find its caller.
    const harness = await startRegion({
      systemName: '1436-remote-ask-timeout',
      port: 45_750,
      hocon: 'actor-ts.actor.ask-timeout = 121237ms',
      lifetimeMs: 121_237,
    });
    await remoteKeptUntil(harness, 120_000, 121_300);
  }, 20_000);

  test('stamped on system.clock, the clock the sweep reads', async () => {
    // Ten minutes between `system.clock` and the wall clock: a caller stamped
    // from the wall clock is already past its lifetime at the first sweep.
    const harness = await startRegion({ systemName: '1436-remote-clock', port: 45_751, lifetimeMs: LIFETIME_FLOOR_MS });
    harness.scheduler.advance(600_000);
    await remoteKeptUntil(harness, 59_000, LIFETIME_FLOOR_MS + 1);
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

describe('a query made before the region registered is delayed, not lost (#1436)', () => {
  test('both queries are asked again once the coordinator acknowledges the region', async () => {
    const harness = await startRegion({
      systemName: '1436-registration',
      port: 45_743,
      lifetimeMs: LIFETIME_FLOOR_MS,
      withCoordinator: true,
    });
    const location = harness.recorder('location');
    const stats = harness.recorder('stats');

    // Asked while no coordinator can be reached: nothing leaves the region.
    harness.region.tell(locationQuery(5), location);
    harness.region.tell(statsQuery(1_234), stats);
    await harness.fence();

    harness.openCoordinator();
    await awaitCondition(() => coordinatorFrames.some((frame) => frame.kind === 'sharding.Register'), {
      timeoutMs: 4_000,
      label: 'the region registered once its coordinator could be reached',
    });
    harness.acknowledgeRegistration();

    await awaitCondition(
      () => coordinatorFrames.some((frame) => frame.kind === 'sharding.GetShardHome' && frame.shardId === 5)
        && coordinatorFrames.some((frame) => frame.kind === 'sharding.GetClusterShardingStats'),
      { timeoutMs: 4_000, label: 'both queries made before registration were asked again' },
    );
    const statsFrame = coordinatorFrames.find((frame) => frame.kind === 'sharding.GetClusterShardingStats');
    // Asked again as the caller asked it — its own fan-out deadline, its own correlation.
    const [correlationId] = statsCorrelationsOf(harness.instance());
    expect(statsFrame).toMatchObject({ correlationId, timeoutMs: 1_234 });

    harness.place(5);
    harness.answerStats(correlationId!);
    await harness.fence();
    await drain(location);
    await drain(stats);

    expect(answerCountOf('location')).toBe(1);
    expect(answersOf('stats')).toEqual([[]]);
  }, 20_000);

  test('a query still waiting across a leader change is asked of the new coordinator too', async () => {
    // The region is registered, a request went to the coordinator and was
    // never answered, and the leader changes: the region registers again and
    // the new coordinator acknowledges it.  That acknowledgment is not a new
    // registration as far as the announcement goes, and the query must be
    // asked again all the same.
    const harness = await startRegion({
      systemName: '1436-leader-change',
      port: 45_746,
      lifetimeMs: LIFETIME_FLOOR_MS,
      withCoordinator: true,
    });
    const location = harness.recorder('location');
    const framesOf = (kind: ShardingMessage['kind']): ShardingMessage[] =>
      coordinatorFrames.filter((frame) => frame.kind === kind);
    const shardHomeRequests = (): number =>
      framesOf('sharding.GetShardHome').filter((frame) => frame.kind === 'sharding.GetShardHome' && frame.shardId === 5)
        .length;

    harness.openCoordinator();
    await awaitCondition(() => framesOf('sharding.Register').length > 0, {
      timeoutMs: 4_000,
      label: 'the region registered once its coordinator could be reached',
    });
    harness.acknowledgeRegistration();
    await harness.fence();

    harness.region.tell(locationQuery(5), location);
    await harness.fence();
    expect(shardHomeRequests()).toBe(1);

    const registrations = framesOf('sharding.Register').length;
    harness.cluster._publishClusterEvent(new LeaderChanged(harness.cluster.leader()));
    await awaitCondition(() => framesOf('sharding.Register').length > registrations, {
      timeoutMs: 4_000,
      label: 'the region registered again after the leader change',
    });
    harness.acknowledgeRegistration();
    await awaitCondition(() => shardHomeRequests() >= 2, {
      timeoutMs: 4_000,
      label: 'the waiting query was asked again of the new coordinator',
    });
  }, 20_000);

  test('each acknowledgment asks a waiting query again, and its caller is answered once', async () => {
    // A region registers again — and is acknowledged again — on every
    // MemberUp, MemberRemoved and LeaderChanged, and every acknowledgment asks
    // every waiting query again.  So a query in flight across two of them is
    // asked three times and can be answered three times, not twice at most;
    // the caller is answered by the first, and the others find nobody waiting.
    const harness = await startRegion({
      systemName: '1436-asked-per-acknowledgment',
      port: 45_752,
      lifetimeMs: LIFETIME_FLOOR_MS,
      withCoordinator: true,
    });
    const stats = harness.recorder('stats');
    const statsRequests = (): number[] => coordinatorFrames.flatMap((frame) =>
      frame.kind === 'sharding.GetClusterShardingStats' ? [frame.correlationId] : []);

    harness.openCoordinator();
    await awaitCondition(() => coordinatorFrames.some((frame) => frame.kind === 'sharding.Register'), {
      timeoutMs: 4_000,
      label: 'the region registered once its coordinator could be reached',
    });
    harness.acknowledgeRegistration();
    await harness.fence();

    harness.region.tell(statsQuery(), stats);
    await harness.fence();
    harness.acknowledgeRegistration();
    await harness.fence();
    harness.acknowledgeRegistration();
    await harness.fence();
    await awaitCondition(() => statsRequests().length >= 3, {
      timeoutMs: 4_000,
      label: 'the query was asked once, and again on each acknowledgment',
    });

    const correlations = statsRequests();
    expect(correlations).toHaveLength(3);
    expect(new Set(correlations).size).toBe(1);
    for (const correlationId of correlations) harness.answerStats(correlationId);
    await harness.fence();
    await drain(stats);

    expect(answersOf('stats')).toEqual([[]]);
  }, 20_000);
});

/**
 * A reply settles a waiting caller only from the node it was waiting on, and
 * its correlation cannot be guessed (#1268).
 *
 * `onShardReply` and `onClusterShardingStats` matched on the correlation alone,
 * and the correlation was a per-region counter from 1 — so any member could
 * spray replies for 1..N and answer other nodes' asks with whatever it liked,
 * the honest reply then finding nobody waiting.  Each entry now records the
 * node it was directed at, and the correlation comes from `randomId`.
 */
describe('a reply is bound to the node that was asked (#1268)', () => {
  test('a reply from another peer does not settle the ask, and the honest reply still does', async () => {
    const harness = await startRegion({ systemName: '1268-peer', port: 44_320, lifetimeMs: LIFETIME_FLOOR_MS });
    const ask = await askRemotely(harness, 'bound', 5);

    harness.replyFrom(harness.bystander, ask.correlationId, 'forged');
    harness.replyFrom(harness.cluster.selfAddress, ask.correlationId, 'forged locally');
    await harness.fence();
    await drain(ask.caller);
    expect(answerCountOf('bound')).toBe(0);

    harness.reply(ask.correlationId, 'honest');
    await harness.fence();
    await drain(ask.caller);
    expect(answersOf('bound')).toEqual(['honest']);
  }, 20_000);

  test('a reply with a fabricated correlation settles nothing, and the correlations are not a counter', async () => {
    const harness = await startRegion({ systemName: '1268-guess', port: 44_322, lifetimeMs: LIFETIME_FLOOR_MS });
    const first = await askRemotely(harness, 'first', 5);
    const second = await askRemotely(harness, 'second', 6);

    // The counter this replaced handed out 1, 2, …; a guess from that range,
    // sent from the very node that was asked, must find nobody waiting.
    expect(first.correlationId).not.toBe(1);
    expect(second.correlationId).not.toBe(first.correlationId + 1);
    for (let guess = 1; guess <= 64; guess++) harness.reply(guess, `guess ${guess}`);
    await harness.fence();
    await drain(first.caller);
    await drain(second.caller);
    expect(answerCountOf('first')).toBe(0);
    expect(answerCountOf('second')).toBe(0);

    harness.reply(first.correlationId, 'honest');
    await harness.fence();
    await drain(first.caller);
    expect(answersOf('first')).toEqual(['honest']);
  }, 20_000);

  test('a refused forgery leaves the entry to the sweep, which still reclaims it', async () => {
    const harness = await startRegion({ systemName: '1268-sweep', port: 44_324, lifetimeMs: LIFETIME_FLOOR_MS });
    const ask = await askRemotely(harness, 'abandoned', 5);
    harness.replyFrom(harness.bystander, ask.correlationId, 'forged');
    await harness.fence();

    harness.scheduler.advance(LIFETIME_FLOOR_MS + 1);
    await harness.sweep();
    harness.reply(ask.correlationId, 'too late');
    await harness.fence();
    await drain(ask.caller);
    expect(answerCountOf('abandoned')).toBe(0);
  }, 20_000);

  test('a shards() answer from a node other than the coordinator\'s settles nothing', async () => {
    const harness = await startRegion({ systemName: '1268-stats', port: 44_326, lifetimeMs: LIFETIME_FLOOR_MS });
    const stats = harness.recorder('stats');
    harness.region.tell(statsQuery(), stats);
    await harness.fence();
    const [correlationId] = statsCorrelationsOf(harness.instance());

    harness.answerStatsFrom(harness.remoteNode, correlationId!);
    await harness.fence();
    await drain(stats);
    expect(answerCountOf('stats')).toBe(0);

    harness.answerStats(correlationId!);
    await harness.fence();
    await drain(stats);
    expect(answersOf('stats')).toEqual([[]]);
  }, 20_000);

  test('a forwarding hop asks under its own correlation and relays the answer to the origin', async () => {
    // A region that receives an envelope for a shard that has since moved
    // forwards it.  It used to forward the origin's correlation untouched, so
    // the next hop answered the origin directly — from a node the origin never
    // asked.  Now the hop asks under a correlation of its own, bound to the
    // node it forwarded to, and passes the answer back itself.
    const harness = await startRegion({ systemName: '1268-hop', port: 44_328, lifetimeMs: LIFETIME_FLOOR_MS });
    const entityId = entityOn(5);
    harness.placeRemotely(5);
    const envelope: ShardEnvelope = {
      kind: 'sharding.Envelope',
      message: { kind: 'work', id: entityId } satisfies WorkCommand,
      originNode: harness.remoteNode.toJSON(),
      originRegion: '/system/sharding/origin-region',
      correlationId: 77,
    };
    harness.region.tell(new AuthenticatedShardingMessage(harness.remoteNode, envelope));
    await harness.fence();

    const forwarded = remoteEnvelopes.find((sent) => (sent.message as Partial<WorkCommand>).id === entityId);
    expect(forwarded?.originNode).toEqual(harness.cluster.selfAddress.toJSON());
    expect(forwarded?.correlationId).not.toBe(77);

    harness.reply(forwarded!.correlationId!, 'answer');
    await awaitCondition(() => remoteReplies.some((sent) => sent.correlationId === 77), {
      timeoutMs: 4_000,
      label: 'the hop relayed the answer to the origin under the origin\'s correlation',
    });
    expect(remoteReplies.find((sent) => sent.correlationId === 77)?.message).toBe('answer');
  }, 20_000);
});
