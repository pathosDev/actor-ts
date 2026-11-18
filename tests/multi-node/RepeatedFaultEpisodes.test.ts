import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../src/Actor.js';
import type { ActorRef } from '../../src/ActorRef.js';
import { KeepMajority } from '../../src/cluster/downing/index.js';
import { StartShardingOptions } from '../../src/cluster/sharding/StartShardingOptions.js';
import { StartSingletonOptions } from '../../src/cluster/singleton/index.js';
import { ManualScheduler } from '../../src/testkit/ManualScheduler.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeSpecOptions } from '../../src/testkit/MultiNodeSpecOptions.js';
import { bookkeepingViolations, converged, incarnationSeen } from './internal/ClusterBookkeeping.js';

/**
 * #1379 — several fault episodes against one cluster, with the bookkeeping
 * checked after every one of them.
 *
 * Every other multi-node suite injects one episode and asserts recovery once.
 * The defects that survive that shape are the ones where recovery leaves
 * residue — a parked peer, a reachability verdict, a tombstone, a gossip mark
 * for a run that is gone, a shard homed twice — because residue is invisible
 * until something needs the slot again.  So each scenario here runs episode
 * after episode on the cluster the previous one recovered, varies the fault
 * each time, and asserts the strict form after each: one identical view on
 * every node, nothing stuck `unreachable` or `leaving`, exactly the records
 * the current membership accounts for (see `ClusterBookkeeping.ts`).
 *
 * Four nodes, so a split can be one against three or two against two, and the
 * isolated node can be the seed and leader (`a`, the lowest address), a plain
 * member, or one of a pair.
 *
 * Virtual time throughout, advanced one gossip interval per step — one large
 * `spec.advance` fires every detection tick in the span before any node
 * settles, and marks healthy peers unreachable (`DowningVirtualClock.test.ts`
 * measured it).  On the virtual clock all three scenarios together cost about
 * two seconds of wall-clock time, which is what lets them run per commit.
 */

const ROLES = ['a', 'b', 'c', 'd'] as const;
type Role = typeof ROLES[number];

const GOSSIP_INTERVAL_MS = 100;
const FAILURE_DETECTOR = {
  heartbeatIntervalMs: 200,
  unreachableAfterMs: 1_000,
  downAfterMs: 2_000,
} as const;
/** Long enough to cross `down-after`, so every cut-off peer is parked or downed. */
const PARTITION_MS = 4_000;
/** What one recovery may take: a few heartbeats and gossip rounds, with margin. */
const RECOVERY_BUDGET_MS = 6_000;
/**
 * Quiet time after convergence before the bookkeeping is read: convergence is
 * reached on the first gossip round that agrees, and a residue that a later
 * round would have cleared is not one.
 */
const SETTLE_MS = 1_000;

async function advanceInGossipSteps(spec: MultiNodeSpec, ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += GOSSIP_INTERVAL_MS) {
    await spec.advance(Math.min(GOSSIP_INTERVAL_MS, ms - elapsed));
  }
}

function statusOf(spec: MultiNodeSpec, observer: Role, subject: Role): string {
  const address = spec.addressFor(subject);
  return spec.clusterFor(observer).getMembers().find((member) => member.address.equals(address))?.status ?? 'absent';
}

function leaderSeenBy(spec: MultiNodeSpec, observer: Role): string {
  return spec.clusterFor(observer).leader().fold(() => 'none', (member) => member.address.systemName);
}

function incarnations(spec: MultiNodeSpec, observer: Role): Record<Role, string | undefined> {
  return Object.fromEntries(ROLES.map((role) => [role, incarnationSeen(spec, observer, role)])) as Record<Role, string | undefined>;
}

type Split = { readonly left: ReadonlyArray<Role>; readonly right: ReadonlyArray<Role> };

