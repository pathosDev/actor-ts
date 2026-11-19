/**
 * The deep half of `tests/unit/delivery/DeliveryOrderingProperties.test.ts`
 * (#1370): the same scheduled-delivery property, with more sends per case and
 * many more cases.
 *
 * **Not collected by `bun test`, by its name.**  Bun collects `*.test.ts` and
 * `*.spec.ts`; a `.nightly.ts` file runs only when named by path, which is
 * what `.github/workflows/nightly-flakes.yml` does:
 *
 *     bun test ./tests/nightly/DeliveryOrderingDeep.nightly.ts
 *
 * That is how the run count stays out of the per-commit suite without an
 * environment variable deciding whether a test runs — which
 * `tests/unit/ci/NoEnvironmentGatedSkips.test.ts` forbids, because a workflow
 * can set one.
 *
 * The seed is the preload's, so a red night replays locally with the `path`
 * the failure prints: add `{ path: '<printed>' }` to the `fc.assert` options
 * below, run the command above, and the same interleaving comes back.  Then
 * copy it into the per-commit file as an example test before fixing anything.
 */
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  deliveryScenario,
  deliveryScheduler,
  runScheduledDelivery,
} from '../util/ScheduledDelivery.js';

/** Cases per night — a little over a minute on a hosted runner at ~20 ms a case. */
const NIGHTLY_RUNS = 3_000;

/** Sends per case: wide enough for the window, the queue and two resend periods to overlap. */
const NIGHTLY_MAXIMUM_SENDS = 8;

/** The per-test cap for this file only, sized to the run count above with room for a slow runner. */
const NIGHTLY_TIMEOUT_MS = 15 * 60_000;

describe('reliable delivery under a controlled resolution order — deep', () => {
  test('no loss, no duplicate handling and no sequence gap, whichever hop lands first', async () => {
    await fc.assert(
      fc.asyncProperty(
        deliveryScheduler(),
        deliveryScenario(NIGHTLY_MAXIMUM_SENDS),
        async (scheduler, scenario) => {
          expect(await runScheduledDelivery(scheduler, scenario)).toEqual([]);
        },
      ),
      { numRuns: NIGHTLY_RUNS },
    );
  }, NIGHTLY_TIMEOUT_MS);
});
