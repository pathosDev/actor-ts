/**
 * The refusals `BackoffSupervisor` records have to answer the criterion they
 * refuse (#1509).
 *
 * Two of them did not, in the same way: each addressed one half of a
 * two-part suggestion and read, afterwards, as if it had addressed both.  A
 * recorded refusal is the artefact a later reader trusts instead of
 * re-deriving the question, so one that is narrower than the question it
 * answers is worse than none — it closes the thread on an argument that was
 * never made.
 *
 * ## What the first version of this file could not see, measured
 *
 * It asserted three identifiers somewhere inside a tightly-sliced comment
 * block, and said of itself that "an identifier that ends up inside the block
 * for some other reason satisfies the check".  That is exactly what happens,
 * and it needs no ingenuity: replacing the entire #770 argument with the
 * single line
 *
 *     ATTACK: whole argument replaced. See ActorCell.enqueueSystem and
 *     scheduleOnceFunction.
 *
 * left this file at 2 pass / 0 fail.  The guard was satisfied by prose that
 * had deleted the reasoning it existed to preserve — and rewording is
 * precisely the drift it was added to catch, since rewording is how all of
 * these comments got into their previous state.
 *
 * ## What replaced it
 *
 * Two different kinds of assertion, because the two halves of a refusal are
 * not the same kind of fact.
 *
 * **The decision is pinned in code.**  Both refusals are decisions *not* to
 * build something, and an absent behaviour has no test — but it does leave a
 * shape, and the shape is checkable.  If the dedicated internal channel were
 * ever built, `enqueueSystem` would appear as a *call* rather than only as a
 * comment mention; if the respawn were armed off the scheduler instead of the
 * mailbox, `scheduleOnceFunction` would.  Those assertions run over
 * comment-stripped source, so they are about the module's code and cannot be
 * satisfied — or broken — by anything written in prose.  This is the half
 * that actually holds: a future change that reverses the refusal goes red
 * whether or not anybody updates the comment.
 *
 * **The reasoning is pinned as prose, with the collapse closed.**  The
 * identifiers must still be there, and must now be in *distinct sentences* of
 * real length, which is what the attack above violated.  That is a higher
 * bar, not a different kind of bar: prose that argues the opposite at full
 * length still passes, and no assertion over English will fix that.  It is
 * worth having anyway because the realistic failure is a reflow, a
 * translation or a summary, and all three now fail.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const SUPERVISOR_SOURCE = join(
  import.meta.dir, '..', '..', '..', 'src', 'pattern', 'BackoffSupervisor.ts',
);

const source = (): string => readFileSync(SUPERVISOR_SOURCE, 'utf8');

/** One comment block, from a sentence unique to it to the delimiter that ends it. */
const blockOpeningWith = (text: string, opening: string): string => {
  const start = text.indexOf(opening);
  expect(start).toBeGreaterThan(-1);
  const end = text.indexOf('*/', start);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
};

/**
 * The block as flowing prose: leading `*` gutters gone, lines joined, so a
 * sentence can be recognised across the line breaks the source wraps it at.
 */
