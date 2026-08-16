import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'bun:test';

/**
 * The repeat-run flake harness has to survive the failure it exists to measure.
 *
 * `scripts/stress-test.mjs` was written for the two outcomes a child process
 * usually has: it resolved on `close` and on `error`.  But the failure mode the
 * quarantined multi-node suites actually show on GitHub's hosted runners is
 * neither — workers "spawn, handshake, and then never run", so `bun test` does
 * not exit at all.  With no timer, `runOnce` never settled, the loop never
 * advanced, and the nightly job sat until its `timeout-minutes` and was killed
 * with no per-run report and no aggregate.  The one measurement the harness
 * exists to make was the one it could not survive.
 *
 * A hang is data.  It is recorded as its own outcome — not folded into
 * "failed", which would say a test was red, and not into "no report", which
 * would say bun died before flushing.  Then the loop continues, because the
 * interesting question is whether run 2 hangs as well.
 *
 * Both tests below drive the real script end to end against a suite that
 * genuinely never finishes.  Nothing smaller would do: the defect was in the
 * shape of the promise `runOnce` returns, and a stub child would let a
 * watchdog that never fires pass.
 */

const SCRIPT = join(import.meta.dir, '..', '..', '..', 'scripts', 'stress-test.mjs');

/**
 * A suite that hangs the way the quarantined ones do.  Its own per-test
 * timeout is set far beyond the watchdog's on purpose — otherwise bun would
 * end the run itself and the harness would never need to intervene, and the
 * test would pass against the unfixed script.
 */
const HANGING_SUITE = [
  "import { test } from 'bun:test';",
  "test('never finishes, the way a starved worker never finishes', async () => {",
  '  await new Promise(() => {});',
  '}, 600_000);',
  '',
].join('\n');

type HarnessRun = {
  readonly status: number | null;
  readonly output: string;
  readonly summary: {
    runs: number;
    greenRuns: number;
    runsTimedOut?: number[];
    runsWithoutReport: number[];
  } | undefined;
  readonly wallClockMs: number;
};

/**
 * Run the harness over a throwaway directory holding {@link HANGING_SUITE}.
 *
 * `spawnSync`'s own `timeout` is the backstop that makes the unfixed script
 * fail *as a hang* rather than by hanging this test file too — without it a
 * red run here would take the whole suite down with it.
 */
function runHarness(argv: readonly string[], environment: Record<string, string> = {}): HarnessRun {
  const directory = mkdtempSync(join(tmpdir(), 'actor-ts-stress-hang-'));
  try {
    writeFileSync(join(directory, 'Hang.test.ts'), HANGING_SUITE);
    const startedAt = Date.now();
    const child = spawnSync('bun', [SCRIPT, '--report-dir=.stress', ...argv], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', ...environment },
      timeout: 90_000,
      killSignal: 'SIGKILL',
    });
    const wallClockMs = Date.now() - startedAt;
    let summary: HarnessRun['summary'];
    try {
      summary = JSON.parse(readFileSync(join(directory, '.stress', 'summary.json'), 'utf8'));
    } catch {
      summary = undefined;
    }
    return {
      status: child.status,
      output: `${child.stdout ?? ''}${child.stderr ?? ''}`,
      summary,
      wallClockMs,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('the stress harness survives a run that never exits', () => {
  /**
   * The env var rather than the flag, deliberately: an unrecognised
   * environment variable is ignored, so against the unfixed script this test
   * exercises exactly the defect — no watchdog, `runOnce` never settles — and
   * fails as "the harness never exited", not as "unknown option".
   *
   * Two runs, so the assertion also covers the half of the requirement a
   * single run cannot show: the loop *continues* past a hang instead of
   * treating it as an abort.
   */
  test('a hung child is killed, recorded as a hang, and the loop goes on', () => {
    const result = runHarness(['--runs=2'], { ACTOR_TS_STRESS_RUN_TIMEOUT_MS: '2500' });

    expect(
      result.status,
      'the harness did not exit on its own — a `bun test` that never finishes '
      + `still hangs the loop with it.\n${result.output.slice(-2_000)}`,
    ).not.toBeNull();
    // Both runs hung, so the harness must report failure rather than "green".
    expect(result.status).not.toBe(0);
    // 2 runs x 2.5 s plus process startup; anything near the 90 s backstop
    // means the watchdog fired late or not at all.
    expect(result.wallClockMs).toBeLessThan(60_000);

    expect(result.summary, 'no summary.json was written').toBeDefined();
    expect(result.summary!.runsTimedOut).toEqual([1, 2]);
    expect(result.summary!.greenRuns).toBe(0);
    // A hang is its own outcome: it must not be filed as bun dying before the
    // reporter flushed, which is a different diagnosis with a different fix.
    expect(result.summary!.runsWithoutReport).toEqual([]);

    expect(result.output).toContain('run 1: HUNG');
    expect(result.output).toContain('run 2: HUNG');
  }, 120_000);

  /** The same watchdog, reached through the documented flag. */
  test('--run-timeout configures the watchdog and fails the gate', () => {
    const result = runHarness(['--runs=1', '--run-timeout=2500']);

    expect(result.status).toBe(1);
    expect(result.summary!.runsTimedOut).toEqual([1]);
    expect(result.output).toContain('never exited');
  }, 120_000);

  /**
   * `--run-timeout=0` must be rejected as a bad *value*.  Asserting the
   * wording matters: an unrecognised option also exits 2 and also echoes the
   * flag back, so a laxer assertion would have passed against the script that
   * had no watchdog at all.
   */
  test('--run-timeout rejects a non-positive value', () => {
    const result = runHarness(['--runs=1', '--run-timeout=0']);

    expect(result.status).toBe(2);
    expect(result.output).toContain('--run-timeout must be a positive integer');
  }, 60_000);
});
