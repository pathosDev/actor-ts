/**
 * The documented `main`, run as a child process by
 * `CoordinatedStartupNodeBudget.test.ts`: create a system with one startup
 * task and await `whenReady()` at the top level, with nothing else in the
 * program to keep the process alive.
 *
 * `argv[2]` picks the task:
 *
 *   - `hung` — waits on a promise that holds no handle and never settles.  The
 *     phase's budget is the only thing that can end it, so the run must reach
 *     it: an `ERROR` line naming the task, then `whenReady()` rejecting.
 *   - `quick` — finishes at once under a budget of a minute.  The process must
 *     then exit by itself, long before that minute is up: a budget timer that
 *     outlived its task would hold it open.
 *
 * Exit status 3 marks a rejection and 0 a resolution, so the parent tells the
 * two apart from a runtime that ended the program on its own — Node's 13 for
 * an unsettled top-level await.
 */
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { CoordinatedStartupOptions, StartupPhases } from '../../src/CoordinatedStartupOptions.js';

const scenario = process.argv[2];
const hung = scenario === 'hung';
const startupOptions = CoordinatedStartupOptions.create()
  .withDefaultPhaseTimeoutMs(hung ? 300 : 60_000)
  .withTasks([{
    phase: StartupPhases.PersistenceStart,
    name: hung ? 'hung-connect' : 'quick-connect',
    task: () => (hung ? new Promise<void>(() => {}) : Promise.resolve()),
  }]);
const systemOptions = ActorSystemOptions.create().withCoordinatedStartup(startupOptions);
const system = ActorSystem.create(`startup-budget-${scenario}`, systemOptions);
console.log('CREATED');
try {
  await system.whenReady();
  console.log('READY');
} catch (error) {
  console.log(`REJECTED ${(error as Error).message}`);
  process.exitCode = 3;
}
