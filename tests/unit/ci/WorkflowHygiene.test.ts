import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * Repo-wide invariants over `.github/workflows/` that no other gate can see.
 *
 * Workflow YAML is invisible to `bun run typecheck` and to every other check
 * the project runs, so a hardening decision made once decays the first time
 * someone edits a file without knowing about it — and the only feedback is a
 * red release, months later. These assertions run under plain `bun test`,
 * exactly like the other repo-file guards (`tests/unit/config/NoDeadConfigKeys.test.ts`,
 * `tests/unit/TreeShaking.test.ts`).
 *
 * Deliberately regex-based rather than YAML-parsed: the repository has no
 * YAML dependency, and adding one to assert three line-shaped properties
 * would cost more than it protects. Each parser below is written to fail
 * loudly (and the "guards the guard" tests below reject a vacuous pass)
 * rather than to be generally correct for arbitrary YAML.
 */

const WORKFLOW_DIRECTORY = join(import.meta.dir, '..', '..', '..', '.github', 'workflows');

type WorkflowFile = {
  readonly name: string;
  readonly lines: readonly string[];
};

/**
 * Split on `\r?\n`, not on `\n`.  These files are read from the working tree,
 * so their line endings are whatever the checkout produced — CRLF on a Windows
 * clone under the repository's `text` attribute, LF on the CI runner.  A
 * trailing `\r` is invisible in every assertion below except the ones anchored
 * with `$`, and `.` does not match `\r` in JavaScript (it is a line
 * terminator), so `uses: x@sha # v1.2.3\r` silently matched nothing and every
 * pin assertion passed vacuously — on Linux CI it would have stayed green
 * forever while being red for anyone developing on Windows.
 */
const workflows: readonly WorkflowFile[] = readdirSync(WORKFLOW_DIRECTORY)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .map((name) => ({
    name,
    lines: readFileSync(join(WORKFLOW_DIRECTORY, name), 'utf8').split(/\r?\n/),
  }));

type ActionReference = {
  readonly workflow: string;
  readonly line: number;
  /** Everything after `uses:` and before the trailing comment. */
  readonly reference: string;
  /** The trailing `# …` comment, or `''` when there is none. */
  readonly comment: string;
};

/**
 * `uses:` lines, as a step key — `- uses: x` or `uses: x`, optionally with a
 * trailing comment. A value that carries neither `/` nor `@` is not an action
 * reference (a local `./path` action, a `docker://` image) and is skipped; the
 * repository uses none of those today, so nothing is silently excused.
 */
