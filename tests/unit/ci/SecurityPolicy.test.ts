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

const DOCUMENTATION_ROOT = join(REPOSITORY_ROOT, 'docs', 'src', 'content', 'docs');

const SUPPLY_CHAIN_PATH = join('operations', 'security', 'supply-chain.mdx');

/**
 * Every place that states, in prose, how many advisories are suppressed —
 * with the sentence each one makes.
 *
 * Markdown wraps, and `SECURITY.md` wraps this claim in the middle of its own
 * bold span, so the sentences are matched against whitespace-collapsed text
 * rather than against a line.
 */
const EMPTINESS_CLAIMS: ReadonlyArray<readonly [string, string]> = [
  ['SECURITY.md', '**there are no accepted ones**'],
  [join('docs', SUPPLY_CHAIN_PATH), 'Nothing is suppressed.'],
  [join('docs', 'de', SUPPLY_CHAIN_PATH), 'Es ist nichts unterdrückt.'],
];

const collapsed = (text: string): string => text.replace(/\s+/g, ' ');

const claimSources: ReadonlyArray<readonly [string, string]> = [
  ['SECURITY.md', collapsed(securityPolicy)],
  [
    join('docs', SUPPLY_CHAIN_PATH),
    collapsed(readFileSync(join(DOCUMENTATION_ROOT, SUPPLY_CHAIN_PATH), 'utf8')),
  ],
  [
    join('docs', 'de', SUPPLY_CHAIN_PATH),
    collapsed(readFileSync(join(DOCUMENTATION_ROOT, 'de', SUPPLY_CHAIN_PATH), 'utf8')),
  ],
];

const packageHealthWorkflow = readFileSync(
  join(REPOSITORY_ROOT, '.github', 'workflows', 'package-health.yml'),
  'utf8',
);

const lockfile = readFileSync(join(REPOSITORY_ROOT, 'bun.lock'), 'utf8');

/** The version `bun.lock` resolves a top-level package to, or `undefined`. */
function resolvedVersion(name: string): string | undefined {
  return new RegExp(`"${name}": \\["${name}@([^"]+)"`).exec(lockfile)?.[1];
}

/**
 * The `#539 — the advisory gate` comment block, on its own. Scoping the
 * assertions below to it keeps them about that paragraph rather than about the
 * file, and keeps a failure readable — a `toContain` over the whole workflow
 * prints the whole workflow.
 */
const AUDIT_COMMENT_OPENING = '# #539 — the advisory gate.';

const auditGateComment: string = (() => {
  const start = packageHealthWorkflow.indexOf(AUDIT_COMMENT_OPENING);
  if (start < 0) return '';
  const rest = packageHealthWorkflow.slice(start);
  const end = rest.indexOf('- name:');
  return end < 0 ? rest : rest.slice(0, end);
})();

