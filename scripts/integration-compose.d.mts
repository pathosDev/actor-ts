/**
 * The broker-suite driver's importable surface, typed for its own test (#559).
 *
 * `scripts/integration-compose.mjs` is plain ESM JavaScript and the repository
 * compiles with `allowJs` off, so a `.ts` test cannot import it without a
 * declaration to resolve.  This file is that declaration and nothing more — it
 * adds no behaviour and is not shipped (`package.json`'s `files` publishes
 * `dist/` only).
 *
 * As with `stress-test.d.mts`, it is hand-written and can therefore drift from
 * the script.  What bounds the risk is that
 * `tests/unit/ci/IntegrationBrokerSuites.test.ts` reads real values through
 * these shapes rather than only type-checking against them, and that the
 * surface is the *pure* half of the driver: discovery, argument parsing,
 * suite selection and the compose argument vectors.  Nothing here spawns.
 * The spawning half is one `spawnSync` whose arguments are pinned by that
 * test, which is the part that could silently change what Docker is asked to
 * do.
 */

/** One discovered suite: a directory under `tests/integration/brokers/`. */
export type BrokerSuite = {
  /** The directory name, which is also the suite's public name. */
  readonly name: string;
  /** Repo-relative POSIX path of its compose file, as passed to `-f`. */
  readonly composeFile: string;
};

/** What the driver was asked to do, per {@link parseArguments}. */
export type ComposeOptions = {
  readonly mode: 'up' | 'down' | 'logs';
  readonly all: boolean;
  readonly names: readonly string[];
};

/** Repo-relative POSIX path of the directory holding one directory per suite. */
export const BROKERS_DIRECTORY: string;

/**
 * Every suite in the tree, sorted by name.  Throws when a directory holds a
 * compose file not named after it — that would otherwise be an invisible
 * omission from both the aggregate and CI.
 */
export function discoverSuites(repositoryRoot?: string): readonly BrokerSuite[];

/** The `docker` argument vector for one suite in one mode. */
export function composeArguments(composeFile: string, mode: 'up' | 'down' | 'logs'): readonly string[];

export function parseArguments(argv: readonly string[]): ComposeOptions;

/** Which suites a parsed command line selects, in run order.  Throws on an unknown name. */
export function selectSuites(options: ComposeOptions, suites: readonly BrokerSuite[]): readonly BrokerSuite[];
