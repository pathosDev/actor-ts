import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'bun:test';

/**
 * The harness measures the whole suite, including the suites CI removes (#290).
 *
 * Three multi-node suites are gated behind `ACTOR_TS_SKIP_FLAKY_MNS=1` in
 * `test.yml`, `multi-runtime.yml` and `publish.yml` (#538) — and they are
 * precisely the suites most likely to flake.  A flake harness that inherited
 * that flag would measure a strictly smaller suite than a local run and then
 * report a reliable pass rate over exactly the tests known not to be reliable:
 * the one number nobody may trust, produced by the tool built to be trusted.
 * So `scripts/stress-test.mjs` **deletes** the variable from the child
 * environment by default, and `--skip-quarantined` re-sets it for the runs whose
 * subject is the rest of the suite.
 *
 * Until now that was defended by prose only — the script's header, the docs
 * page, and a comment on the nightly job all state it, and nothing checked it.
 * The failure it guards against is silent by construction: a run that skipped
 * the quarantined suites prints "green" in exactly the same words as a run that
 * passed them, and the only visible difference is a smaller `executed` count
 * that no reader has a baseline for.
 *
 * Both directions matter and each fails differently:
 *
 *  - drop the `delete` and a developer (or a job) with the flag exported gets a
 *    measurement over a smaller suite while believing otherwise;
 *  - drop the `else` and `--skip-quarantined` silently stops skipping, so a run
 *    that meant to measure "everything except the known-bad" measures
 *    everything and goes red for the reason it was trying to exclude.
 *
 * The fixture below copies the real `describeMns` shape verbatim from
 * `tests/multi-node/LeaseMajority.test.ts:38`, so what is asserted is the
 * guard the suites actually use rather than a paraphrase of it.
 *
 * Refs #290, #538.
 */

const SCRIPT = join(import.meta.dir, '..', '..', '..', 'scripts', 'stress-test.mjs');

/**
 * Two tests: one behind the quarantine guard, one not.  The unguarded one is
 * the control — it keeps "the flag was honoured" apart from "the run did
 * nothing", which otherwise look the same in an `executed` count.
 */
const QUARANTINED_SUITE = [
  "import { describe, expect, test } from 'bun:test';",
  '',
  "const describeMns = process.env.ACTOR_TS_SKIP_FLAKY_MNS === '1' ? describe.skip : describe;",
  '',
  "describeMns('quarantined', () => {",
  "  test('runs only when the flag is absent', () => {",
  '    expect(1).toBe(1);',
  '  });',
  '});',
  '',
  "describe('always', () => {",
  "  test('runs either way', () => {",
  '    expect(1).toBe(1);',
  '  });',
  '});',
  '',
].join('\n');

type HarnessSummary = {
  readonly runs: number;
  readonly greenRuns: number;
  readonly totalExecuted: number;
  readonly quarantinedSuitesIncluded: boolean;
};

type HarnessRun = {
  readonly status: number | null;
  readonly output: string;
  readonly summary: HarnessSummary | undefined;
};

/**
 * `undefined` means the variable is absent from the parent environment, which
 * is not the same as the empty string: the script's default path *deletes* a
 * value that is there, and a test run without one first would prove nothing
 * about the deletion.
 */
function environmentWithFlag(flag: string | undefined): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  if (flag === undefined) delete environment.ACTOR_TS_SKIP_FLAKY_MNS;
  else environment.ACTOR_TS_SKIP_FLAKY_MNS = flag;
  return environment;
}

function runHarness(argv: readonly string[], flag: string | undefined): HarnessRun {
  const directory = mkdtempSync(join(tmpdir(), 'actor-ts-stress-quarantine-'));
  try {
    writeFileSync(join(directory, 'Quarantined.test.ts'), QUARANTINED_SUITE);
    const child = spawnSync('bun', [SCRIPT, '--runs=1', '--report-dir=.stress', ...argv], {
      cwd: directory,
      encoding: 'utf8',
      env: environmentWithFlag(flag),
      timeout: 90_000,
      killSignal: 'SIGKILL',
    });
    let summary: HarnessSummary | undefined;
    try {
      summary = JSON.parse(readFileSync(join(directory, '.stress', 'summary.json'), 'utf8'));
    } catch {
      summary = undefined;
    }
    return { status: child.status, output: `${child.stdout ?? ''}${child.stderr ?? ''}`, summary };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('the quarantine flag never reaches a stress run by accident', () => {
  /**
   * The whole rationale, exercised: the flag *is* exported in the parent
   * environment, and the quarantined test still has to run.  Setting it here is
   * the load-bearing half — with the variable absent, deleting it is a no-op and
   * the assertion would hold against a script that never touched it.
   */
  test('an exported ACTOR_TS_SKIP_FLAKY_MNS is dropped, so the gated test still runs', () => {
    const result = runHarness([], '1');

    expect(result.summary, `no summary.json was written\n${result.output.slice(-2_000)}`).toBeDefined();
    expect(
      result.summary!.totalExecuted,
      'the quarantined test did not run: the harness inherited ACTOR_TS_SKIP_FLAKY_MNS '
      + 'from its parent, so this measurement covers a smaller suite than it claims to.',
    ).toBe(2);
    expect(result.summary!.quarantinedSuitesIncluded).toBe(true);
    expect(result.summary!.greenRuns).toBe(1);
    expect(result.output).toContain('quarantined suites included');
    expect(result.output).toContain('quarantined suites: included');
    expect(result.status).toBe(0);
  }, 120_000);

  /** The same default with a clean environment — nothing to delete, same result. */
  test('with no flag in the environment the gated test runs as well', () => {
    const result = runHarness([], undefined);

    expect(result.summary!.totalExecuted).toBe(2);
    expect(result.summary!.quarantinedSuitesIncluded).toBe(true);
  }, 120_000);

  /**
   * The opt-out, from a parent that does *not* carry the flag: the harness has
   * to set it, not merely forward it.  Otherwise the documented way to measure
   * "the rest of the suite" quietly measures all of it.
   */
  test('--skip-quarantined sets the flag even when the parent has none', () => {
    const result = runHarness(['--skip-quarantined'], undefined);

    expect(result.summary, `no summary.json was written\n${result.output.slice(-2_000)}`).toBeDefined();
    expect(
      result.summary!.totalExecuted,
      '--skip-quarantined did not skip anything: both tests ran, so a run meant to '
      + 'exclude the known-bad suites included them.',
    ).toBe(1);
    expect(result.summary!.quarantinedSuitesIncluded).toBe(false);
    expect(result.output).toContain('quarantined suites skipped');
    expect(result.output).toContain('quarantined suites: SKIPPED (--skip-quarantined)');
    expect(result.status).toBe(0);
  }, 120_000);

  /**
   * The two directions differ by exactly one executed test, and that number is
   * the entire signal — so it is asserted as a *difference* as well, where a
   * fixture that silently stopped running anything cannot satisfy both sides.
   */
  test('the two modes differ, and differ by the gated test only', () => {
    const included = runHarness([], '1');
    const excluded = runHarness(['--skip-quarantined'], '1');

    expect(included.summary!.totalExecuted - excluded.summary!.totalExecuted).toBe(1);
    expect(excluded.summary!.totalExecuted).toBeGreaterThan(0);
  }, 150_000);
});
