/**
 * **What the system queue documents as its producers is what actually enqueues
 * onto it** (#794).
 *
 * The argument for leaving that lane unbounded is a claim about *volume*: every
 * envelope on it is paid for by an event that already cost the node an actor,
 * so a peer that can queue N of them has already made the node hold N cells.
 * That argument is only as good as its list of what goes on the queue — and
 * #794 shipped a list with a message on it that nothing emits.
 *
 * `watchNotify` is declared in `SystemCommand` and dispatched by
 * `ActorCell.handleSystemCommand`, and no caller anywhere in `src/` produces
 * one; the cell's own JSDoc says so ("Currently unreachable — nothing in the
 * framework emits `watchNotify`").  A watched death does not travel this lane
 * at all: `_notifyWatcher` reaches a local watcher through
 * `postSignalEnvelope`, which is the *user* lane, exempt from the bound but
 * still behind everything already told to that watcher.  So "one `watchNotify`
 * per watched death" named a producer that does not exist, and the mailboxes
 * page repeated it as "one signal per ... watched death" in both languages —
 * three sentences after the same page says a `Terminated` is a user message.
 *
 * Naming a phantom producer is the harmless half.  The list also *omitted*
 * `recreate`, which supervision genuinely enqueues on every `Directive.Restart`
 * — so the enumeration was wrong in both directions, and nothing noticed.
 *
 * ## What this guard does
 *
 * It derives the producer set from the tree rather than trusting either piece
 * of prose: every `enqueueSystem({ kind: '...' })` under `src/`.  Then it holds
 * the JSDoc's enumeration to exactly that set, and holds each mailboxes page to
 * naming only real producers.  Adding a system-message source now turns this
 * red, which is precisely the re-check the JSDoc asks a reader to perform.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const SOURCE_ROOT = join(REPOSITORY_ROOT, 'src');
const SYSTEM_COMMAND_SOURCE = join(SOURCE_ROOT, 'internal', 'SystemCommand.ts');
const MAILBOX_SOURCE = join(SOURCE_ROOT, 'internal', 'Mailbox.ts');
const DOCUMENTATION_ROOT = join(REPOSITORY_ROOT, 'docs', 'src', 'content', 'docs');

/**
 * The one declared variant with no producer, and the reason it stays declared.
 *
 * Checked in both directions — an entry that has grown a producer fails too —
 * the shape `NoDeadConfigKeys`' `KNOWN_DEAD_KEYS` has, so wiring `watchNotify`
 * up cannot land while the enumerations still leave it out.
 */
const KINDS_WITH_NO_PRODUCER: ReadonlyMap<string, string> = new Map([
  ['watchNotify', 'kept exempt from the bound so a later wiring cannot take the ordinary door (#729)'],
]);

/**
 * The paragraph on each mailboxes page that enumerates what fills the queue,
 * found by the bold lead it opens with.
 *
 * Per language, because the lead is translated — and the lead is the anchor
 * rather than the section, so the check reads the enumeration itself and not
 * the surrounding passage that legitimately talks about death watch.
 */
const SYSTEM_QUEUE_PARAGRAPHS: ReadonlyMap<string, { readonly page: string; readonly lead: string }> =
  new Map([
    ['en', {
      page: join(DOCUMENTATION_ROOT, 'fundamentals', 'mailboxes.mdx'),
      lead: '**A mailbox capacity bounds the user queue only.**',
    }],
    ['de', {
      page: join(DOCUMENTATION_ROOT, 'de', 'fundamentals', 'mailboxes.mdx'),
      lead: '**Eine Mailbox-Kapazität begrenzt nur die User-Queue.**',
    }],
  ]);

/**
 * How each language spells the claim that a watched death fills this queue.
 *
 * Narrow on purpose: a paragraph may still *contrast* the two lanes — that is
 * the useful thing to say — so what is refused is the attribution, not the
 * subject.
 */
const WATCHED_DEATH_AS_PRODUCER: ReadonlyMap<string, RegExp> = new Map([
  ['en', /watched death/i],
  ['de', /beobachtete[mnrs]?\s+Tod/i],
]);

/* -------------------------------- scanning -------------------------------- */

const typeScriptFilesUnder = (directory: string): string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...typeScriptFilesUnder(path));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
};

const matchesOf = (text: string, pattern: RegExp): string[] =>
  [...text.matchAll(pattern)].map((match) => match[1]!);

/** Every `kind` the `SystemCommand` union declares. */
const declaredKinds = (): ReadonlySet<string> =>
  new Set(matchesOf(readFileSync(SYSTEM_COMMAND_SOURCE, 'utf8'), /readonly kind: '([A-Za-z]+)'/g));

