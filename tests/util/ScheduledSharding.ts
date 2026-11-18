/**
 * The sharding coordinator handshake with the order of every cross-node frame
 * under fast-check's control (#1823).
 *
 * The second target #1370 named.  `ScheduledDelivery` puts the hops of reliable
 * delivery under `fc.scheduler()`; this puts the frames between two cluster
 * nodes there, so `GetShardHome`, `ShardHome`, `RegisterRegion` and the gossip
 * that tells a region who leads arrive in an order the framework picks,
 * shrinks on failure and prints as a replay path.
 *
 * What is real: two nodes of a `MultiNodeSpec` on one virtual clock, each with
 * its own `ShardRegion`, and the `ShardCoordinator` on the leader — the one the
 * cluster runs, not a stand-in.  What is scheduled: every frame a node sends
 * to the other, which is where the coordinator handshake crosses nodes.  A
 * frame is delivered only when the scheduler releases it, and after each
 * release the spec settles every node — `/system` included, where the regions
 * and the coordinator live (#1835) — before the next decision.
 *
 * The scenario is two scheduled phases with an optional restart of the leader
 * between them.  The restart is the window #1272 is about: the node at the
 * lowest address comes back and leads again at once, with an empty shard map,
 * while the other node's region still hosts shards.  The restart itself runs
 * with the scheduler out of the way — it is a crash, a termination and a join,
 * none of which is the handshake — and the second phase then races the other
 * region's registration against the restarted region's requests for a home.
 *
 * **The reference model** holds three claims, and checks each where it can be
 * seen:
 *
 *  - **One home per shard at any time.**  An entity records its node when it
 *    starts and forgets it when it stops; a start on a second node while the
 *    first still runs it is a second home, caught the instant it happens.
 *  - **No placement before every region's claim has arrived.**  A coordinator
 *    that places a shard before the region still hosting it has registered
 *    puts it on a second node, which the first claim then sees.
 *  - **A hand-off never leaves a shard homeless.**  Once the network has
 *    drained, every entity the run asked about is reached again from both
 *    regions.  Without a restart, every ask in flight has to be answered too,
 *    by the entity it was sent to.  Across a restart one may be lost, because
 *    sharding delivers at most once and a node that is starting refuses a
 *    frame for a `/system` path its owner has not registered yet — measured
 *    here, seed 1424 path 6 of a 60-case run: the restarted node refused the
 *    reply to its own ask.  What may not be lost is the home, and the
 *    verification round after the drain is what asks for it.
 *
 * **The two-sided evidence** #1370 asked for: `dropRegistrationBarrier` is an
 * injected ordering fault — the coordinator places shards the moment it leads,
 * as it did before #1272 — and the property has to fail under it, with a
 * replay path that fails again.  `tests/unit/cluster/sharding/
 * ShardingHandshakeOrderingProperties.test.ts` asserts both.
 *
 * Lives under `tests/util/` so the per-commit property and the deeper nightly
 * run (`tests/nightly/`) drive one harness with different run counts.
 */
import fc from 'fast-check';
import { Actor } from '../../src/Actor.js';
import type { ActorRef } from '../../src/ActorRef.js';
import type { NodeAddress } from '../../src/cluster/NodeAddress.js';
import type { WireMessage } from '../../src/cluster/Protocol.js';
import { LeastShardAllocationStrategy } from '../../src/cluster/sharding/AllocationStrategy.js';
import { ShardCoordinator } from '../../src/cluster/sharding/ShardCoordinator.js';
import { StartShardingOptions } from '../../src/cluster/sharding/StartShardingOptions.js';
import { LogLevel } from '../../src/Logger.js';
import { ManualScheduler } from '../../src/testkit/ManualScheduler.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeSpecOptions } from '../../src/testkit/MultiNodeSpecOptions.js';

/** The two nodes.  `a` has the lowest address, so it leads, and it is the one restarted. */
const ROLES = ['a', 'b'] as const;
type Role = (typeof ROLES)[number];
const LEADER: Role = 'a';

