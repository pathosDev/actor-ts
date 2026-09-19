import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
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

/**
 * `.github/dependabot.yml` once more — this time for *which manifests it
 * watches at all*, and through which updater.
 *
 * #1596: the repository tracks thirteen `package.json` files and the file
 * watched one of them, through an `npm` entry that cannot read the `bun.lock`
 * beside it. Nothing noticed for five months, because the failure mode is
 * an absence — a PR that never opens — and no other check reads this file.
 */
type DependabotEntry = {
  /** `bun`, `npm`, `github-actions`, … */
  readonly ecosystem: string;
  /** 1-based line of the `- package-ecosystem:` item, for messages. */
  readonly line: number;
  /** The `directory:` value, or every item of the `directories:` list. */
  readonly directories: readonly string[];
};

/**
 * Every `- package-ecosystem:` item with the directories it names. Same
 * regex-over-YAML trade-off as the parsers above: a list item is a directory
 * only while `directories:` is the nearest preceding key, so the `labels:` and
 * `update-types:` lists in the same entry are not mistaken for one.
 */
function dependabotEntries(): DependabotEntry[] {
  const out: { ecosystem: string; line: number; directories: string[] }[] = [];
  let inDirectories = false;
  dependabotLines.forEach((line, index) => {
    if (line.trim() === '' || line.trim().startsWith('#')) return;
    const entry = /^\s*-\s*package-ecosystem:\s*"([^"]+)"\s*$/.exec(line);
    if (entry) {
      out.push({ ecosystem: entry[1]!, line: index + 1, directories: [] });
      inDirectories = false;
      return;
    }
    const current = out[out.length - 1];
    if (!current) return;
    const single = /^\s*directory:\s*"([^"]+)"\s*$/.exec(line);
    if (single) {
      current.directories.push(single[1]!);
      inDirectories = false;
      return;
    }
    if (/^\s*directories:\s*$/.test(line)) {
      inDirectories = true;
      return;
    }
    const item = /^\s*-\s*"([^"]+)"\s*$/.exec(line);
    if (inDirectories && item) {
      current.directories.push(item[1]!);
      return;
    }
    inDirectories = false; // any other key ends the list
  });
  return out;
}

/** The entries that watch a `package.json`; `github-actions` watches workflows. */
const manifestEntries: readonly DependabotEntry[] = dependabotEntries()
  .filter(({ ecosystem }) => ecosystem === 'npm' || ecosystem === 'bun');

/**
 * A `directory:` / `directories:` value against a manifest's directory.
 * Dependabot normalises a trailing slash away and lets `directories:` carry
 * `*`; the same segment walk as {@link matchesPattern}, so a glob here is
 * matched the way the group patterns are.
 */
const matchesDirectory = (pattern: string, directory: string): boolean => {
  const normalised = pattern.length > 1 && pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
  return matchesPattern(normalised, directory);
};

type TrackedManifest = {
  /** Dependabot-style: `/` for the root, `/docs`, `/examples/chat/frontend-next`, … */
  readonly directory: string;
  /** Repository-relative path of the `package.json`, POSIX separators. */
  readonly path: string;
  /** Lockfile names committed beside it, out of `bun.lock` and `package-lock.json`. */
  readonly lockfiles: readonly string[];
};

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');

const LOCKFILE_NAMES = ['bun.lock', 'package-lock.json'] as const;

/**
 * Every tracked `package.json`, with the lockfiles tracked beside it.
 *
 * The git index rather than a directory walk, as in
 * `tests/unit/ci/ComparisonLauncherModes.test.ts`: the population Dependabot
 * sees is what a clone contains, which excludes an untracked scratch manifest
 * and every `node_modules/` — and a walk that skipped those by name would be
 * asserting its own exclusion list.
 */
