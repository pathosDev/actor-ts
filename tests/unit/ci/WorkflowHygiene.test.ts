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

/** Anything that fetches and executes somebody else's code on the runner. */
const INSTALL_COMMAND = /\b(bun install|bunx|npm ci|npm install|npx|pnpm install|yarn install)\b/;

const declaresPermissions = (file: WorkflowFile): boolean =>
  file.lines.some((line) => /^permissions:/.test(line))
  || jobsOf(file).every((job) => job.lines.some((line) => /^\s+permissions:/.test(line)));

describe('workflow hygiene', () => {
  test('the workflow directory actually parsed', () => {
    // Guards the guard: a path or parser regression that yielded nothing
    // would make every assertion below vacuously pass.
    expect(workflows.map((workflow) => workflow.name)).toContain('publish.yml');
    expect(workflows.length).toBeGreaterThanOrEqual(11);
    expect(references.length).toBeGreaterThanOrEqual(30);
    expect(jobs.length).toBeGreaterThanOrEqual(workflows.length);
    expect(jobs.map((job) => `${job.workflow}#${job.name}`)).toContain('docs.yml#deploy');
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
   * #621 — a workflow-level `permissions:` block is granted to every job in
   * the file, including the ones that install and execute third-party code.
   * That is how `docs.yml`'s build job came to hold `pages: write` +
   * `id-token: write` while its only Pages step needed neither.
   *
   * So the workflow-level block is a read-only floor and nothing more; a
   * scope that can change anything belongs on the single job that uses it.
   */
  test.each(workflows)('$name grants no write scope at workflow level', (file) => {
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
  test.each(workflows)('$name states its token permissions explicitly', (file) => {
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