type RootManifest = {
  scripts?: Record<string, string | undefined>;
  dependencies?: Record<string, string>;
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
   * The bijection above is a *shape* claim — the table and the flags list the
   * same IDs — and three sentences make a *count* claim on top of it: that the
   * list is empty.  A suppression added back together with its table row
   * satisfies the bijection perfectly and leaves all three sentences false,
   * which was measured (#779, #781).
   *
   * That is the worse of the two failures.  A drifted table is a page that
   * under-reports one advisory; a false "nothing is suppressed" is a page that
   * tells a reader not to go looking, and it is the sentence someone
   * evaluating this project for adoption actually reads.
   *
   * Stated in both directions on purpose.  The claim must go when the first
   * suppression lands, and it must come back when the last one is removed —
   * a page that hedges forever, after the list is empty again, is the same
   * defect pointing the other way, and hedging is what a page drifts towards
   * when only one direction is enforced.
   */
  test('the pages that say nothing is suppressed only say it while nothing is', () => {
    // Guards the guard: a renamed file or a rewritten paragraph would leave
    // the loop below comparing against text that no longer contains the
    // sentence in any form, which reads as "the claim is correctly absent".
    for (const [file, source] of claimSources) {
      expect(source.length, `${file} read back empty`).toBeGreaterThan(1_000);
    }

    const expectedToClaimEmptiness = suppressedAdvisories.length === 0;
    for (const [file, sentence] of EMPTINESS_CLAIMS) {
      const source = claimSources.find(([name]) => name === file)?.[1] ?? '';
      expect(
        source.includes(sentence),
        expectedToClaimEmptiness
          ? `${file} no longer says ${JSON.stringify(sentence)}, but lint:audit `
            + 'suppresses nothing. The sentence is what tells a reader there is '
            + 'no accepted-risk list to go looking for; restore it, or change '
            + 'this test on purpose.'
          : `${file} still says ${JSON.stringify(sentence)}, and lint:audit now `
            + `suppresses ${suppressedAdvisories.join(', ')}. The bijection above `
            + 'is satisfied by adding a table row, so nothing else notices that '
            + 'the sentence has become false. Reword it in every language.',
      ).toBe(expectedToClaimEmptiness);
    }
  });

  /**
   * The same shape one level down: the workflow's own comment argues for
   * `bun audit` over `actions/dependency-review-action` by CONTRASTING two
   * concrete numbers — the unresolved range GitHub's dependency graph records
   * out of `package.json` against the version `bun.lock` actually pins — and
   * both numbers are hand-written into a comment beside files that move
   * without it.
   *
   * A Dependabot bump is all it takes. The comment then names versions that
   * are not in the lockfile, and the illustration stops being evidence for the
   * choice it exists to justify: the next person weighing the two tools reads
   * a worked example whose numbers they cannot reproduce, and the honest
   * conclusion from that is that the comment is stale rather than that the
   * argument is wrong. Nothing else opens this file — YAML is invisible to the
   * type checker, and `WorkflowHygiene` reads workflows for pinned actions and
   * permissions, not for prose.
   *
   * The range is asserted to still BE a range, because that is the half the
   * contrast rests on. A pinned `fastify` in `package.json` would make the
   * graph record the shipped version too, and the paragraph would be arguing
   * from a difference that no longer exists (#779, #781).
   *
   * The range is quoted in three places — the comment and both documentation
   * mirrors — and all three are checked, because the point of writing a number
   * down in three languages is lost the moment one of them is a different
   * number.
   */
  test('every place that quotes the fastify range and pins quotes what the files carry', () => {
    // Guards the guard: every assertion below is a `toContain` over one comment
    // block, and a block that failed to slice out would satisfy none of them
    // for a reason worth telling apart from a drifted number.
    expect(
      auditGateComment.length,
      `No ${JSON.stringify(AUDIT_COMMENT_OPENING)} comment found in `
      + '.github/workflows/package-health.yml — the paragraph was renamed or '
      + 'removed, so the assertions below are reading an empty string.',
    ).toBeGreaterThan(500);

    const declaredFastifyRange = rootManifest.dependencies?.['fastify'] ?? '';
    expect(
      declaredFastifyRange,
      'package.json no longer declares `fastify` as a caret range. The comment '
      + 'contrasts the range the dependency graph records with the version the '
      + 'lockfile pins; a pinned manifest makes those the same string and the '
      + 'argument has to be rewritten rather than re-numbered.',
    ).toMatch(/^\^/);

    for (const name of ['fastify', 'find-my-way'] as const) {
      expect(
        resolvedVersion(name),
        `bun.lock no longer resolves a top-level \`${name}\`, so the comment's `
        + 'illustration cannot be checked against it.',
      ).toBeDefined();
    }

    // The range is quoted three times over — once in the comment and once in
    // each documentation mirror, all three making the same argument from it —
    // so all three move when the manifest does.
    const rangeQuotations: ReadonlyArray<readonly [string, string]> = [
      ['.github/workflows/package-health.yml', auditGateComment],
      ...claimSources.filter(([file]) => file !== 'SECURITY.md'),
    ];
    for (const [file, source] of rangeQuotations) {
      expect(
        source,
        `${file} quotes a \`fastify\` range that package.json no longer `
        + 'declares. That number is the whole evidence for preferring `bun '
        + 'audit` over `actions/dependency-review-action` — it is what the '
        + 'dependency graph records instead of the shipped version — so it '
        + 'moves with the manifest, in every language.',
      ).toContain(`\`fastify ${declaredFastifyRange}\``);
    }

    expect(
      auditGateComment,
      'The `bun audit` comment in package-health.yml quotes lockfile versions '
      + 'that bun.lock no longer pins — a Dependabot bump moves the lockfile '
      + 'and leaves the comment behind, and a worked example whose numbers do '
      + 'not reproduce reads as a stale argument. Re-quote the current pins.',
    ).toContain(
      `bun.lock pins fastify@${resolvedVersion('fastify')} `
      + `and find-my-way@${resolvedVersion('find-my-way')}`,
    );
  });

  /**
   * And the documentation half of the same paragraph, in both languages.
   *
   * The supply-chain page tells a reader three things they can act on: which
   * workflow runs the gate, that `bun run lint:audit` is *exactly* what CI
   * runs, and that it also runs weekly on a clock. Each is a claim about a
   * file, and each fails differently when it rots — a renamed workflow sends
   * the reader nowhere, a CI step that stopped going through the `lint:audit`
   * script makes the local command a different check wearing the same name,
   * and a dropped `schedule:` silently turns the gate back into a push-only
   * one while the page still promises the cron that catches an advisory
   * published against an unchanged lockfile.
   *
   * That last one is the reason the cron is asserted as a SHAPE rather than as
   * a string: "weekly" means a pinned day-of-week and an unpinned day-of-month,
   * so a cron edited to monthly or to daily fails here while the offset the
   * comment explains — Mondays 05:00 UTC, away from the Dependabot window —
   * stays free to move.
   */
  test('both supply-chain mirrors describe the advisory gate the workflow actually runs', () => {
    const WORKFLOW_PATH = '.github/workflows/package-health.yml';
    const LOCAL_COMMAND = 'bun run lint:audit';

    expect(
      packageHealthWorkflow,
      `Both supply-chain pages promise that \`${LOCAL_COMMAND}\` is exactly `
      + 'what CI runs. The workflow no longer runs it, so the local command is '
      + 'a different check with the same name.',
    ).toContain(`run: ${LOCAL_COMMAND}`);

    const cron = /cron:\s*'([^']+)'/.exec(packageHealthWorkflow)?.[1]?.split(/\s+/) ?? [];
    expect(
      cron.length,
      'package-health.yml has no `schedule:` cron. Both pages say the gate '
      + 'also runs weekly, and that clock is the only thing that catches an '
      + 'advisory published upstream against a lockfile that did not change — '
      + 'a push-only gate would not notice until the next unrelated commit.',
    ).toBe(5);
    const NOT_WEEKLY = 'The `schedule:` cron in package-health.yml is no longer '
      + 'weekly — both pages say it is. Weekly is a pinned day-of-week with an '
      + 'unpinned day-of-month; anything else is a different promise and both '
      + 'mirrors have to be reworded together.';
    expect(cron[4], NOT_WEEKLY).not.toBe('*');
    expect(cron[2], NOT_WEEKLY).toBe('*');

    for (const [file, source] of claimSources) {
      if (file === 'SECURITY.md') continue;
      expect(source, `${file} no longer names the workflow that runs the gate.`)
        .toContain(WORKFLOW_PATH);
      expect(
        source,
        `${file} no longer names \`${LOCAL_COMMAND}\` as the command a reader `
        + 'can run, which is what makes the gate reproducible off CI.',
      ).toContain(LOCAL_COMMAND);
      expect(
        source,
        `${file} no longer quotes the audit level the script enforces. A page `
        + 'that names a lower one than `lint:audit` uses tells a reader the '
        + 'gate is stricter or laxer than it is.',
      ).toContain('--audit-level=high');
    }
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
