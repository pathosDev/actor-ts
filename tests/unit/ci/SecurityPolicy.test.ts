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
 * Two things are worth a test here rather than a convention.
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
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');

const securityPolicy = readFileSync(join(REPOSITORY_ROOT, 'SECURITY.md'), 'utf8');

const securityTemplate = readFileSync(
  join(REPOSITORY_ROOT, '.github', 'ISSUE_TEMPLATE', 'security_report.yml'),
  'utf8',
);

const auditScript: string = (
  JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string | undefined>;
  }
).scripts['lint:audit'] ?? '';

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
});
