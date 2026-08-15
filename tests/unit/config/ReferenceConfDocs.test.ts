import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';

/**
 * The docs publish the bundled reference configuration verbatim so a reader
 * can see everything that is settable in one place.  A hand-copied file is
 * exactly the drift surface #653 was about — a documented default that no
 * longer matches the shipped one is the same lie as a documented key nothing
 * reads — so the copy is pinned to the source here instead of to nobody.
 *
 * Both languages carry the identical block: house rule is that code samples
 * stay the same across translations and only prose is translated.
 */

const DOCS_ROOT = join(import.meta.dir, '..', '..', '..', 'docs', 'src', 'content', 'docs');

const PAGES = [
  ['English', join(DOCS_ROOT, 'reference', 'reference-conf.mdx')],
  ['German', join(DOCS_ROOT, 'de', 'reference', 'reference-conf.mdx')],
] as const;

/**
 * The page's `actor-ts { … }` HOCON block.  Anchored on the opening brace
 * rather than on "the first hocon fence": both pages lead with a short
 * application.conf example, and matching that one instead would compare the
 * wrong thing while still looking like it passed.
 */
function referenceBlockOf(page: string): string | null {
  const fences = page.matchAll(/```hocon\r?\n([\s\S]*?)```/g);
  for (const fence of fences) {
    const body = fence[1]!.trimEnd();
    if (body.startsWith('actor-ts {')) return body.replace(/\r\n/g, '\n');
  }
  return null;
}

describe('the docs reproduce reference.conf verbatim', () => {
  test.each(PAGES)('%s page matches REFERENCE_CONF', (_language, path) => {
    const block = referenceBlockOf(readFileSync(path, 'utf8'));

    expect(block, `${path} has no fenced hocon block starting with "actor-ts {"`).not.toBeNull();
    expect(
      block,
      'The published reference configuration has drifted from src/config/Reference.ts. '
      + 'Copy REFERENCE_CONF into the hocon block on both language pages.',
    ).toBe(REFERENCE_CONF.replace(/\r\n/g, '\n'));
  });
});
