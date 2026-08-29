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
 * Every assertion is keyed on a *semantic* marker rather than a sentence, so a
 * rewrite that keeps the meaning keeps passing.  When the bound genuinely moves
 * — a **required** incarnation identity is what moves it (#823) — the markers
 * move with it. Deleting them instead is the one edit this file exists to
 * prevent.
 *
 * `ROADMAP.md` joined the guarded set once its two #112 passages were corrected
 * to match: the roadmap is the one text whose stated purpose is to keep a
 * conclusion from being re-derived, so a wrong one there costs more than
 * elsewhere, and it is also the text most likely to be edited by someone with
 * no reason to open the security page.  It carries a second marker the pages do
 * not, because it is where a reader goes to find out *which issue* to follow:
 * #940 landed the incarnation as an optional field and deliberately did not act
 * on it, and an optional field is bypassed by stripping it — so the issue that
 * gates a refusal is #823, the wire break that makes the field required.
 *
 * Know this guard's own reach: `test.yml` filters on `src/**` and `tests/**`,
 * so a commit that touches *only* one of the four texts does not run it.  It
 * fires locally, and on any push that also carries code — which is the shape a
 * correction to these texts has had every time so far.  Widening that filter is
 * a workflow change, not a test one.
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
const ROADMAP = 'ROADMAP.md';

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

/**
 * A `-` bullet located by a phrase inside it and sliced to the next bullet at
 * the same indent.  `ROADMAP.md` has no headings at the depth these passages
 * live at, so the bullet is the unit a reader takes the claim from — and the
 * indent has to be passed in, because a shallower marker would swallow the
 * sibling bullets that follow and a deeper one would not match at all.
 */
function bulletAround(path: string, document: string, anchor: string, marker: string): string {
  const anchorAt = document.indexOf(anchor);
  if (anchorAt < 0) {
    throw new Error(
      `${path}: the anchor phrase "${anchor}" is gone, so this guard can no longer find the `
      + 'bullet it is about — re-point it at the new wording.',
    );
  }
  const openedAt = document.lastIndexOf(marker, anchorAt);
  if (openedAt < 0) throw new Error(`${path}: no "${marker.trim()} " bullet precedes "${anchor}".`);
  const nextSibling = document.indexOf(marker, anchorAt);
  return document.slice(openedAt, nextSibling < 0 ? document.length : nextSibling);
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
const roadmap = read(ROADMAP);
/** The wave retrospective, anchored on the subject rather than the claim. */
const roadmapResidual = bulletAround(ROADMAP, roadmap, "#112's guard", '\n  - ');
/** The `[Unreleased]` heads bullet, which is where the open items are listed. */
const roadmapOpenItems = bulletAround(ROADMAP, roadmap, 'the residual security items', '\n- ');

/**
 * One marker per way a mark can be absent, in each text's own language.  The
 * middle one is the whole point of the guard: a receiver that has only ever
 * heard *about* a peer holds no mark for it, and the sender is a full member
 * the entire time.
 *
 * `residualCount` is optional because only the two pages and the code comment
 * enumerate what the guard leaves open; the roadmap states the bound and points
 * at the issue, which is a different job and a different count.
 */
type BoundText = {
  readonly what: string;
  readonly text: string;
  readonly evictedSender: RegExp;
  readonly freshProcess: RegExp;
  readonly learnedThirdParty: RegExp;
  readonly residualCount?: RegExp;
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
  {
    what: `${ROADMAP} — the wave retrospective on #112`,
    text: roadmapResidual,
    evictedSender: /evicted/i,
    freshProcess: /restarted process/i,
    learnedThirdParty: /third-party/i,
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
    // The roadmap needs the same negative, and for a sharper reason than the
    // pages do: its guard is otherwise keyword presence alone, so a passage can
    // name all three ways the mark can be missing *while denying they matter*
    // and still pass every other assertion here.  Verified by writing exactly
    // such a bullet and watching this file stay green without this line.
    expect(
      roadmapResidual,
      `${ROADMAP}: the retrospective claims the guard holds while the sender is `
      + 'a member. It does not, and this file exists because that wording '
      + 'survived two review passes in three places.',
    ).not.toMatch(/holds (?:only )?while (?:its |the )?sender is (?:still )?a member/i);
  });

  test('every guarded text names every way the mark can be missing', () => {
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
      + 'All three ways admit a recording, and only the first was ever written down. The other '
      + 'two are asserted by execution in tests/unit/cluster/GossipReplayGuard.test.ts — the prose '
      + 'has to agree, or the next reader credits the guard with a hold it does not have.',
    ).toEqual([]);
  });

  test('both security pages count the same residuals, and the code agrees', () => {
    // The bilingual mirror is 1:1 by project rule, and a count is the cheapest
    // half of that to get wrong: the pages disagreed on "two" for a while
    // because only one of them had been re-measured.
    const miscounted = BOUND_TEXTS
      .filter((bound) => bound.residualCount !== undefined && !bound.residualCount.test(bound.text))
      .map((bound) => `  ${bound.what}`);
    expect(
      miscounted,
      `${miscounted.length} text(s) no longer say there are three residuals:\n`
      + `${miscounted.join('\n')}\n`
      + 'If a required incarnation identity has landed (#823) the count genuinely drops — move '
      + 'all three texts and the counterfactuals in GossipReplayGuard.test.ts together.',
    ).toEqual([]);
  });

  test('the roadmap sends a reader to the issue that actually gates the fix', () => {
    // #940 landed `NodeAddress.incarnation` as an *optional* field and
    // deliberately did not act on it, because a refusal keyed on an optional
    // field is one an attacker opts out of by stripping it while a legitimate
    // older peer walks into it.  So the issue to follow from here is #823, the
    // wire break that makes the field required.  Both roadmap passages named
    // #940 alone, which reads as a dependency that has already landed.
    const dependency = /#112[^;)]*/.exec(roadmapOpenItems)?.[0] ?? '';
    expect(
      dependency,
      `${ROADMAP}: the open-items bullet says #112 waits on "${dependency.trim()}". The optional `
      + 'incarnation #940 landed cannot carry a refusal; #823 is the wire break that makes it '
      + 'required, and it is the issue a reader has to follow.',
    ).toMatch(/#823/);
    expect(
      roadmapResidual,
      `${ROADMAP}: the wave retrospective on #112 exists so the conclusion is not re-derived, and `
      + 'it does not name #823 — the reader is left with an incarnation identity and no way to '
      + 'tell that the one on the wire today is optional and therefore inert.',
    ).toMatch(/#823/);
  });
});
