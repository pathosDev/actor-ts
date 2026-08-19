/**
 * Drives the framework comparison — one framework per subprocess (#27).
 *
 *   bun run bench:compare                        # every arm, one round
 *   bun run bench:compare -- --rounds=10         # ten interleaved rounds, mean published
 *   bun run bench:compare -- --framework=nact    # one arm
 *   bun run bench:compare -- --list              # what would run
 *   bun run bench:compare -- --javascript-only   # skip the arms needing a JDK / .NET SDK
 *
 * **Publish from `--rounds`, never from a single round.**  One round is not a
 * measurement on a machine that is not otherwise idle, and no development
 * machine is: five consecutive rounds here varied by 2 % on one arm, 15 % on
 * another and 34 % on a third, while the ordering of the three stayed
 * identical throughout.  `--rounds=N` runs the arms interleaved — round 1 of
 * every arm, then round 2 — so whatever else the machine is doing lands on
 * all of them, and publishes the per-scenario **mean** together with the
 * spread across those rounds.
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
import { captureEnvironment } from './js/environment.js';
import { mergeRounds } from './js/merge-rounds.js';
import { ROUNDS_DIRECTORY } from './js/result-file.js';

/** An arm written in TypeScript, run through the shared harness on Bun. */
type JavaScriptArm = {
  readonly kind: 'javascript';
  readonly name: string;
  /** File under `js/`, run in its own Bun subprocess. */
  readonly file: string;
};

/**
 * An arm on another virtual machine, driven by its own build tool.
 *
 * It mirrors the measurement protocol by hand and writes the same result
 * schema — see `report.ts`, which validates every one of the workload
 * constants precisely because these cannot import them.
 */
type ExternalArm = {
  readonly kind: 'external';
  readonly name: string;
  /** Directory to run in, relative to this file. */
  readonly directory: string;
  /**
   * The command to run.
   *
   * `'directory'` means a script that ships with the arm (a build wrapper) and
   * is invoked through its absolute path; `'path'` means an installed tool
   * found on `PATH`.  The distinction is not cosmetic: cmd.exe resolves a bare
   * name against `PATH` but *not* against the child's working directory, so
   * getting it wrong fails with "is either misspelled or could not be found" —
   * a message that reads like a missing toolchain rather than a lookup rule.
   */
  readonly resolveFrom: 'directory' | 'path';
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  /** Why this arm exists as a separate toolchain, for `--list`. */
  readonly toolchain: string;
};

type ComparisonArm = JavaScriptArm | ExternalArm;

/**
 * Every arm, in publication order.
 *
 * There is deliberately no "no framework" arm.  One existed — plain method
 * calls, meant as a floor showing what the abstraction costs — and it was
 * removed: a column running three orders of magnitude above the others
 * invites the conclusion that the frameworks are wasteful rather than that
 * they are doing something else entirely, and it was also the least stable
 * number in the suite (16 % between consecutive runs, because a loop a JIT
 * can flatten is barely a measurement).  A figure that misleads more than it
 * informs does not earn its place in a comparison.
 */
const ARMS: ReadonlyArray<ComparisonArm> = [
  { kind: 'javascript', name: 'actor-ts', file: 'actor-ts.ts' },
  { kind: 'javascript', name: 'nact', file: 'nact.ts' },
  { kind: 'javascript', name: 'xstate', file: 'xstate.ts' },
  {
    kind: 'external',
    name: 'akka-java',
    directory: 'akka-java',
    resolveFrom: 'directory',
    executable: millWrapper(),
    args: ['--ticker', 'false', 'run'],
    toolchain: 'JDK 21 + Mill wrapper',
  },
  // The same framework, same version, through its Scala API in the idiomatic
  // functional style.  Next to the Java arm on purpose: the pair differs only
  // in the language binding, so any gap between them is the binding rather
  // than the framework or the runtime.
  {
    kind: 'external',
    name: 'akka-scala',
    directory: 'akka-scala',
    resolveFrom: 'directory',
    executable: millWrapper(),
    args: ['--ticker', 'false', 'run'],
    toolchain: 'JDK 21 + Mill wrapper',
  },
  // Its Apache-licensed fork, measured next to it on purpose: the two differ
  // only in their dependency, so any gap between them is the fork rather than
  // the benchmark — and the licences differ in a way that decides adoption.
  {
    kind: 'external',
    name: 'pekko-java',
    directory: 'pekko-java',
    resolveFrom: 'directory',
    executable: millWrapper(),
    args: ['--ticker', 'false', 'run'],
    toolchain: 'JDK 21 + Mill wrapper',
  },
  // And the fork's Scala binding — the fourth corner of a two-by-two. Reading
  // down a column gives the licence question, across a row the binding one.
  {
    kind: 'external',
    name: 'pekko-scala',
    directory: 'pekko-scala',
    resolveFrom: 'directory',
    executable: millWrapper(),
    args: ['--ticker', 'false', 'run'],
    toolchain: 'JDK 21 + Mill wrapper',
  },
  // The .NET side. `--nologo -v q` keeps the build chatter out of the run;
  // Release matters, since a Debug build measures the absence of the JIT's
  // optimiser rather than the framework.
  {
    kind: 'external',
    name: 'akka.net',
    directory: 'akka-net',
    resolveFrom: 'path',
    executable: 'dotnet',
    args: ['run', '-c', 'Release', '--nologo', '-v', 'q'],
    toolchain: '.NET 10 SDK',
  },
  // The virtual-actor model, and the arm whose semantics diverge most: grains
  // activate on first call and there is no caller-visible spawn or stop, so
  // three of its four rows measure a near-equivalent and say so in a note.
  {
    kind: 'external',
    name: 'orleans',
    directory: 'orleans',
    resolveFrom: 'path',
    executable: 'dotnet',
    args: ['run', '-c', 'Release', '--nologo', '-v', 'q'],
    toolchain: '.NET 10 SDK',
  },
];