/**
 * Different every time: one against three with a plain member alone, two
 * against two, the seed and leader alone, and a second two-against-two that
 * crosses the first.  A recovery that only works for the split it was first
 * exercised with shows up as a later episode that does not converge.
 */
const SPLITS: ReadonlyArray<Split> = [
  { left: ['d'], right: ['a', 'b', 'c'] },
  { left: ['a', 'b'], right: ['c', 'd'] },
  { left: ['a'], right: ['b', 'c', 'd'] },
  { left: ['b', 'd'], right: ['a', 'c'] },
];

function describeSplit(split: Split): string {
  return `${split.left.join('')} | ${split.right.join('')}`;
}

/** Cut every link across `split`, hold it past `down-after`, and check both sides saw it. */
async function partitionAndHold(spec: MultiNodeSpec, split: Split): Promise<void> {
  for (const left of split.left) for (const right of split.right) spec.partition(left, right);
  await advanceInGossipSteps(spec, PARTITION_MS);
  for (const left of split.left) {
    for (const right of split.right) {
      expect(statusOf(spec, left, right), `${left} still sees ${right} up through the partition`).toBe('unreachable');
      expect(statusOf(spec, right, left), `${right} still sees ${left} up through the partition`).toBe('unreachable');
    }
  }
}

function heal(spec: MultiNodeSpec, split: Split): void {
  for (const left of split.left) for (const right of split.right) spec.heal(left, right);
}

async function awaitRecovered(spec: MultiNodeSpec, roles: ReadonlyArray<Role>, description: string): Promise<void> {
  await spec.advanceUntil(() => converged(spec, roles), { budgetMs: RECOVERY_BUDGET_MS, description });
  await advanceInGossipSteps(spec, SETTLE_MS);
}

/* ------------------------------ sharded workload ------------------------------ */

type PingCommand = { readonly kind: 'ping'; readonly id: string };
type Command = PingCommand;

const ENTITY_COUNT = 24;
const NUMBER_OF_SHARDS = 12;
const entityIds = Array.from({ length: ENTITY_COUNT }, (_unused, index) => `e${index}`);

/**
 * Where each entity id is live right now, by node, and every moment one was
 * live on two nodes at once.  Process-wide, which is what one process running
 * every node makes possible: an overlap is caught in `preStart`, the instant
 * it happens, rather than sampled between episodes.
 */
const liveOn = new Map<string, Set<string>>();
/** The shard each live entity reported itself in, by id. */
const shardOfEntity = new Map<string, number>();
const entityOverlaps: string[] = [];
/** Nodes currently running the singleton. */
const singletonHosts = new Set<string>();

class Entity extends Actor<Command> {
  private get node(): string { return this.context.system.name; }

  override preStart(): void {
    const nodes = liveOn.get(this.entityId) ?? new Set<string>();
    if (nodes.size > 0 && !nodes.has(this.node)) {
      entityOverlaps.push(`${this.entityId} on ${[...nodes].join('+')} and ${this.node}`);
    }
    nodes.add(this.node);
    liveOn.set(this.entityId, nodes);
    shardOfEntity.set(this.entityId, this.entity.shardId);
  }

  override postStop(): void {
    liveOn.get(this.entityId)?.delete(this.node);
  }

  override onReceive(command: Command): void {
    match(command)
      .with({ kind: 'ping' }, (ping) => this.onPing(ping))
      .exhaustive();
  }

  private onPing(ping: PingCommand): void {
    this.sender.forEach((sender) => sender.tell(`${ping.id}@${this.node}`));
  }
}

class SingletonMarker extends Actor<string> {
  private get node(): string { return this.context.system.name; }
  override preStart(): void { singletonHosts.add(this.node); }
  override postStop(): void { singletonHosts.delete(this.node); }
  override onReceive(): void { /* presence is the whole point */ }
}

const regions = new Map<string, ActorRef<Command>>();

afterEach(() => {
  liveOn.clear();
  shardOfEntity.clear();
  entityOverlaps.length = 0;
  singletonHosts.clear();
  regions.clear();
});

