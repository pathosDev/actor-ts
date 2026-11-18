/**
 * The sharding coordinator handshake with the arrival order of every frame
 * between two nodes under test control (#1823).
 *
 * The harness is `tests/util/ScheduledSharding.ts`: a real coordinator and two
 * real regions on a `MultiNodeSpec`, each cross-node frame released by
 * `fc.scheduler()`, an optional restart of the leader between two scheduled
 * phases, and a reference model of three claims — one home per shard at any
 * time, no placement before every region's claim has arrived (#1272), and no
 * shard left homeless once the network has drained.
 *
 * **Both sides of the evidence.**  The property holds against the coordinator
 * as it is, and it fails once the registration barrier is dropped — the
 * coordinator placing shards the moment it leads, as before #1272 — with a
 * replay path that fails again.  A property that could not fail under that
 * fault would be measuring nothing.
 *
 * **A failure hands you the interleaving.**  fast-check shrinks it and prints
 * `{ seed, path }` with the scheduler's report — the frames in the order they
 * were released.  Pass that `path` back as an `fc.assert` option to replay it,
 * and copy the shrunk case into an example test beside this property before
 * fixing anything.
 *
 * **Run count is bounded on purpose.**  Each case boots a two-node cluster and
 * settles both nodes after every release, so the per-commit count is small;
 * `tests/nightly/ShardingHandshakeDeep.nightly.ts` explores many more cases
 * in the nightly workflow, and `bun test` does not collect it.
 */
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  runScheduledSharding,
  shardingScenario,
  shardingScheduler,
} from '../../../util/ScheduledSharding.js';

/** Cases per commit — measured at about 80 ms a case, so well under two seconds. */
const PER_COMMIT_RUNS = 20;
/** Asks per phase: enough for both regions to want one shard at once. */
const PER_COMMIT_MAXIMUM_ASKS = 4;
/** The per-test cap, sized to the run count with room for a loaded machine. */
const PER_COMMIT_TIMEOUT_MS = 60_000;

/** Cases the faulty coordinator gets to show itself in. */
const FAULT_SEARCH_RUNS = 40;

const holds = (faults: { readonly dropRegistrationBarrier?: boolean } = {}) =>
  fc.asyncProperty(
    shardingScheduler(),
    shardingScenario(PER_COMMIT_MAXIMUM_ASKS),
    async (scheduler, scenario) => {
      expect(await runScheduledSharding(scheduler, scenario, faults)).toEqual([]);
    },
  );

describe('the sharding coordinator handshake under a controlled frame order', () => {
  test('one home per shard, no placement ahead of a claim, no shard left homeless — whichever frame lands first', async () => {
    await fc.assert(holds(), { numRuns: PER_COMMIT_RUNS });
  }, PER_COMMIT_TIMEOUT_MS);

  test('the property fails once the registration barrier is dropped, and its replay path fails again', async () => {
    const found = await fc.check(holds({ dropRegistrationBarrier: true }), { numRuns: FAULT_SEARCH_RUNS });
    expect(found.failed).toBe(true);
    expect(String(found.errorInstance)).toContain('two homes');

    const replayed = await fc.check(holds({ dropRegistrationBarrier: true }), {
      seed: found.seed,
      path: found.counterexamplePath ?? undefined,
      endOnFailure: true,
    });
    expect(replayed.failed).toBe(true);
    expect(replayed.numRuns).toBe(1);
    expect(String(replayed.errorInstance)).toContain('two homes');
  }, PER_COMMIT_TIMEOUT_MS * 2);
});