const sentencesOf = (block: string): readonly string[] =>
  block
    .replace(/^[ \t]*\*[ \t]?/gm, '')
    .replace(/\s+/g, ' ')
    .split(/(?<=\.)\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

/**
 * The one sentence carrying `token`, asserted to be a sentence and not a
 * pointer.  120 characters is about a line and a half of this file's prose —
 * comfortably under every real argument here and comfortably over anything
 * that merely names the identifier.
 */
const argumentSentenceFor = (sentences: readonly string[], token: string): string => {
  const hits = sentences.filter(s => s.includes(token));
  expect(hits.length).toBeGreaterThan(0);
  const longest = hits.reduce((a, b) => (b.length > a.length ? b : a));
  expect(longest.length).toBeGreaterThan(120);
  return longest;
};

/** Source with comments removed — what the module actually executes. */
const codeOnly = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

describe('the #770 refusal covers both halves of what it refuses', () => {
  test('neither refused design is built', () => {
    const code = codeOnly(source());
    // The stripper found the module rather than emptying it.
    expect(code).toContain('export class BackoffSupervisor');

    // The door a user-level actor does not have onto the system lane.  A
    // mention of it survives in the comment; a *call* to it would mean the
    // dedicated internal channel had been built after all, which is the
    // thing #770 asked for and this module declined.
    expect(code).not.toMatch(/\benqueueSystem\s*\(/);
    // And the substitute the block rejects for a different reason: arming
    // the respawn off the scheduler would run `respawn()` outside the
    // actor's turn.  The ticks go through the actor's own `TimerScheduler`
    // instead, so this name must not appear as a call either.
    expect(code).not.toMatch(/\bscheduleOnceFunction\s*\(/);

    // The half the refusal does deliver, and the only one with a positive
    // shape to assert: both sentinels are unguessable `Symbol()`s, not
    // registry-resolved `Symbol.for()`s.
    expect(code).toMatch(/const RESPAWN_TICK = Symbol\('/);
    expect(code).toMatch(/const DRAIN_TICK = Symbol\('/);
    expect(code).not.toMatch(/Symbol\.for\s*\(/);
  });

  test('the control-tick block argues why a dedicated internal channel is not taken', () => {
    const sentences = sentencesOf(blockOpeningWith(source(), 'The two control ticks'));

    expect(sentences.some(s => s.includes('#770'))).toBe(true);

    // The issue asked for provenance "verified (`this.sender` is `self`), or
    // route the ticks through a dedicated internal channel".  The commit
    // body, the CHANGELOG entry and this block all answered the first half
    // only, so the recorded refusal looked stronger than it was.
    const channel = argumentSentenceFor(sentences, 'enqueueSystem');
    // And the reason the obvious substitute is not one: a scheduler callback
    // runs outside the actor's turn.
    const scheduler = argumentSentenceFor(sentences, 'scheduleOnceFunction');

    // Two arguments, not one line naming two identifiers — which is the
    // shape that used to pass.
    expect(channel).not.toBe(scheduler);
  });
});

describe('the unconditional stash eviction says where its cost is bounded', () => {
  test('the eviction really is unconditional', () => {
    const body = codeOnly(source()).slice(
      codeOnly(source()).indexOf('private evictOldestStashed('),
    ).split('\n  }')[0];

    // What the whole argument is *about*: this path dead-letters every
    // eviction, with no option gating it.  If a knob ever appears here the
    // block below stops describing the code, and the asymmetry it spends
    // four sentences justifying has quietly gone away.
    expect(body).toContain('deadLetters.tell(');
    expect(body).not.toContain('deadLetterDrops');
    // The only branch before the publish is the empty-stash guard.
    expect(body).toMatch(/if \(evicted === undefined\) return;/);
  });

  test("evictOldestStashed's JSDoc names #1179 rather than only its attribution", () => {
    const sentences = sentencesOf(blockOpeningWith(source(), 'Make room in a full stash'));

    // The asymmetry that needed answering: the mailbox path made the same
    // per-message dead letter opt-in (`BoundedMailboxOptionsType.deadLetterDrops`,
    // default `false`) on the grounds of what it costs, while this one
    // dead-letters every eviction unconditionally.  The block argued the case
    // from *attribution* — "not on the sender's stack" — which answers who
    // pays rather than how much, so the two decisions read as contradicting
    // each other on the question neither had addressed.
    const asymmetry = argumentSentenceFor(sentences, 'deadLetterDrops');
    // The answer is that the magnitude is bounded for every producer at the
    // publish side, not per producer: that is #1179's storm suppression, and
    // naming it is what makes this a decision a reader can follow rather than
    // an omission.
    const bound = argumentSentenceFor(sentences, '#1179');
    expect(asymmetry).not.toBe(bound);

    expect(sentences.some(s => s.includes('#773'))).toBe(true);
  });
});