const GOSSIP_INTERVAL_MS = 100;
const NUMBER_OF_SHARDS = 4;
/** Entities per case: two per shard, so a shard can be asked about twice. */
const SHARDING_ENTITY_COUNT = 8;
/**
 * An ask's deadline, in virtual time: far past the registration window and a
 * hand-off, so a timeout is a lost message rather than a slow one, and short of
 * the drain, so a lost one has an outcome before the drain gives up.
 */
const ASK_TIMEOUT_MS = 5_000;
/**
 * Gossip ticks a scheduled phase may hold.  The registration window is three
 * gossip rounds plus a register retry — 800 ms here — and a coordinator that
 * gives up waiting places shards without the missing claim by design
 * (availability over uniqueness, with a lease as the hard guarantee).  Three
 * ticks keep a phase well inside the window, so a second home the model sees
 * is a defect rather than that documented trade.
 */
const MAXIMUM_TICKS_PER_PHASE = 3;
/**
 * Short enough that a rebalance — and so a hand-off from one region to the
 * other, with its buffered messages replayed — falls inside most cases: a
 * restarted leader comes back with no shards and the strategy moves some to it.
 */
const REBALANCE_INTERVAL_MS = 300;
/**
 * Virtual time the verification round spans.  The coordinator rebalances only
 * once its view of the members has held for the membership settle window —
 * `downAfterMs`, 2 s here — so this covers that, the 800 ms registration
 * window and a few rebalance intervals: the shards a restarted leader came
 * back without are handed back to it while the verification asks are in
 * flight.  Measured: 33 hand-off frames released across a 60-case run.
 */
const SETTLE_PERIOD_MS = 3_000;
/** Upper bound on drain rounds — each releases everything in flight, then moves one gossip interval. */
const MAXIMUM_DRAIN_ROUNDS = 80;

type PingCommand = { readonly kind: 'ping'; readonly id: string };
type Command = PingCommand;

/** Ask entity `entity` through the region on `from`. */
type AskStep = { readonly kind: 'ask'; readonly from: Role; readonly entity: number };
/** Let one gossip interval pass: heartbeats, gossip and every timer due in it fire. */
type TickStep = { readonly kind: 'tick' };

/** One command of a scheduled phase. */
export type ShardingStep = AskStep | TickStep;

/** What a generated case is made of, besides the scheduler. */
export type ShardingScenario = {
  /** Before the restart, or the whole workload when there is none. */
  readonly before: readonly ShardingStep[];
  /** Whether the leader is restarted between the phases. */
  readonly restartLeader: boolean;
  readonly after: readonly ShardingStep[];
};

/** Faults a case can inject, to show the property is able to fail. */
export type ShardingFaults = {
  /** The coordinator places shards the moment it leads, without waiting for the other region's claim. */
  readonly dropRegistrationBarrier?: boolean;
};

/** What one run saw, kept where the entities can reach it. */
type Observations = {
  /** Entity id → the nodes it is running on right now. */
  readonly liveOn: Map<string, Set<string>>;
  /** Every moment an entity ran on two nodes at once. */
  readonly violations: string[];
};

/** The run in progress — entities are spawned by the framework and cannot be handed it. */
let observations: Observations | null = null;

class Entity extends Actor<Command> {
  private get node(): string { return this.context.system.name; }

  override preStart(): void {
    const seen = observations;
    if (seen === null) return;
    const nodes = seen.liveOn.get(this.entityId) ?? new Set<string>();
    if (nodes.size > 0 && !nodes.has(this.node)) {
      seen.violations.push(`entity ${this.entityId} started on ${this.node} while it ran on ${[...nodes].join('+')} — two homes`);
    }
    nodes.add(this.node);
    seen.liveOn.set(this.entityId, nodes);
  }

  override postStop(): void {
    observations?.liveOn.get(this.entityId)?.delete(this.node);
  }

