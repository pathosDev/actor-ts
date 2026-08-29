import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * Repo-file guard over the security policy — the same class of check as
 * `tests/unit/ci/WorkflowHygiene.test.ts`, `tests/unit/config/NoDeadConfigKeys.test.ts`
 * and `tests/unit/TreeShaking.test.ts`: assertions about files no compiler
 * reads, run under plain `bun test` because nothing else in the toolchain
 * would ever notice them rotting.
 *
 * Three things are worth a test here rather than a convention.
 *
 * The first is that the issue template used to point at a `SECURITY.md` that
 * had never existed in this repository, with a "(or, if absent, contact the
 * maintainer privately)" hedge and no channel named — so a reporter following
 * the instructions arrived nowhere (#539). Deleting the file would restore
 * exactly that state, silently.
 *
 * The second is the audit baseline. `lint:audit` suppresses advisory IDs that
 * were already in the closure when the gate landed; a suppression that nobody
 * can see is a gate that has quietly stopped gating, which is the failure mode
 * #1194 taught this repository to write assertions against. Requiring every
 * suppressed ID to appear in `SECURITY.md` — and every listed ID to still be
 * suppressed — makes the list impossible to grow in the dark and impossible to
 * leave behind once #779 removes the advisories.
 *
 * The third is the route around that list. A dependency override rewrites the
 * resolved closure `bun audit` reads, so it can retire an advisory without
 * touching the `--ignore` flags at all — a suppression the table above cannot
 * see. #676 found it while looking for a way to declare `cassandra-driver`.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');

const securityPolicy = readFileSync(join(REPOSITORY_ROOT, 'SECURITY.md'), 'utf8');

const securityTemplate = readFileSync(
  join(REPOSITORY_ROOT, '.github', 'ISSUE_TEMPLATE', 'security_report.yml'),
  'utf8',
);

type RootManifest = {
  scripts?: Record<string, string | undefined>;
  peerDependencies?: Record<string, string>;
  /** npm spelling of a transitive-version pin. */
  overrides?: Record<string, unknown>;
  /** yarn spelling of the same thing — bun reads both (measured, #676). */
  resolutions?: Record<string, unknown>;
};

const rootManifest = JSON.parse(
  readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8'),
) as RootManifest;

const auditScript: string = rootManifest.scripts?.['lint:audit'] ?? '';

/**
 * The template's prose is a markdown blockquote wrapped across YAML lines, so
 * every phrase in it is split by `\n        > `. Normalising the quote markers
 * and the wrapping away is what lets the assertions below talk about sentences
 * instead of about where the line breaks happen to fall.
 */
const templateProse = securityTemplate.replace(/^\s*>\s?/gm, ' ').replace(/\s+/g, ' ');

const advisoryPattern = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/g;

const suppressedAdvisories: readonly string[] = [
  ...new Set(
    [...auditScript.matchAll(/--ignore=(GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4})/g)]
      .map((match) => match[1] ?? ''),
  ),
].sort();

/** Advisory IDs linked from the policy's "Accepted advisories" table. */
const documentedAdvisories: readonly string[] = [
  ...new Set(securityPolicy.slice(securityPolicy.indexOf('## Accepted advisories'))
    .match(advisoryPattern) ?? []),
].sort();

/**
 * Packages the root manifest pins past the range something in the closure
 * declares for them — both spellings, because bun honours both.
 */
const overriddenPackages: readonly string[] = [
  ...new Set([
    ...Object.keys(rootManifest.overrides ?? {}),
    ...Object.keys(rootManifest.resolutions ?? {}),
  ]),
].sort();

/** The heading a dependency override has to be written up under. */
const OVERRIDE_SECTION_HEADING = '## Dependency overrides';

/**
 * Package names written in backticks under that heading. Absent heading and
 * all today — the manifest carries no override, which is the state this keeps
 * from changing quietly rather than a state it forbids.
 */
function documentedOverrides(): readonly string[] {
  const start = securityPolicy.indexOf(OVERRIDE_SECTION_HEADING);
  if (start < 0) return [];
  const rest = securityPolicy.slice(start + OVERRIDE_SECTION_HEADING.length);
  const nextHeading = rest.indexOf('\n## ');
  const section = nextHeading < 0 ? rest : rest.slice(0, nextHeading);
  return [...new Set([...section.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? ''))].sort();
}

