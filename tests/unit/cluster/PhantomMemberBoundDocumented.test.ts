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
 * #1103 moved the two together: the sender door admitted through the same route
 * as the merge and registered what it filed.  #939 then closed the door
 * outright — it filed a member with no authority check, and no legitimate frame
 * needed it, since every gossip frame carries its sender's own record.  So the
 * guard now pins the last state: the section names the sender field as no
 * longer a way in, with #939 in the same sentence.  Keyed on markers rather
 * than on a sentence, like `GossipReplayBoundDocumented`, so a rewrite that
 * keeps the meaning keeps passing.
 *
 * The version-skew section on the same page leaned on the door too: it said a
 * refused self-announcement was not exclusion, because the sender was still
 * filed at version 1 without roles.  With the door gone a refusal *is*
 * exclusion — the node's own record is the only thing that introduces it — so
 * the second block pins that: no sentence there may put "version 1" next to
 * roles, and one has to call the refusal exclusion.
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
  readonly closed: RegExp;
};

const DOOR_TEXTS: readonly DoorText[] = [
  {
    path: 'docs/src/content/docs/operations/security/cluster-security.mdx',
    anchor: 'Splitting members from tombstones is not tidiness',
    door: /\bsender\b/i,
    closed: /\bclosed\b|\bno longer a route\b/i,
  },
  {
    path: 'docs/src/content/docs/de/operations/security/cluster-security.mdx',
    anchor: 'Mitglieder und Tombstones zu trennen ist keine Ordnungsliebe',
    door: /Absender/,
    closed: /\bTür ist zu\b|\bkein Weg mehr\b|\bgeschlossen\b/,
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

describe('#1477 — the phantom passage says the sender door is closed', () => {
  for (const text of DOOR_TEXTS) {
    test(`${text.path}: the sender field is named as no way in, with #939`, () => {
      const sentences = sentencesOf(sectionAround(text.path, text.anchor));
      const closing = sentences
        .filter((sentence) => text.door.test(sentence) && text.closed.test(sentence) && /#939/.test(sentence));
      expect(
        closing.length,
        `${text.path}: no sentence in the two-caps section says, with #939, that a frame's sender field `
        + 'no longer files a member. Since #939 a sender is introduced only by its own record, through the merge.',
      ).toBeGreaterThan(0);
    });
  }
});

type SkewText = {
  readonly path: string;
  readonly anchor: string;
  readonly versionOne: RegExp;
  readonly roles: RegExp;
  readonly exclusion: RegExp;
};

const SKEW_TEXTS: readonly SkewText[] = [
  {
    path: 'docs/src/content/docs/operations/security/cluster-security.mdx',
    anchor: 'A version cannot claim an address in advance',
    versionOne: /\bversion 1\b/i,
    roles: /\broles?\b/i,
    exclusion: /\bis exclusion\b/i,
  },
  {
    path: 'docs/src/content/docs/de/operations/security/cluster-security.mdx',
    anchor: 'Eine Version kann keine Adresse im Voraus beanspruchen',
    versionOne: /\bVersion 1\b/,
    roles: /Rolle/,
    exclusion: /\bist Ausschluss\b/,
  },
];

describe('#939 — the version-skew section says a refusal keeps the node out', () => {
  for (const text of SKEW_TEXTS) {
    test(`${text.path}: no sentence files a refused node at version 1 without roles`, () => {
      const sentences = sentencesOf(sectionAround(text.path, text.anchor));
      const stale = sentences.filter((sentence) => text.versionOne.test(sentence) && text.roles.test(sentence));
      expect(
        stale,
        `${text.path}: the version-skew section still says a refused node is filed at version 1 without roles. `
        + 'That was the gossip sender door, which #939 removed: a node is introduced only by its own record, '
        + 'so a refusal keeps it out of the member list until its clock is back inside maxVersionSkewMs.',
      ).toEqual([]);
    });

    test(`${text.path}: the refusal is called exclusion`, () => {
      const sentences = sentencesOf(sectionAround(text.path, text.anchor));
      expect(
        sentences.some((sentence) => text.exclusion.test(sentence)),
        `${text.path}: no sentence in the version-skew section says a refusal is exclusion. Since #939 a node `
        + 'whose own record is refused for version skew is not filed at all.',
      ).toBe(true);
    });
  }
});
