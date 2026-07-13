#!/usr/bin/env bun
/**
 * Coverage-floor gate (#294).  Runs `bun test --coverage`, parses
 * the "All files" aggregate line, exits non-zero if line coverage
 * falls below the floor.
 *
 * Defaults: 80% line coverage.  Override via env vars:
 *   COVERAGE_LINE_FLOOR=85   # require ≥85% lines
 *
 * Used by `.github/workflows/test.yml` as the post-test gate.
 * Developers can run it locally with:
 *
 *   bun run test:coverage:gate
 *
 * Same parser shape as test.yml's badge-update step so the two
 * see the same numbers — pinning the contract via a single
 * source of truth.
 */
import { spawnSync } from 'node:child_process';

const FLOOR = Number(process.env.COVERAGE_LINE_FLOOR ?? '80');
if (!Number.isFinite(FLOOR) || FLOOR < 0 || FLOOR > 100) {
  console.error(`coverage-gate: invalid COVERAGE_LINE_FLOOR=${FLOOR}`);
  process.exit(2);
}

const result = spawnSync('bun', ['test', '--coverage'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
const output = (result.stdout ?? '') + (result.stderr ?? '');

// Replay so the CI log shows the same output a normal `bun test`
// step would have shown.
process.stdout.write(output);

if (result.status !== 0) {
  console.error(`\ncoverage-gate: \`bun test --coverage\` exited with ${result.status}; failing.`);
  process.exit(result.status ?? 1);
}

// Parse the "All files" aggregate row.  Bun's `--coverage` table is
//   File ... | % Funcs | % Lines | Uncovered Line #s
// so LINE coverage is the SECOND numeric column (the first is % Funcs).
const m = output.match(/^All files\s+\|\s+[0-9]+(?:\.[0-9]+)?\s+\|\s+([0-9]+(?:\.[0-9]+)?)/m);
if (!m) {
  console.error('coverage-gate: could not find "All files" aggregate row in `bun test --coverage` output.');
  process.exit(2);
}
const linePct = Number(m[1]);
if (!Number.isFinite(linePct)) {
  console.error(`coverage-gate: parsed bad line-coverage value: ${m[1]}`);
  process.exit(2);
}

console.log(`\ncoverage-gate: parsed line coverage = ${linePct.toFixed(2)}%, floor = ${FLOOR}%`);
if (linePct < FLOOR) {
  console.error(
    `coverage-gate: line coverage ${linePct.toFixed(2)}% < floor ${FLOOR}% — failing.\n` +
    `Add tests for under-covered files (see the per-file table above) and rerun.`,
  );
  process.exit(1);
}
console.log(`coverage-gate: PASS (${linePct.toFixed(2)}% ≥ ${FLOOR}%)`);
