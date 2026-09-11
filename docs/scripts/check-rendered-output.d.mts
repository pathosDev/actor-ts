/**
 * The rendered-output check's importable surface, typed for its own test
 * (#1528).
 *
 * `docs/scripts/check-rendered-output.mjs` is plain ESM JavaScript and the
 * repository compiles with `allowJs` off, so a `.ts` test cannot import it
 * without a declaration to resolve.  This file is that declaration and nothing
 * more — no behaviour, and not shipped.  Same arrangement, and the same reason,
 * as `scripts/coverage-gate.d.mts`.
 *
 * Hand-written, so it can drift from the script; what gives these shapes value
 * is `tests/unit/docs/RenderedOutputCheck.test.ts` reading real values through
 * them, so a field renamed in the script and not here fails that test on the
 * value rather than on the type.
 */

/** What `auditPage` found on one rendered page. */
export type PageAudit = {
  /**
   * One entry per rule that fired, each prefixed with its rule name —
   * `directive-leaked`, `mermaid-unrendered`, `mermaid-style-empty`.  Empty
   * for a page with nothing wrong.
   */
  readonly findings: ReadonlyArray<string>;
  /** Rendered mermaid diagrams on the page, for the positive guard. */
  readonly svgs: number;
};

/** One finding, located. */
export type DistFinding = {
  /** Path relative to the dist root, POSIX separators. */
  readonly page: string;
  readonly finding: string;
};

/** What `auditDist` concluded about a whole build. */
export type DistAudit = {
  /** `true` exactly when there is no finding and no problem. */
  readonly ok: boolean;
  /** Guard failures — missing or partial output, or no diagram where the source has fences. */
  readonly problems: ReadonlyArray<string>;
  readonly pages: number;
  readonly svgs: number;
  readonly findings: ReadonlyArray<DistFinding>;
};

/** `docs/dist/`, resolved from the script's own location. */
export const DIST_ROOT: string;
/** `docs/src/content/docs/`, resolved from the script's own location. */
export const CONTENT_ROOT: string;

/** Classify one page's HTML.  Pure — reads nothing. */
export function auditPage(html: string): PageAudit;

/**
 * Audit a built site.  Both roots default to the real ones; a test passes a
 * temporary directory for each.  Never exits — the CLI entry point decides.
 */
export function auditDist(distRoot?: string, contentRoot?: string): DistAudit;