/**
 * The Mill wrapper's file name differs by platform.  It is always invoked
 * through its absolute path: a bare name is not on the PATH, and cmd.exe does
 * not resolve one against the child's working directory either — which fails
 * with "is either misspelled or could not be found", a message that reads like
 * a missing toolchain rather than a lookup rule.
 *
 * And on Windows the `.bat` is not a convenience but the only entry point: the
 * POSIX `mill` script refuses to run anywhere that is not Linux or macOS, so a
 * Git Bash invocation of `./mill` exits rather than falling back — which the
 * Maven wrapper it replaced did not do.
 */
function millWrapper(): string {
  return process.platform === 'win32' ? 'mill.bat' : 'mill';
}

const COMPARISON_ROOT = resolve(import.meta.dirname ?? '.', '.');
const JAVASCRIPT_ARM_DIRECTORY = join(COMPARISON_ROOT, 'js');

/**
 * The environment block, passed to external arms rather than re-derived there.
 *
 * Every arm of a run executes on the same machine in the same session, and a
 * JVM has no portable way to read a CPU model at all — so two arms describing
 * one machine differently would be a reporting bug with no upside.
 */
function environmentVariables(): Record<string, string> {
  const environment = captureEnvironment();
  return {
    ACTOR_TS_COMPARISON_CPU: environment.cpuModel,
    ACTOR_TS_COMPARISON_CORES: String(environment.logicalCores),
    ACTOR_TS_COMPARISON_MEMORY_BYTES: String(environment.memoryBytes),
    ACTOR_TS_COMPARISON_OS: environment.os,
    ACTOR_TS_COMPARISON_DATE: environment.date,
    ACTOR_TS_COMPARISON_VERSION: environment.actorTsVersion,
    ACTOR_TS_COMPARISON_COMMIT: environment.actorTsCommit,
  };
}

function runArm(arm: ComparisonArm, environment: NodeJS.ProcessEnv): number | null {
  if (arm.kind === 'javascript') {
    return spawnSync('bun', ['run', join(JAVASCRIPT_ARM_DIRECTORY, arm.file)], {
      stdio: 'inherit',
      env: environment,
    }).status;
  }

  const directory = join(COMPARISON_ROOT, arm.directory);
  const command = arm.resolveFrom === 'directory'
    ? join(directory, arm.executable)
    : arm.executable;
  return spawnSync(command, [...arm.args], {
    stdio: 'inherit',
    cwd: directory,
    env: environment,
    // A build wrapper is a script rather than an executable, so it needs a
    // shell to run at all.
    shell: true,
  }).status;
}

function run(): void {
  const args = process.argv.slice(2);
  const frameworkFlag = args.find((a) => a.startsWith('--framework='))?.slice('--framework='.length);
  const roundsFlag = args.find((a) => a.startsWith('--rounds='))?.slice('--rounds='.length);
  const listOnly = args.includes('--list');
  // CI installs Bun and nothing else, so the cross-language arms cannot run
  // there. Without this the smoke job would fail on a missing toolchain and
  // say nothing about the arms it *can* check.
  const javascriptOnly = args.includes('--javascript-only');

  const rounds = roundsFlag === undefined ? 1 : Number.parseInt(roundsFlag, 10);
  if (!Number.isFinite(rounds) || rounds < 1) {
    console.error(`--rounds must be a positive integer, got "${roundsFlag}"`);
    process.exit(1);
  }

  const byToolchain = javascriptOnly
    ? ARMS.filter((arm) => arm.kind === 'javascript')
    : ARMS;
  const selected = frameworkFlag === undefined
    ? byToolchain
    : byToolchain.filter((arm) => arm.name === frameworkFlag);

  if (selected.length === 0) {
    console.error(
      `No comparison arm named "${frameworkFlag}".  Known: ${ARMS.map((a) => a.name).join(', ')}`,
    );
    process.exit(1);
  }

  if (listOnly) {
    for (const arm of selected) {
      console.log(arm.kind === 'javascript'
        ? `${arm.name}  js/${arm.file}`
        : `${arm.name}  ${arm.directory}/  (${arm.toolchain})`);
    }
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
  const sharedEnvironment = { ...process.env, ...environmentVariables() };

  // Rounds outside, arms inside.  The other order would measure each arm
  // under whatever the machine happened to be doing during its block.
  for (let round = 1; round <= rounds; round++) {
    for (const arm of selected) {
      const roundLabel = rounds > 1 ? ansi.gray(` (round ${round}/${rounds})`) : '';
      const where = arm.kind === 'javascript' ? `js/${arm.file}` : `${arm.directory}/`;
      console.log('\n' + ansi.cyan('▸ ') + ansi.bold(arm.name) + ansi.gray(' / ') + where + roundLabel);

      const environment = rounds > 1
        ? { ...sharedEnvironment, ACTOR_TS_COMPARISON_ROUND: String(round) }
        : sharedEnvironment;

      const status = runArm(arm, environment);
      if (status !== 0) {
        console.error(ansi.red(`  [exit=${status}] ${arm.name}`));
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
