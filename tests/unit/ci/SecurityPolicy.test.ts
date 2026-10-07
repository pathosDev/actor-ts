import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * Repo-file guard over the security policy — the same class of check as
 * `tests/unit/ci/WorkflowHygiene.test.ts`, `tests/unit/config/NoDeadConfigKeys.test.ts`
 * and `tests/unit/TreeShaking.test.ts`: assertions about files no compiler
 * reads, run under plain `bun test` because nothing else in the toolchain
 * would ever notice them rotting.
 *
 * Four things are worth a test here rather than a convention.
 *
 * The first is that the issue template used to point at a `SECURITY.md` that
 * had never existed in this repository, with a "(or, if absent, contact the
 * maintainer privately)" hedge and no channel named — so a reporter following
 * the instructions arrived nowhere (#539). Deleting the file would restore
 * exactly that state, silently.
 *
 * The second is the audit baseline. `lint:audit` landed with eleven
 * `--ignore`d advisory IDs — every high the closure carried at the time — and
 * a suppression that nobody can see is a gate that has quietly stopped
 * gating, which is the failure mode #1194 taught this repository to write
 * assertions against. Requiring every suppressed ID to appear in
 * `SECURITY.md` — and every listed ID to still be suppressed — made the list
 * impossible to grow in the dark, and when #779 emptied it with an in-range
 * lockfile refresh (5c4d2cfd), impossible to leave behind: the list is empty,
 * the pages say so, and both facts are asserted below in both directions.
 *
 * The third is the route around that list. A dependency override rewrites the
 * resolved closure `bun audit` reads, so it can retire an advisory without
 * touching the `--ignore` flags at all — a suppression the table above cannot
 * see. #676 found it while looking for a way to declare `cassandra-driver`.
 *
 * The fourth is which lockfiles the gate reads at all. `bun.lock` was audited
 * from the day the gate landed, and it was not the only Bun closure CI put on
 * a runner: docs-checks.yml and docs.yml install `docs/bun.lock` for the site
 * build, and test.yml, multi-runtime.yml and publish.yml install
 * `devtools-ui/bun.lock` — the last inside the job that holds the publishing
 * token. Nothing read either one, and between them they carried nine high
 * advisories with in-range fixes while the root gate stayed green (#1413).
 * So the closures the gate reads are derived from the workflow's own steps,
 * checked against every `bun install` in `.github/workflows/`, and the pages
 * that tell a reader what is audited are held to the same list.
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
  // The working standards are the page every contributor — and every coding
  // agent, which loads them as project context — reads before the policy.
  // They described the baseline in the present tense for two weeks after
  // #779 had emptied it (#1508).
  ['AGENTS.md', '**Nothing is suppressed today.**'],
];

const collapsed = (text: string): string => text.replace(/\s+/g, ' ');

/**
 * Prose reduced to what a claim is compared against: code-span backticks and
 * emphasis markers dropped, whitespace collapsed, case folded — so a reflow or
 * a bolded word does not turn a claim red, and a changed word does.
 */
const normalisedProse = (text: string): string =>
  collapsed(text.replace(/[`*_]+/g, '')).trim().toLowerCase();

/**
 * The SECURITY.md section `heading` opens, up to the next heading of its level
 * or above, or `''` when the heading is gone — reduced to what GitHub renders
 * as prose.  A fenced block and an HTML comment are dropped: the first is an
 * example rather than a claim, the second renders nothing at all, and a guard
 * that reads either goes green on a policy no reader can see saying it.  The
 * policy is checked out with CRLF line endings on Windows, and an anchor
 * spelled with `\n` that silently matches nothing would read as "the section
 * is correctly absent".
 */
function policySection(heading: string, policy: string = securityPolicy): string {
  const text = policy
    .replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[ \t]*```[\s\S]*?^[ \t]*```[ \t]*$/gm, '');
  const start = text.indexOf(`\n${heading}\n`);
  if (start < 0) return '';
  const level = heading.indexOf(' ');
  const body = text.slice(start + heading.length + 2);
  const next = body.search(new RegExp(`^#{1,${level}} `, 'm'));
  return next < 0 ? body : body.slice(0, next);
}

/**
 * The heading under `## Scope` that records #1430's decision.  Documentation
 * pages link to it by its GitHub anchor, so it is a link target as well as a
 * heading.
 */
const JOURNAL_AT_REST_HEADING = '### Out of scope — the event journal at rest';

/**
 * What the record has to say, each a load-bearing part of the decision, as
 * exact phrases of the normalised section.  A rewording changes this list on
 * purpose, which is the point: the record is what a reporter, and whoever
 * revisits #1430, reads as the project's position.
 */
const JOURNAL_DECISION_CLAIMS: ReadonlyArray<readonly [string, string]> = [
  ['the decision', 'at-rest confidentiality and integrity of the event journal are delegated to the database'],
  ['its standing', 'a documented non-goal'],
  ['what the per-actor hooks cover', 'the two hooks cover snapshots and durable state only'],
  [
    'the half the delegation leaves uncovered, and why',
    'the integrity half stays uncovered, because transparent data encryption is not tamper detection',
  ],
  ['that the framework detects no edit', 'nothing in the framework detects it'],
];

/**
 * The record must not overstate the gap either.  Replay already refuses a
 * stream whose shape is broken — out of order, holed, outside the window it
 * asked for — with a `JournalIntegrityError`, so "no tamper detection" would
 * contradict the PersistentActor page.  What stays uncovered is the
 * confidentiality of events and an event edited in place.
 */
const JOURNAL_DECISION_OVERSTATEMENTS: readonly RegExp[] = [
  /\bno tamper detection\b/,
  /\bnothing detects tampering\b/,
  /\bthe journal has no integrity checks?\b/,
];

/**
 * GitHub's anchor for each heading of a Markdown page, in page order — the
 * rule github-slugger applies to the rendered heading text: lower case; every
 * character that is not a letter, a mark, a digit, a connector, a space or a
 * hyphen dropped; each space a hyphen.  So an em dash between two spaces
 * leaves two hyphens behind.  A text that repeats takes `-1`, `-2`, … on its
 * later copies.  Headings inside a fence or an HTML comment are not headings.
 */
function githubAnchors(markdown: string): string[] {
  const occurrences = new Map<string, number>();
  const rendered = markdown
    .replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[ \t]*```[\s\S]*?^[ \t]*```[ \t]*$/gm, '');
  return [...rendered.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*$/gm)].map(([, title = '']) => {
    const text = title.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*]+/g, '');
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
    const seen = occurrences.get(base) ?? 0;
    occurrences.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen}`;
  });
}

type PolicyAnchorLink = { readonly file: string; readonly anchor: string };

/**
 * Markdown links whose target is a `SECURITY.md` with a fragment — the
 * absolute GitHub URL the documentation uses, or a relative path.  An HTML
 * `<a href>` is not read; nothing in the tree writes one.
 */
function policyAnchorLinksIn(file: string, text: string): PolicyAnchorLink[] {
  return [...text.matchAll(/\]\(\s*<?[^)\s>]*SECURITY\.md#([^)\s>]+)>?\s*\)/g)]
    .map(([, anchor = '']) => ({ file, anchor: decodeURIComponent(anchor) }));
}

/** Every link into a SECURITY.md heading, from the documentation in both languages and the root pages. */
function linksIntoPolicy(): PolicyAnchorLink[] {
  const documentation = (readdirSync(DOCUMENTATION_ROOT, { recursive: true }) as string[])
    .filter((path) => /\.mdx?$/.test(path))
    .map((path) => join('docs', 'src', 'content', 'docs', path));
  const rootPages = readdirSync(REPOSITORY_ROOT).filter((name) => /\.md$/.test(name));
  return [...documentation, ...rootPages].flatMap((file) =>
    policyAnchorLinksIn(file.replaceAll('\\', '/'), readFileSync(join(REPOSITORY_ROOT, file), 'utf8')));
}

/** The supply-chain page and its German mirror — the two that document the gate for a reader. */
const mirrorSources: ReadonlyArray<readonly [string, string]> = [
  [
    join('docs', SUPPLY_CHAIN_PATH),
    collapsed(readFileSync(join(DOCUMENTATION_ROOT, SUPPLY_CHAIN_PATH), 'utf8')),
  ],
  [
    join('docs', 'de', SUPPLY_CHAIN_PATH),
    collapsed(readFileSync(join(DOCUMENTATION_ROOT, 'de', SUPPLY_CHAIN_PATH), 'utf8')),
  ],
];

const claimSources: ReadonlyArray<readonly [string, string]> = [
  ['SECURITY.md', collapsed(securityPolicy)],
  ['AGENTS.md', collapsed(readFileSync(join(REPOSITORY_ROOT, 'AGENTS.md'), 'utf8'))],
  ...mirrorSources,
];

const WORKFLOWS_ROOT = join(REPOSITORY_ROOT, '.github', 'workflows');

const PACKAGE_HEALTH = 'package-health.yml';

const packageHealthWorkflow = readFileSync(join(WORKFLOWS_ROOT, PACKAGE_HEALTH), 'utf8');

/** Every workflow, by file name, for the installs they run. */
const workflows: ReadonlyArray<readonly [string, string]> = readdirSync(WORKFLOWS_ROOT)
  .filter((name) => /\.ya?ml$/.test(name))
  .sort()
  .map((name) => [name, readFileSync(join(WORKFLOWS_ROOT, name), 'utf8')] as const);

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

/** One entry of a job's `steps:` list, as the keys it sets. */
type WorkflowStep = {
  /** 1-based line of the `- ` that opens it. */
  readonly line: number;
  /** `name`, `run`, `working-directory`, … — a block scalar's lines joined with `\n`. */
  readonly keys: Readonly<Record<string, string>>;
};

/**
 * The steps of every job in a workflow, read as flat key/value pairs.
 *
 * A small reader rather than a YAML parser, on purpose: a step's keys sit two
 * columns in from the `- ` that opens it, a block scalar (`run: |`) is the
 * deeper-indented lines that follow its key, and nothing the assertions
 * below ask about nests further. `WorkflowHygiene.test.ts` reads the same
 * shapes for its own questions; this file asks a different one — which
 * directory a step runs in — and keeps its reader beside the assertions
 * that depend on it.
 */
function stepsOf(workflow: string): WorkflowStep[] {
  const steps: { line: number; keys: Record<string, string> }[] = [];
  let listIndent = -1;
  let block: { readonly key: string; readonly separator: '\n' | ' ' } | undefined;
  workflow.split(/\r?\n/).forEach((text, index) => {
    const trimmed = text.trim();
    const indent = text.length - text.trimStart().length;
    const step = steps.at(-1);
    if (block !== undefined && step) {
      if (trimmed === '') return;
      if (indent > listIndent + 2) {
        const { key, separator } = block;
        step.keys[key] = step.keys[key] ? `${step.keys[key]}${separator}${trimmed}` : trimmed;
        return;
      }
      block = undefined;
    }
    if (trimmed === '' || trimmed.startsWith('#')) return;
    if (trimmed === 'steps:') {
      listIndent = indent + 2;
      return;
    }
    if (listIndent < 0) return;
    if (indent < listIndent) {
      listIndent = -1;
      return;
    }
    const opener = indent === listIndent && trimmed.startsWith('- ');
    if (opener) steps.push({ line: index + 1, keys: {} });
    const scalar = /^(?:- )?([\w-]+):\s*(.*)$/.exec(trimmed);
    const current = steps.at(-1);
    if (!current || !scalar || !(opener || indent === listIndent + 2)) return;
    const [, key = '', value = ''] = scalar;
    if (/^[|>][-+]?$/.test(value)) {
      // A folded block (`>`) is one line to the shell; a literal one (`|`)
      // keeps its line breaks.
      block = { key, separator: value.startsWith('>') ? ' ' : '\n' };
      current.keys[key] = '';
    } else {
      current.keys[key] = value;
    }
  });
  return steps;
}

/**
 * The lines of a `run:` script as the shell sees them: a backslash
 * continuation joined to the line it continues, runs of whitespace
 * collapsed. Both are spellings a reader working line by line would miss —
 * `bun install \` with `--cwd docs` on the next line reads as a root
 * install without this.
 */
const shellLinesOf = (script: string): string[] =>
  script.replace(/\\\n\s*/g, ' ').split('\n').map((line) => line.replace(/\s+/g, ' ').trim());

const unquoted = (value: string): string => value.replace(/^(['"])(.*)\1$/, '$2');

const GITHUB_EXPRESSION = /\$\{\{/;

/** A shell line split at its operators — enough for the one-liners CI writes. */
const segmentsOf = (text: string): string[] =>
  text.split(/\s*(?:&&|\|\||;|\|)\s*/).map((segment) => segment.trim()).filter((segment) => segment !== '');

type ManifestScripts = Readonly<Record<string, string>>;

/** The nearest `package.json` at or above `directory`, the way `bun run` finds one. */
function manifestAt(directory: string): { readonly path: string; readonly scripts: ManifestScripts } {
  let current = posix.normalize(directory);
  for (;;) {
    const path = posix.join(current, 'package.json');
    if (existsSync(join(REPOSITORY_ROOT, path))) {
      const parsed = JSON.parse(readFileSync(join(REPOSITORY_ROOT, path), 'utf8')) as { scripts?: ManifestScripts };
      return { path, scripts: parsed.scripts ?? {} };
    }
    if (current === '.') return { path, scripts: {} };
    current = posix.dirname(current);
  }
}

/**
 * Every command a `bun run <script>` stands for, followed through the scripts
 * it chains to, against the manifest of the directory it runs in. An install
 * reached through a script (`ui:install`, #1622) is as much a closure on the
 * runner as one written out, so the audit question has to read through them
 * the way `WorkflowHygiene.test.ts`'s frozen-install question does.
 */
function commandsOf(
  directory: string,
  script: string,
  scriptsIn: (directory: string) => ManifestScripts = (at) => manifestAt(at).scripts,
  seen = new Set<string>(),
): string[] {
  if (seen.has(script)) return [];
  seen.add(script);
  const body = scriptsIn(directory)[script];
  if (body === undefined) return [];
  return segmentsOf(body).flatMap((command) => {
    const nested = /^bun run (\S+)$/.exec(command);
    return nested ? commandsOf(directory, nested[1] ?? '', scriptsIn, seen) : [command];
  });
}

/** The script the root and `docs/` route their audit through. */
const AUDIT_SCRIPT = 'lint:audit';

type AuditStep = {
  /** Repository-relative directory whose `bun.lock` the step reads; `.` for the root. */
  readonly closure: string;
  /** The `bun audit …` line — read through the manifest when the step runs the script. */
  readonly command: string;
  /** Where `command` was read from, for the failure messages. */
  readonly source: string;
};

/**
 * Every advisory audit `package-health.yml` runs, with the closure it reads.
 *
 * Two spellings are read. A step that runs `bun run lint:audit` is resolved
 * against the manifest of its working directory, the way `bun run` resolves
 * it, so the flags are read from the script a developer runs locally. A step
 * that writes `bun audit …` out is read as written — the DevTools UI closure
 * is audited that way, because its manifest is hashed into the embedded
 * bundle's `source-hash` and a script added there costs a `build:ui`.
 */
function auditStepsOf(workflow: string): AuditStep[] {
  return stepsOf(workflow).flatMap(({ line, keys }) => {
    const run = shellLinesOf(keys['run'] ?? '').join('\n');
    const closure = posix.normalize(unquoted(keys['working-directory'] ?? '.'));
    if (run === `bun run ${AUDIT_SCRIPT}`) {
      const manifest = manifestAt(closure);
      return [{ closure, command: manifest.scripts[AUDIT_SCRIPT] ?? '', source: `${manifest.path}#scripts.${AUDIT_SCRIPT}` }];
    }
    if (/^bun audit\b/.test(run)) return [{ closure, command: run, source: `.github/workflows/${PACKAGE_HEALTH}:${line}` }];
    return [];
  });
}