  override onReceive(command: Command): void {
    this.onPing(command);
  }

  private onPing(command: PingCommand): void {
    this.sender.forEach((sender) => sender.tell(`${command.id}@${this.node}`));
  }
}

const entityIdOf = (index: number): string => `e${String(index)}`;

/**
 * The frames between the nodes, each released by the scheduler while
 * `scheduling` is on.  The label names the sender, the receiver and the frame
 * — and, for an envelope, the message inside it — which is what the replay
 * report prints.
 */
class ScheduledFrames {
  scheduling = false;

  constructor(private readonly scheduler: fc.Scheduler) {}

  /** Route `role`'s outgoing frames through the scheduler.  Again after a restart: the node is a new one. */
  intercept(spec: MultiNodeSpec, role: Role): void {
    const faults = spec.faultsFor(role);
    const send = faults.send.bind(faults);
    faults.send = (to: NodeAddress, message: WireMessage): void => {
      if (!this.scheduling) {
        send(to, message);
        return;
      }
      const label = `${role}→${to.systemName} ${frameName(message)}`;
      void this.scheduler.schedule(Promise.resolve(label), label).then(() => send(to, message));
    };
  }
}

/** `envelope(sharding.GetShardHome)` for a message frame, the frame's own kind for the rest. */
function frameName(message: WireMessage): string {
  if (message.kind !== 'envelope') return message.kind;
  const body = message.body as { readonly kind?: unknown } | null;
  return `envelope(${typeof body?.kind === 'string' ? body.kind : '?'})`;
}

/** Specs of the run in progress — `act` is built before the run creates its own. */
const liveSpecs = new Set<MultiNodeSpec>();

/** After a release, let every node's actors — `/system` included — run until all are quiet. */
async function settleEverySpec(): Promise<void> {
  for (const spec of liveSpecs) await spec.advance(0);
}

/** The scheduler every run uses: after each release, settle before the next decision. */
export const shardingScheduler = (): fc.Arbitrary<fc.Scheduler> =>
  fc.scheduler({
    act: async (release) => {
      await release();
      await settleEverySpec();
    },
  });

/** A phase: asks from either region, with at most {@link MAXIMUM_TICKS_PER_PHASE} ticks among them. */
const phase = (maximumAsks: number): fc.Arbitrary<ShardingStep[]> =>
  fc.record({
    asks: fc.array(
      fc.record({ from: fc.constantFrom(...ROLES), entity: fc.nat({ max: SHARDING_ENTITY_COUNT - 1 }) }),
      { minLength: 1, maxLength: maximumAsks },
    ),
    ticks: fc.array(fc.nat({ max: maximumAsks }), { maxLength: MAXIMUM_TICKS_PER_PHASE }),
  }).map(({ asks, ticks }) => {
    const steps: ShardingStep[] = [];
    asks.forEach((ask, index) => {
      for (const at of ticks) if (at === index) steps.push({ kind: 'tick' });
      steps.push({ kind: 'ask', from: ask.from, entity: ask.entity });
    });
    return steps;
  });

/** Workloads of up to `maximumAsks` asks a phase, with the leader restarted between the phases or not. */
export const shardingScenario = (maximumAsks: number): fc.Arbitrary<ShardingScenario> =>
  fc.record({
    before: phase(maximumAsks),
    restartLeader: fc.boolean(),
    after: phase(maximumAsks),
  });

/** One ask, as the model sees it. */
type AskRecord = { readonly label: string; outcome: string | null };

/** The real side of a phase. */
type ShardingReal = {
  readonly spec: MultiNodeSpec;
  readonly regions: Map<string, ActorRef<Command>>;
  readonly asks: AskRecord[];
};

/** Nothing to remember up front: the claims are about what the run did, and are checked against it. */
type ShardingModel = Record<string, never>;