function trackedManifests(): TrackedManifest[] {
  const listed = spawnSync(
    'git',
    ['ls-files', '-z', '--', '*package.json', ...LOCKFILE_NAMES.map((name) => `*${name}`)],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8' },
  );

  // Deliberately not a skip, and thrown at load so the whole file goes red: a
  // coverage guard that passes when it cannot list the manifests is worth
  // less than no guard, and every context this suite runs in is a git
  // working tree.
  if (listed.error) throw new Error(`could not run git ls-files: ${listed.error.message}`);
  if (listed.status !== 0) throw new Error(`git ls-files exited ${listed.status}: ${listed.stderr}`);

  const lockfilesByDirectory = new Map<string, string[]>();
  const manifestPaths: string[] = [];
  for (const path of listed.stdout.split('\0')) {
    if (path === '') continue;
    const name = posix.basename(path);
    const directory = posix.dirname(path);
    if (name === 'package.json') manifestPaths.push(path);
    else if ((LOCKFILE_NAMES as readonly string[]).includes(name)) {
      lockfilesByDirectory.set(directory, [...(lockfilesByDirectory.get(directory) ?? []), name]);
    }
  }
  return manifestPaths.sort().map((path) => {
    const directory = posix.dirname(path);
    return {
      path,
      directory: directory === '.' ? '/' : `/${directory}`,
      lockfiles: (lockfilesByDirectory.get(directory) ?? []).sort(),
    };
  });
}

const manifests: readonly TrackedManifest[] = trackedManifests();

/**
 * The updater that can write the lockfile CI installs from. `examples.yml`
 * runs `npm ci` wherever a `package-lock.json` is committed, and the npm
 * updater has no code for `bun.lock` at all; everywhere else the install is
 * `bun install --frozen-lockfile`, which only the `bun` updater can keep
 * green. A manifest with no lockfile is updated manifest-only by either, and
 * takes `bun` because that is what installs it.
 */
const expectedEcosystem = ({ lockfiles }: TrackedManifest): 'npm' | 'bun' =>
  (lockfiles.includes('package-lock.json') ? 'npm' : 'bun');

/**
 * The highest `lockfileVersion` the Dependabot `bun` updater reads. It
 * bundles Bun 1.3.14, and since dependabot/dependabot-core#15896 a newer
 * stamp fails the entry outright (`DependencyFileNotSupported`) instead of
 * being silently downgraded — dependabot/dependabot-core#16071 raises the
 * ceiling and is open. Bun 1.4 stamps a fresh lockfile 2 but preserves an
 * existing 1 on every re-save, so the exposure is a `bun.lock` regenerated
 * from scratch: it keeps installing and quietly stops being updated. Raise
 * this when #16071 lands; until then restamp the file (v1 and v2 are
 * identical apart from the number — v2 only added parse-time strictness).
 */
const DEPENDABOT_BUN_LOCKFILE_VERSION_CEILING = 1;

/** The `"lockfileVersion": N` stamp at the top of a text `bun.lock`. */
function lockfileVersion(path: string): number | undefined {
  const match = /"lockfileVersion":\s*(\d+)/.exec(readFileSync(join(REPOSITORY_ROOT, path), 'utf8'));
  return match ? Number(match[1]) : undefined;
}

/** Every `bun.lock` a `bun` entry watches, with the manifest it belongs to. */
const watchedBunLockfiles = manifests
  .filter((manifest) => manifest.lockfiles.includes('bun.lock'))
  .filter((manifest) => manifestEntries.some(
    (entry) => entry.ecosystem === 'bun'
      && entry.directories.some((pattern) => matchesDirectory(pattern, manifest.directory)),
  ))
  .map((manifest) => ({ directory: manifest.directory, path: posix.join(posix.dirname(manifest.path), 'bun.lock') }));

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

/** A single backslash, spelled so no shell heredoc or editor can eat it. */
const BACKSLASH = String.fromCharCode(92);

type BunTestRun = {
  readonly workflow: string;
  readonly line: number;
  /** The whole logical command, with shell line continuations joined back up. */
  readonly command: string;
};

/**
 * `bun test …` invocations, as a `run:` value or a line inside a block scalar.
 *
 * Continuations are followed on purpose.  `test.yml` writes its coverage run
 * across four lines, three of them continued, so a flag added to it does not
 * necessarily land on the line the command starts on — and a scanner reading
 * one line at a time would have declared that command free of everything below
 * while looking at a quarter of it.
 */