const auditSteps: readonly AuditStep[] = auditStepsOf(packageHealthWorkflow);

type InstallSite = {
  readonly workflow: string;
  readonly line: number;
  /** The directory whose `bun.lock` the install resolves: `--cwd` when given, else the step's own. */
  readonly closure: string;
  readonly command: string;
};

/** `bun install`, and the two spellings bun accepts for it. */
const BUN_INSTALL = /^bun (?:install|i|ci)\b/;

/**
 * Every `bun install` a workflow runs, with the closure it puts on the runner.
 *
 * The closure is the step's working directory, moved by a `cd` earlier on the
 * same line and by the install's own `--cwd`. `--dry-run` installs are left
 * out: examples.yml runs one per bundled frontend to check `bun.lock` against
 * its manifest, and a dry run fetches nothing and runs nothing, so there is no
 * closure on the runner for an audit to be about — `npm ci` installs those
 * frontends from `package-lock.json`, which GitHub's dependency graph does
 * read. A `bun run` under a matrix working directory names no manifest to
 * read; `WorkflowHygiene.test.ts` already fails every such step, so none is
 * followed here.
 */
function installsOf(
  name: string,
  workflow: string,
  scriptsIn: (directory: string) => ManifestScripts = (at) => manifestAt(at).scripts,
): InstallSite[] {
  return stepsOf(workflow).flatMap(({ line, keys }) => {
    const stepDirectory = posix.normalize(unquoted(keys['working-directory'] ?? '.'));
    const found: InstallSite[] = [];
    for (const text of shellLinesOf(keys['run'] ?? '')) {
      let directory = stepDirectory;
      const commands = segmentsOf(text).flatMap((command) => {
        const script = /^bun run (\S+)$/.exec(command)?.[1];
        return script !== undefined && !GITHUB_EXPRESSION.test(directory)
          ? commandsOf(directory, script, scriptsIn)
          : [command];
      });
      for (const command of commands) {
        const moved = /^(?:cd|pushd|Set-Location) (\S+)$/.exec(command)?.[1];
        if (moved !== undefined) directory = posix.normalize(posix.join(directory, unquoted(moved)));
        if (!BUN_INSTALL.test(command) || /--dry-run\b/.test(command)) continue;
        const flaggedDirectory = unquoted(/--cwd[= ](\S+)/.exec(command)?.[1] ?? '.');
        found.push({ workflow: name, line, closure: posix.normalize(posix.join(directory, flaggedDirectory)), command });
      }
    }
    return found;
  });
}

