/**
 * #1421 — a drift guard over what the maps page *claims* about nested
 * identity, in the shape of `tests/unit/cluster/GossipReplayBoundDocumented.test.ts`.
 *
 * `ORMap` recovers its own key identity on decode and leaves the CRDTs stored
 * inside it on the default `JSON.stringify` rule.  That boundary is written
 * down rather than closed (#1421), and the reasoning for it lives in one
 * place — the sets page's *Identity inside DistributedData* section.  The maps
 * page carries a cross-reference to it plus the one thing that is specific to
 * a map: which operation can still get the application's inner identity onto a
 * value the decoder built.
 *
 * Two things can rot here and neither has anything watching it otherwise:
 *
 *  - **The pointer.**  In-page anchors are not validated by anything.  The
 *    Astro build checks MDX and the sidebar and never resolves a `#fragment`,
 *    so renaming the sets heading breaks both links silently.  The anchors are
 *    therefore derived from the sets pages' own heading text here, which makes
 *    a rename red instead of quiet.
 *  - **The claim.**  The maps paragraph describes a sequence — `update` reuses
 *    the value already under the key, `remove` makes the next `update` run the
 *    factory — that is a consequence of two lines in `ORMap` (`update`'s
 *    `this.get(key) ?? factory()` and `get`'s keyset filter).  Either could
 *    change for a good reason, and the page would then be confidently wrong.
 *    So the second half of this file asserts the behaviour by execution, with
 *    the same values the prose uses.
 *
 * Know this guard's reach: `test.yml` filters on `src/**` and `tests/**`, so a
 * commit touching *only* the two documentation pages does not run it in CI.
 * It runs locally, and on any push that also carries code — which is every
 * shape that can invalidate the behavioural half.
 *
 * Refs #1421, #766.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { ORMap } from '../../../src/crdt/ORMap.js';
import { ORSet } from '../../../src/crdt/ORSet.js';

const DOCS_ROOT = join(import.meta.dir, '..', '..', '..', 'docs', 'src', 'content', 'docs');

const pageSource = (relative: string): string =>
  readFileSync(join(DOCS_ROOT, ...relative.split('/')), 'utf8');

const EN_MAPS = 'distributed-data/crdt-types/maps.mdx';
const DE_MAPS = 'de/distributed-data/crdt-types/maps.mdx';
const EN_SETS = 'distributed-data/crdt-types/sets.mdx';
const DE_SETS = 'de/distributed-data/crdt-types/sets.mdx';

/** A fence opener: up to three spaces, then three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * `[level, text]` for every ATX heading outside fenced code and frontmatter.
 * Fence-aware because a HOCON or shell fence can legitimately carry a `#`
 * comment at the start of a line.
 */
