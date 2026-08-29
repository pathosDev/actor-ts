#!/usr/bin/env node
/**
 * One driver for every live-broker integration suite (#559).
 *
 * There used to be a `package.json` script per suite, in pairs — 34 of them,
 * plus two aggregates — and every one was the same two lines with a different
 * compose path spliced in.  That is a list of backends maintained in four
 * places at once: the two per-suite scripts, both aggregate chains, and the
 * matrix in `.github/workflows/integration-brokers.yml`.  Adding a backend
 * meant editing all four and noticing nothing if you missed one; the run
 * simply never happened.
 *
 * So the list is not maintained at all any more — it is *discovered*.  A suite
 * is a directory under `tests/integration/brokers/` holding a compose file
 * named after it, which is a convention all seventeen already followed.  The
 * shape is deliberately strict rather than a glob-and-hope:
 *
 *   - A directory with no compose file at all is not a suite and is skipped
 *     silently.  `brokers/lib/` is that case and always will be.
 *   - A directory holding a compose file under some OTHER name is an error,
 *     not a skip.  A glob would quietly leave such a suite out of both the
 *     aggregate and CI, which is precisely the failure this script exists to
 *     make impossible.
 *
 * The CI matrix still lists the suites, because it also carries a display
 * label per broker that nothing can derive.  It is no longer a second source
 * of truth: `tests/unit/ci/IntegrationBrokerSuites.test.ts` fails when the
 * matrix and the tree disagree in either direction, and pins the compose
 * argument vectors below against the commands the per-suite scripts used to
 * run, so this refactor cannot have changed what Docker is asked to do.
 *
 * Usage — the name is the DIRECTORY name, which is why the matrix no longer
 * needs a second column mapping `redis-streams` to a `redis` script:
 *
 *   node scripts/integration-compose.mjs redis-streams          # bring up
 *   node scripts/integration-compose.mjs redis-streams --down   # tear down
 *   node scripts/integration-compose.mjs redis-streams --logs    # dump logs
 *   node scripts/integration-compose.mjs --all                  # every suite
 *   node scripts/integration-compose.mjs --all --down
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where the suites live, repo-relative and POSIX-separated because the value
 * ends up in a `docker compose -f` argument that has to read the same on
 * Windows as on a runner.
 */
export const BROKERS_DIRECTORY = 'tests/integration/brokers';

/** Matches any compose file, so a misnamed one is caught rather than skipped. */
const COMPOSE_FILE_PATTERN = /^docker-compose\..+\.ya?ml$/;

/**
 * Every suite in the tree, sorted by name so the aggregate order is stable
 * across platforms — `readdirSync` is not required to be.
 *
 * @param {string} [repositoryRoot]
 * @returns {ReadonlyArray<{ name: string, composeFile: string }>}
 */
export function discoverSuites(repositoryRoot = REPOSITORY_ROOT) {
  const root = resolve(repositoryRoot, BROKERS_DIRECTORY);
  const suites = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const present = readdirSync(resolve(root, entry.name)).filter((f) => COMPOSE_FILE_PATTERN.test(f));
    if (present.length === 0) continue;
    const expected = `docker-compose.${entry.name}.yml`;
    if (!present.includes(expected)) {
      throw new Error(
        `${BROKERS_DIRECTORY}/${entry.name} holds ${present.join(', ')} but no ${expected}. `
        + 'A suite\'s compose file must be named after its directory, or nothing can discover it.',
      );
    }
    suites.push({ name: entry.name, composeFile: `${BROKERS_DIRECTORY}/${entry.name}/${expected}` });
  }
  return suites.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The argument vector for one suite.  These three are transcriptions of the
 * scripts this file replaced and are pinned by test — `--exit-code-from runner`
 * in particular is what makes a failing scenario inside the container turn the
 * CI step red, so losing it would leave every broker suite passing forever.
 *
 * @param {string} composeFile
 * @param {'up' | 'down' | 'logs'} mode
 * @returns {readonly string[]}
 */
export function composeArguments(composeFile, mode) {
  const base = ['compose', '-f', composeFile];
  switch (mode) {
    case 'up':
      return [...base, 'up', '--build', '--abort-on-container-exit', '--exit-code-from', 'runner'];
    case 'down':
      return [...base, 'down', '-v', '--remove-orphans'];
    case 'logs':
      return [...base, 'logs', '--no-color'];
    default: {
      const unreachable = /** @type {never} */ (mode);
      throw new Error(`composeArguments: unknown mode ${String(unreachable)}`);
    }
  }
}

/**
 * @param {readonly string[]} argv
 * @returns {{ mode: 'up' | 'down' | 'logs', all: boolean, names: readonly string[] }}
 */
export function parseArguments(argv) {
  let mode = /** @type {'up' | 'down' | 'logs'} */ ('up');
  let all = false;
  const names = [];
  for (const argument of argv) {
    if (argument === '--down') { mode = 'down'; continue; }
    if (argument === '--logs') { mode = 'logs'; continue; }
    if (argument === '--all') { all = true; continue; }
    if (argument.startsWith('-')) throw new Error(`integration-compose: unknown flag ${argument}`);
    names.push(argument);
  }
  return { mode, all, names };
}

/**
 * Which suites a parsed command line selects, in run order.
 *
 * An unknown name is fatal and lists what is available: the old scripts failed
 * with npm's "missing script" for a typo, which said nothing about which
 * backends exist.
 *
 * @param {ReturnType<typeof parseArguments>} options
 * @param {ReadonlyArray<{ name: string, composeFile: string }>} suites
 */
export function selectSuites(options, suites) {
  if (options.all) {
    if (options.names.length > 0) {
      throw new Error('integration-compose: --all takes no suite names');
    }
    return suites;
  }
  if (options.names.length === 0) {
    throw new Error(
      `integration-compose: name a suite or pass --all. Available: ${suites.map((s) => s.name).join(', ')}`,
    );
  }
  return options.names.map((name) => {
    const suite = suites.find((s) => s.name === name);
    if (!suite) {
      throw new Error(
        `integration-compose: no suite '${name}'. Available: ${suites.map((s) => s.name).join(', ')}`,
      );
    }
    return suite;
  });
}

function main() {
  let options;
  let selected;
  try {
    options = parseArguments(process.argv.slice(2));
    selected = selectSuites(options, discoverSuites());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  // `up` stops at the first failure and `down` does not, which is the
  // behaviour of the `&&` and `;` chains the two aggregates used to be.  A
  // teardown that gave up halfway would strand containers and volumes from
  // every later suite, and the next run would inherit them.
  const stopOnFailure = options.mode === 'up';
  let worstStatus = 0;

  for (const suite of selected) {
    if (selected.length > 1) console.log(`\n=== ${suite.name} (${options.mode}) ===`);
    const result = spawnSync('docker', composeArguments(suite.composeFile, options.mode), {
      cwd: REPOSITORY_ROOT,
      stdio: 'inherit',
      shell: false,
    });
    if (result.error) {
      console.error(`integration-compose: could not run docker — ${result.error.message}`);
      process.exit(127);
    }
    const status = result.status ?? 1;
    if (status !== 0) {
      worstStatus = status;
      if (stopOnFailure) break;
    }
  }

  process.exit(worstStatus);
}

if (import.meta.main) main();
