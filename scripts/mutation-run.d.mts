/**
 * The mutation runner's importable surface, typed for its own tests (#1368).
 *
 * `scripts/mutation-run.mjs` is plain ESM JavaScript and the repository
 * compiles with `allowJs` off, so a `.ts` test cannot import it without a
 * declaration to resolve.  Hand-written, like `stress-test.d.mts`, and bounded
 * the same way: `tests/unit/ci/MutationRunner.test.ts` reads real values
 * through these shapes, so a field renamed in the script and not here fails on
 * the value.  The driver (`main`, file selection, git) is deliberately absent.
 */

export type Operator =
  | 'relational-boundary'
  | 'equality'
  | 'logical'
  | 'boolean-literal'
  | 'removed-call'
  | 'removed-return';

export const OPERATORS: readonly Operator[];

export type IgnoreEntry = {
  readonly operators: readonly Operator[];
  readonly pattern: string;
  readonly reason?: string;
};

export type Mutant = {
  readonly id: number;
  readonly operator: Operator;
  readonly start: number;
  readonly end: number;
  readonly original: string;
  readonly replacement: string;
  readonly line: number;
  readonly column: number;
  readonly lineText: string;
};

export type MutantStatus = 'killed' | 'timed-out' | 'survived' | 'no-coverage' | 'not-run';

export type StatusCounts = Record<MutantStatus, number> & {
  readonly total: number;
  readonly score: number | null;
};

export type RunResult = {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly output: string;
};

export type FileGuard = {
  mutate(path: string, original: Buffer, mutated: string): void;
  restore(path: string): void;
  restoreAll(): void;
  pending(): string[];
  recover(): string[];
};

export type RestoreTarget = {
  on(event: string, handler: () => void): unknown;
  off(event: string, handler: () => void): unknown;
  exit(code: number): void;
};

export type ParsedArguments = {
  readonly files: string[];
  readonly globs: string[];
  readonly since: string | undefined;
  readonly set: string | undefined;
  readonly tests: string[];
  readonly operators: Operator[];
  readonly reportDirectory: string;
  readonly configPath: string;
  readonly baselinePath: string;
  readonly writeBaseline: boolean;
  readonly timeoutFactor: number;
  readonly timeoutMs: number | undefined;
  readonly budgetMinutes: number | undefined;
  readonly maximumMutantsPerFile: number | undefined;
  readonly mutantIds: number[] | undefined;
  readonly dryRun: boolean;
  readonly recoverOnly: boolean;
};

export type ReportFile = {
  readonly path: string;
  readonly tests: readonly string[];
  readonly invalid: number;
  readonly equivalent: number;
  readonly skipped?: string;
  readonly mutants: ReadonlyArray<Omit<Mutant, 'start' | 'end'> & { readonly status: MutantStatus }>;
  readonly counts: StatusCounts;
};

export type Report = {
  readonly startedAt: string;
  readonly bunVersion: string | null;
  readonly commit: string | null;
  readonly files: readonly ReportFile[];
  readonly totals: StatusCounts;
  readonly baseline?: Readonly<Record<string, BaselineCounts>>;
};

export type BaselineCounts = {
  readonly killed: number;
  readonly timedOut: number;
  readonly survived: number;
  readonly noCoverage: number;
};

export type BaselineDocument = {
  readonly recordedAt: string;
  readonly commit: string | null;
  readonly bunVersion: string | null;
  files: Record<string, BaselineCounts>;
};

export function codeMask(source: string): Uint8Array;
export function findMutants(
  source: string,
  options?: { operators?: readonly Operator[]; ignore?: readonly IgnoreEntry[] },
): Mutant[];
export function applyMutant(source: string, mutant: Pick<Mutant, 'start' | 'end' | 'replacement'>): string;
export function partitionMutants(
  source: string,
  mutants: readonly Mutant[],
  transpile: (code: string) => string,
): { valid: Mutant[]; invalid: Mutant[]; equivalent: Mutant[] };
export function toPosix(path: string): string;
export function importedSources(testPath: string, text: string): Set<string>;
export function testsFor(sourcePath: string, testPaths: readonly string[], readText: (path: string) => string): string[];
export function lineHits(lcov: string, sourcePath: string): Map<number, number>;
export function classifyRun(result: { exitCode: number | null; timedOut: boolean }): 'killed' | 'survived' | 'timed-out';
export function timeoutFor(
  baselineMs: number,
  options?: { factor?: number; slackMs?: number; fixedMs?: number },
): number;
export function countStatuses(mutants: ReadonlyArray<{ status: MutantStatus }>): StatusCounts;
export function renderMarkdown(report: Report): string;
export function baselineDocument(report: Report): BaselineDocument;
export function createFileGuard(options: { journalDirectory: string; root?: string }): FileGuard;
export function installRestoreHandlers(
  guard: FileGuard,
  options?: { target?: RestoreTarget; onSignal?: (signal: string) => void },
): () => void;
export function runWithTimeout(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; cwd?: string; environment?: NodeJS.ProcessEnv },
): Promise<RunResult>;
export function parseArguments(argv: readonly string[]): ParsedArguments;
export class UsageError extends Error {}
export function isMutableSource(path: string): boolean;
