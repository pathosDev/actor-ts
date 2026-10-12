import { describe, expect, test } from 'bun:test';
import type {
  CoordinatedStartupOptionsType,
  StartupTask,
  StartupTaskRegistration,
  TerminateOptions,
} from '../../src/index.js';

/**
 * Type-only names the root barrel has to carry.
 *
 * `tests/unit/ExportSurface.test.ts` reads module namespace objects, which hold
 * values only, so a dropped `export type` passes it.  This file is the other
 * half: each name is imported from the package entry and used, so
 * `bun run typecheck:dev` fails when one goes missing.  The runtime assertions
 * are incidental — the compile is the test.
 */
describe('type-only exports of the root barrel', () => {
  // Exported from `ActorSystem.ts` beside the class, and missing from the root
  // until this test: `import type { TerminateOptions } from 'actor-ts'` did not
  // resolve, so the one argument `terminate()` takes had no public name.
  test('TerminateOptions — what system.terminate(options) takes', () => {
    const terminateOptions: TerminateOptions = { runCoordinatedShutdown: true };
    expect(terminateOptions.runCoordinatedShutdown).toBe(true);
  });

  // The startup graph's type half (#1473): a task's signature, the shape a
  // registration takes, and the plain-object form of its options.
  test('StartupTask, StartupTaskRegistration and CoordinatedStartupOptionsType', () => {
    const openJournal: StartupTask = (signal) => { expect(signal.aborted).toBe(false); };
    const registration: StartupTaskRegistration = { phase: 'persistence-start', name: 'open-journal', task: openJournal };
    const startupOptions: CoordinatedStartupOptionsType = { defaultPhaseTimeoutMs: 1_000, tasks: [registration] };
    expect(startupOptions.tasks).toHaveLength(1);
  });
});
