import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * The German chat-sample page translates the comments inside its code blocks.
 *
 * `AGENTS.md` asks for the mirror's prose to be translated and its code to
 * stay identical, and a comment sits on the line between the two.  The
 * convention the repository actually follows is that it counts as prose: the
 * sibling page `de/examples/overview.mdx` translated its comment in the same
 * commit that left this page's three in English, which is what makes this an
 * inconsistency rather than a policy.
 *
 * Asserted as a property of the pair rather than as three expected strings:
 * no comment inside a fenced block on the German page may appear verbatim
 * inside a fenced block on the English one.  That is what "translated" means
 * here operationally, it needs no list to maintain, and it goes red on a
 * revert or on a newly-added English comment.  The commands themselves are
 * deliberately not compared — they are supposed to be identical, and the
 * assertion below would be wrong if it touched them.
 */

const ENGLISH_PAGE = 'docs/src/content/docs/examples/chat-sample.mdx';
const GERMAN_PAGE = 'docs/src/content/docs/de/examples/chat-sample.mdx';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');

type FenceComment = {
  readonly lineNumber: number;
  readonly text: string;
};

/** Every `#` comment line inside a fenced code block, with its line number. */
function fenceComments(relativePath: string): ReadonlyArray<FenceComment> {
  const lines = readFileSync(join(repositoryRoot, relativePath), 'utf8').split(/\r?\n/);
  const comments: FenceComment[] = [];
  let insideFence = false;
  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) {
      insideFence = !insideFence;
      return;
    }
    if (insideFence && /^\s*#/.test(line)) {
      comments.push({ lineNumber: index + 1, text: line.trim() });
    }
  });
  return comments;
}

describe('the German chat-sample mirror translates its code comments', () => {
  test('both pages have code comments at all, so the check is not vacuous', () => {
    // Without this a page whose fences lost their comments — or a fence-parser
    // that stopped matching — would pass by having nothing to compare.
    expect(fenceComments(ENGLISH_PAGE).length).toBeGreaterThan(0);
    expect(fenceComments(GERMAN_PAGE).length).toBeGreaterThan(0);
  });

  test('no German code comment is still the English one', () => {
    const english = new Set(fenceComments(ENGLISH_PAGE).map((comment) => comment.text));
    const untranslated = fenceComments(GERMAN_PAGE)
      .filter((comment) => english.has(comment.text));

    expect(
      untranslated.map((comment) => `${GERMAN_PAGE}:${comment.lineNumber}  ${comment.text}`),
      'these comments are byte-identical to the English page',
    ).toEqual([]);
  });
});