function bunTestRuns({ name, lines }: WorkflowFile): BunTestRun[] {
  const out: BunTestRun[] = [];
  lines.forEach((line, index) => {
    const match = /^\s*(?:- )?run:\s*(bun test\b.*)$/.exec(line)
      ?? /^\s*(bun test\b.*)$/.exec(line);
    if (!match) return;
    let command = (match[1] ?? '').trim();
    for (let next = index + 1; command.endsWith(BACKSLASH) && next < lines.length; next++) {
      command = `${command.slice(0, -1).trim()} ${(lines[next] ?? '').trim()}`;
    }
    out.push({ workflow: name, line: index + 1, command });
  });
  return out;
}

const bunTests = workflows.flatMap(bunTestRuns);

/** The suites that gate a commit, and therefore have to shuffle (#1422). */
const PER_COMMIT_SUITES: readonly string[] = ['test.yml', 'multi-runtime.yml'];

type RunScript = {
  readonly workflow: string;
  readonly line: number;
  /** The script the runner executes: a scalar value, or a whole block scalar. */
  readonly text: string;
};

/**
 * Every `run:` script, whether written as a scalar or as a `|` block.
 *
 * A block ends at the first non-blank line indented no deeper than the `run:`
 * key itself, which is the next step or the next key — enough structure to read
 * a script's whole body without a YAML parser, like the rest of this file.
 */
function runScriptsOf({ name, lines }: WorkflowFile): RunScript[] {
  const out: RunScript[] = [];
  lines.forEach((line, index) => {
    const run = /^\s*(?:- )?run:\s*(.*)$/.exec(line);
    if (!run) return;
    const value = (run[1] ?? '').trim();
    if (!/^[|>][-+]?$/.test(value)) {
      if (value !== '') out.push({ workflow: name, line: index + 1, text: value });
      return;
    }
    const indent = keyIndentOf(line);
    const body: string[] = [];
    for (let next = index + 1; next < lines.length; next++) {
      const candidate = lines[next] ?? '';
      if (candidate.trim() !== '' && keyIndentOf(candidate) <= indent) break;
      body.push(candidate);
    }
    out.push({ workflow: name, line: index + 1, text: body.join('\n') });
  });
  return out;
}


/** `${{ … }}` — a value GitHub substitutes into the script before bash sees it. */
const GITHUB_EXPRESSION = /\$\{\{[^}]*\}\}/;

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