class AskCommand implements fc.AsyncCommand<ShardingModel, ShardingReal> {
  constructor(private readonly step: AskStep) {}
  check(): boolean { return true; }
  async run(_model: ShardingModel, real: ShardingReal): Promise<void> {
    const id = entityIdOf(this.step.entity);
    const record: AskRecord = { label: `${this.step.from} → ${id}`, outcome: null };
    real.asks.push(record);
    void real.regions.get(this.step.from)!.ask<string>({ kind: 'ping', id }, ASK_TIMEOUT_MS).then(
      (reply) => { record.outcome = reply.startsWith(`${id}@`) ? 'answered' : `answered by the wrong entity: ${reply}`; },
      (error: unknown) => { record.outcome = (error as Error).message; },
    );
    await real.spec.advance(0);
  }
  toString(): string { return `ask(${this.step.from}, ${entityIdOf(this.step.entity)})`; }
}

class TickCommand implements fc.AsyncCommand<ShardingModel, ShardingReal> {
  check(): boolean { return true; }
  async run(_model: ShardingModel, real: ShardingReal): Promise<void> {
    await real.spec.advance(GOSSIP_INTERVAL_MS);
  }
  toString(): string { return 'tick'; }
}

const commandFor = (step: ShardingStep): fc.AsyncCommand<ShardingModel, ShardingReal> =>
  step.kind === 'ask' ? new AskCommand(step) : new TickCommand();

/** The private hook the injected fault replaces. */
type CoordinatorBarrierHook = { beginRegistrationBarrier: () => void };

/**
 * One generated case.  Returns the list of violated claims, empty when the
 * protocol held; the property asserts it is empty.
 */
export async function runScheduledSharding(
  scheduler: fc.Scheduler,
  scenario: ShardingScenario,
  faults: ShardingFaults = {},
): Promise<string[]> {
  const seen: Observations = { liveOn: new Map(), violations: [] };
  observations = seen;
  const prototype = ShardCoordinator.prototype as unknown as CoordinatorBarrierHook;
  const barrier = prototype.beginRegistrationBarrier;
  if (faults.dropRegistrationBarrier === true) prototype.beginRegistrationBarrier = () => { /* the injected fault */ };

  const regions = new Map<string, ActorRef<Command>>();
  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName('entity')
    .withEntityActor(Entity)
    .withExtractEntityId((command) => command.id)
    .withNumShards(NUMBER_OF_SHARDS)
    .withPassivationIdleMs(0)
    .withRebalanceIntervalMs(REBALANCE_INTERVAL_MS)
    // Moves shards to the least-loaded region, so a restarted leader gets some
    // back by hand-off; the default hash strategy never moves a shard that is
    // already on its hash node.
    .withAllocationStrategy(new LeastShardAllocationStrategy());
  const options = MultiNodeSpecOptions.create()
    .withRoles([...ROLES])
    .withLogLevel(LogLevel.Off)
    .withFailureDetector({ heartbeatIntervalMs: 200, unreachableAfterMs: 1_000, downAfterMs: 2_000 })
    .withFailureDetectorAutoDown(false)
    .withGossipIntervalMs(GOSSIP_INTERVAL_MS)
    .withScheduler(new ManualScheduler())
    .withNodeSetup((role, _system, cluster) => {
      regions.set(role, cluster.sharding.start<Command>(shardingOptions));
    });
  const spec = new MultiNodeSpec(options);
  const frames = new ScheduledFrames(scheduler);
  const asks: AskRecord[] = [];
  try {
    await spec.start();
    await spec.advanceUntil(() => converged(spec), { budgetMs: 30_000, description: 'two members up on both nodes' });
    await warmUp(spec, regions);
    for (const role of ROLES) frames.intercept(spec, role);
    liveSpecs.add(spec);

    const real: ShardingReal = { spec, regions, asks };
    frames.scheduling = true;
    await fc.scheduledModelRun(scheduler, () => ({ model: {}, real }), scenario.before.map(commandFor));
    if (scenario.restartLeader) {
      frames.scheduling = false;
      await spec.restart(LEADER);
      frames.intercept(spec, LEADER);
      frames.scheduling = true;
    }
    await fc.scheduledModelRun(scheduler, () => ({ model: {}, real }), scenario.after.map(commandFor));

    await drain(spec, scheduler, asks);
    const violations = [...seen.violations, ...unanswered(asks, scenario.restartLeader)];

    // The third claim, stated where a restart cannot excuse it: every entity
    // the run asked about is reached again from both regions.  The asks go out
    // at the start of a settle period long enough for the barrier to lift and
    // the coordinator to rebalance, so they race the hand-offs that moves —
    // buffered while a shard is handed off, and replayed once it has a home.
    // A shard a hand-off or a lost claim left without a home fails here,
    // whatever happened to the asks in flight before.
    const verification: AskRecord[] = [];
    const askedAbout = [...new Set(scenario.before.concat(scenario.after).flatMap((step) => (step.kind === 'ask' ? [step.entity] : [])))];
    for (const entity of askedAbout) {
      for (const role of ROLES) await new AskCommand({ kind: 'ask', from: role, entity }).run({}, { spec, regions, asks: verification });
    }
    for (let elapsed = 0; elapsed < SETTLE_PERIOD_MS; elapsed += GOSSIP_INTERVAL_MS) {
      await scheduler.waitIdle();
      await spec.advance(GOSSIP_INTERVAL_MS);
    }
    await drain(spec, scheduler, verification);
    return [...violations, ...unanswered(verification, false).map((line) => `after the drain, ${line}`)];
  } finally {
    frames.scheduling = false;
    liveSpecs.delete(spec);
    prototype.beginRegistrationBarrier = barrier;
    await spec.stop();
    observations = null;
  }
}

