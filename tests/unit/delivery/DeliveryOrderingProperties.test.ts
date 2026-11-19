/**
 * Reliable delivery with the arrival order of every message under test control
 * (#1370).
 *
 * Every other suite in this directory sees one interleaving per case — the one
 * the dispatcher's `setImmediate` happens to produce — and repeating them
 * explores nothing new.  Here `fc.scheduler()` decides which in-flight
 * delivery, retransmit or acknowledgment lands next, and
 * `fc.scheduledModelRun` drives the workload against a reference model that
 * only remembers what was sent.  The harness is `tests/util/ScheduledDelivery.ts`.
 *
 * **A failure hands you the interleaving.**  fast-check shrinks it and prints
 * `{ seed, path }` together with the scheduler's report — the hops in the
 * order they were released.  Passing that `path` (and the seed, which the
 * preload pins anyway) back as `fc.assert` options replays that one case;
 * `docs/…/testing/diagnosing-flakes.mdx` shows the shape.  Copy the shrunk
 * case into an example test beside this property before fixing anything.
 *
 * **Run count is bounded on purpose.**  Each case boots an `ActorSystem` and
 * settles it after every release, so the global floor of 120 would not fit
 * bun's 5 s per-test cap on a loaded machine.  The deeper exploration lives in
 * `tests/nightly/DeliveryOrderingDeep.nightly.ts`, which the nightly workflow
 * runs and `bun test` does not collect.
 */
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  deliveryScenario,
  deliveryScheduler,
  deliverySchedulerFor,
  runScheduledDelivery,
} from '../../util/ScheduledDelivery.js';

/** Cases per commit — measured at well under a second for the whole property. */
const PER_COMMIT_RUNS = 40;

/** Sends per case: enough for two to be in flight beside a queued third. */
const PER_COMMIT_MAXIMUM_SENDS = 4;

describe('reliable delivery under a controlled resolution order', () => {
  test('no loss, no duplicate handling and no sequence gap, whichever hop lands first', async () => {
    await fc.assert(
      fc.asyncProperty(
        deliveryScheduler(),
        deliveryScenario(PER_COMMIT_MAXIMUM_SENDS),
        async (scheduler, scenario) => {
          expect(await runScheduledDelivery(scheduler, scenario)).toEqual([]);
        },
      ),
      { numRuns: PER_COMMIT_RUNS },
    );
  });

  test('a sequence handled above a gap and then retransmitted is not handled again', async () => {
    // The counterexample the property printed (seed 1424, path "11") with the
    // duplicate check narrowed to `seq <= contiguous` — the `above` half of it
    // removed — copied here so that interleaving is checked whatever the seed
    // explores next.  Seq 2's first delivery and seq 3's acknowledgment are
    // lost, so seq 3 lands, is handled above the gap and is retransmitted;
    // the retransmit (task 12) lands before seq 2 closes the gap (task 11).
    // Only the `above` set tells that retransmit from a new message.
    //
    // The numbers are the `task${n}` ids from the printed report, in release
    // order: 1 starts the model, 2–3 / 5–6 / 7–8 are each send's check and
    // run, the rest are network hops.
    const scheduler = deliverySchedulerFor([1, 2, 3, 5, 6, 4, 7, 8, 9, 12, 11, 13, 10, 14, 15]);
    const violations = await runScheduledDelivery(scheduler, {
      steps: [{ kind: 'send', body: 0 }, { kind: 'send', body: 1 }, { kind: 'send', body: 2 }],
      losses: [false, true, true, false, true, true, true, true],
      windowSize: 4,
    });
    expect(violations).toEqual([]);
  });
});