function actionReferences({ name, lines }: WorkflowFile): ActionReference[] {
  const out: ActionReference[] = [];
  lines.forEach((line, index) => {
    const match = /^\s*(?:- )?uses:\s*(\S+)\s*(#.*)?$/.exec(line);
    if (!match) return;
    const reference = match[1];
    if (!reference.includes('/') || !reference.includes('@')) return;
    out.push({ workflow: name, line: index + 1, reference, comment: match[2] ?? '' });
  });
  return out;
}

const references = workflows.flatMap(actionReferences);

/**
 * `.github/dependabot.yml` — for the one property of a pin that no workflow
 * file can express: whether the bumps Dependabot will open are *mergeable*.
 */
const DEPENDABOT_FILE = join(import.meta.dir, '..', '..', '..', '.github', 'dependabot.yml');

const dependabotLines: readonly string[] = readFileSync(DEPENDABOT_FILE, 'utf8').split(/\r?\n/);

/** One `- package-ecosystem: "<name>"` entry, up to the next entry or EOF. */
function ecosystemBlock(ecosystem: string): readonly string[] {
  const marker = `- package-ecosystem: "${ecosystem}"`;
  const start = dependabotLines.findIndex((line) => line.trim() === marker);
  if (start < 0) return [];
  const rest = dependabotLines.slice(start + 1);
  const end = rest.findIndex((line) => /^\s*-\s*package-ecosystem:/.test(line));
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * Every `patterns:` entry of every group in a `groups:` block.  Same
 * regex-over-YAML trade-off as the workflow parsers above: a list item counts
 * only while `patterns:` is the nearest preceding key, so a sibling
 * `update-types:` list is not mistaken for one.
 */
function groupPatterns(block: readonly string[]): string[] {
  const start = block.findIndex((line) => /^\s*groups:\s*$/.test(line));
  if (start < 0) return [];
  const groupsIndent = /^\s*/.exec(block[start]!)![0].length;
  const out: string[] = [];
  let inPatterns = false;
  for (const line of block.slice(start + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (/^\s*/.exec(line)![0].length <= groupsIndent) break; // the `groups:` block ended
    const item = /^\s*-\s*"?([^"#]+?)"?\s*$/.exec(line);
    if (inPatterns && item) out.push(item[1]!);
    else inPatterns = /^\s*patterns:\s*$/.test(line);
  }
  return out;
}

const actionGroupPatterns = groupPatterns(ecosystemBlock('github-actions'));

/**
 * A Dependabot group pattern — `*` is its only wildcard.  Matched by walking
 * the literal segments in order rather than by compiling a RegExp: a pattern
 * is repository configuration, and turning one into a regex would let a `.`
 * or a `+` inside it quietly widen what the group is asserted to cover.
 */
const matchesPattern = (pattern: string, dependency: string): boolean => {
  const segments = pattern.split('*');
  const first = segments[0] ?? '';
  const last = segments[segments.length - 1] ?? '';
  if (segments.length === 1) return dependency === first;
  if (!dependency.startsWith(first) || !dependency.endsWith(last)) return false;
  let index = first.length;
  for (const segment of segments.slice(1, -1)) {
    const found = dependency.indexOf(segment, index);
    if (found < 0) return false;
    index = found + segment.length;
  }
  return index <= dependency.length - last.length;
};

type CoupledAction = {
  /** `owner/repo` — the action whose sub-paths have to move together. */
  readonly action: string;
  /** The distinct dependency names Dependabot sees, one per sub-path. */
  readonly paths: readonly string[];
};

/**
 * Actions reached through more than one sub-path — exactly the ones Dependabot
 * splits across PRs, because it reads every `uses:` path as its own dependency.
 */
const coupledActions: readonly CoupledAction[] = (() => {
  const byAction = new Map<string, Set<string>>();
  for (const { reference } of references) {
    const dependency = reference.split('@')[0] ?? '';
    if (dependency.split('/').length <= 2) continue; // no sub-path, nothing to split
    const action = dependency.split('/').slice(0, 2).join('/');
    const paths = byAction.get(action) ?? new Set<string>();
    byAction.set(action, paths.add(dependency));
  }
  return [...byAction]
    .map(([action, paths]) => ({ action, paths: [...paths].sort() }))
    .filter(({ paths }) => paths.length > 1);
})();

type WorkflowJob = {
  readonly workflow: string;
  readonly name: string;
  readonly lines: readonly string[];
};

/**
 * The `jobs:` mapping split into its two-space-indented entries. Everything
 * between one job key and the next belongs to that job — enough to ask which
 * scopes a job grants itself and what it runs, without a YAML parser.
 */
function jobsOf(file: WorkflowFile): WorkflowJob[] {
  const start = file.lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (start < 0) return [];
  const out: { workflow: string; name: string; lines: string[] }[] = [];
  for (const line of file.lines.slice(start + 1)) {
    if (/^[A-Za-z0-9_-]+:/.test(line)) break; // a new top-level key ends `jobs:`
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) out.push({ workflow: file.name, name: header[1] ?? '', lines: [] });
    else out[out.length - 1]?.lines.push(line);
  }
  return out;
}

const jobs = workflows.flatMap(jobsOf);

/** `scope: value` pairs of the workflow-level (column 0) `permissions:` block. */
function workflowLevelScopes({ lines }: WorkflowFile): string[] {
  const start = lines.findIndex((line) => /^permissions:\s*$/.test(line));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!/^ {2}\S/.test(line)) break;
    out.push(line.trim());
  }
  return out;
}

type InstallStep = {
  readonly workflow: string;
  readonly line: number;
  readonly command: string;
};

/** `bun install …` invocations, as a `run:` value or inside a block scalar. */
function installSteps({ name, lines }: WorkflowFile): InstallStep[] {
  const out: InstallStep[] = [];
  lines.forEach((line, index) => {
    const match = /^\s*(?:- )?run:\s*(bun install\b.*)$/.exec(line)
      ?? /^\s*(bun install\b.*)$/.exec(line);
    if (!match) return;
    out.push({ workflow: name, line: index + 1, command: (match[1] ?? '').trim() });
  });
  return out;
}