/** An ask's deadline, in virtual time. */
const ASK_TIMEOUT_MS = 5_000;
/** What the workload may take to settle after a recovery, in virtual time. */
const WORKLOAD_SETTLE_BUDGET_MS = 6_000;

/**
 * `spec.advanceUntil` in gossip steps, failing with `describe()` as it reads
 * when the budget runs out rather than with a label fixed up front.
 *
 * This used to be a wait of its own, which yielded up to two hundred
 * event-loop turns before each step, because `advance` settled only `/user`
 * and every actor the workload runs on — region, shard, entity, singleton
 * manager — lives under `/system`.  An advance returned with a cross-node
 * reply still a few turns from landing, and the next step moved the clock on
 * past it: of the asks sent from the second region 4 of 24 timed out on
 * virtual time without ever having been slow, from the third and the fourth
 * every remote one did, and a node's shard map read stale against the
 * leader's in five runs of six.  `advance` settles `/system` too since #1835,
 * so the harness's own wait is the right one again.
 */
async function settleUntil(
  spec: MultiNodeSpec,
  cond: () => boolean,
  options: { readonly budgetMs: number; readonly describe: () => string },
): Promise<void> {
  try {
    await spec.advanceUntil(cond, { budgetMs: options.budgetMs, stepMs: GOSSIP_INTERVAL_MS });
  } catch (error) {
    throw new Error(`settleUntil: not within ${options.budgetMs} ms of virtual time — ${options.describe()}`, { cause: error });
  }
}

/**
 * Keep every running region telling every entity, once per gossip step, until
 * every node sees all four members up and `SETTLE_MS` more have passed.
 * Tells, not asks: what this is for is the window right after a restart,
 * where a coordinator that has just become leader is asked about shards a
 * survivor still runs (#1272), and the entity registry catches a second live
 * copy the instant it starts — no reply is needed for that.  The restarted
 * node's own region is in `regions` again as soon as `restart` has re-run the
 * node setup, and its traffic is the half that matters: it knows no home at
 * all.
 */
async function trafficUntilRecovered(spec: MultiNodeSpec, description: string): Promise<void> {
  let recoveredAt: number | null = null;
  for (let elapsed = 0; elapsed <= RECOVERY_BUDGET_MS + SETTLE_MS; elapsed += GOSSIP_INTERVAL_MS) {
    if (recoveredAt === null && converged(spec, ROLES)) recoveredAt = elapsed;
    if (recoveredAt !== null && elapsed - recoveredAt >= SETTLE_MS) return;
    for (const region of regions.values()) for (const id of entityIds) region.tell({ kind: 'ping', id });
    await spec.advance(GOSSIP_INTERVAL_MS);
  }
  throw new Error(`${description}: not every node saw all four members up within ${RECOVERY_BUDGET_MS} ms of virtual time`);
}

/** Ask every entity once from every region in `from`; the failures, as readable lines. */
async function pingEverything(spec: MultiNodeSpec, from: ReadonlyArray<Role>): Promise<string[]> {
  const failures: string[] = [];
  for (const role of from) {
    let settled = 0;
    const asks = entityIds.map((id) => regions.get(role)!.ask<string>({ kind: 'ping', id }, ASK_TIMEOUT_MS)
      .then(
        (reply) => { if (!reply.startsWith(`${id}@`)) failures.push(`${role} → ${id}: ${reply}`); },
        (error: unknown) => { failures.push(`${role} → ${id}: ${(error as Error).message}`); },
      )
      .finally(() => { settled += 1; }));
    // Past the deadline every ask has settled one way or the other.
    await settleUntil(spec, () => settled === asks.length, {
      budgetMs: ASK_TIMEOUT_MS + GOSSIP_INTERVAL_MS,
      describe: () => `${asks.length - settled} asks from ${role} neither answered nor timed out`,
    });
    await Promise.all(asks);
  }
  return failures;
}

