import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MongoDurableStateStoreOptionsValidator } from '../../../src/persistence/durable-state-stores/MongoDurableStateStoreOptions.js';
import { MongoJournalOptionsValidator } from '../../../src/persistence/journals/MongoJournalOptions.js';
import { MongoSnapshotStoreOptionsValidator } from '../../../src/persistence/snapshot-stores/MongoSnapshotStoreOptions.js';

/**
 * #1490 — the MongoDB journal page says, in both languages, that a replica-set
 * seed list is accepted, and the url it quotes is held to the claim.
 *
 * A phrase check alone cannot tell a claim from its negation, so the claim is
 * pinned three ways: every seed-list url the page quotes in prose is run
 * through the three validators the stores are constructed with; every sentence
 * quoting one says it is accepted and negates nothing; and the two languages
 * quote the same urls.  Prose means what a reader sees — fenced code and MDX
 * comments are dropped first, so a claim parked in either does not count.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');

type Page = {
  readonly language: string;
  readonly path: string;
  /**
   * The claim as one proposition, the same in both languages.  The whole
   * clause rather than the verb: "is accepted no more" carries the verb too.
   */
  readonly accepted: RegExp;
  /** Words that would turn the sentence against it, as a backstop. */
  readonly negation: RegExp;
};

const PAGES: ReadonlyArray<Page> = [
  {
    language: 'en',
    path: 'docs/src/content/docs/persistence/journals/mongodb.mdx',
    accepted: /\bis accepted as the driver accepts it\b/,
    negation: /\b(?:not|never|no longer|no more|refused|rejected|refuses|rejects)\b/i,
  },
  {
    language: 'de',
    path: 'docs/src/content/docs/de/persistence/journals/mongodb.mdx',
    accepted: /\bwird angenommen, wie der Treiber sie annimmt\b/,
    negation: /\b(?:nicht|nie|nicht mehr|abgelehnt|zurückgewiesen|lehnt)\b/i,
  },
];

/**
 * An inline code span holding a url whose host list names more than one host.
 * `mongodb+srv://` counts too, so a page claiming such a list is accepted is
 * contradicted by the validators, which refuse it.
 */
const SEED_LIST_SPAN = /`(mongodb(?:\+srv)?:\/\/[^`/?]*,[^`]*)`/;

const VALIDATORS: ReadonlyArray<(url: string) => void> = [
  (url) => new MongoJournalOptionsValidator().validate({ url }),
  (url) => new MongoSnapshotStoreOptionsValidator().validate({ url }),
  (url) => new MongoDurableStateStoreOptionsValidator().validate({ url }),
];

/** What a reader sees: line endings normalised, fenced code and MDX comments dropped. */
function proseOf(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/^[ \t]*```[\s\S]*?^[ \t]*```/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

/** The prose as sentences, each paragraph's line breaks folded into spaces. */
function sentencesOf(prose: string): string[] {
  return prose
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .flatMap((paragraph) => paragraph.split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ`])/));
}

/** Every seed-list url quoted in the prose, in order. */
function seedListsOf(prose: string): string[] {
  return [...prose.matchAll(new RegExp(SEED_LIST_SPAN.source, 'g'))].map((match) => match[1]!);
}

const read = (path: string): string => readFileSync(join(REPOSITORY_ROOT, path), 'utf8');

describe('the MongoDB page says a seed list is accepted (#1490)', () => {
  for (const page of PAGES) {
    test(`${page.language}: every sentence quoting a seed list says it is accepted`, () => {
      const sentences = sentencesOf(proseOf(read(page.path))).filter((sentence) => SEED_LIST_SPAN.test(sentence));
      expect(sentences.length).toBeGreaterThan(0);
      for (const sentence of sentences) {
        expect(sentence).toMatch(page.accepted);
        expect(sentence).not.toMatch(page.negation);
      }
    });

    test(`${page.language}: every seed list the page quotes passes all three validators`, () => {
      const urls = seedListsOf(proseOf(read(page.path)));
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) {
        for (const validate of VALIDATORS) expect(() => validate(url)).not.toThrow();
      }
    });
  }

  test('both languages quote the same seed lists', () => {
    const [english, german] = PAGES.map((page) => seedListsOf(proseOf(read(page.path))));
    expect(german).toEqual(english);
  });
});
