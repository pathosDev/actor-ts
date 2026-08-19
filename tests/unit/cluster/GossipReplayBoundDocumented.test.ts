/**
 * #112 — a drift guard over the *claim*, not the code.
 *
 * The gossip replay guard shipped with a security claim one qualifier short:
 * that a recorded frame "cannot be played back while its sender is still a
 * member".  Three texts said it — this page in both languages, plus the
 * changelog and roadmap entries — and it is false for the ordinary case, not
 * an edge one: `acceptedGossipSequences` has a single writer and it runs in the
 * gossip path, so a member this node learned **third-party** is an `up` member
 * with no mark at all, and one recorded frame from it merges.
 * `GossipReplayGuard.test.ts` proves that by execution.
 *
 * The claim survived two review passes because nothing checked it.  That is
 * what this file is: prose is where a security boundary is actually
 * communicated, and an unchecked boundary gets rounded up.  Same shape as
 * `tests/unit/ci/SecurityPolicy.test.ts`, which holds `SECURITY.md` to what the
 * audit script suppresses.
 *
 * Deliberately three assertions and no more, each keyed on a *semantic* marker
 * rather than a sentence, so a rewrite that keeps the meaning keeps passing.
 * When the bound genuinely moves — a **required** incarnation identity is what
 * moves it (#940, #823) — the markers move with it. Deleting them instead is
 * the one edit this file exists to prevent.
 *
 * Refs #112, #823, #940.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');

const CLUSTER_SOURCE = 'src/cluster/Cluster.ts';
const ENGLISH_PAGE = 'docs/src/content/docs/operations/security/cluster-security.mdx';
const GERMAN_PAGE = 'docs/src/content/docs/de/operations/security/cluster-security.mdx';

const read = (path: string): string => readFileSync(join(REPOSITORY_ROOT, path), 'utf8');

/**
 * A `### ` section located by a phrase inside it rather than by its heading —
 * the heading is the thing under assertion, so keying on it would make the
 * guard vacuous the moment it drifted.
 */
type Section = {
  readonly heading: string;
  readonly body: string;
};

function sectionAround(path: string, page: string, anchor: string): Section {
  const anchorAt = page.indexOf(anchor);
  if (anchorAt < 0) {
    throw new Error(
      `${path}: the replay section's anchor phrase "${anchor}" is gone, so this guard can no `
      + 'longer find the section it is about — re-point it at the new wording.',
    );
  }
  const headingAt = page.lastIndexOf('\n### ', anchorAt);
  if (headingAt < 0) throw new Error(`${path}: no "### " heading precedes "${anchor}".`);
  const headingEnd = page.indexOf('\n', headingAt + 1);
  const nextTopLevel = page.indexOf('\n## ', headingEnd);
  return {
    heading: page.slice(headingAt + 1, headingEnd),
    body: page.slice(headingEnd, nextTopLevel < 0 ? page.length : nextTopLevel),
  };
}

/** The doc comment attached to a declaration, by exact declaration text. */
function documentationBefore(path: string, source: string, declaration: string): string {
  const declaredAt = source.indexOf(declaration);
  if (declaredAt < 0) throw new Error(`${path}: "${declaration}" is gone — re-point this guard.`);
  const openedAt = source.lastIndexOf('/**', declaredAt);
  if (openedAt < 0) throw new Error(`${path}: "${declaration}" carries no doc comment.`);
  return source.slice(openedAt, declaredAt);
}

const englishPage = read(ENGLISH_PAGE);
const germanPage = read(GERMAN_PAGE);
const englishSection = sectionAround(
  ENGLISH_PAGE, englishPage, 'Every gossip frame therefore carries a **sequence**',
);
const germanSection = sectionAround(
  GERMAN_PAGE, germanPage, 'Jeder Gossip-Frame trägt deshalb eine **Sequence**',
);
const guardDocumentation = documentationBefore(
  CLUSTER_SOURCE, read(CLUSTER_SOURCE), 'private admitsGossipSequence(',
);

/**
 * One marker per way a mark can be absent, in each text's own language.  The
 * middle one is the whole point of the guard: a receiver that has only ever
 * heard *about* a peer holds no mark for it, and the sender is a full member
 * the entire time.
 */