// Below `keyIndentOf`, which `runScriptsOf` reads: a `const` arrow is in its
// temporal dead zone until its own declaration runs, so an eager scan placed
// beside the function would throw at import.
const runScripts = workflows.flatMap(runScriptsOf);

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
   * The three assertions above are all of the form "no line matches this
   * pattern", and every one of them passes when its pattern has quietly
   * stopped matching anything at all. That decay is not theoretical here: the
   * badge statistics `ZERO_DEFAULTS` names were shell variables in `test.yml`
   * until #541 moved the coverage half into `scripts/coverage-gate.mjs`, and a
   * refactor that moved the rest would leave the ban green and empty.
   *
   * So each pattern is exercised against the line it was written against — a
   * line this workflow has actually carried, not an invention — and
   * `PIPED_TEST_RUN` against the invocation the workflow uses today, so the ban
   * cannot be satisfied only by banning everything.
   */
  test('the badge-statement bans still match the shapes they ban', () => {
    expect(ZERO_DEFAULTS.some((pattern) => pattern.test('[[ -z "$PASS" ]] && PASS=0'))).toBe(true);
    expect(ZERO_DEFAULTS.some((pattern) => pattern.test('LINES_INT=${LINES:-0}'))).toBe(true);

    expect(CONSOLE_SCRAPE.test('PASS=$(grep -E "^[[:space:]]+[0-9]+ pass$" "$LOG_FILE")')).toBe(true);

    expect(PIPED_TEST_RUN.test('OUTPUT=$(bun test --coverage)')).toBe(true);
    // The gate script replays the whole run when it is given no artifacts, so
    // capturing it is the same hazard under a different name.
    expect(PIPED_TEST_RUN.test('OUTPUT=$(bun scripts/coverage-gate.mjs)')).toBe(true);
    expect(PIPED_TEST_RUN.test('OUTPUT=$(bun run test:coverage:gate)')).toBe(true);
    expect(PIPED_TEST_RUN.test('bun scripts/coverage-gate.mjs --log="$LOG_FILE" --lcov="$LCOV"'))
      .toBe(false);
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
  /**
   * A job with no `timeout-minutes` inherits GitHub's six-hour default, and a
   * suite that stops making progress then burns six hours of a hosted runner
   * before anyone learns anything from it.
   *
   * That is not hypothetical here: it is the failure mode the `ACTOR_TS_SKIP_FLAKY_MNS`
   * quarantine was originally justified by (#538).  Bun on hosted runners could
   * not respawn worker threads, the suites hung rather than failed, and hiding
   * them was cheaper than watching a job time out.  A bounded job turns that
   * into a red check inside the hour, which is a thing you can act on.
   *
   * Every job in the directory carries one today; this keeps the next one from
   * being added without.  A job that only `uses:` a reusable workflow cannot
   * carry `timeout-minutes` and would need an exemption — there are none, and
   * adding the first should be a decision, not a silent pass.
   */
  test.each(jobs)('$workflow#$name bounds its own runtime', (job) => {
    expect(
      job.lines.some((line) => /^\s{4}timeout-minutes:\s*[0-9]+\s*$/.test(line)),
      `${job.workflow}#${job.name} declares no timeout-minutes, so it inherits `
      + "GitHub's six-hour default. A job that stops making progress should fail "
      + 'inside the hour instead — that is the failure mode the multi-node '
      + 'quarantine was justified by (#538).',
    ).toBe(true);
  });

  test('the scanner found the bun test runs it reasons about', () => {
    // Both assertions below are `test.each` over this list. An empty list would
    // satisfy them by running nothing at all.
    expect(
      bunTests.map((run) => `${run.workflow}:${run.line}`),
      'No `bun test` invocation was found in .github/workflows/. Either the '
      + 'suite stopped running in CI or this scanner stopped reading it; both '
      + 'are worth failing on.',
    ).not.toEqual([]);
  });

  /**
   * **`--retry` is never a gate.**  A test that passes on the second attempt is
   * a flake, and retrying it discards the one observation that says so — the
   * check goes green, the report says nothing, and the defect keeps shipping.
   *
   * The repository has the counter-example on file.  `LeaseMajority` failed 13
   * of 21 nights, and the cause was not the runner every hypothesis blamed: it
   * was a product defect in split-brain resolution (#839), a partition detected
   * one peer at a time resolved as a run of majority decisions.  A retry would
   * have hidden that for as long as the retry budget held.
   *
   * Repeat *runs* are the opposite tool and stay: `--rerun-each` and
   * `bun run test:stress` exist to make a flake more visible, not less, and
   * they aggregate what failed instead of forgetting it.
   */
  test.each(bunTests)('$workflow:$line does not retry a failing test', ({ command }) => {
    expect(
      command,
      'A retried test is a flake whose evidence was thrown away: the check goes '
      + 'green and the report says nothing. Treat the failure as a defect — '
      + '`bun run test:stress` measures how often it happens, and '
      + '`--rerun-each` makes it more visible rather than less.',
    ).not.toMatch(/--retry(?:=|\s|$)/);
  });

  /**
   * `--timeout` sets bun's per-test cap for the **whole run**, which is a
   * different thing from the cap a slow test declares for itself.
   *
   * The tree caps per test, as the third argument to `test(...)`, and
   * `tests/unit/ci/AwaitConditionBudgets.test.ts` checks that each of those
   * caps is actually reachable from the budgets inside it.  A run-wide raise
   * would grant every test the loosest cap any one of them needed, so a test
   * that quietly started taking twenty seconds would stop being a finding —
   * and the per-test caps would go on describing a bound nothing enforced.
   */
  test.each(bunTests)('$workflow:$line does not raise the per-test cap run-wide', ({ command }) => {
    expect(
      command,
      'A run-wide --timeout grants every test the loosest cap any one of them '
      + 'needs, which makes the per-test caps decorative and hides a test that '
      + 'started taking longer. Raise the cap on the test that needs it, as the '
      + 'third argument to test(...).',
    ).not.toMatch(/--timeout(?:=|\s|$)/);
  });

  /**
   * #1422 — declaration order is a premise no test should be resting on, and
   * four were: a fixture block that wrote a value in one test and read it in
   * the next, a suite whose module mock was undone by whoever ran after it, and
   * one that counted microtask turns behind a dangling operation.  All four
   * passed every run in declaration order and failed under a shuffle.
   *
   * So the per-commit gate shuffles.  The seed is chosen by the workflow and
   * echoed rather than scraped back out of bun's output: bun prints it in the
   * summary block it stops printing under GitHub Actions, which is the same
   * trap that once turned an unreadable pass count into a green `0 of 0` badge.
   */
  test.each([...PER_COMMIT_SUITES])('%s runs its tests in randomized order', (workflow) => {
    const runs = bunTests.filter((run) => run.workflow === workflow);
    expect(runs, `${workflow} runs no bun test at all`).not.toEqual([]);
    for (const run of runs) {
      expect(
        run.command,
        `${workflow}:${run.line} runs the suite in declaration order, so a test `
        + 'that depends on running after another one passes here and fails for '
        + 'whoever runs them differently (#1422). Pass --seed, which implies '
        + '--randomize, and echo the seed so a red run is reproducible.',
      ).toMatch(/--seed(?:=|\s)|--randomize\b/);
    }
  });

  test('the scanner reads a block scalar to its end, and stops at the next step', () => {
    const file: WorkflowFile = {
      name: 'fixture.yml',
      lines: [
        'jobs:',
        '  build:',
        '    steps:',
        '      - name: Two lines',
        '        run: |',
        '          echo one',
        '          echo two',
        '      - name: Next step',
        '        run: echo three',
      ],
    };
    const scripts = runScriptsOf(file);
    expect(scripts.map((script) => script.text)).toEqual([
      '          echo one\n          echo two',
      'echo three',
    ]);
  });

  test('the scanner sees an expression a block scalar hides on a later line', () => {
    // The shape that motivated this: the offending line is not the `run:` line,
    // so a scanner reading one line at a time would find nothing.
    const file: WorkflowFile = {
      name: 'fixture.yml',
      lines: [
        'jobs:',
        '  build:',
        '    steps:',
        '      - run: |',
        '          echo starting',
        '          git checkout "${{ github.head_ref }}"',
      ],
    };
    const [script] = runScriptsOf(file);
    expect(GITHUB_EXPRESSION.test(script?.text ?? '')).toBe(true);
  });

  test('a value passed through env: is not an expression in the script', () => {
    const file: WorkflowFile = {
      name: 'fixture.yml',
      lines: [
        'jobs:',
        '  build:',
        '    steps:',
        '      - env:',
        '          REF: ${{ github.head_ref }}',
        '        run: |',
        '          git checkout "$REF"',
      ],
    };
    const [script] = runScriptsOf(file);
    expect(GITHUB_EXPRESSION.test(script?.text ?? '')).toBe(false);
  });

  test('the scanner found the run: scripts it reasons about', () => {
    // The assertion below is a `test.each` over this list, and an empty list
    // would satisfy it by running nothing.
    expect(runScripts.length).toBeGreaterThan(20);
  });

  /**
   * **A GitHub expression is substituted into the script before bash parses
   * it**, so `${{ github.event.pull_request.title }}` in a `run:` body is that
   * title *as shell source*.  On a fork pull request the title is written by
   * whoever opened it, and the runner has a checkout and a token.
   *
   * Through `env:` it is a value instead: the runner sets the variable and the
   * script reads `"$TITLE"`, which bash never re-parses.  The rule is GitHub's
   * own hardening guidance, and the tree already followed it in both places
   * that needed it — `publish.yml` passes the release tag as `TAG`, and the
   * changed-test probe passes the base SHA as `BASE_SHA` (#1423).  This is what
   * turns a habit into something the next author cannot skip by accident.
   *
   * Deliberately every expression, not a list of the dangerous ones.  Which
   * context is attacker-controlled changes with GitHub's feature set, and a
   * blocklist is a promise to keep re-reading their documentation; `env:` costs
   * two lines and is correct for all of them.
   */
  test.each(runScripts)('$workflow:$line takes no GitHub expression into its script', ({ text }) => {
    expect(
      GITHUB_EXPRESSION.exec(text)?.[0],
      'A ${{ … }} is substituted into the script before bash parses it, so an '
      + 'expression carrying attacker-controlled text (a branch name, a PR '
      + 'title) is shell source on a fork pull request. Pass it through the '
      + "step's env: block and read it as \"$VARIABLE\", which bash never "
      + 're-parses.',
    ).toBeUndefined();
  });

  /**
   * **`--parallel` belongs on the coverage run**, and this assertion changed
   * direction because the runtime did, not because the argument did.
   *
   * It used to forbid the flag, and #1332 was right to: on bun 1.4.0 a
   * parallel run executed identically — the same hit count for 721 of 723
   * files, the numerator byte-for-byte the same 55 293 lines — while 407 files
   * reported a *larger* instrumented-line denominator and none a smaller one.
   * `src/cluster/Cluster.ts` went from 1 077 to 1 469 against the same 1 074
   * hit, the aggregate read **79.16 % against 93.82 % on the same code**, and
   * the obvious response to that red gate would have been to lower the floor.
   *
   * Bun 1.4.1 lists a fix for under-reported coverage across workers, and on
   * the 1.4.2 pin (#1519) the defect is measured gone: over 728 lcov records,
   * **zero** report a larger denominator, 20 report one smaller by a line or
   * three (30 lines out of 59 593, or 0.05 %), and the numerator is identical
   * at 56 041.  Bun's own aggregate agrees to 0.05 points — 94.66 % parallel
   * against 94.61 % serial — and the run goes **352 s to 41 s** on 32 cores.
   *
   * So the assertion inverts rather than disappearing.  A silently dropped
   * flag costs eight minutes a run and shows up nowhere in a green check, and
   * if a future Bun re-inflates the denominator the floor in
   * `scripts/coverage-gate.mjs` reports it — which is the pair that has to
   * stay together, in whichever direction it points.  #1521.
   */
  test.each(bunTests.filter((run) => run.command.includes('--coverage')))(
    '$workflow:$line measures coverage in parallel',
    ({ command }) => {
      expect(
        command,
        'The coverage run lost --parallel. It was deliberately absent while bun '
        + '1.4.0 inflated the instrumented-line denominator under it (79.16% '
        + 'against 93.82% on identical execution, #1332), and deliberately '
        + 'present since the 1.4.2 pin, where 0 of 728 lcov records report a '
        + 'larger denominator, the aggregate agrees to 0.05 points, and the run '
        + 'drops from 352 s to 41 s (#1521). Dropping it is an eight-minute '
        + 'regression per run that a green check would never show. If a future '
        + 'bun re-inflates the denominator the coverage floor reports that — do '
        + 'not answer it by lowering the floor.',
      ).toMatch(/--parallel\b/);
    },
  );

  test('the coverage run this reasons about is still there', () => {
    // The assertion above is a `test.each` over a filter, and a filter that
    // matches nothing passes silently.
    expect(
      bunTests.filter((run) => run.command.includes('--coverage')).length,
    ).toBeGreaterThan(0);
  });

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

describe('dependabot manifest coverage', () => {
  test('the manifest listing and the entry parser found their subjects', () => {
    // Thirteen today: the root, docs, the DevTools UI, the comparison
    // benchmarks, the broker runners and eight example frontends. Pinned from
    // below so a listing that quietly shrinks — a pathspec that stops matching
    // on some platform, say — is a failure rather than a `test.each` over less.
    // Removing a manifest lowers this deliberately, in the same commit.
    expect(manifests.length).toBeGreaterThanOrEqual(13);
    expect(manifests.map(({ directory }) => directory)).toContain('/');
    // Both lockfile shapes are present, or the ecosystem rule below is never
    // exercised in one of its two directions.
    expect(manifests.some(({ lockfiles }) => lockfiles.includes('package-lock.json'))).toBe(true);
    expect(manifests.some(({ lockfiles }) => lockfiles.includes('bun.lock')
      && !lockfiles.includes('package-lock.json'))).toBe(true);
    // The entry parser needs no vacuity check of its own: an entry it fails to
    // read leaves its manifests unwatched, and the coverage tests below fail
    // loudly for those. The lockfile-version `test.each` is the one that
    // would pass over an empty list.
    expect(watchedBunLockfiles.length).toBeGreaterThan(0);
  });

  /**
   * #1596 — a manifest no entry names gets version updates from nobody. It
   * still gets *security* updates, which Dependabot opens from the dependency
   * graph regardless of this file, and that is exactly what hid the gap: the
   * PR list was not empty, it was just never a non-advisory bump.
   *
   * Exactly one entry, not at least one: two entries on the same directory
   * open two PRs per bump, each stale the moment the other merges.
   */
  test.each([...manifests])('$path is watched by exactly one Dependabot entry', (manifest) => {
    const watching = manifestEntries.filter(({ directories }) =>
      directories.some((pattern) => matchesDirectory(pattern, manifest.directory)));
    expect(
      watching.map(({ ecosystem, line }) => `${ecosystem} entry at dependabot.yml:${line}`),
      `${manifest.path} is named by ${watching.length} entries in .github/dependabot.yml. `
      + `Every tracked package.json needs exactly one — add a package-ecosystem entry for `
      + `"${manifest.directory}" (or a line in an existing directories: list).`,
    ).toHaveLength(1);
  });

  /**
   * The updater has to be the one that writes the lockfile CI installs from.
   * The `npm` updater edits `package-lock.json` and has no code for
   * `bun.lock`; the `bun` updater regenerates `bun.lock` and never touches
   * `package-lock.json`. Cross them and every PR the entry opens is red on
   * the frozen install by construction — the root spent five months that way
   * (#817), and the in-range updates it could not see never surfaced at all.
   */
  test.each([...manifests])('$path is watched by the updater that writes its lockfile', (manifest) => {
    const watching = manifestEntries.find(({ directories }) =>
      directories.some((pattern) => matchesDirectory(pattern, manifest.directory)));
    if (!watching) return; // the test above already fails for this manifest
    const expected = expectedEcosystem(manifest);
    expect(
      watching.ecosystem,
      `${manifest.path} sits beside ${manifest.lockfiles.join(' and ') || 'no lockfile'}, so its `
      + `Dependabot entry has to be package-ecosystem: "${expected}" — the "${watching.ecosystem}" `
      + `updater at dependabot.yml:${watching.line} cannot write the lockfile CI installs from, `
      + 'and every PR it opens is red on the frozen install by construction.',
    ).toBe(expected);
  });

  /**
   * The converse: a directory an entry names has to hold a manifest, or the
   * entry errors on every run and updates nothing — invisible from the PR
   * list, like the gap above, and easy to leave behind when a directory moves.
   */
  test.each(manifestEntries.flatMap(({ ecosystem, line, directories }) =>
    directories.map((pattern) => ({ ecosystem, line, pattern }))))(
    '$ecosystem entry at line $line names a tracked manifest with $pattern',
    ({ pattern }) => {
      expect(
        manifests.filter(({ directory }) => matchesDirectory(pattern, directory)).map(({ path }) => path),
        `No tracked package.json sits at "${pattern}" — the entry updates nothing. `
        + 'Point it at a manifest that exists or remove it.',
      ).not.toEqual([]);
    },
  );

  /**
   * A `bun.lock` the updater cannot parse fails its entry on every run, and
   * nothing else notices: the file installs fine under the repository's own
   * Bun, the PR list simply stays empty. `devtools-ui/bun.lock` was born under
   * 1.4.0 with a 2 (`65548aa9`) and is restamped; see the constant for why
   * the ceiling is where it is.
   */
  test.each(watchedBunLockfiles)(
    '$path carries a lockfileVersion the Dependabot bun updater can read',
    ({ path }) => {
      const version = lockfileVersion(path);
      expect(version, `${path} has no "lockfileVersion" stamp`).toBeDefined();
      expect(
        version!,
        `${path} is stamped lockfileVersion ${version}, and the Dependabot bun updater reads `
        + `${DEPENDABOT_BUN_LOCKFILE_VERSION_CEILING} at most — its entry fails on every run and `
        + 'opens nothing. Restamp the file (the content is identical across the two versions '
        + 'and Bun 1.4 preserves the lower stamp), or raise the ceiling once '
        + 'dependabot/dependabot-core#16071 has landed.',
      ).toBeLessThanOrEqual(DEPENDABOT_BUN_LOCKFILE_VERSION_CEILING);
    },
  );
});
