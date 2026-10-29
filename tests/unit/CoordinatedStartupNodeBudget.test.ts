import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The startup phase budget bounds a task the documented `main` awaits, on
 * every runtime — Node included (#1473).
 *
 * Node ends a program whose top-level `await` is pending once nothing else
 * holds the event loop, with status 13 and "Detected unsettled top-level
 * await".  A system holds no handle of its own, so a budget armed on an
 * unreferenced timer was nothing either: `await system.whenReady()` over a task
 * waiting on a promise that holds nothing ended the process before the budget
 * fired — no ERROR line naming the task, no startup failure, no error.  Bun
 * and Deno keep running, so the in-process suite never saw it, and only a
 * child process under Node can.
 *
 * `CoordinatedStartupNodeBudget.fixture.ts` is bundled once and run under each
 * runtime here; Bun is the control that the fixture itself is sound.  The
 * second case is the other half of keeping the budget referenced: cleared the
 * moment its task finishes, so a finished startup leaves nothing that holds
 * the process for the rest of a budget.
 *
 * A runtime that is not installed is skipped by name — a capability probe, not
 * a setting.
 */

const fixture = join(import.meta.dir, 'CoordinatedStartupNodeBudget.fixture.ts');

let directory = '';
afterAll(() => {
  if (directory !== '') rmSync(directory, { recursive: true, force: true });
});

// Bundled at module scope, not in a test: bounded work, but inside a test body
// it would race bun's per-test timeout for nothing.
directory = mkdtempSync(join(tmpdir(), 'actor-ts-startup-budget-'));
const built = await Bun.build({
  entrypoints: [fixture],
  outdir: directory,
  target: 'node',
  format: 'esm',
  naming: 'startup-budget.mjs',
});
if (!built.success) throw new Error(`bundling the fixture failed: ${built.logs.map(String).join('\n')}`);
const bundle = join(directory, 'startup-budget.mjs');

type Runtime = { readonly name: string; readonly command: string | null };

const runtimes: readonly Runtime[] = [
  { name: 'Node', command: Bun.which('node') },
  { name: 'Bun', command: process.execPath },
];

type FixtureRun = {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  /** Standard output and standard error together: the logger writes its ERROR line to either. */
  readonly everything: string;
};

/**
 * Run one scenario of the fixture.  The cap is the child's, not the test's: a
 * process that something keeps alive is killed after it and reports no
 * status, which the assertions name.
 */
function runFixture(command: string, scenario: 'hung' | 'quick'): FixtureRun {
  const child = spawnSync(command, [bundle, scenario], { encoding: 'utf8', timeout: 20_000 });
  return {
    status: child.status,
    signal: child.signal,
    stdout: child.stdout,
    everything: `${child.stdout}${child.stderr}`,
  };
}

describe('the startup phase budget bounds a task the documented main awaits', () => {
  for (const runtime of runtimes) {
    const command = runtime.command;
    const name = command === null ? `${runtime.name} (not installed here)` : runtime.name;

    (command === null ? test.skip : test)(`${name}: a task that never settles fails at its budget, named in an ERROR line`, () => {
      const child = runFixture(command!, 'hung');
      expect(child.everything).not.toContain('unsettled top-level await');
      expect({ status: child.status, signal: child.signal }).toEqual({ status: 3, signal: null });
      expect(child.everything).toMatch(
        /ERROR Startup task "hung-connect" in phase "persistence-start" failed: the phase's 300 ms budget ran out/,
      );
      expect(child.stdout).toContain('REJECTED Startup task "hung-connect" in phase "persistence-start" failed');
    }, 30_000);

    (command === null ? test.skip : test)(`${name}: a task that finishes leaves no budget holding the process open`, () => {
      const child = runFixture(command!, 'quick');
      // Killed at the child's 20 s cap, it would report signal SIGTERM and no
      // status: the minute-long budget of the finished task kept it alive.
      expect({ status: child.status, signal: child.signal }).toEqual({ status: 0, signal: null });
      expect(child.stdout).toContain('READY');
    }, 30_000);
  }
});
