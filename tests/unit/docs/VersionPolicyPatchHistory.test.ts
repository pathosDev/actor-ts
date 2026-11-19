import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * The version policy owns up to every patch release that broke something
 * (#1004).
 *
 * The page promised "patch versions — bug fixes, no breaking changes" while
 * 0.12.1 and 0.12.2 each shipped an entry the CHANGELOG itself marks
 * `BREAKING`.  A caret or tilde range installs a patch without asking, so the
 * promise was the one sentence a consumer relies on when choosing a range, and
 * the release history contradicted it.
 *
 * The CHANGELOG is the record, so the page is held to it: every released patch
 * section (`## [0.x.Y]` with `Y > 0`) that carries a `BREAKING` marker has to
 * be named, in bold, on the page in both languages — and a future patch that
 * breaks something turns this red until the page says so.  The 0.12.2 encoding
 * change is the case where a rolling deploy mixes old readers with new rows,
 * so the page has to send the reader to the rolling-migration recipe as well.
 *
 * What this cannot see: whether the sentence around a version describes the
 * break correctly.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const DOCUMENTATION_ROOT = join(REPOSITORY_ROOT, 'docs', 'src', 'content', 'docs');

const PAGES = [
  { language: 'en', path: join(DOCUMENTATION_ROOT, 'reference', 'version-policy.mdx'), rollingMigration: '](/operations/upgrades/rolling-migration/)' },
  { language: 'de', path: join(DOCUMENTATION_ROOT, 'de', 'reference', 'version-policy.mdx'), rollingMigration: '](/de/operations/upgrades/rolling-migration/)' },
] as const;

function readNormalised(path: string): string {
  return readFileSync(path, 'utf8').split(/\r?\n/).join('\n');
}

/** Released patch versions whose CHANGELOG section carries a `BREAKING` marker. */
function breakingPatchReleases(): string[] {
  const changelog = readNormalised(join(REPOSITORY_ROOT, 'CHANGELOG.md'));
  const headings = [...changelog.matchAll(/^## \[(\d+)\.(\d+)\.(\d+)\][^\n]*$/gm)];
  const out: string[] = [];
  headings.forEach((heading, index) => {
    if (heading[3] === '0') return;
    const end = index + 1 < headings.length ? headings[index + 1]!.index : changelog.length;
    if (changelog.slice(heading.index, end).includes('BREAKING')) {
      out.push(`${heading[1]}.${heading[2]}.${heading[3]}`);
    }
  });
  return out;
}

describe('version policy against the patch history (#1004)', () => {
  const releases = breakingPatchReleases();

  test('the CHANGELOG scan finds the two known breaking patches', () => {
    // Not vacuous: a heading format the scan stopped matching would otherwise
    // leave every page check below green over an empty list.
    expect(releases).toEqual(expect.arrayContaining(['0.12.1', '0.12.2']));
  });

  for (const page of PAGES) {
    test(`${page.language}: every breaking patch release is named on the page`, () => {
      const text = readNormalised(page.path);
      const missing = releases.filter((version) => !text.includes(`**${version}**`));
      expect(missing).toEqual([]);
    });

    test(`${page.language}: the page sends a patch upgrade to the rolling-migration recipe`, () => {
      expect(readNormalised(page.path)).toContain(page.rollingMigration);
    });
  }
});
