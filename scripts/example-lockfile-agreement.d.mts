/**
 * The example-lockfile guard's importable surface, typed for its own tests.
 *
 * `scripts/example-lockfile-agreement.mjs` is plain ESM JavaScript and the
 * repository compiles with `allowJs` off, so a `.ts` test cannot import it
 * without a declaration. Hand-written, the same arrangement as
 * `scripts/nightly-flake-report.d.mts`; what keeps it honest is
 * `tests/unit/ci/ExampleLockfileAgreement.test.ts` reading real values
 * through it.
 */

/** Package name → every version a lockfile resolves it to. */
export type Resolutions = Map<string, Set<string>>;

/** Package name → the advisory URLs an audit report lists for it. */
export type Advisories = Map<string, Set<string>>;

export type MajorDisagreement = {
  readonly name: string;
  readonly npm: string[];
  readonly bun: string[];
};

export type AdvisoryDisagreement = {
  readonly name: string;
  readonly advisory: string;
  readonly vulnerable: 'npm' | 'bun';
  readonly npm: string[];
  readonly bun: string[];
};

export type AuditedLockfile = {
  readonly resolutions: Resolutions;
  readonly advisories: Advisories;
};

export function npmResolutions(text: string): Resolutions;
export function bunResolutions(text: string): Resolutions;
export function majorLine(version: string): string;
export function majorDisagreements(npm: Resolutions, bun: Resolutions): MajorDisagreement[];
export function bunAuditAdvisories(report: unknown): Advisories;
export function npmAuditAdvisories(report: unknown): Advisories;
export function advisoryDisagreements(npm: AuditedLockfile, bun: AuditedLockfile): AdvisoryDisagreement[];
export function resolutionsIn(directory: string): { npm: Resolutions; bun: Resolutions };
