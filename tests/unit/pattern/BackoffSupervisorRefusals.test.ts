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
 * Pinned as prose because there is nothing else to pin.  Both refusals are
 * decisions *not* to build something; the behaviour they decline is absent,
 * and an absent behaviour has no test.  What these assertions hold is that
 * the reasoning stays written down at the site, named by the identifiers it
 * turns on rather than by a phrase, so a translation or a reflow does not
 * quietly satisfy them.
 *
 * What they cannot see: an identifier that ends up inside the block for some
 * other reason satisfies the check without the argument being there.  The
 * blocks are anchored tightly for that reason — each is sliced from its own
 * opening sentence to the delimiter that closes it — but a guard over prose
 * is a guard over prose.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const SUPERVISOR_SOURCE = join(
  import.meta.dir, '..', '..', '..', 'src', 'pattern', 'BackoffSupervisor.ts',
);

/** One comment block, from a sentence unique to it to the delimiter that ends it. */
const blockOpeningWith = (source: string, opening: string): string => {
  const start = source.indexOf(opening);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('*/', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

describe('the #770 refusal covers both halves of what it refuses', () => {
  test('the control-tick block says why a dedicated internal channel is not taken', () => {
    const block = blockOpeningWith(readFileSync(SUPERVISOR_SOURCE, 'utf8'), 'The two control ticks');

    // The issue asked for provenance "verified (`this.sender` is `self`), or
    // route the ticks through a dedicated internal channel".  The commit body,
    // the CHANGELOG entry and this block all answered the first half only, so
    // the recorded refusal looked stronger than it was.
    expect(block).toContain('#770');
    // The door a user-level actor does not have onto the system lane.
    expect(block).toContain('enqueueSystem');
    // And the reason the obvious substitute is not one: a scheduler callback
    // runs outside the actor's turn.
    expect(block).toContain('scheduleOnceFunction');
  });
});

describe('the unconditional stash eviction says where its cost is bounded', () => {
  test("evictOldestStashed's JSDoc names #1179 rather than only its attribution", () => {
    const block = blockOpeningWith(
      readFileSync(SUPERVISOR_SOURCE, 'utf8'),
      'Make room in a full stash',
    );

    // The asymmetry that needed answering: the mailbox path made the same
    // per-message dead letter opt-in (`BoundedMailboxOptionsType.deadLetterDrops`,
    // default `false`) on the grounds of what it costs, while this one
    // dead-letters every eviction unconditionally.  The block argued the case
    // from *attribution* — "not on the sender's stack" — which answers who
    // pays rather than how much, so the two decisions read as contradicting
    // each other on the question neither had addressed.
    expect(block).toContain('deadLetterDrops');
    // The answer is that the magnitude is bounded for every producer at the
    // publish side, not per producer: that is #1179's storm suppression, and
    // naming it is what makes this a decision a reader can follow rather than
    // an omission.
    expect(block).toContain('#1179');
    expect(block).toContain('#773');
  });
});