describe('security policy', () => {
  test('SECURITY.md exists and names a reporting channel', () => {
    // Guards the guard: an empty or stub file would satisfy "exists" while
    // leaving a reporter with nowhere to go, which is the state #539 found.
    expect(securityPolicy.length).toBeGreaterThan(2000);
    expect(
      securityPolicy,
      'SECURITY.md must name the private reporting channel explicitly — a '
      + 'policy that says "report responsibly" and stops there is what the '
      + 'issue template already did.',
    ).toContain('Report a vulnerability');
    expect(securityPolicy).toContain('## Supported versions');
    expect(securityPolicy).toContain('## Scope');
  });

  /**
   * The scope boundary is the project-specific half of this policy and the
   * half a generic template would omit: the cluster transport ships as plain
   * TCP without peer authentication on purpose, so a report of that default is
   * not a vulnerability — while a documented mitigation that fails to deliver
   * (#565) is. Without that sentence written down, both sides get triaged
   * wrong.
   */
  test('SECURITY.md states the cluster-transport scope boundary', () => {
    expect(securityPolicy).toContain('### Out of scope');
    expect(securityPolicy).toContain('### In scope');
    expect(
      securityPolicy,
      'The out-of-scope section must name the plaintext, unauthenticated '
      + 'cluster-transport default explicitly — it is the one boundary a '
      + 'reporter cannot infer from the code.',
    ).toContain('plain TCP with no peer');
  });

  /**
   * A policy nobody can find is not a policy.  GitHub surfaces SECURITY.md on
   * its own tab, but the README is where a reader who arrives from npm or a
   * search result actually lands, and that reader has no reason to guess the
   * file exists.
   */
  test('README.md points at SECURITY.md', () => {
    const readme = readFileSync(join(REPOSITORY_ROOT, 'README.md'), 'utf8');
    expect(
      readme,
      'README.md must link SECURITY.md so a reporter arriving from npm or a '
      + 'search result finds the reporting channel without knowing to look '
      + 'for the file.',
    ).toContain('SECURITY.md');
  });

  test('the security issue template points at SECURITY.md without a hedge', () => {
    expect(securityTemplate).toContain('SECURITY.md');
    expect(
      templateProse,
      'The template still hedges with "(or, if absent, contact the maintainer '
      + 'privately)". SECURITY.md exists now, and the hedge named no channel — '
      + 'it is the sentence that sent reporters nowhere.',
    ).not.toMatch(/if,?\s*absent/i);
  });

  test('the audit gate is still a gate', () => {
    // Guards the guard: if the script is renamed or its level relaxed, the
    // bijection below would compare two empty sets and pass.
    expect(auditScript).toContain('bun audit');
    expect(
      auditScript,
      'lint:audit must stay at --audit-level=high. Lowering it to critical '
      + 'would make the suppression list below meaningless and stop the gate '
      + 'catching the severity band the closure actually carries.',
    ).toContain('--audit-level=high');
  });

  test('every suppressed advisory is documented in SECURITY.md', () => {
    expect(
      documentedAdvisories,
      'The "Accepted advisories" table in SECURITY.md and the --ignore list in '
      + 'the lint:audit script have drifted apart. An advisory silenced in the '
      + 'script but missing from the table is a gate that stopped gating '
      + 'without saying so; an advisory left in the table after its suppression '
      + 'was dropped is a policy claiming risk the project no longer carries. '
      + 'Both halves move together — see #779, which removes them.',
    ).toEqual([...suppressedAdvisories]);
  });

  /**
   * The `--ignore` list is not the only way to make `bun audit` go quiet, and
   * the other way leaves no trace at all.
   *
   * An `overrides` (npm) or `resolutions` (yarn) entry in the root manifest
   * pins a transitive dependency past the range its parent declares, and what
   * lands in `bun.lock` is what `bun audit` reads. Both spellings work —
   * measured on bun 1.4.0 against a throwaway manifest declaring
   * `adm-zip: ~0.5.10`, which resolves to 0.5.18 on its own and to 0.6.0 under
   * either field. So an override can lift a package over the version that
   * fixes an advisory, and `lint:audit` goes green with no flag added and no
   * row here.
   *
   * That route is live and has a name. #676 needed `cassandra-driver` installed
   * somewhere to check the structural stub in
   * `src/persistence/journals/CassandraClient.ts` against the real module, and
   * it cannot be a root devDependency: the driver's newest release hard-pins
   * `adm-zip: ~0.5.10`, and GHSA-xcpc-8h2w-3j85 (high) is fixed only in 0.6.0.
   * Pinning `adm-zip` here would have cleared the gate in one line.
   *
   * It would also be the worst of the available answers, which is why this is
   * a bijection and not a ban. npm-style overrides apply only while this
   * package is the root project — a consumer who installs `actor-ts` and the
   * Cassandra backend resolves the vulnerable range again — so the override
   * would move the advisory out of *our* audit while leaving it in *their*
   * install. A suppression at least says so out loud, in a table someone
   * reviews. An override says nothing.
   *
   * So neither was taken. The driver went into
   * `tests/integration/brokers/package.json`, whose packages are absent from
   * the root `node_modules` by design, and the stub is checked against a live
   * cluster in `tests/integration/brokers/cassandra/`. The advisory did not
   * move out of view: it was never in the root closure to begin with, and a
   * consumer who installs the Cassandra backend still resolves it — which an
   * override would have hidden from us while changing nothing for them.
   *
   * Hence: overrides are allowed, in the light. Whoever adds the first one
   * writes the section this looks for and states what it pins and why, the
   * same discipline the advisory table above already enforces.
   */
  test('no dependency override silences the audit without a SECURITY.md entry', () => {
    // Guards the guard: every assertion here filters a list read out of the
    // root manifest, and a manifest that failed to parse into the shape above
    // would report no overrides for the same reason it would report none if
    // there genuinely were none.
    expect(
      Object.keys(rootManifest.peerDependencies ?? {}).length,
      'The root package.json did not parse into the expected shape — the '
      + 'override scan below read `undefined` and reported nothing, which is '
      + 'indistinguishable from a clean manifest.',
    ).toBeGreaterThan(20);
    const undocumented = overriddenPackages.filter(
      (name) => !documentedOverrides().includes(name),
    );
    expect(
      undocumented,
      'These packages are pinned by an `overrides` / `resolutions` entry in the '
      + 'root package.json but are not written up under a '
      + `"${OVERRIDE_SECTION_HEADING}" heading in SECURITY.md. An override `
      + 'rewrites the closure `bun audit` reads, so it can lift a dependency '
      + 'past the version that fixes an advisory and turn `lint:audit` green '
      + 'with no --ignore flag and no row in the table above — a suppression '
      + 'with no paper trail. It is also weaker than it looks for a library: '
      + 'overrides apply only while this package is the root project, so a '
      + 'consumer installing actor-ts resolves the original range again. Add '
      + 'the section, name the package, and say what it pins and why (#676).',
    ).toEqual([]);
  });
});