/** The node each placed shard is homed on, as a role, in `observer`'s shard map. */
function shardHomesSeenBy(spec: MultiNodeSpec, observer: Role): Map<number, string> {
  const view = spec.clusterFor(observer).sharding.shardMap('entity');
  const homes = new Map<number, string>();
  if (view === null) return homes;
  const nodeOfRegion = new Map(view.regions.map((region) => [region.key, region.address]));
  for (const assignment of view.shardHome) {
    const address = nodeOfRegion.get(assignment.regionKey) ?? `unknown region ${assignment.regionKey}`;
    homes.set(assignment.shard, address.split('@')[0]!);
  }
  return homes;
}

function renderShardHomes(homes: Map<number, string>): string {
  return [...homes].sort(([x], [y]) => x - y).map(([shard, home]) => `${shard}:${home}`).join(' ');
}

/**
 * Every sharding and singleton violation, as readable lines; empty when the
 * workload is sound.  Read after a full ping round, so every entity is live.
 */
function workloadViolations(spec: MultiNodeSpec, roles: ReadonlyArray<Role>): string[] {
  const violations: string[] = [...entityOverlaps.map((overlap) => `overlap seen: ${overlap}`)];
  const leader = leaderSeenBy(spec, roles[0]!) as Role;
  const homes = shardHomesSeenBy(spec, leader);
  for (const id of entityIds) {
    const nodes = [...(liveOn.get(id) ?? [])];
    if (nodes.length !== 1) {
      violations.push(`${id} is live on ${nodes.length} nodes (${nodes.join(', ')})`);
      continue;
    }
    // The entity runs where the coordinator says its shard lives — the
    // shard-home half and the entity half of "exactly one home" agree.
    const shard = shardOfEntity.get(id)!;
    if (homes.get(shard) !== nodes[0]) {
      violations.push(`${id} (shard ${shard}) is live on ${nodes[0]} but the shard is homed on ${homes.get(shard) ?? 'nothing'}`);
    }
  }
  for (const [shard, home] of homes) {
    if (!roles.includes(home as Role)) violations.push(`shard ${shard} is homed on ${home}, not a current member`);
  }
  // Every node routes from the same map once the coordinator has published.
  const reference = renderShardHomes(homes);
  for (const role of roles) {
    const seen = renderShardHomes(shardHomesSeenBy(spec, role));
    if (seen !== reference) violations.push(`${role} holds a different shard map than the leader ${leader}: ${seen} vs ${reference}`);
  }
  if (singletonHosts.size !== 1) violations.push(`the singleton runs on ${singletonHosts.size} nodes (${[...singletonHosts].join(', ')})`);
  else if (!singletonHosts.has(leader)) violations.push(`the singleton runs on ${[...singletonHosts][0]}, the leader is ${leader}`);
  return violations;
}

/**
 * Wait for the workload to settle with no violation left, and fail naming
 * every violation when it does not.  A wait, because the shard map reaches
 * each node in a publish of its own and a singleton hand-over takes a round
 * trip; an overlap, once recorded, stays recorded, so waiting cannot hide one.
 */
async function awaitWorkloadSound(spec: MultiNodeSpec, roles: ReadonlyArray<Role>, episode: string): Promise<void> {
  await settleUntil(spec, () => workloadViolations(spec, roles).length === 0, {
    budgetMs: WORKLOAD_SETTLE_BUDGET_MS,
    describe: () => `${episode}: ${workloadViolations(spec, roles).join('; ')}`,
  });
}

/* ---------------------------------- scenarios --------------------------------- */

type PartitionEpisode = { readonly kind: 'partition'; readonly split: Split };
type RestartEpisode = { readonly kind: 'restart'; readonly role: Role };
type Episode = PartitionEpisode | RestartEpisode;

