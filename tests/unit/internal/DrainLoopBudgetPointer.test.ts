/**
 * The system-drain loop points at the decision that governs it (#794, #1509).
 *
 * `ActorCell.run` drains the system queue completely before every user
 * message, and it carries no per-turn budget.  That is a decision, not an
 * omission — a budget would interleave a supervision decision with the user
 * traffic that decision exists to gate — and it is argued at length in
 * `Mailbox.enqueueSystem`, one file away, on a method that is about *enqueuing*
 * rather than about the loop the refusal is really about.
 *
 * `run`'s own JSDoc argues every other exit condition in the turn: why the
 * batch ends on a state change, why "no envelope" means stop rather than skip,
 * why an empty throttle bucket breaks rather than continues.  A maintainer
 * reading it — the natural place to propose the budget — found nothing, which
 * is what made the decision re-derivable rather than readable.
 *
 * So this pins a cross-reference, in both directions: the loop names the
 * method, and the method still holds the argument the loop defers to.  A
 * pointer is only worth having while it points at something, and prose is
 * exactly the kind of thing that moves without a compiler noticing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const ACTOR_CELL_SOURCE = join(REPOSITORY_ROOT, 'src', 'internal', 'ActorCell.ts');
const MAILBOX_SOURCE = join(REPOSITORY_ROOT, 'src', 'internal', 'Mailbox.ts');

/**
 * The JSDoc block immediately above a declaration, without its delimiters.
 *
 * Scoped to the one block on purpose: the file mentions plenty of issue
 * numbers, and a guard that searched the whole of it would pass on any of
 * them — which is the guard passing for a reason that has nothing to do with
 * what it claims.  Delimiter-based rather than line-based, so the repository's
 * CRLF checkout reads the same as an LF one.
 */
const jsDocAbove = (source: string, declaration: string): string => {
  const at = source.indexOf(declaration);
  expect(at).toBeGreaterThan(-1);
  const open = source.lastIndexOf('/**', at);
  expect(open).toBeGreaterThan(-1);
  const close = source.indexOf('*/', open);
  return source.slice(open, close);
};

describe('the absent per-turn budget is readable from the loop — #794', () => {
  test("ActorCell.run's JSDoc names the method that refuses the budget", () => {
    const jsDoc = jsDocAbove(readFileSync(ACTOR_CELL_SOURCE, 'utf8'), 'private async run(): Promise<void> {');

    // The method, so a reader has somewhere to go, and the issue, so they can
    // tell whether the argument there is still the current one.
    expect(jsDoc).toContain('enqueueSystem');
    expect(jsDoc).toContain('#794');
    // And the subject itself, or the pointer could be about anything the two
    // files share.
    expect(jsDoc).toContain('per-turn budget');
  });

  test('Mailbox.enqueueSystem still holds the argument the loop defers to', () => {
    const jsDoc = jsDocAbove(readFileSync(MAILBOX_SOURCE, 'utf8'), 'enqueueSystem(env: Envelope<unknown>): void {');

    // The half that keeps the pointer honest.  If this argument moves or is
    // rewritten away, the loop is pointing at a decision that is no longer
    // recorded there, which is the state #794 was filed about in the first
    // place — one file further along.
    expect(jsDoc).toContain('per-turn budget');
    expect(jsDoc).toContain('ActorCell.run');
  });
});