const installs: readonly InstallSite[] = workflows.flatMap(([name, text]) => installsOf(name, text));

/**
 * `workflow:line` of every `working-directory:` under a `defaults:` block.
 * A job- or workflow-level default moves every step in its scope, and the
 * readers above attribute a step to its own key alone — so rather than
 * misplace an install, the invariant refuses the shape until somebody models
 * it. No workflow writes one today.
 */
function defaultWorkingDirectoriesOf(name: string, workflow: string): string[] {
  const out: string[] = [];
  let defaultsIndent = -1;
  workflow.split(/\r?\n/).forEach((text, index) => {
    const trimmed = text.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    const indent = text.length - text.trimStart().length;
    if (defaultsIndent >= 0 && indent <= defaultsIndent) defaultsIndent = -1;
    if (trimmed === 'defaults:') {
      defaultsIndent = indent;
      return;
    }
    if (defaultsIndent >= 0 && trimmed.startsWith('working-directory:')) out.push(`${name}:${index + 1}`);
  });
  return out;
}

/**
 * Bun closures a workflow installs that no step of the gate reads, each with
 * the reason it is not audited. The list is a gap named out loud, and empty
 * is where it belongs: #1413 is what an unnamed gap looks like — two closures
 * CI installed, one of them inside the publishing job, that no gate read
 * while the root gate stayed green.
 */
