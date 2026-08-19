/**
 * The doc-sample harness's importable surface, typed for its own tests (#470).
 *
 * `scripts/check-doc-samples.mjs` is plain ESM JavaScript and the repository
 * compiles with `allowJs` off, so a `.ts` test cannot import it without a
 * declaration to resolve.  This file is that declaration and nothing more — it
 * adds no behaviour and is not shipped (`package.json`'s `files` publishes
 * `dist/` only).  Same arrangement, and same reasoning, as
 * `scripts/stress-test.d.mts`.
 *
 * It is hand-written, so it can drift from the script.  What bounds the risk is
 * that `tests/unit/docs/DocSampleHarness.test.ts` reads real values through
 * these shapes: a field renamed in the script and not here fails that test on
 * the value rather than on the type, because `skipLibCheck` means nothing in
 * here is checked in isolation.
 *
 * The surface is deliberately the *pure* half: classification, binding
 * extraction, the continuity prologue, line re-basing and diagnostic parsing.
 * Nothing that spawns `tsc` is exported, because a stubbed compiler would let a
 * broken two-pass compile pass its own test — that half is covered end-to-end
 * by driving the real script over a fixture tree with `--docs` / `--out`.
 */

/** One fenced block of a documentation page. */
export type Fence = {
  /** Absolute path of the page the fence came from. */
  readonly file: string;
  /** The fence's whole info string, e.g. `ts no-compile — needs a broker`. */
  readonly info: string;
  /** First word of the info string, lower-cased: `ts`, `bash`, `json`, `''`. */
  readonly language: string;
  /** 1-based line of the fence's first body line, so diagnostics re-base onto the page. */
  readonly bodyStart: number;
  readonly body: readonly string[];
};

/** A `no-compile` fence, carrying whatever reason followed the marker. */
export type ExemptFence = Fence & { readonly reason: string };

/** A fence that will be emitted and compiled, with its body joined. */
export type CompiledFence = Fence & { readonly source: string; readonly page?: string };

/** The four buckets the fence convention sorts `ts` fences into. */
export type Classification = {
  readonly fragments: readonly Fence[];
  readonly elided: readonly Fence[];
  readonly exempt: readonly ExemptFence[];
  readonly compiled: readonly CompiledFence[];
};

/** One `tsc` diagnostic, re-based onto the page it came from. */
export type Diagnostic = {
  /** Name of the generated file, which is the key into the emitted map. */
  readonly file: string;
  readonly code: string;
  readonly message: string;
  /** 1-based line in the generated file, prologue included. */
  readonly generatedLine: number;
  readonly fence?: CompiledFence;
  readonly page?: string;
  /** Page line, or `null` when the diagnostic landed in the continuity prologue. */
  readonly line?: number | null;
  readonly column?: number;
  /** Printable `page:line:column`, or a prologue marker. */
  readonly where: string;
};

/** What a fence's semantic diagnostics say about it. */
export type Verdict = 'clean' | 'prose' | 'missing-import' | 'real-error';

/** Per-fence verdicts plus the tallies a sweep is planned from. */
export type DiagnosticReport = {
  readonly clean: readonly CompiledFence[];
  readonly prose: readonly CompiledFence[];
  readonly missingImport: readonly CompiledFence[];
  readonly realError: readonly CompiledFence[];
  /** Every diagnostic the default run fails on — `missing-import` and `real-error`. */
  readonly reported: readonly Diagnostic[];
  /** Fences carrying each diagnostic code. */
  readonly codes: ReadonlyMap<string, number>;
  /** Reported fences per page. */
  readonly pages: ReadonlyMap<string, number>;
  /** Prose placeholder names, by how many diagnostics they cause. */
  readonly placeholders: ReadonlyMap<string, number>;
  readonly syntaxFiles: ReadonlySet<string>;
};

export type HarnessOptions = {
  readonly measureOnly: boolean;
  readonly reportOnly: boolean;
  readonly keepOutput: boolean;
  readonly docs: string;
  readonly out: string;
};

/**
 * How an earlier fence bound a name, when the specifier is one this program can
 * certainly resolve — enough to rebuild an import for exactly that one name.
 */
export type ImportBinding = {
  readonly kind: 'named' | 'default' | 'namespace';
  /** The name in scope on the page. */
  readonly local: string;
  /** The exported name, when it differs from `local`. Absent for default/namespace. */
  readonly imported?: string;
  readonly specifier: string;
  readonly typeOnly: boolean;
};

/** What one fence inherits from the fences above it on its page. */
export type CarriedDeclarations = {
  /** Re-importable, so the continuation is genuinely type-checked. */
  readonly imports: readonly ImportBinding[];
  /** Everything else — declared `any`, because the harness cannot know the type. */
  readonly opaque: readonly string[];
};

export function markdownFiles(directory: string, out?: string[]): string[];
export function fencesOfSource(text: string, file: string): Fence[];
export function fencesOf(path: string): Fence[];
export function classify(typescriptFences: readonly Fence[]): Classification;
export function namesFromImportClause(clause: string): string[];
export function namesFromPattern(pattern: string): string[];
export function bindingsOf(source: string): Set<string>;
export function importsOf(source: string): Map<string, ImportBinding>;
export function importStatementFor(descriptor: ImportBinding): string;
export function carriedNames(pageFences: readonly Fence[]): Map<Fence, string[]>;
export function carriedDeclarations(pageFences: readonly Fence[]): Map<Fence, CarriedDeclarations>;
export function continuityPrologue(carried: readonly string[] | CarriedDeclarations): string;
export function pageLineOf(fence: Pick<Fence, 'bodyStart'>, generatedLine: number): number;
export function isSyntaxError(code: string): boolean;
export function isUnresolvedName(code: string): boolean;
export function unresolvedNameOf(message: string): string | null;
export function actorTsVocabulary(typescriptFences: readonly Fence[]): Set<string>;
export function verdictOf(
  diagnostics: readonly Pick<Diagnostic, 'code' | 'message'>[],
  vocabulary: ReadonlySet<string>,
): Verdict;
export function parseDiagnostics(
  output: string,
  emitted: ReadonlyMap<string, CompiledFence>,
  pageOf: (fence: CompiledFence) => string,
): Diagnostic[];
export function classifyDiagnostics(
  emitted: ReadonlyMap<string, CompiledFence>,
  syntax: readonly Diagnostic[],
  semantic: readonly Diagnostic[],
  vocabulary: ReadonlySet<string>,
): DiagnosticReport;
export function parseArguments(argv: readonly string[]): HarnessOptions;
export function exportsPaths(
  manifest: { exports: Record<string, unknown> },
  toRoot?: string,
): Record<string, string[]>;

/** Lines the continuity prologue occupies in every emitted file. */
export const PROLOGUE_LINES: number;
export const DECLARES_IMPORT: RegExp;
export const ELIDED: RegExp;
export const COMMENT_AS_EXPRESSION_BODY: RegExp;
export const CLASS_MEMBER_FRAGMENT: RegExp;
