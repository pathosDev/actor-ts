import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * `src/devtools/generated/UiAssets.ts` carries the DevTools UI as base64,
 * and **review is the only thing that ever looks at those bytes.**
 *
 * `bun run check:ui` proves the committed `source-hash` matches the sources
 * it claims; it deliberately does not compare the bundle's bytes, because
 * they are not reproducible across operating systems and Bun releases. So a
 * payload edited without touching `devtools-ui/**` passes every automated
 * gate the project has. It is visible in a diff — `gzipBase64`, `size` and
 * `etag` move while `source-hash` and the UI sources stay put — and that is
 * the whole control (#620).
 *
 * The `-diff` attribute used to make git and GitHub report the module as
 * binary, which removed even that. Nothing else would notice it coming
 * back: it is one token, `bun run typecheck` cannot see `.gitattributes`,
 * and the change reads like noise reduction to whoever is annoyed by
 * `git show`. Hence this test.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const GENERATED_MODULE = 'src/devtools/generated/UiAssets.ts';

const rule = readFileSync(join(REPOSITORY_ROOT, '.gitattributes'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .find((line) => line.startsWith(GENERATED_MODULE));

describe('UiAssets.ts stays reviewable', () => {
  test('.gitattributes has a rule for the generated module', () => {
    // Guards the guard: without the rule, every assertion below is vacuous.
    expect(rule, `no .gitattributes line covers ${GENERATED_MODULE}`).toBeDefined();
  });

  test('the generated bundle is not hidden from diffs', () => {
    expect(
      rule?.split(/\s+/),
      'Restoring "-diff" makes git and GitHub report UiAssets.ts as binary. '
      + 'check:ui hashes the UI sources, not the embedded payload, so review '
      + 'is the only check the payload ever gets — see AGENTS.md, DevTools UI.',
    ).not.toContain('-diff');
  });

  test('the generated bundle stays collapsed and LF-normalised', () => {
    // The other three tokens each do a job `-diff` does not, and dropping
    // them is the plausible over-correction: `linguist-generated` keeps the
    // module out of the language stats and collapsed in review, and
    // `text eol=lf` is what makes the source-hash identical on Windows and
    // Linux checkouts (scripts/build-devtools-ui.mjs).
    const tokens = rule?.split(/\s+/) ?? [];
    expect(tokens).toContain('linguist-generated');
    expect(tokens).toContain('text');
    expect(tokens).toContain('eol=lf');
  });
});