/** Both members up in both nodes' views. */
function converged(spec: MultiNodeSpec): boolean {
  return ROLES.every((role) => spec.clusterFor(role).getMembers().filter((member) => member.status === 'up').length === ROLES.length);
}

/**
 * Ask the first half of the entities once from the second node, unscheduled,
 * so both regions host shards before the scheduler takes over — the state a
 * restarted leader has to respect — while the shards only the other half maps
 * to are still unplaced, for the scheduled phases to race over.
 */
async function warmUp(spec: MultiNodeSpec, regions: Map<string, ActorRef<Command>>): Promise<void> {
  let settled = 0;
  const warmed = SHARDING_ENTITY_COUNT / 2;
  for (let index = 0; index < warmed; index++) {
    void regions.get(ROLES[1])!.ask<string>({ kind: 'ping', id: entityIdOf(index) }, ASK_TIMEOUT_MS)
      .finally(() => { settled += 1; });
  }
  await spec.advanceUntil(() => settled === warmed, { budgetMs: 10_000, description: 'the warm-up asks' });
}

/**
 * Release everything in flight in an order the scheduler still chooses, then
 * let a gossip interval pass, until every ask in `asks` has an outcome.
 */
async function drain(spec: MultiNodeSpec, scheduler: fc.Scheduler, asks: readonly AskRecord[]): Promise<void> {
  for (let round = 0; round < MAXIMUM_DRAIN_ROUNDS; round++) {
    await scheduler.waitIdle();
    if (asks.every((ask) => ask.outcome !== null)) break;
    await spec.advance(GOSSIP_INTERVAL_MS);
  }
  await scheduler.waitIdle();
}

/**
 * The asks the third claim does not accept: one answered by the wrong entity
 * always, and one never answered unless `lossTolerated` — a restart in the
 * case, across which delivery is at most once.
 */
function unanswered(asks: readonly AskRecord[], lossTolerated: boolean): string[] {
  return asks
    .filter((ask) => ask.outcome !== 'answered' && !(lossTolerated && ask.outcome?.startsWith('answered') !== true))
    .map((ask) => `ask ${ask.label}: ${ask.outcome ?? 'no outcome — neither answered nor timed out'}`);
}