function headingsOf(source: string): ReadonlyArray<readonly [number, string]> {
  const lines = source.split(/\r?\n/);
  const found: Array<readonly [number, string]> = [];
  let fence: string | undefined;
  let inFrontmatter = lines[0] === '---';
  for (let index = inFrontmatter ? 1 : 0; index < lines.length; index += 1) {
    const text = lines[index] ?? '';
    if (inFrontmatter) {
      if (text === '---') inFrontmatter = false;
      continue;
    }
    const opener = FENCE.exec(text)?.[1];
    if (fence === undefined) {
      if (opener !== undefined) {
        fence = opener;
        continue;
      }
      const heading = /^(#{1,6})\s+(.*\S)\s*$/.exec(text);
      if (heading !== null) found.push([heading[1]!.length, heading[2]!] as const);
    } else if (opener !== undefined && opener[0] === fence[0] && opener.length >= fence.length) {
      fence = undefined;
    }
  }
  return found;
}

/**
 * Starlight slugifies a heading the way `github-slugger` does: lowercase, drop
 * punctuation, runs of whitespace to a hyphen — **non-ASCII letters kept**,
 * which is why the German anchors already in this tree read
 * `#kardinalitätsdisziplin` rather than a transliteration.
 */
const slugOf = (heading: string): string =>
  heading.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');

/**
 * `source` with fenced code blocks removed.
 *
 * The issue reference has to be in the prose, and `toContain` over the raw
 * file cannot tell the two apart: moving `#1421` into a `// background:`
 * comment inside the first fence — with the sentence that explains it gone —
 * kept this file green on the first attempt at attacking it.  A reference a
 * reader only meets inside a code sample is not a cross-reference.
 */
function proseOf(source: string): string {
  const lines = source.split(/\r?\n/);
  const kept: string[] = [];
  let fence: string | undefined;
  for (const text of lines) {
    const opener = FENCE.exec(text)?.[1];
    if (fence === undefined) {
      if (opener !== undefined) fence = opener;
      else kept.push(text);
    } else if (opener !== undefined && opener[0] === fence[0] && opener.length >= fence.length) {
      fence = undefined;
    }
  }
  return kept.join('\n');
}

/** The single heading on `page` whose text contains `needle`, case-insensitively. */
function soleHeadingContaining(page: string, needle: string): string {
  const matches = headingsOf(pageSource(page))
    .filter(([, text]) => text.toLowerCase().includes(needle.toLowerCase()))
    .map(([, text]) => text);
  expect(matches, `headings of ${page} containing ${needle}`).toHaveLength(1);
  return matches[0]!;
}

describe('#1421 — the maps page points at the nesting boundary', () => {
  test('the English page names the issue and links to the sets section that argues it', () => {
    const prose = proseOf(pageSource(EN_MAPS));
    const anchor = slugOf(soleHeadingContaining(EN_SETS, 'Identity inside DistributedData'));

    expect(prose).toContain('#1421');
    expect(prose).toContain(`/distributed-data/crdt-types/sets/#${anchor}`);
  });

  test('the German page names the issue and links to the German mirror of that section', () => {
    const prose = proseOf(pageSource(DE_MAPS));
    const anchor = slugOf(soleHeadingContaining(DE_SETS, 'Identität innerhalb von DistributedData'));

    expect(prose).toContain('#1421');
    expect(prose).toContain(`/de/distributed-data/crdt-types/sets/#${anchor}`);
  });

  test('the two mirrors keep the same heading structure', () => {
    // Text is translated, nesting is not: a section added to one language and
    // forgotten in the other shows up as a different level sequence.
    expect(headingsOf(pageSource(DE_MAPS)).map(([level]) => level))
      .toEqual(headingsOf(pageSource(EN_MAPS)).map(([level]) => level));
  });

  test('both mirrors carry the nested-identity section inside the ORMap chapter', () => {
    for (const page of [EN_MAPS, DE_MAPS]) {
      const headings = headingsOf(pageSource(page));
      const ormap = headings.findIndex(([level, text]) => level === 2 && text === 'ORMap');
      const nextChapter = headings.findIndex(([level], index) => index > ormap && level === 2);
      const inside = headings.slice(ormap + 1, nextChapter === -1 ? undefined : nextChapter);
      expect(inside.some(([, text]) => /identit/i.test(text)), `nested-identity section in ${page}`)
        .toBe(true);
    }
  });
});

describe('#1421 — the sequence the maps page describes, by execution', () => {
  type CartItem = { readonly sku: string; readonly quantity: number };
  const bySku = (item: CartItem): string => item.sku;
  const emptyCart = (): ORSet<CartItem> => ORSet.empty<CartItem>({ identity: bySku });

  /** A peer's frame for one tenant, written before that peer ran its own `update`. */
  const peerFrame = (): ReturnType<ORMap<string, ORSet<CartItem>>['toJSON']> =>
    ORMap.empty<string, ORSet<CartItem>>()
      .update('peer', 'tenant-a', () => ORSet.empty<CartItem>(),
        (cart) => cart.add('peer', { sku: 'book', quantity: 10 }))
      .toJSON();

  /** What `DistributedData` does today: an inner decode with no identity to hand down. */
  const decodeValue = (json: unknown): ORSet<CartItem> =>
    ORSet.fromJSON<CartItem>(json as Parameters<typeof ORSet.fromJSON>[0]);

  const gossiped = (): ORMap<string, ORSet<CartItem>> =>
    ORMap.fromJSON<string, ORSet<CartItem>>(peerFrame(), decodeValue);

  test('a value the decoder built is on the default identity', () => {
    expect(gossiped().get('tenant-a')?.customIdentity()).toBeUndefined();
  });

  test('a further update does not teach it — the factory never runs for a key that exists', () => {
    const own = gossiped().update('self', 'tenant-a', emptyCart,
      (cart) => cart.add('self', { sku: 'book', quantity: 3 }));

    // The page's claim: `update` reuses the value already under the key, so the
    // one place the inner identity lives is skipped.  The visible cost is two
    // entries for one SKU.
    expect(own.get('tenant-a')?.customIdentity()).toBeUndefined();
    expect(own.get('tenant-a')?.size).toBe(2);
  });

  test('a remove makes the next update run the factory, and it starts over rather than re-keying', () => {
    const own = gossiped().update('self', 'tenant-a', emptyCart,
      (cart) => cart.add('self', { sku: 'book', quantity: 3 }));
    const readded = own.remove('tenant-a').update('self', 'tenant-a', emptyCart,
      (cart) => cart.add('self', { sku: 'book', quantity: 3 }));

    expect(readded.get('tenant-a')?.customIdentity()).toBe(bySku as never);
    // One entry, and it is the one this replica just added: the pre-remove
    // element is gone rather than re-filed, which is what a remove means.
    expect(readded.get('tenant-a')?.value()).toEqual([{ sku: 'book', quantity: 3 }]);
  });

  test('a peer still holding the pre-remove state files its elements under its own key again', () => {
    const own = gossiped().update('self', 'tenant-a', emptyCart,
      (cart) => cart.add('self', { sku: 'book', quantity: 3 }));
    const readded = own.remove('tenant-a').update('self', 'tenant-a', emptyCart,
      (cart) => cart.add('self', { sku: 'book', quantity: 3 }));

    const merged = readded.merge(gossiped());

    // `merge` unions element keys verbatim — it never re-keys the other side —
    // so the SKU is back twice even though this replica's own value was clean.
    expect(merged.get('tenant-a')?.size).toBe(2);
    expect(merged.get('tenant-a')?.customIdentity()).toBe(bySku as never);
  });
});