const UNAUDITED_INSTALLS: ReadonlyMap<string, string> = new Map([
  [
    'benchmarks/comparison',
    'nact and xstate, pinned exactly and installed by benchmarks.yml alone, under a '
    + 'read-only token, to be measured against; the manifest keeps them out of '
    + '`bun audit`\'s surface by its own description, and #1413 widened the gate to '
    + 'the closures the test and publish jobs install. Clean (3 packages) when '
    + 'this was written; auditing it is one more step in package-health.yml.',
  ],
]);

/** The `paths:` filter of each trigger in a workflow's `on:` block. */
function pathFiltersOf(workflow: string): ReadonlyArray<readonly [string, readonly string[]]> {
  const out: [string, string[]][] = [];
  let trigger = '';
  let paths: string[] | undefined;
  for (const line of workflow.split(/\r?\n/)) {
    const named = /^  ([\w-]+):/.exec(line);
    if (named) trigger = named[1] ?? '';
    if (/^\s+paths:\s*$/.test(line)) {
      paths = [];
      out.push([trigger, paths]);
      continue;
    }
    const entry = paths && /^\s+- (.+?)\s*$/.exec(line);
    if (entry) paths?.push(unquoted(entry[1] ?? ''));
    else paths = undefined;
  }
  return out;
}

/**
 * The template's prose is a markdown blockquote wrapped across YAML lines, so
 * every phrase in it is split by `\n        > `. Normalising the quote markers
 * and the wrapping away is what lets the assertions below talk about sentences
 * instead of about where the line breaks happen to fall.
 */
const templateProse = securityTemplate.replace(/^\s*>\s?/gm, ' ').replace(/\s+/g, ' ');

const advisoryPattern = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/g;

