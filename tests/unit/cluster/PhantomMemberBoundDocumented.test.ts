/**
 * #1477 — what bounds a phantom live member, stated the way the code bounds it.
 *
 * The cluster-security page explains why membership carries two caps by the
 * lifetimes of two kinds of phantom, and it said every live phantom is a member
 * the failure detector watches, so both detectors declare it `down` and the
 * downing configuration decides what that does.  That holds for a phantom that
 * arrives as a record in a gossip frame: the merge registers it with the
 * detector.  It does not hold for the other door the same page names — a
 * frame whose `from` names an address the receiver holds no record of — which
 * files the sender as `joining` without registering it, so no detector ever
 * declares it `down`, the leader promotes it like any joining member, and it
 * stays until an operator removes it (#939, open).  A reader of the old wording
 * credited the detector with a bound it does not have on that door.
 *
 * So the section had to name that door in a sentence that said the detector
 * does not watch what comes through it, and cite #939 there.
 *
 * #1103 moved the two together, as this file anticipated: the sender door now
 * admits through the same route as the merge and registers what it files,
 * because a live member without a detector entry reads `healthy` for good and
 * the bound on the detector's size is stated as "an entry per live member".  So
 * the detector bound the old wording credited is real on that door now, and
 * the guard pins the opposite sentence — the door named as registered, with
 * #1103.  #939 stays cited beside the door: the authority half of it, a member
 * filed with no check at all, is still open.  Keyed on markers rather than on a
 * sentence, like `GossipReplayBoundDocumented`, so a rewrite that keeps the
 * meaning keeps passing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');

type DoorText = {
  readonly path: string;
  /** A phrase inside the section, which is located by it rather than by its heading. */
  readonly anchor: string;
  readonly door: RegExp;
  readonly registered: RegExp;
};

const DOOR_TEXTS: readonly DoorText[] = [
  {
    path: 'docs/src/content/docs/operations/security/cluster-security.mdx',
    anchor: 'Splitting members from tombstones is not tidiness',
    door: /\bsender\b/i,
    registered: /\bregisters?\b[^.]*\bdetector\b|\bregistered with the detector\b/i,
  },
  {
    path: 'docs/src/content/docs/de/operations/security/cluster-security.mdx',
    anchor: 'Mitglieder und Tombstones zu trennen ist keine Ordnungsliebe',
    door: /Absender/,
    registered: /\bbeim Detector an\b|\bbeim Detector angemeldet\b/,
  },
];

/** The `### ` section around `anchor`, MDX comments dropped because they render nothing. */
function sectionAround(path: string, anchor: string): string {
  const page = readFileSync(join(REPOSITORY_ROOT, path), 'utf8');
  const anchorAt = page.indexOf(anchor);
  if (anchorAt < 0) {
    throw new Error(`${path}: the anchor phrase "${anchor}" is gone — re-point this guard at the new wording.`);
  }
  const start = page.lastIndexOf('\n### ', anchorAt);
  const next = page.slice(anchorAt).search(/\n#{2,3} /);
  return page
    .slice(start < 0 ? 0 : start, next < 0 ? page.length : anchorAt + next)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
}

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter((sentence) => sentence !== '');
}

describe('#1477 — the phantom passage states the detector bound the sender door has', () => {
  for (const text of DOOR_TEXTS) {
    test(`${text.path}: the sender door is named as registered, with #1103, and #939 beside it`, () => {
      const sentences = sentencesOf(sectionAround(text.path, text.anchor));
      const registering = sentences
        .filter((sentence) => text.door.test(sentence) && text.registered.test(sentence) && /#1103/.test(sentence));
      expect(
        registering.length,
        `${text.path}: no sentence in the two-caps section says that a phantom filed from a frame's `
        + 'sender field is registered with the failure detector, with #1103. Since #1103 the sender insert '
        + 'admits like the merge and registers what it files, so the detector declares it down like any '
        + 'silent member.',
      ).toBeGreaterThan(0);
      const citing = sentences.filter((sentence) => text.door.test(sentence) && /#939/.test(sentence));
      expect(
        citing.length,
        `${text.path}: the sender door is no longer cited with #939 — the member it files without any `
        + 'authority check is still that issue.',
      ).toBeGreaterThan(0);
    });
  }
});
