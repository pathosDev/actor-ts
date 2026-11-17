import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import type { ActorRef } from '../../src/ActorRef.js';
import { StartShardingOptions } from '../../src/cluster/sharding/StartShardingOptions.js';
import { ManualScheduler } from '../../src/testkit/ManualScheduler.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeSpecOptions } from '../../src/testkit/MultiNodeSpecOptions.js';
import { converged } from './internal/ClusterBookkeeping.js';

/**
 * `MultiNodeSpec.advance` and `advanceUntil` settle the `/system` tree, not
 * only `/user`, and they settle every node to one common quiet (#1835).
 *
 * Sharding regions and coordinators live under `/system`.  While the advance
 * settled only `/user`, it returned with a cross-node ask still a few turns
 * from landing, and the next step moved the clock another gossip interval on
 * with the reply queued: lane I3 of the v0.19.0 wave measured remote asks
 * from the second region timing out on virtual time — 4 of 24 — and from the
 * third and fourth every remote one.  The first test is the issue's
 * reproduction, made an assertion.
 *
 * The other two are stricter, because a test stepping many times catches up
 * on a stalled reply at a later step: work that needs no virtual time at all
 * has to be complete after one `advance(0)`, and after the probe
 * `advanceUntil` makes before it spends any.  That is what tells a common
 * quiet over all nodes from one settle per node, which declares a node quiet
 * and moves on while a later node's reply is on its way back to it.
 */

type PingCommand = { readonly kind: 'ping'; readonly id: string };
type Command = PingCommand;

class Entity extends Actor<Command> {
  override onReceive(command: Command): void {
    this.onPing(command);
  }

  private onPing(command: PingCommand): void {
    this.sender.forEach((sender) => sender.tell(`${command.id}@${this.context.system.name}`));
  }
}

const ROLES = ['a', 'b', 'c', 'd'] as const;
const ENTITIES = 24;
/** An ask's deadline, in virtual time: well past a few gossip rounds, well short of the step budget. */
const ASK_TIMEOUT_MS = 3_000;

type Asks = {
  /** How many asks have been answered or have failed so far. */
  readonly settled: () => number;
  /** Every ask that failed or was answered by the wrong entity. */
  readonly failures: string[];
  readonly done: Promise<unknown>;
};

let spec: MultiNodeSpec | undefined;

afterEach(async () => {
  await spec?.stop();
  spec = undefined;
});

/** Four converged nodes on one virtual clock, each running a region for `Entity`. */
async function startCluster(): Promise<{ spec: MultiNodeSpec; scheduler: ManualScheduler; regions: Map<string, ActorRef<Command>> }> {
  const regions = new Map<string, ActorRef<Command>>();
  const scheduler = new ManualScheduler();
  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName('entity')
    .withEntityActor(Entity)
    .withExtractEntityId((command) => command.id)
    .withNumShards(12)
    .withPassivationIdleMs(0)
    .withRebalanceIntervalMs(600_000);
  const options = MultiNodeSpecOptions.create()
    .withRoles([...ROLES])
    .withFailureDetector({ heartbeatIntervalMs: 200, unreachableAfterMs: 1_000, downAfterMs: 2_000 })
    .withFailureDetectorAutoDown(false)
    .withGossipIntervalMs(100)
    .withScheduler(scheduler)
    .withNodeSetup((role, _system, cluster) => {
      regions.set(role, cluster.sharding.start<Command>(shardingOptions));
    });
  const started = new MultiNodeSpec(options);
  spec = started;
  await started.start();
  await started.advanceUntil(() => converged(started, ROLES), { budgetMs: 30_000, description: 'convergence' });
  return { spec: started, scheduler, regions };
}

/** Ask every entity once through the region on `from`. */
function askEveryEntity(region: ActorRef<Command>, from: string): Asks {
  let settled = 0;
  const failures: string[] = [];
  const asks = Array.from({ length: ENTITIES }, (_unused, index) => `e${String(index)}`).map((id) =>
    region.ask<string>({ kind: 'ping', id }, ASK_TIMEOUT_MS)
      .then(
        (reply) => { if (!reply.startsWith(`${id}@`)) failures.push(`${from} → ${id}: ${reply}`); },
        (error: unknown) => { failures.push(`${from} → ${id}: ${(error as Error).message}`); },
      )
      .finally(() => { settled += 1; }));
  return { settled: () => settled, failures, done: Promise.all(asks) };
}

describe('MultiNodeSpec.advance settles /system on every node (#1835)', () => {
  test('every ask from every region is answered on a virtual clock', async () => {
    const { spec: running, regions } = await startCluster();
    const failures: string[] = [];
    for (const from of ROLES) {
      const asks = askEveryEntity(regions.get(from)!, from);
      await running.advanceUntil(() => asks.settled() === ENTITIES, { budgetMs: 10_000, description: `asks from ${from}` });
      await asks.done;
      failures.push(...asks.failures);
    }
    expect(failures).toEqual([]);
  }, 60_000);

  test('cross-node work that needs no virtual time is complete after one advance(0)', async () => {
    const { spec: running, scheduler, regions } = await startCluster();
    const from = ROLES[ROLES.length - 1];
    const startedAt = scheduler.now();
    const asks = askEveryEntity(regions.get(from)!, from);
    await running.advance(0);
    expect(scheduler.now()).toBe(startedAt);
    expect(asks.settled()).toBe(ENTITIES);
    await asks.done;
    expect(asks.failures).toEqual([]);
  }, 60_000);

  test('advanceUntil settles every node before it spends any virtual time', async () => {
    const { spec: running, scheduler, regions } = await startCluster();
    const from = ROLES[ROLES.length - 2];
    const startedAt = scheduler.now();
    const asks = askEveryEntity(regions.get(from)!, from);
    // A budget of nothing: only the probe before the first advance can make it hold.
    await running.advanceUntil(() => asks.settled() === ENTITIES, { budgetMs: 0, description: `asks from ${from}` });
    expect(scheduler.now()).toBe(startedAt);
    await asks.done;
    expect(asks.failures).toEqual([]);
  }, 60_000);
});
