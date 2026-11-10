/**
 * Child-process fixture for `tests/unit/Scheduler.test.ts` (#1567).
 *
 * Schedules one fixed-rate task that cancels its own handle from its first
 * tick, shuts the scheduler down, and returns.  The whole assertion is whether
 * this process then *exits*: a scheduler that arms its interval after the
 * first tick leaves a referenced timer nobody can clear, and the process runs
 * until something kills it.  That is observable from a parent and from
 * nowhere inside the process, which is why this lives in a file of its own
 * rather than in the test.
 *
 * The timings are short on purpose — a fixture that fails takes exactly as
 * long as the parent's spawn timeout, so nothing here should contribute to it.
 */
import { Scheduler } from '../../../src/Scheduler.js';

const scheduler = new Scheduler();
const handle = scheduler.scheduleAtFixedRateFunction(10, 10, () => { handle.cancel(); });

setTimeout(() => {
  scheduler.shutdown();
  // Printed so a parent can tell "exited early without running" from "ran
  // and exited" — the exit code alone cannot.
  console.log(`self-cancelled=${handle.isCancelled}`);
}, 40);
