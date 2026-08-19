/**
 * The coverage gate's importable surface, typed for its own tests (#541).
 *
 * `scripts/coverage-gate.mjs` is plain ESM JavaScript and the repository
 * compiles with `allowJs` off, so a `.ts` test cannot import it without a
 * declaration to resolve.  This file is that declaration and nothing more — no
 * behaviour, and not shipped (`package.json`'s `files` publishes `dist/` only).
 * Same arrangement, and the same reason, as `scripts/stress-test.d.mts`.
 *
 * It is hand-written and can therefore drift from the script.  `skipLibCheck`
 * means nothing here is checked in isolation; what gives these shapes value is
 * `tests/unit/ci/CoverageGate.test.ts` reading real values through them, so a
 * field renamed in the script and not here fails that test on the value rather
 * than on the type.
 *
 * The surface is the *pure* half: parsing, the weighted rollup and the verdicts.
 * The driver — which spawns `bun test` — is deliberately absent.  It is covered
 * end to end instead, by running the script over synthetic artifacts with
 * `--log` / `--lcov`, because a per-module floor that cannot fail is worse than
 * no floor at all and only a real invocation proves the exit code moves.
 */

/** One source file's line counts, as lcov records them. */
export type LcovRecord = {
  /** Repository-relative, POSIX separators — see `normaliseCoveragePath`. */
  readonly path: string;
  /** lcov `LF:` — instrumented lines in the file. */
  readonly linesFound: number;
  /** lcov `LH:` — how many of them were executed. */
  readonly linesHit: number;
};

/**
 * One module's weighted coverage.  `percentage` is `undefined` exactly when
 * `linesFound` is 0, which includes the case that matters: no record matched
 * the prefix at all.
 */
export type ModuleRollup = {
  readonly prefix: string;
  readonly files: number;
  readonly linesFound: number;
  readonly linesHit: number;
  readonly percentage: number | undefined;
};

/** A module at or above its floor. */
export type PassVerdict = ModuleRollup & {
  readonly floor: number;
  readonly percentage: number;
  readonly kind: 'pass';
};

/** A module that measured below its floor — the gate fails. */
export type BelowFloorVerdict = ModuleRollup & {
  readonly floor: number;
  readonly percentage: number;
  readonly kind: 'below-floor';
};

/**
 * A module the report says nothing about.  Its own verdict rather than a pass,
 * because "nothing matched" is what a mistyped prefix, a report from the wrong
 * run and an unnormalised Windows path all look like.
 */
export type NoRecordsVerdict = ModuleRollup & {
  readonly floor: number;
  readonly percentage: undefined;
  readonly kind: 'no-records';
};

export type ModuleVerdict = PassVerdict | BelowFloorVerdict | NoRecordsVerdict;

/** Path prefix → line-coverage floor, as `MODULE_LINE_FLOORS` holds it. */
export type ModuleFloorTable = Readonly<Record<string, number>>;

/** The gate's own arguments, per {@link parseArguments}. */
export type CoverageGateArguments = {
  readonly logPath: string | undefined;
  readonly lcovPath: string | undefined;
};

export const DEFAULT_LINE_FLOOR: number;
export const MODULE_LINE_FLOORS: ModuleFloorTable;

export function normaliseCoveragePath(value: string): string;
export function parseLcovRecords(text: string): readonly LcovRecord[];
export function rollUpModule(records: readonly LcovRecord[], prefix: string): ModuleRollup;
export function evaluateModuleFloors(
  records: readonly LcovRecord[],
  floors?: ModuleFloorTable,
): readonly ModuleVerdict[];
export function parseAggregateLineCoverage(output: string): number | undefined;
export function parseArguments(argv: readonly string[]): CoverageGateArguments;
export function describeModuleVerdict(verdict: ModuleVerdict): string;