/**
 * Every `kind` some caller in `src/` actually puts on the system queue.
 *
 * Matched at the call site rather than by reading the union, which is the whole
 * point: a declared variant nobody sends is exactly what went undetected.  The
 * cell's own forwarding hop (`this.mailbox.enqueueSystem({ message, sender })`)
 * carries no `kind` literal and so does not register as a producer.
 */
const producedKinds = (): ReadonlySet<string> => {
  const produced = new Set<string>();
  for (const file of typeScriptFilesUnder(SOURCE_ROOT)) {
    const source = readFileSync(file, 'utf8');
    for (const kind of matchesOf(source, /enqueueSystem\(\s*\{\s*kind:\s*'([A-Za-z]+)'/g)) {
      produced.add(kind);
    }
  }
  return produced;
};

/** Backticked `SystemCommand` kinds named in a passage, deduplicated. */
const kindsNamedIn = (passage: string, kinds: ReadonlySet<string>): ReadonlySet<string> =>
  new Set([...kinds].filter((kind) => passage.includes(`\`${kind}\``)));

const sorted = (kinds: ReadonlySet<string>): string[] => [...kinds].sort();

/**
 * The paragraph of the `enqueueSystem` JSDoc that enumerates its producers.
 *
 * Anchored on its bold lead and ended at the next blank JSDoc line, so the rest
 * of the block — which legitimately names `watchNotify` as the declared variant
 * nothing sends — is not read as an enumeration of producers.
 */
const producerParagraph = (source: string): string => {
  const start = source.indexOf('**What bounds it instead is the producer');
  expect(start).toBeGreaterThan(-1);
  const lines = source.slice(start).split(/\r?\n/);
  const end = lines.findIndex((line) => line.trim() === '*');
  expect(end).toBeGreaterThan(0);
  return lines.slice(0, end).join(' ');
};

/** One MDX paragraph, from the bold lead that opens it to the next blank line. */
const paragraphFrom = (page: string, lead: string): string => {
  const start = page.indexOf(lead);
  expect(start).toBeGreaterThan(-1);
  const lines = page.slice(start).split(/\r?\n/);
  const end = lines.findIndex((line) => line.trim() === '');
  expect(end).toBeGreaterThan(0);
  return lines.slice(0, end).join(' ');
};

/* ------------------------------- the invariant ---------------------------- */

describe('the system queue names its real producers — #794', () => {
  test('exactly one declared SystemCommand has no producer in src/', () => {
    const dormant = sorted(new Set([...declaredKinds()].filter((kind) => !producedKinds().has(kind))));

    // Both directions: a variant that grew a producer has to leave this map, and
    // a variant that lost its last one has to enter it — either way the
    // enumerations below have to be revisited in the same change.
    expect(dormant).toEqual(sorted(new Set(KINDS_WITH_NO_PRODUCER.keys())));
  });

  test("Mailbox.enqueueSystem's JSDoc enumerates exactly the real producers", () => {
    const produced = producedKinds();
    const paragraph = producerParagraph(readFileSync(MAILBOX_SOURCE, 'utf8'));

    // The argument for the absent bound is "one envelope per event that already
    // costs the node an actor", so the list has to be the list.  A phantom on it
    // makes the argument cover traffic that does not exist; a missing one leaves
    // a real source unaccounted for.
    expect(sorted(kindsNamedIn(paragraph, declaredKinds()))).toEqual(sorted(produced));
  });

  for (const [language, { page, lead }] of SYSTEM_QUEUE_PARAGRAPHS) {
    test(`the mailboxes page attributes only real producers to it (${language})`, () => {
      const paragraph = paragraphFrom(readFileSync(page, 'utf8'), lead);
      const produced = producedKinds();

      // A watched death rides the *user* lane through `postSignalEnvelope`, which
      // is what the same section says three sentences earlier.  Counting it here
      // contradicts the lane distinction inside the paragraph that is the whole
      // argument for the lane being unbounded.
      expect(paragraph).not.toMatch(WATCHED_DEATH_AS_PRODUCER.get(language)!);

      // Named in code rather than described in prose, so the claim is checkable
      // at all — and identical in both languages, which is the rule the mirrored
      // pages already follow.
      const named = kindsNamedIn(paragraph, declaredKinds());
      expect(sorted(new Set([...named].filter((kind) => !produced.has(kind))))).toEqual([]);
      expect(named.has('childTerminated')).toBe(true);
      expect(named.has('failure')).toBe(true);
    });
  }
});