describe('repeated fault episodes against one cluster (#1379)', () => {
  test('four partition/heal episodes, a different split each time, leave no residue', async () => {
    // Nothing downs anyone: a cut-off peer is parked at `unreachable`, the
    // state a partition leaves members in under the opt-out, and the one from
    // which healing has to work (#930).
    const options = MultiNodeSpecOptions.create()
      .withRoles([...ROLES])
      .withFailureDetector({ ...FAILURE_DETECTOR })
      .withFailureDetectorAutoDown(false)
      .withGossipIntervalMs(GOSSIP_INTERVAL_MS)
      .withScheduler(new ManualScheduler());
    const spec = new MultiNodeSpec(options);
    try {
      await spec.start();
      await awaitRecovered(spec, ROLES, 'every node sees all four members up');
      expect(bookkeepingViolations(spec, ROLES)).toEqual([]);
      const startingIncarnations = incarnations(spec, 'a');

      for (const [index, split] of SPLITS.entries()) {
        const episode = `episode ${index + 1} (${describeSplit(split)})`;
        await partitionAndHold(spec, split);
        heal(spec, split);
        await awaitRecovered(spec, ROLES, `${episode} healed`);
        expect(bookkeepingViolations(spec, ROLES), episode).toEqual([]);
        // Healed by the network, not by anything restarting: the same runs.
        for (const role of ROLES) expect(incarnations(spec, role), episode).toEqual(startingIncarnations);
        expect(leaderSeenBy(spec, 'd'), episode).toBe('a');
      }
    } finally {
      await spec.stop();
    }
  }, 60_000);

  test('join churn — every role rejoins in turn, after a restart, a crash or a leave — leaves no residue', async () => {
    // `KeepMajority` for the episodes that wait for the removal: it tombstones
    // the crashed node, so the survivors converge on its absence once.  The
    // detector's own auto-down deleted instead, and survivors re-introduced
    // the deleted member to each other (#1806), so a removal never converged.
    // Since #1834 auto-down tombstones too, and this scenario passes under it
    // with no strategy; `KeepMajority` is kept as the scenario was written.
    const options = MultiNodeSpecOptions.create()
      .withRoles([...ROLES])
      .withFailureDetector({ ...FAILURE_DETECTOR })
      .withDowning(() => new KeepMajority())
      .withGossipIntervalMs(GOSSIP_INTERVAL_MS)
      .withScheduler(new ManualScheduler());
    const spec = new MultiNodeSpec(options);
    // How the old run ends before a new one joins at the same address:
    // `restart` — at once, so the new run replaces the old one before anyone
    // downs it (the replaced-incarnation path, #1426); `crash` — and the
    // survivors remove it first (the tombstone path); `leave` — gracefully,
    // removed and tombstoned on its own word.  Every path for the seed and
    // leader.
    const episodes: ReadonlyArray<{ readonly role: Role; readonly ending: 'restart' | 'crash' | 'leave' }> = [
      { role: 'a', ending: 'restart' },
      { role: 'b', ending: 'crash' },
      { role: 'c', ending: 'leave' },
      { role: 'a', ending: 'crash' },
      { role: 'd', ending: 'restart' },
      { role: 'b', ending: 'leave' },
      { role: 'a', ending: 'leave' },
    ];
    try {
      await spec.start();
      await awaitRecovered(spec, ROLES, 'every node sees all four members up');
      expect(bookkeepingViolations(spec, ROLES)).toEqual([]);

      for (const [index, { role, ending }] of episodes.entries()) {
        const episode = `episode ${index + 1} (${role}: ${ending}, then rejoin)`;
        const observer: Role = role === 'b' ? 'c' : 'b';
        const before = incarnations(spec, observer);
        if (ending !== 'restart') {
          await (ending === 'crash' ? spec.crash(role) : spec.leave(role));
          const survivors = ROLES.filter((other) => other !== role);
          await awaitRecovered(spec, survivors, `${episode}: the survivors removed ${role}`);
          expect(bookkeepingViolations(spec, survivors, { tombstonesFor: [role] }), episode).toEqual([]);
        }
        await spec.restart(role);
        await awaitRecovered(spec, ROLES, `${episode}: the new run is up everywhere`);
        expect(bookkeepingViolations(spec, ROLES), episode).toEqual([]);
        // Exactly one run changed, and every node holds the new one.
        const after = incarnations(spec, observer);
        expect(after[role], episode).not.toBe(before[role]);
        expect(after[role], episode).toBe(spec.clusterFor(role).selfAddress.incarnation);
        for (const other of ROLES.filter((candidate) => candidate !== role)) expect(after[other], episode).toBe(before[other]);
        // The seed comes back as the lowest address, so it leads again.
        expect(leaderSeenBy(spec, observer), episode).toBe('a');
      }
    } finally {
      await spec.stop();
    }
  }, 60_000);

  test('a sharded workload and a singleton survive partitions and restarts interleaved', async () => {
    const options = MultiNodeSpecOptions.create()
      .withRoles([...ROLES])
      .withFailureDetector({ ...FAILURE_DETECTOR })
      .withFailureDetectorAutoDown(false)
      .withGossipIntervalMs(GOSSIP_INTERVAL_MS)
      .withScheduler(new ManualScheduler())
      // On every node, and again on a restarted one — `restart` re-runs it.
      .withNodeSetup((role, _system, cluster) => {
        const shardingOptions = StartShardingOptions.create<Command>()
          .withTypeName('entity')
          .withEntityActor(Entity)
          .withExtractEntityId((command) => command.id)
          .withNumShards(NUMBER_OF_SHARDS)
          .withPassivationIdleMs(0)
          .withRebalanceIntervalMs(600_000);
        regions.set(role, cluster.sharding.start<Command>(shardingOptions));
        const singletonOptions = StartSingletonOptions.create()
          .withTypeName('marker')
          .withActor(SingletonMarker);
        cluster.singleton.start(singletonOptions);
      });
    const spec = new MultiNodeSpec(options);
    // Partitions park (auto-down off, no strategy), so a shard on the far side
    // stays where it is and comes back with the heal; restarts replace the
    // run at once, so the coordinator re-homes the lost run's shards.  No
    // traffic while a partition holds: with nothing downing, each side elects
    // its own leader, and a second coordinator placing shards there is the
    // documented price of the opt-out, not residue.
    const episodes: ReadonlyArray<Episode> = [
      { kind: 'partition', split: SPLITS[0]! },
      { kind: 'restart', role: 'b' },
      { kind: 'partition', split: SPLITS[1]! },
      { kind: 'restart', role: 'a' },
      { kind: 'partition', split: SPLITS[2]! },
      { kind: 'restart', role: 'd' },
    ];
    try {
      await spec.start();
      await awaitRecovered(spec, ROLES, 'every node sees all four members up');
      expect(await pingEverything(spec, ROLES)).toEqual([]);
      await awaitWorkloadSound(spec, ROLES, 'before the first episode');

      for (const [index, step] of episodes.entries()) {
        const episode = `episode ${index + 1} (${step.kind === 'partition' ? describeSplit(step.split) : `restart ${step.role}`})`;
        if (step.kind === 'partition') {
          await partitionAndHold(spec, step.split);
          heal(spec, step.split);
        } else {
          regions.delete(step.role);
          await spec.restart(step.role);
          // Under traffic until the new run is up everywhere and a while
          // after: the window in which a second live copy could start.
          await trafficUntilRecovered(spec, episode);
        }
        await awaitRecovered(spec, ROLES, `${episode} recovered`);
        expect(bookkeepingViolations(spec, ROLES), episode).toEqual([]);
        expect(await pingEverything(spec, ROLES), episode).toEqual([]);
        await awaitWorkloadSound(spec, ROLES, episode);
      }
    } finally {
      await spec.stop();
    }
  }, 60_000);
});