type BoundText = {
  readonly what: string;
  readonly text: string;
  readonly evictedSender: RegExp;
  readonly freshProcess: RegExp;
  readonly learnedThirdParty: RegExp;
  readonly residualCount: RegExp;
};

const BOUND_TEXTS: readonly BoundText[] = [
  {
    what: `${CLUSTER_SOURCE} — the admitsGossipSequence doc comment`,
    text: guardDocumentation,
    evictedSender: /deleteMember/,
    freshProcess: /restarted process/i,
    learnedThirdParty: /third-party/i,
    residualCount: /Three things/,
  },
  {
    what: `${ENGLISH_PAGE} — "${englishSection.heading}"`,
    text: englishSection.body,
    evictedSender: /evict/i,
    freshProcess: /restarted/i,
    learnedThirdParty: /third-party/i,
    residualCount: /Three things this does \*\*not\*\* close/,
  },
  {
    what: `${GERMAN_PAGE} — "${germanSection.heading}"`,
    text: germanSection.body,
    evictedSender: /evakuier/i,
    freshProcess: /neu gestartet/i,
    learnedThirdParty: /über Dritte/i,
    residualCount: /Drei Dinge schließt das \*\*nicht\*\*/,
  },
];

describe('#112 — the replay bound is stated the way the tests measure it', () => {
  test('neither security page heads the section with the disproven bound', () => {
    // The heading is what a reader scans and what the changelog and roadmap
    // entries echoed, so it is the sentence that has to stop claiming a hold
    // that a third-party-learned sender walks straight through.  Asserted on
    // the heading alone, because the body legitimately *quotes* the old wording
    // in order to withdraw it.
    expect(
      englishSection.heading,
      `${ENGLISH_PAGE}: the section is headed "${englishSection.heading}", which claims the guard `
      + 'holds while the sender is a member. It does not — a member learned third-party is `up` '
      + 'with no mark, and GossipReplayGuard.test.ts merges a recording through it.',
    ).not.toMatch(/while its sender is (?:still )?a member/i);
    expect(
      germanSection.heading,
      `${GERMAN_PAGE}: same claim, German side — "${germanSection.heading}".`,
    ).not.toMatch(/solange sein Absender Member ist/i);
  });

  test('all three texts name every way the mark can be missing', () => {
    const silent: string[] = [];
    for (const bound of BOUND_TEXTS) {
      const missing: string[] = [];
      if (!bound.evictedSender.test(bound.text)) missing.push('an evicted sender');
      if (!bound.freshProcess.test(bound.text)) missing.push('a fresh or restarted process');
      if (!bound.learnedThirdParty.test(bound.text)) missing.push('a member learned third-party');
      if (missing.length > 0) silent.push(`  ${bound.what}\n      silent on: ${missing.join(', ')}`);
    }
    expect(
      silent,
      `${silent.length} text(s) state #112's bound without naming every way a high-water mark can `
      + `be absent:\n${silent.join('\n')}\n`
      + 'All three admit a recording, and only the first was ever written down. The other two are '
      + 'asserted by execution in tests/unit/cluster/GossipReplayGuard.test.ts — the prose has to '
      + 'agree with them, or the next reader credits the guard with a hold it does not have.',
    ).toEqual([]);
  });

  test('both security pages count the same residuals, and the code agrees', () => {
    // The bilingual mirror is 1:1 by project rule, and a count is the cheapest
    // half of that to get wrong: the pages disagreed on "two" for a while
    // because only one of them had been re-measured.
    const miscounted = BOUND_TEXTS
      .filter((bound) => !bound.residualCount.test(bound.text))
      .map((bound) => `  ${bound.what}`);
    expect(
      miscounted,
      `${miscounted.length} text(s) no longer say there are three residuals:\n`
      + `${miscounted.join('\n')}\n`
      + 'If a required incarnation identity has landed (#823, #940) the count genuinely drops — '
      + 'move all three texts and the counterfactuals in GossipReplayGuard.test.ts together.',
    ).toEqual([]);
  });
});
