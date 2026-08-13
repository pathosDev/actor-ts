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

const workflows: readonly WorkflowFile[] = readdirSync(WORKFLOW_DIRECTORY)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .map((name) => ({
    name,
    lines: readFileSync(join(WORKFLOW_DIRECTORY, name), 'utf8').split('\n'),
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

describe('workflow hygiene', () => {
  test('the workflow directory actually parsed', () => {
    // Guards the guard: a path or parser regression that yielded nothing
    // would make every assertion below vacuously pass.
    expect(workflows.map((workflow) => workflow.name)).toContain('publish.yml');
    expect(workflows.length).toBeGreaterThanOrEqual(11);
    expect(references.length).toBeGreaterThanOrEqual(30);
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
});