/** Advisory IDs any audit step ignores — one list across every closure the gate reads. */
const suppressedAdvisories: readonly string[] = [
  ...new Set(
    auditSteps.flatMap(({ command }) =>
      [...command.matchAll(/--ignore=(GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4})/g)]
        .map((match) => match[1] ?? '')),
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
   * The second boundary a reporter cannot infer from the code (#1430):
   * `encryption()` and `integrity()` reach snapshots and durable state, and no
   * journal is asked about them, so every event sits in the database as
   * plaintext JSON and an event edited in place is folded on recovery.  The
   * maintainer decided that stays so — the journal's at-rest confidentiality
   * and integrity are the database's job — and a decision nobody wrote down
   * gets triaged as a fresh vulnerability by every reader who finds the
   * plaintext.  So the record is held to its content, not to its existence:
   * the delegation, the coverage of the hooks, and the half the delegation
   * leaves uncovered, which transparent data encryption does not close.
   */
  test('SECURITY.md records the event journal at rest as delegated to the database (#1430)', () => {
    const scope = policySection('## Scope');
    const record = policySection(JOURNAL_AT_REST_HEADING);
    expect(
      record.length,
      `SECURITY.md has no "${JOURNAL_AT_REST_HEADING}" section. It is where #1430's decision is `
      + 'recorded, and the documentation links to it by that heading.',
    ).toBeGreaterThan(500);
    expect(
      scope.includes(`\n${JOURNAL_AT_REST_HEADING}\n`),
      'The journal record sits outside `## Scope`, where a reporter deciding what to file does not look.',
    ).toBe(true);
    const prose = normalisedProse(record);
    const missing = JOURNAL_DECISION_CLAIMS
      .filter(([, phrase]) => !prose.includes(phrase))
      .map(([claim, phrase]) => `${claim}: "${phrase}"`);
    expect(
      missing,
      'The journal record no longer says these parts of the decision. Reword them here and in '
      + 'JOURNAL_DECISION_CLAIMS together, or not at all.',
    ).toEqual([]);
    expect(
      JOURNAL_DECISION_OVERSTATEMENTS.filter((pattern) => pattern.test(prose)).map(String),
      'The journal record overstates the gap: replay refuses a structurally broken stream with a '
      + 'JournalIntegrityError. What stays uncovered is an event edited in place, and the events\' '
      + 'confidentiality.',
    ).toEqual([]);
  });

  test('the in-scope list promises at-rest protection only where the hooks give it', () => {
    const inScope = normalisedProse(policySection('### In scope — everything the mitigations promise'));
    // Guards the guard: an unread section would satisfy both halves below.
    expect(inScope.length).toBeGreaterThan(300);
    expect({
      promisesAtRestEncryptionOfEverything: inScope.includes('at-rest encryption and key rotation'),
      saysWhereTheHooksApply: inScope.includes('that encryption() and integrity() promise for snapshots and durable state'),
    }).toEqual({ promisesAtRestEncryptionOfEverything: false, saysWhereTheHooksApply: true });
  });

  /**
   * A heading of this policy is a link target now: the documentation cites
   * the journal record by its GitHub anchor (#1430).  Nothing else checks such
   * a link — the docs build does not resolve them, and GitHub answers a
   * missing fragment with the top of the file rather than an error — so a
   * renamed heading would leave every citation pointing nowhere while each
   * page still reads as if it linked somewhere.
   */
  test('every link to a SECURITY.md heading lands on one', () => {
    const anchors = new Set(githubAnchors(securityPolicy));
    const links = linksIntoPolicy();
    // Guards the guard: the documentation cites the journal record, so a
    // reader that finds no anchored link at all has stopped seeing the shape
    // those links are written in, and the comparison below is over nothing.
    expect(
      links.length,
      'No page links to a SECURITY.md heading any more, or this reader stopped finding the links. '
      + 'The operations overview and the per-actor policies page cite the journal record by its anchor.',
    ).toBeGreaterThan(0);
    expect(
      links.filter(({ anchor }) => !anchors.has(anchor)).map(({ file, anchor }) => `${file} -> #${anchor}`),
      'These links name a SECURITY.md heading that does not exist, so they open the top of the file. '
      + 'Rename the links with the heading, or keep the heading.',
    ).toEqual([]);
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

  test('the audit gate is still a gate, over every closure it reads', () => {
    // Guards the guard: if the script is renamed or its level relaxed, the
    // bijection below would compare two empty sets and pass — and a reader
    // that stopped seeing the root step would report the same nothing.
    expect(
      auditSteps.map(({ closure }) => closure),
      `${PACKAGE_HEALTH} no longer audits the root closure, or this file no `
      + 'longer recognises the step that does: neither `run: bun run '
      + `${AUDIT_SCRIPT}\` at the root nor a written-out \`bun audit\` was found.`,
    ).toContain('.');
    for (const { closure, command, source } of auditSteps) {
      const lockfileOf = posix.join(closure, 'bun.lock');
      expect(
        command,
        `${source}, the audit over ${lockfileOf}, no longer runs \`bun audit\` — `
        + 'the step is still there and gates nothing.',
      ).toContain('bun audit');
      expect(
        command,
        `${source}, the audit over ${lockfileOf}, must stay at --audit-level=high. `
        + 'Lowering it to critical would make the suppression list below '
        + 'meaningless and stop the gate catching the severity band the closure '
        + 'actually carries; one closure at a laxer level than the others is a '
        + 'gate with a hole in it.',
      ).toContain('--audit-level=high');
    }
  });

  /**
   * The defect class #1413 names: a lockfile CI resolves and no gate reads.
   * The invariant is stated over the installs rather than over a list of
   * lockfiles, so a fourth Bun closure that a workflow starts installing is
   * red here on its first `bun test` unless a step audits it or the list
   * above says, with a reason, why not.
   */
  test('every Bun closure a workflow installs is audited by package-health.yml, or listed as unaudited with its reason', () => {
    const installed = [...new Set(installs.map(({ closure }) => closure))].sort();
    const audited = [...new Set(auditSteps.map(({ closure }) => closure))].sort();
    // Guards the guard: the reader has to have found the root install, or it
    // is reading the wrong shapes and the comparison below is over nothing.
    expect(
      installed,
      'No `bun install` was found in .github/workflows/. Either CI stopped '
      + 'installing anything or this reader stopped seeing it; both are worth '
      + 'failing on.',
    ).toContain('.');

    const unresolvable = installs
      .filter(({ closure }) => GITHUB_EXPRESSION.test(closure))
      .map(({ workflow, line, command }) => `${workflow}:${line} ${command}`);
    expect(
      unresolvable,
      'An install under a matrix working directory names no closure this test '
      + 'can match to an audit step. Write the directory out, or audit each '
      + 'matrix value in package-health.yml.',
    ).toEqual([]);
    expect(
      workflows.flatMap(([name, text]) => defaultWorkingDirectoriesOf(name, text)),
      'A `defaults.run.working-directory` moves every step in its scope, and '
      + 'this test reads a step\'s own `working-directory:` alone — so an '
      + 'install under that default would be attributed to the wrong closure '
      + 'and could pass as the root one. Set the directory on the step, or '
      + 'teach `stepsOf` the default first.',
    ).toEqual([]);
    expect(
      workflows.flatMap(([name, text]) =>
        stepsOf(text).filter(({ keys }) => (keys['uses'] ?? '').startsWith('./')).map(({ line }) => `${name}:${line}`)),
      'A local composite action runs steps this test never reads, so an '
      + 'install inside it would be invisible here (and to WorkflowHygiene). '
      + 'Write the install out in the workflow, or teach the readers to '
      + 'follow `uses: ./` first.',
    ).toEqual([]);

    const unaudited = installed.filter(
      (closure) => !audited.includes(closure) && !UNAUDITED_INSTALLS.has(closure),
    );
    expect(
      unaudited,
      `CI installs these Bun closures and ${PACKAGE_HEALTH} audits none of them: `
      + `${unaudited.map((closure) => posix.join(closure, 'bun.lock')).join(', ')}. `
      + 'A lockfile no gate reads carries whatever advisories it carries until '
      + 'somebody happens to look — docs/bun.lock sat on five high ones with '
      + 'in-range fixes that way (#1413). Add a step with `working-directory` '
      + 'set to the closure (through its manifest\'s `lint:audit` where it has '
      + 'one), put its package.json and bun.lock in both path filters, or list '
      + 'the closure in UNAUDITED_INSTALLS with the reason it stays unread.',
    ).toEqual([]);

    const stale = [...UNAUDITED_INSTALLS.keys()].filter(
      (closure) => !installed.includes(closure) || audited.includes(closure),
    );
    expect(
      stale,
      'Listed in UNAUDITED_INSTALLS, but no workflow installs it any more, or '
      + 'the gate now reads it. Drop the entry: an exemption for a closure that '
      + 'is audited or gone is a reason nobody can check.',
    ).toEqual([]);
  });

  /**
   * A push-triggered gate runs only when its path filter says so. The root
   * closure was always in the filter; a refresh of `docs/bun.lock` that
   * reintroduced an advisory would, without entries of its own, be audited by
   * nothing until the Monday cron — which reports on `develop`, after the
   * change is in, rather than on the pull request that moved the lockfile.
   */
  test('package-health.yml re-runs on a push that moves any closure it audits', () => {
    const filters = pathFiltersOf(packageHealthWorkflow);
    expect(
      filters.map(([trigger]) => trigger),
      `${PACKAGE_HEALTH} no longer declares a \`paths:\` filter on both push `
      + 'and pull_request, so the assertions below have nothing to read.',
    ).toEqual(['push', 'pull_request']);
    for (const { closure } of auditSteps) {
      for (const file of ['package.json', 'bun.lock'] as const) {
        const path = posix.join(closure, file);
        for (const [trigger, paths] of filters) {
          expect(
            paths,
            `${PACKAGE_HEALTH}'s ${trigger} path filter does not list ${path}, so a `
            + 'change to that closure does not re-run the audit that reads it. '
            + 'The step is only a gate on the change if the change triggers it.',
          ).toContain(path);
        }
      }
    }
  });

  /**
   * The pages tell a reader which lockfiles the gate reads, and that sentence
   * was true and incomplete for as long as there was one: it named `bun.lock`
   * while CI installed three. Asserted from the workflow's own steps so that a
   * closure gets its mention when it gets its step, in every language.
   */
  test('SECURITY.md, AGENTS.md and both supply-chain mirrors name every nested lockfile the gate reads', () => {
    const nested = [...new Set(auditSteps.map(({ closure }) => closure))]
      .filter((closure) => closure !== '.')
      .sort();
    // Guards the guard: an empty list satisfies the loop below by asserting
    // nothing, and the gate reading only the root closure is the state #1413
    // found, not a state this test should quietly accept.
    expect(
      nested,
      `${PACKAGE_HEALTH} audits the root closure only. If the nested closures `
      + 'are no longer installed by CI either, this test and the pages that '
      + 'name their lockfiles go together; otherwise the gate has regressed '
      + 'to the shape #1413 reported.',
    ).not.toEqual([]);
    for (const [file, source] of claimSources) {
      for (const closure of nested) {
        const path = posix.join(closure, 'bun.lock');
        expect(
          source,
          `${file} does not name \`${path}\` as a lockfile the advisory gate `
          + 'reads. The pages said the gate reads `bun.lock`, which was true '
          + 'and incomplete while CI installed three closures; every closure '
          + 'the workflow audits is named on every page, in every language.',
        ).toContain(`\`${path}\``);
      }
    }
  });

  test('every suppressed advisory is documented in SECURITY.md', () => {
    expect(
      documentedAdvisories,
      'The "Accepted advisories" table in SECURITY.md and the --ignore flags '
      + 'of the audit steps (every closure the gate reads, taken together) have '
      + 'drifted apart. An advisory silenced in a '
      + 'script but missing from the table is a gate that stopped gating '
      + 'without saying so; an advisory left in the table after its suppression '
      + 'was dropped is a policy claiming risk the project no longer carries. '
      + 'Both halves move together: #779 emptied both at once, and this is '
      + 'what keeps one from coming back without the other.',
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
          ? `${file} no longer says ${JSON.stringify(sentence)}, but no audit `
            + 'step suppresses anything. The sentence is what tells a reader '
            + 'there is no accepted-risk list to go looking for; restore it, or '
            + 'change this test on purpose.'
          : `${file} still says ${JSON.stringify(sentence)}, and the audit now `
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
      ...mirrorSources,
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

    for (const [file, source] of mirrorSources) {
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

/**
 * The closure invariant above is only as good as the reader under it, and a
 * reader that silently misses a shape passes the way an empty list passes. So
 * the shapes it has to see are pinned here against fixtures: the ones CI
 * writes today, the ones #1622 found hidden behind a `package.json` script,
 * and the ones a step could plausibly be rewritten into.
 */
describe('the closure readers behind the audit invariant', () => {
  const workflowOf = (...steps: readonly string[]): string =>
    ['jobs:', '  build:', '    steps:', ...steps].join('\n');

  const noScripts = (): ManifestScripts => ({});

  test('an install names the closure its step, a `cd`, or its own --cwd selects', () => {
    const workflow = workflowOf(
      '      - run: bun install --frozen-lockfile',
      '      - name: Nested',
      "        working-directory: 'docs'",
      '        run: bun install --frozen-lockfile',
      '      - run: bun install --frozen-lockfile --cwd devtools-ui',
      '      - run: cd benchmarks/comparison && bun install --frozen-lockfile',
      '      - run: bun ci',
    );
    expect(installsOf('fixture.yml', workflow, noScripts).map(({ line, closure }) => `${line}:${closure}`))
      .toEqual(['4:.', '5:docs', '8:devtools-ui', '9:benchmarks/comparison', '10:.']);
  });

  test('an install reached through a package.json script counts, in the directory the script runs in', () => {
    const scripts = new Map<string, ManifestScripts>([
      ['.', { 'ui:install': 'bun install --cwd devtools-ui', 'ci:prepare': 'bun run clean && bun run ui:install', clean: 'rm -rf dist' }],
      ['docs', { 'tools:install': 'cd tools && bun install' }],
    ]);
    const scriptsIn = (directory: string): ManifestScripts => scripts.get(directory) ?? {};
    const workflow = workflowOf(
      '      - run: bun run ci:prepare',
      '      - working-directory: docs',
      '        run: bun run tools:install',
    );
    expect(installsOf('fixture.yml', workflow, scriptsIn).map(({ closure, command }) => `${closure} (${command})`))
      .toEqual(['devtools-ui (bun install --cwd devtools-ui)', 'docs/tools (bun install)']);
  });

  test('a dry run, a comment and a block scalar are read for what they are', () => {
    const workflow = workflowOf(
      '      - working-directory: ${{ matrix.directory }}',
      '        run: bun install --frozen-lockfile --dry-run',
      '      # - run: bun install --cwd commented-out',
      '      - run: |',
      '          echo preparing',
      '          # bun install --cwd shell-comment',
      '',
      '          bun install --frozen-lockfile --cwd=tools',
      '      - run: echo done',
    );
    expect(installsOf('fixture.yml', workflow, noScripts).map(({ line, closure }) => `${line}:${closure}`))
      .toEqual(['7:tools']);
  });

  test('CRLF line endings read the same as LF', () => {
    const workflow = workflowOf('      - working-directory: docs', '        run: bun install --frozen-lockfile');
    expect(installsOf('fixture.yml', workflow.replaceAll('\n', '\r\n'), noScripts).map(({ closure }) => closure))
      .toEqual(['docs']);
  });

  test('a folded block, a continuation and doubled spaces do not move an install to the root', () => {
    // Each of these is one command to the shell; a reader working one raw line
    // at a time sees `bun install` alone on a line and files it under `.`.
    const workflow = workflowOf(
      '      - run: >',
      '          bun install --frozen-lockfile',
      '          --cwd docs',
      '      - run: |',
      '          bun install --frozen-lockfile \\',
      '            --cwd devtools-ui',
      '      - run: bun  install   --cwd   benchmarks/comparison',
    );
    expect(installsOf('fixture.yml', workflow, noScripts).map(({ closure }) => closure))
      .toEqual(['docs', 'devtools-ui', 'benchmarks/comparison']);
  });

  test('a job-level default working directory is reported rather than read past', () => {
    const workflow = [
      'jobs:',
      '  build:',
      '    defaults:',
      '      run:',
      '        working-directory: docs',
      '    steps:',
      '      - run: bun install --frozen-lockfile',
      '      - working-directory: devtools-ui',
      '        run: bun install --frozen-lockfile',
    ].join('\n');
    expect(defaultWorkingDirectoriesOf('fixture.yml', workflow)).toEqual(['fixture.yml:5']);
    // What the step reader makes of it without the default — the wrong closure
    // for the first step — is why the default is refused above.
    expect(installsOf('fixture.yml', workflow, noScripts).map(({ closure }) => closure)).toEqual(['.', 'devtools-ui']);
    expect(defaultWorkingDirectoriesOf('fixture.yml', workflowOf('      - working-directory: docs', '        run: bun install'))).toEqual([]);
  });

  test('an audit step is read through its manifest script or as written, in its own directory', () => {
    const steps = auditStepsOf(workflowOf(
      '      - run: bun run lint:audit',
      '      - working-directory: ./docs',
      '        run: bun run lint:audit',
      "      - working-directory: 'devtools-ui'",
      '        run: bun audit --audit-level=high --ignore=GHSA-aaaa-bbbb-cccc',
      '      - run: bun run lint:knip',
    ));
    // A written-out step is located by the line that opens it, as the
    // installs are.
    expect(steps.map(({ closure, source }) => `${closure} <- ${source}`)).toEqual([
      '. <- package.json#scripts.lint:audit',
      'docs <- docs/package.json#scripts.lint:audit',
      `devtools-ui <- .github/workflows/${PACKAGE_HEALTH}:7`,
    ]);
    expect(steps.map(({ command }) => command)).toEqual([
      rootManifest.scripts?.['lint:audit'] ?? '',
      manifestAt('docs').scripts['lint:audit'] ?? '',
      'bun audit --audit-level=high --ignore=GHSA-aaaa-bbbb-cccc',
    ]);
  });

  test('a path filter is read per trigger, quoted or not', () => {
    const workflow = [
      'on:',
      '  push:',
      "    branches: ['**']",
      '    paths:',
      "      - 'src/**'",
      '      - docs/bun.lock',
      '  pull_request:',
      '    paths:',
      '      - "bun.lock"',
      '  schedule:',
      "    - cron: '0 5 * * 1'",
    ].join('\n');
    expect(pathFiltersOf(workflow)).toEqual([
      ['push', ['src/**', 'docs/bun.lock']],
      ['pull_request', ['bun.lock']],
    ]);
  });
});

/**
 * The scope assertions read SECURITY.md through `policySection`, and a reader
 * that sees text GitHub does not render passes on a record nobody can read —
 * so what it drops, and where a section ends, is pinned against fixtures.  The
 * same for the anchor and link readers: a slug computed differently from
 * GitHub's, or a link shape the reader misses, passes the way an empty list
 * passes.
 */
describe('the policy readers behind the scope assertions', () => {
  test('anchors are computed the way GitHub computes them', () => {
    const page = [
      '# Security policy',
      '### Out of scope — the event journal at rest',
      '## The `lint:audit` gate, **in short**',
      '## Scope',
      '## Scope',
      '```sh',
      '# not a heading',
      '```',
      '<!--',
      '## Not a heading either',
      '-->',
      '## Read [the docs](https://example.com) first',
    ].join('\r\n');
    expect(githubAnchors(page)).toEqual([
      'security-policy',
      'out-of-scope--the-event-journal-at-rest',
      'the-lintaudit-gate-in-short',
      'scope',
      'scope-1',
      'read-the-docs-first',
    ]);
  });

  test('a link into SECURITY.md is read by its fragment, and nothing else is', () => {
    const page = [
      'See [`SECURITY.md`](https://github.com/pathosDev/actor-ts/blob/main/SECURITY.md#out-of-scope--the-event-journal-at-rest).',
      'Or [the policy](../../SECURITY.md#scope), or [the whole file](https://github.com/pathosDev/actor-ts/blob/main/SECURITY.md).',
      'A bare mention of SECURITY.md#accepted-advisories is not a link.',
    ].join('\n');
    expect(policyAnchorLinksIn('fixture.mdx', page).map(({ anchor }) => anchor)).toEqual([
      'out-of-scope--the-event-journal-at-rest',
      'scope',
    ]);
  });

  const CLAIM = 'at-rest confidentiality and integrity of the event journal are delegated to the database';

  const policyWith = (body: string): string => [
    '# Policy', '', '## Scope', '', JOURNAL_AT_REST_HEADING, '', body, '',
    '### In scope — everything the mitigations promise', '', 'unrelated', '', '## Next', '',
  ].join('\n');

  const recordOf = (policy: string): string => normalisedProse(policySection(JOURNAL_AT_REST_HEADING, policy));

  test('a section runs to the next heading of its level, through a deeper one, and CRLF reads like LF', () => {
    expect(recordOf(policyWith(CLAIM))).toContain(CLAIM);
    expect(recordOf(policyWith(CLAIM))).not.toContain('unrelated');
    expect(recordOf(policyWith(`#### A detail\n\n${CLAIM}`))).toContain(CLAIM);
    expect(recordOf(policyWith(CLAIM).replaceAll('\n', '\r\n'))).toContain(CLAIM);
  });

  test('nothing a reader cannot see counts as the record saying it', () => {
    expect(recordOf(policyWith(`<!--\n${CLAIM}\n-->`))).not.toContain(CLAIM);
    expect(recordOf(policyWith(`\`\`\`text\n${CLAIM}\n\`\`\``))).not.toContain(CLAIM);
    // ...and a heading inside a comment is no heading.
    expect(policySection(JOURNAL_AT_REST_HEADING, `## Scope\n\n<!--\n${JOURNAL_AT_REST_HEADING}\n\n${CLAIM}\n-->\n`))
      .toBe('');
  });
});
