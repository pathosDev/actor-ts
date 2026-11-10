/**
 * The page that tells an operator to size a capacity against measured heap
 * says which queue that capacity bounds (#1509, #794).
 *
 * `Mailbox.enqueueSystem`'s JSDoc issues the instruction — "a capacity an
 * operator tunes against measured heap is a user-queue capacity; say so when
 * you document one" — and the commit that wrote it put the new paragraph on
 * the concepts page instead.  The one page in the repository that documents
 * tuning a capacity against measured heap is this one, and its "Picking
 * capacity" list still said `capacity × bytes_per_message` bounds *the*
 * memory cost, flat.  The qualification existed on the page only ninety lines
 * earlier, in past tense, inside the historical passage explaining why #310
 * was reverted — which is not where a reader sizing a mailbox is looking.
 *
 * That gap is the whole reason the system lane is unbounded on purpose: the
 * argument is that its volume is paid for by events that already cost the
 * node an actor, and it is only safe while an operator knows the capacity
 * they picked does not cover it.  A per-message-memory formula presented
 * without that caveat says the opposite by omission.
 *
 * Anchored on the section rather than the page, so the fact has to be where
 * the sizing happens rather than anywhere in four hundred lines.  Both
 * languages, because the pages are mirrors and a caveat that exists in one
 * language is a caveat half the readers do not get.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const DOCUMENTATION_ROOT = join(
  import.meta.dir, '..', '..', '..', 'docs', 'src', 'content', 'docs',
);

/**
 * The sizing section of each page, and how each language spells "user queue".
 *
 * The heading is matched by a substring unique to that page in that language;
 * the claim is matched by a regular expression because German inflects the
 * compound and English hyphenates it in attributive position.
 */
const SIZING_SECTIONS: ReadonlyMap<string, {
  readonly page: string;
  readonly heading: string;
  readonly userQueue: RegExp;
}> = new Map([
  ['en', {
    page: join(DOCUMENTATION_ROOT, 'operations', 'tuning', 'mailbox-sizing.mdx'),
    heading: 'Picking capacity',
    userQueue: /user[ -]queue/i,
  }],
  ['de', {
    page: join(DOCUMENTATION_ROOT, 'de', 'operations', 'tuning', 'mailbox-sizing.mdx'),
    heading: 'Kapazität wählen',
    userQueue: /User-Queue/i,
  }],
]);

/** One `## ` section of an MDX page, found by a substring of its heading. */
const sectionOf = (page: string, headingContains: string): string => {
  const lines = page.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('## ') && line.includes(headingContains));
  expect(start).toBeGreaterThan(-1);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
};

/**
 * The one numbered item of an ordered list that contains `marker`.
 *
 * The item and not the section, because the section is where the caveat was
 * already technically true and still useless: an operator reads the factor
 * they are about to multiply, not the three around it.  Measured — with the
 * qualification moved one item down, onto the latency factor, a check over
 * the whole section stays green.
 */
const listItemContaining = (section: string, marker: string): string => {
  const items = section.split(/\n(?=\d+\. )/);
  const found = items.filter((item) => item.includes(marker));
  expect(found).toHaveLength(1);
  return found[0]!;
};

describe('the sizing page qualifies what a capacity bounds — #1509', () => {
  for (const [language, { page, heading, userQueue }] of SIZING_SECTIONS) {
    test(`the per-message memory factor names the user queue (${language})`, () => {
      const section = sectionOf(readFileSync(page, 'utf8'), heading);

      // The memory factor is the one that has to carry it: the latency factor
      // divides by a drain rate and is about the queue the consumer reads from
      // either way, while this one is the arithmetic an operator takes away
      // and applies to a heap number.
      expect(listItemContaining(section, 'bytes_per_message')).toMatch(userQueue);
    });
  }
});
