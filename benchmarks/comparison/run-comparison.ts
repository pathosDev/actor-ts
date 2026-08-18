/**
 * Drives the framework comparison — one framework per subprocess (#27).
 *
 *   bun run bench:compare                        # every arm, one round
 *   bun run bench:compare -- --rounds=5          # five interleaved rounds, median published
 *   bun run bench:compare -- --framework=nact    # one arm
 *   bun run bench:compare -- --list              # what would run
 *
 * **Publish from `--rounds`, never from a single round.**  One round is not a
 * measurement on a machine that is not otherwise idle, and no development
 * machine is: five consecutive rounds here varied by 2 % on one arm, 15 % on
 * another and 34 % on a third, while the ordering of the three stayed
 * identical throughout.  `--rounds=N` runs the arms interleaved — round 1 of
 * every arm, then round 2 — so whatever else the machine is doing lands on
 * all of them, and publishes the per-scenario median.
 *
 * A subprocess per arm is not tidiness.  Module-level state, JIT profiles and
 * GC pressure all carry across an arm boundary inside one process, and they
 * carry *asymmetrically* — whichever framework runs second inherits a heap
 * the first one shaped.  That is the difference between measuring two
 * frameworks and measuring one framework plus the residue of another.  The
 * cluster suite one level up isolates its configurations for the same reason
 * (`../cluster/node-count-scaling.ts`).
 *
 * Every arm still runs even when an earlier one fails, and the driver reports
 * the failures in its exit code — the property `run-all.ts` had to learn the
 * hard way when ten broken suites exited 0 for months (#506).
 *
 * This is a deliberately separate driver from `../run-all.ts`, which skips
 * this directory by name: these arms need this tree's own installed manifest,
 * which a clean clone and every CI run of `bun run bench` does not have.
 */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ansi } from '../lib/stats.js';
import { mergeRounds } from './js/merge-rounds.js';
import { ROUNDS_DIRECTORY } from './js/result-file.js';

type ComparisonArm = {
  /** Published framework name — also selects the arm on the command line. */
  readonly name: string;
  /** File under `js/`, run in its own Bun subprocess. */
  readonly file: string;
};

/**
 * Every JavaScript arm, in publication order.
 *
 * The floor comes last on purpose: read as a table, "what it costs against no
 * framework at all" is the closing line rather than the opening one.
 */
const ARMS: ReadonlyArray<ComparisonArm> = [
  { name: 'actor-ts', file: 'actor-ts.ts' },
  { name: 'nact', file: 'nact.ts' },
  { name: 'xstate', file: 'xstate.ts' },
  { name: 'vanilla', file: 'vanilla.ts' },
];

const JAVASCRIPT_ARM_DIRECTORY = resolve(import.meta.dirname ?? '.', 'js');

function run(): void {
  const args = process.argv.slice(2);
  const frameworkFlag = args.find((a) => a.startsWith('--framework='))?.slice('--framework='.length);
  const roundsFlag = args.find((a) => a.startsWith('--rounds='))?.slice('--rounds='.length);
  const listOnly = args.includes('--list');

  const rounds = roundsFlag === undefined ? 1 : Number.parseInt(roundsFlag, 10);
  if (!Number.isFinite(rounds) || rounds < 1) {
    console.error(`--rounds must be a positive integer, got "${roundsFlag}"`);
    process.exit(1);
  }

  const selected = frameworkFlag === undefined
    ? ARMS
    : ARMS.filter((arm) => arm.name === frameworkFlag);

  if (selected.length === 0) {
    console.error(
      `No comparison arm named "${frameworkFlag}".  Known: ${ARMS.map((a) => a.name).join(', ')}`,
    );
    process.exit(1);
  }

  if (listOnly) {
    for (const arm of selected) console.log(`${arm.name}  js/${arm.file}`);
    return;
  }

  const title = `actor-ts · framework comparison (${selected.length} arm(s), ${rounds} round(s))`;
  const border = '─'.repeat(title.length + 4);
  console.log();
  console.log(ansi.gray('╭' + border + '╮'));
  console.log(ansi.gray('│  ') + ansi.bold(ansi.cyan(title)) + ansi.gray('  │'));
  console.log(ansi.gray('╰' + border + '╯'));

  if (rounds > 1) {
    // Start from nothing: a leftover round from an earlier, differently-sized
    // run would silently join this one's median.
    rmSync(ROUNDS_DIRECTORY, { recursive: true, force: true });
    console.log(ansi.gray(
      `\n  ${rounds} rounds, arms interleaved — the published row is the per-scenario median.`
      + '\n  Interleaving is the point: whatever else the machine is doing lands on every arm.',
    ));
  }

  const start = Date.now();
  const failed: string[] = [];

  // Rounds outside, arms inside.  The other order would measure each arm
  // under whatever the machine happened to be doing during its block.
  for (let round = 1; round <= rounds; round++) {
    for (const arm of selected) {
      const roundLabel = rounds > 1 ? ansi.gray(` (round ${round}/${rounds})`) : '';
      console.log('\n' + ansi.cyan('▸ ') + ansi.bold(arm.name) + ansi.gray(' / js/') + arm.file + roundLabel);
      const result = spawnSync(
        'bun',
        ['run', join(JAVASCRIPT_ARM_DIRECTORY, arm.file)],
        {
          stdio: 'inherit',
          env: rounds > 1
            ? { ...process.env, ACTOR_TS_COMPARISON_ROUND: String(round) }
            : process.env,
        },
      );
      if (result.status !== 0) {
        console.error(ansi.red(`  [exit=${result.status}] ${arm.name}`));
        if (!failed.includes(arm.name)) failed.push(arm.name);
      }
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log('\n' + ansi.gray('─'.repeat(60)));

  if (failed.length > 0) {
    console.log(
      `  ${ansi.red('✗')} ${failed.length} of ${selected.length} arm(s) failed `
      + `— total wall time ${ansi.bold(elapsed + 's')}`,
    );
    for (const name of failed) console.log(ansi.red(`      ${name}`));
    process.exit(1);
  }

  if (rounds > 1 && process.env.ACTOR_TS_BENCH_SMOKE !== '1') {
    const written = mergeRounds();
    console.log(`  ${ansi.green('✓')} merged ${rounds} rounds into ${written.length} result file(s)`);
  }

  console.log(`  ${ansi.green('✓')} done — total wall time ${ansi.bold(elapsed + 's')}`);
  console.log(ansi.gray('    regenerate the published tables with `bun run bench:compare:report`'));
}

run();