const installs = workflows.flatMap(installSteps);

type ArtifactUpload = {
  readonly workflow: string;
  readonly line: number;
  /** Every entry of `path:`, whether a scalar or a block-scalar list. */
  readonly paths: readonly string[];
  /** The step's `with:` mapping, flattened to `key -> value`. */
  readonly inputs: Readonly<Record<string, string>>;
};

/** How deep the *keys* of a step sit — the same column whether or not `- ` leads. */
const keyIndentOf = (line: string): number => /^[\s-]*/.exec(line)![0].length;

/**
 * `actions/upload-artifact` steps with their `with:` inputs.
 *
 * A step's keys all sit at one indentation, and its `with:` entries one level
 * deeper, so "the lines belonging to this step" is every following line
 * indented at least as far as the `uses:` key. That is enough to read the three
 * inputs the assertions below care about without a YAML parser — the same
 * trade-off the rest of this file makes, and the "guards the guard" test
 * rejects a parser that silently found nothing.
 */
function artifactUploads({ name, lines }: WorkflowFile): ArtifactUpload[] {
  const out: ArtifactUpload[] = [];
  lines.forEach((line, index) => {
    if (!/^\s*(?:- )?uses:\s*actions\/upload-artifact@/.test(line)) return;
    const keyIndent = keyIndentOf(line);
    const inputs: Record<string, string> = {};
    const paths: string[] = [];
    let inPathBlock = false;
    for (const following of lines.slice(index + 1)) {
      if (following.trim() === '') continue;
      const indent = /^\s*/.exec(following)![0].length;
      if (indent < keyIndent) break; // the step ended
      const entry = /^\s*([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(following);
      if (entry === null) {
        // A block scalar's payload line, which is only ever a path here.
        if (inPathBlock) paths.push(following.trim());
        continue;
      }
      inPathBlock = false;
      const [, key, value] = entry;
      if (key === undefined) continue;
      if (indent > keyIndent) inputs[key] = value ?? '';
      if (key !== 'path') continue;
      if (value === '' || value === '|' || value === '>' || value === '|-') inPathBlock = true;
      else paths.push(value!);
    }
    out.push({ workflow: name, line: index + 1, paths, inputs });
  });
  return out;
}

const uploads = workflows.flatMap(artifactUploads);

/**
 * A path with a dot-prefixed segment in it. `.` and `..` are navigation, not
 * hidden names, so they do not count — `./dist` is an ordinary path.
 */
const isHiddenPath = (path: string): boolean =>
  path
    .replaceAll('\\', '/')
    .split('/')
    .some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..');

/** Anything that fetches and executes somebody else's code on the runner. */
const INSTALL_COMMAND = /\b(bun install|bunx|npm ci|npm install|npx|pnpm install|yarn install)\b/;

const declaresPermissions = (file: WorkflowFile): boolean =>
  file.lines.some((line) => /^permissions:/.test(line))
  || jobsOf(file).every((job) => job.lines.some((line) => /^\s+permissions:/.test(line)));

/**
 * `test.yml` alone maintains the README badges, so the two assertions below are
 * scoped to it by name — a repo-wide version would match nothing in the other
 * ten workflows and would need a permanent exemption list to say so.
 */
const badgeWorkflowLines: readonly string[] =
  workflows.find((workflow) => workflow.name === 'test.yml')?.lines ?? [];

/** Executable lines — the comments below quote the very shapes being banned. */
const badgeStatements: readonly { readonly text: string; readonly line: number }[] =
  badgeWorkflowLines
    .map((line, index) => ({ text: line.trim(), line: index + 1 }))
    .filter(({ text }) => text !== '' && !text.startsWith('#'));

/** The counts and percentages the README badges are rendered from. */
const BADGE_STATISTIC = 'PASS|TOTAL|FAIL|FAILURES|TESTS|SKIPPED|LINES|LINES_INT';

/**
 * Shell that turns "the parser found nothing" into a number — `PASS=${PASS:-0}`
 * and `[[ -z "$PASS" ]] && PASS=0`.
 */
const ZERO_DEFAULTS: readonly RegExp[] = [
  new RegExp(`\\$\\{(?:${BADGE_STATISTIC})(?::-|:=)0\\}`),
  new RegExp(`-z\\s+"?\\$(?:${BADGE_STATISTIC})"?\\s*\\]\\]\\s*&&\\s*(?:${BADGE_STATISTIC})=0`),
];

/** A `grep` anchored on bun's human-readable ` N pass` / ` N fail` summary. */
const CONSOLE_SCRAPE = /grep\b[^|]*\b(?:pass|fail)\\?\$/;

/**
 * `OUTPUT=$(bun test …)` and its backtick spelling — bun's output via a pipe.
 *
 * `scripts/coverage-gate.mjs` counts too, and not out of caution: called
 * without `--log`/`--lcov` it runs `bun test --coverage` itself and replays
 * every line of the output, so capturing *that* through a command substitution
 * recreates #1194 exactly — through a command name the original pattern never
 * mentioned. #541 gave the workflow a reason to invoke the script, so the
 * pattern had to learn its name before the invocation arrived.
 */
const PIPED_TEST_RUN = /(?:\$\(|`)\s*bun\s+(?:run\s+)?(?:test\b|scripts\/coverage-gate\.mjs)/;

describe('workflow hygiene', () => {
  test('the workflow directory actually parsed', () => {
    // Guards the guard: a path or parser regression that yielded nothing
    // would make every assertion below vacuously pass.
    expect(workflows.map((workflow) => workflow.name)).toContain('publish.yml');
    expect(workflows.length).toBeGreaterThanOrEqual(12);
    expect(references.length).toBeGreaterThanOrEqual(30);
    expect(jobs.length).toBeGreaterThanOrEqual(workflows.length);
    expect(jobs.map((job) => `${job.workflow}#${job.name}`)).toContain('docs.yml#deploy');
    expect(badgeStatements.length).toBeGreaterThan(0);
    // The upload parser has to have read both halves of a step, or the two
    // artifact assertions below hold over an empty list.
    expect(uploads.length).toBeGreaterThanOrEqual(3);
    expect(uploads.every((upload) => upload.paths.length > 0)).toBe(true);
    expect(uploads.some((upload) => upload.paths.some(isHiddenPath))).toBe(true);
    expect(uploads.some((upload) => upload.paths.every((path) => !isHiddenPath(path)))).toBe(true);
    // The dependabot parser has to have found the ecosystem, its patterns and
    // the coupling they cover, or the grouping assertion below has no subject.
    expect(dependabotLines.length).toBeGreaterThan(10);
    expect(actionGroupPatterns.length).toBeGreaterThan(0);
    expect(coupledActions.map(({ action }) => action)).toContain('github/codeql-action');
  });

  /**
   * #290 — `actions/upload-artifact` has defaulted `include-hidden-files` to
   * false since v4.4, and `nightly-flakes.yml` uploads `.stress/`. So the
   * nightly that exists to measure the quarantined suites uploaded **nothing**,
   * twice, on both jobs: `No files were found with the provided path: .stress/`,
   * and `total_count: 0` from the artifacts API for both runs. Meanwhile that
   * workflow's own header, `docs/…/testing/diagnosing-flakes.mdx` and
   * `.gitignore` all describe the artifact as the only durable evidence of the
   * fourteen-night un-quarantine criterion, because both jobs are
   * `continue-on-error` and the job conclusion is therefore always `success`.
   *
   * The path is the thing that decides it, so the path is what this reads:
   * anything with a dot-prefixed segment needs the flag, and a future
   * `path: .coverage/` gets the same treatment without anyone remembering why.
   */
  test.each(uploads.filter((upload) => upload.paths.some(isHiddenPath)))(
    '$workflow:$line uploads a hidden path and asks for hidden files',
    ({ paths, inputs }) => {
      expect(
        inputs['include-hidden-files'],
        `The step uploads ${paths.filter(isHiddenPath).join(', ')}, whose leading dot makes it `
        + 'invisible to upload-artifact\'s default glob (include-hidden-files is false since '
        + 'v4.4). Set "include-hidden-files: true", or move the report directory to a '
        + 'non-hidden path. Two nights of nightly-flakes uploaded zero files this way.',
      ).toBe('true');
    },
  );

  /**
   * The other half, and the reason the first went unnoticed for two nights:
   * `if-no-files-found: warn` writes a `::warning::` into a log nobody opens
   * for a job that is `continue-on-error` and therefore always reports success.
   * An upload that kept nothing has to be a red step — `publish.yml`'s SBOM
   * upload has always done it this way.
   */
  test.each(uploads)(
    '$workflow:$line fails rather than warns when it uploads nothing',
    ({ inputs }) => {
      expect(
        inputs['if-no-files-found'],
        'An upload-artifact step that matches no file must fail the step. With the default '
        + '("warn") an artifact that was never produced is a log line, and every statement '
        + 'that treats the artifact as evidence becomes false without anything going red.',
      ).toBe('error');
    },
  );

  /**
   * #1194 — the badge counts used to be scraped out of bun's console summary
   * (`grep -E "^[[:space:]]+[0-9]+ pass$"`). bun 1.3.14 stopped printing that
   * block under GitHub Actions, the grep matched nothing, and because the job
   * pins `bun-version: latest` the change arrived without a commit to blame.
   *
   * The JUnit report is a contract that survives a reporter's cosmetic
   * changes; the rendered console output never was one. Asserting the negative
   * too, because the scrape is the tempting thing to reach for again — it
   * needs no extra flag and looks like it works right up until it doesn't.
   */
  test('test.yml reads the badge counts from a machine-readable report', () => {
    expect(
      badgeWorkflowLines.join('\n'),
      'The README badge counts must come from a JUnit report '
      + '(--reporter=junit --reporter-outfile=…), whose <testsuites tests/failures/'
      + 'skipped> attributes are stable across bun releases.',
    ).toContain('--reporter=junit');

    const scrapes = badgeStatements.filter(({ text }) => CONSOLE_SCRAPE.test(text));
    expect(
      scrapes,
      'A grep anchored on bun\'s " N pass" / " N fail" console summary is back in '
      + 'test.yml. That output is presentation, not an interface — it already '
      + 'disappeared once under GitHub Actions (#1194). Parse the JUnit report.',
    ).toEqual([]);
  });

  /**
   * #1194 — under GitHub Actions bun emits an annotation line per test, so
   * this suite writes roughly 8700 lines. Capturing that with
   * `OUTPUT=$(bun test …)` sends the whole burst through a command
   * substitution pipe, and bun died mid-flush with `An internal error
   * occurred (WriteFailed)`: the coverage table was truncated three-quarters
   * in and the JUnit report never landed (oven-sh/bun#15860 is the same
   * family — large suites, intermittent).
   *
   * The same command reproduces clean locally, where bun prints no per-test
   * lines and the burst is eight times smaller, so it is the volume through
   * the pipe rather than the flags. Redirect to a file and read it back; a
   * regular file cannot short-write the way a pipe can.
   */
  test('test.yml does not pipe bun test output through a command substitution', () => {
    const piped = badgeStatements.filter(({ text }) => PIPED_TEST_RUN.test(text));
    expect(
      piped,
      'bun test\'s output is being captured through a command substitution. '
      + 'Under GitHub Actions that is an ~8700-line burst down a pipe, which is '
      + 'how bun came to die with WriteFailed mid-run (#1194). Redirect it to a '
      + 'file and cat the file instead.',
    ).toEqual([]);
  });

  /**
   * #1194 — the parser breaking was survivable; defaulting its miss to `0` is
   * what published `tests-0 of 0` from an all-green run. A zero denominator is
   * indistinguishable from a real measurement, so it passed the `badge` job's
   * "did we get numbers?" guard, picked the green colour via `PASS == TOTAL`,
   * and overwrote the front page unchallenged.
   *
   * An unreadable statistic has to stay empty: the guard then skips the update
   * and the README keeps figures that were true when they were measured.
   */
  /**
   * The three assertions above are all of the form "no line matches this
   * pattern", and every one of them passes when the pattern has quietly
   * stopped matching anything at all. That is not a theoretical decay: the
   * badge statistics that `ZERO_DEFAULTS` names were shell variables in
   * `test.yml` until #541 moved the coverage half into
   * `scripts/coverage-gate.mjs`, and a refactor that moved the rest would make
   * the ban vacuous while leaving it green.
   *
   * So each pattern is checked against the exact line it was written against —
   * a line that has been in this workflow's history, not an invention.
   */
  test('the badge-statement bans still match the shapes they ban', () => {
    const zeroDefault = '[[ -z "$PASS" ]] && PASS=0';
    expect(ZERO_DEFAULTS.some((pattern) => pattern.test(zeroDefault))).toBe(true);
    expect(ZERO_DEFAULTS.some((pattern) => pattern.test('LINES_INT=${LINES:-0}'))).toBe(true);

    expect(CONSOLE_SCRAPE.test('PASS=$(grep -E "^[[:space:]]+[0-9]+ pass$" "$LOG_FILE")')).toBe(true);

    expect(PIPED_TEST_RUN.test('OUTPUT=$(bun test --coverage)')).toBe(true);
    // The gate script replays the whole run when it is given no artifacts, so
    // capturing it is the same hazard under a different name.
    expect(PIPED_TEST_RUN.test('OUTPUT=$(bun scripts/coverage-gate.mjs)')).toBe(true);
    expect(PIPED_TEST_RUN.test('OUTPUT=$(bun run test:coverage:gate)')).toBe(true);
    // And the shape the workflow actually uses must not trip it, or the ban
    // would be unsatisfiable rather than protective.
    expect(PIPED_TEST_RUN.test('bun scripts/coverage-gate.mjs --log="$LOG_FILE" --lcov="$LCOV"'))
      .toBe(false);
  });

  test('test.yml never defaults an unreadable badge statistic to zero', () => {
    const offenders = badgeStatements.filter(
      ({ text }) => ZERO_DEFAULTS.some((pattern) => pattern.test(text)),
    );
    expect(
      offenders,
      'A badge statistic falls back to 0 when it cannot be parsed, which is how '
      + '"0 of 0" reached README.md from a green run (#1194). Leave it empty and '
      + 'let the badge job skip the update instead.',
    ).toEqual([]);
  });

  /**
   * #585 — a tag is a mutable pointer. Whoever can move `actions/checkout@v7`
   * runs arbitrary code inside `publish.yml`'s job, which holds
   * `id-token: write` and publishes to npm with provenance. A commit SHA
   * cannot be repointed, so every third-party action is pinned to one.
   *
   * Shape only: this cannot prove the SHA resolves to the tag it claims (that
   * needs the network, and a well-formed wrong SHA breaks every workflow at
   * once). Resolve pins with `gh api repos/<owner>/<repo>/commits/<tag>` when
   * writing them; this asserts that nobody quietly goes back to a tag.
   */
  test.each(references)(
    '$workflow:$line pins $reference to a commit SHA',
    ({ reference }) => {
      const [action, gitReference] = reference.split('@');
      expect(
        gitReference,
        `${action} is pinned to "${gitReference}", which is a mutable tag or branch. `
        + 'Pin it to the full 40-character commit SHA of the release instead '
        + '(gh api repos/<owner>/<repo>/commits/<tag> --jq .sha) — see .github/dependabot.yml.',
      ).toMatch(/^[0-9a-f]{40}$/);
    },
  );

  /**
   * The trailing comment is load-bearing, not decoration: Dependabot reads it
   * to learn which version a SHA stands for. Drop it and the pin stops being
   * updated, which leaves the repository frozen on an eventually-vulnerable
   * action — a worse posture than the mutable tags the pins replaced.
   */
  test.each(references)(
    '$workflow:$line records the version $reference is pinned to',
    ({ comment }) => {
      expect(
        comment,
        'A SHA pin needs its release tag in a trailing "# vX.Y.Z" comment, or '
        + 'Dependabot cannot tell what version it is and stops updating it.',
      ).toMatch(/^# v\d+(\.\d+)*$/);
    },
  );

  /**
   * #1348 — the two assertions above pass for a pin that cannot be merged.
   * Dependabot reads every `uses:` path as its own dependency, so an action
   * used through more than one sub-path gets one PR per path, and each of them
   * is a well-formed SHA with a well-formed version comment.
   *
   * They still cannot land one at a time. `github/codeql-action/init` writes a
   * config file stamped with its own version and `github/codeql-action/analyze`
   * refuses to read one that does not match, so each half creates the skew it
   * then fails on — `Loaded a configuration file for version '4.37.8', but
   * running version '4.37.7'` — and only the pair is green (#1346 + #1347,
   * red alone). A `groups:` pattern is what makes them arrive together.
   *
   * `github/codeql-action` is the only such action today, which is exactly why
   * this is a guard and not a comment: the next one gets added by someone with
   * no reason to have read `.github/dependabot.yml`.
   */
  test.each([...coupledActions])(
    '$action is grouped in dependabot.yml, so its sub-paths bump together',
    ({ action, paths }) => {
      expect(
        actionGroupPatterns.filter(
          (pattern) => paths.every((dependency) => matchesPattern(pattern, dependency)),
        ),
        `${action} is used through ${paths.length} sub-paths (${paths.join(', ')}), so `
        + 'Dependabot opens one PR per path and each lands on a tree that is broken '
        + 'in between. Add a pattern covering all of them to the "github-actions" '
        + 'groups: block in .github/dependabot.yml.',
      ).not.toEqual([]);
    },
  );

  /**
   * #621 — a workflow-level `permissions:` block is granted to every job in
   * the file, including the ones that install and execute third-party code.
   * That is how `docs.yml`'s build job came to hold `pages: write` +
   * `id-token: write` while its only Pages step needed neither.
   *
   * So the workflow-level block is a read-only floor and nothing more; a
   * scope that can change anything belongs on the single job that uses it.
   */
  test.each([...workflows])('$name grants no write scope at workflow level', (file) => {
    for (const scope of workflowLevelScopes(file)) {
      expect(
        scope,
        `${file.name} grants "${scope}" to every job in the file, including the `
        + 'ones that run third-party code. Move write scopes down to the job '
        + 'that needs them and leave the workflow-level block read-only.',
      ).toMatch(/:\s*(read|none)$/);
    }
  });

  /**
   * An absent `permissions:` block falls back to the repository default.
   * That default is read-only today, so this is not a live exposure — it is
   * the reason the exposure would be silent if the setting were ever flipped,
   * and new workflows keep being added without one.
   */
  test.each([...workflows])('$name states its token permissions explicitly', (file) => {
    expect(
      declaresPermissions(file),
      `${file.name} declares no permissions, so its token scope is whatever the `
      + 'repository default happens to be. Add a workflow-level '
      + '"permissions: contents: read", or declare one on every job.',
    ).toBe(true);
  });

  /**
   * #622 — an unfrozen install resolves whatever the manifest's ranges allow
   * at that moment, so a required check can pass against a dependency set no
   * lockfile records and nobody can reproduce. Every install in CI is frozen;
   * a Dependabot PR going red here means `bun.lock` needs regenerating (#817),
   * which is the signal, not a bug.
   */
  test.each(installs)('$workflow:$line installs from the lockfile', ({ command }) => {
    expect(
      command,
      `"${command}" resolves dependencies afresh instead of installing what `
      + 'bun.lock records. Add --frozen-lockfile.',
    ).toContain('--frozen-lockfile');
  });

  /**
   * #622 — a job that can write to the repository must not also be the job
   * that runs thousands of other people's postinstall scripts. test.yml used
   * to hold `contents: write` plus a persisted git credential in the job that
   * installed and executed the entire devDependency tree, purely so it could
   * push a README badge afterwards; the badge now lives in its own job that
   * installs nothing.
   *
   * Scoped to `contents: write` on purpose. publish.yml legitimately runs an
   * install next to `id-token: write` — narrowing that one is #703, and
   * asserting it here would only produce a permanent exemption entry.
   */
  test.each(jobs)('$workflow#$name keeps write access away from installs', (job) => {
    if (!job.lines.some((line) => /^\s+contents:\s*write\s*$/.test(line))) return;
    const offender = job.lines.find((line) => INSTALL_COMMAND.test(line) && !line.trim().startsWith('#'));
    expect(
      offender,
      `${job.workflow}#${job.name} grants contents: write and runs "${offender?.trim()}". `
      + 'A job holding a credential that can push to the repository must not '
      + 'execute third-party code — split the privileged step into its own job.',
    ).toBeUndefined();
  });
});
