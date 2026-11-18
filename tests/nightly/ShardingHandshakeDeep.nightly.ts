/**
 * The deep half of
 * `tests/unit/cluster/sharding/ShardingHandshakeOrderingProperties.test.ts`
 * (#1823): the same scheduled coordinator-handshake property, with more asks
 * per phase and many more cases.
 *
 * **Not collected by `bun test`, by its name.**  Bun collects `*.test.ts` and
 * `*.spec.ts`; a `.nightly.ts` file runs only when named by path, which is
 * what the `scheduled-orderings` job of `.github/workflows/nightly-flakes.yml`
 * does, through the stress harness so the night's result reaches the flake
 * report.
 *
 * The seed is the preload's, so a red night replays locally with the `path`
 * the failure prints: add `{ path: '<printed>' }` to the `fc.assert` options
 * below, run `bun test ./tests/nightly/ShardingHandshakeDeep.nightly.ts`, and
 * the same interleaving comes back.  Then copy it into the per-commit file as
 * an example test before fixing anything.
 */
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  runScheduledSharding,
  shardingScenario,
  shardingScheduler,
} from '../util/ScheduledSharding.js';

/** Cases per night — about four minutes at the ~80 ms a case measured locally. */
const NIGHTLY_RUNS = 3_000;

/** Asks per phase: wide enough for both regions to race over every shard at once. */
const NIGHTLY_MAXIMUM_ASKS = 8;

/** The per-test cap for this file only, sized to the run count above with room for a slow runner. */
const NIGHTLY_TIMEOUT_MS = 20 * 60_000;

describe('the sharding coordinator handshake under a controlled frame order — deep', () => {
  test('one home per shard, no placement ahead of a claim, no shard left homeless — whichever frame lands first', async () => {
    await fc.assert(
      fc.asyncProperty(
        shardingScheduler(),
        shardingScenario(NIGHTLY_MAXIMUM_ASKS),
        async (scheduler, scenario) => {
          expect(await runScheduledSharding(scheduler, scenario)).toEqual([]);
        },
      ),
      { numRuns: NIGHTLY_RUNS },
    );
  }, NIGHTLY_TIMEOUT_MS);
});
