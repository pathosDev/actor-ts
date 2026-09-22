import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { decodeBody, encodeBody } from '../../../../src/persistence/object-storage/BodyCodec.js';

/**
 * A drift guard over the "Runtime support" section of the compression pages —
 * the claims, not the code (#1507, #1419).
 *
 * The section said "both directions pick an implementation by **calling** it",
 * immediately after listing all three read rungs.  That is true of the two
 * native ones and false of `fzstd`, which the resolver accepts on a successful
 * import and says so in a comment three lines away.  The imprecision survived
 * from #780 through four commits on `Compression.ts`, which is the argument for
 * this file: nothing read the page against the source, so a sentence that was
 * nearly right stayed nearly right.
 *
 * The section now also connects two facts it used to state separately — a
 * runtime without native zstd can READ zstd bodies, and configuring `zstd`
 * there fails at registration — into the advice that follows from them: such a
 * reader is configured `gzip` or `none`.  That is the claim most likely to be
 * acted on and the most expensive to get wrong (a replica that will not start),
 * so both halves of its mechanism are pinned below.
 *
 * Every assertion is keyed on a semantic marker rather than a sentence, so a
 * rewrite that keeps the meaning keeps passing.  What it will not survive is
 * the meaning changing on one side only — which is the whole point.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const COMPRESSION_SOURCE = 'src/persistence/object-storage/Compression.ts';
const ENGLISH_PAGE = 'docs/src/content/docs/persistence/object-storage/compression.mdx';
const GERMAN_PAGE = 'docs/src/content/docs/de/persistence/object-storage/compression.mdx';

/**
 * Read a repository file with its line endings normalised.
 *
 * Not cosmetic: this repository checks out with `core.autocrlf=true` on
 * Windows, so every anchor below would have to be spelled `\r?\n` or silently
 * match nothing — and "matches nothing" is the failure mode a guard over prose
 * cannot afford, because it looks like the prose being fine.
 */
const read = (path: string): string =>
  readFileSync(join(REPOSITORY_ROOT, path), 'utf8').replace(/\r\n/g, '\n');

/**
 * The body of a top-level `const <name>: … = Lazy.of…` declaration, from its
 * name to the next one.
 *
 * Located by the declaration rather than by a line range for the obvious
 * reason, and returned as text rather than parsed because what is asserted is
 * which helper is *called* where — a question the source answers literally and
 * a type-checker does not answer at all.
 */
/**
 * `region` with `//`-led comments removed.
 *
 * `Compression.ts` explains its own rungs at length, and a comment that
 * *mentions* the canary call would otherwise be counted as one — a false red,
 * and the shape `tests/unit/ci/ModuleMockDiscipline.test.ts` blanks comments
 * and string literals to avoid.  A full blanker is overkill for one
 * declaration: what could fool this one is a `//` inside a string literal in
 * the same region, and there is none.  The assertions below additionally match
 * `await decodesZstdCanary(`, which a prose mention would not spell.
 *
 * `/* … *\/` comments are NOT stripped, which was attacked rather than assumed:
 * a block comment inside the resolver spelling the call turns both assertions
 * red.  That is the safe direction — an over-strict guard argues with a comment,
 * where a permissive one would let the mechanism change under an unchanged page
 * — and the declaration this reads contains no block comment today.
 */
function withoutLineComments(region: string): string {
  return region.replace(/\/\/[^\n]*/g, '');
}

function declarationBody(source: string, name: string): string {
  const start = source.indexOf(`const ${name}`);
  if (start < 0) {
    throw new Error(
      `${COMPRESSION_SOURCE}: \`${name}\` is gone, so this guard can no longer see what it `
      + 'claims to. Re-point it at whatever replaced it rather than deleting the assertion.',
    );
  }
  const next = source.indexOf('\nconst ', start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

describe('compression docs — how a decompress candidate is accepted (#1507)', () => {
  const source = read(COMPRESSION_SOURCE);
  const resolver = withoutLineComments(declarationBody(source, 'zstdDecompressLazy'));

  test('exactly the two native rungs are accepted by being called', () => {
    // The canary call is what "picked by calling it" means, and it appears
    // once per native rung. A third would mean the peer became call-checked
    // too, and the pages' "the fzstd rung is the one that is not call-checked"
    // would be stale — which is the sentence this asserts, from the other side.
    const canaryCalls = [...resolver.matchAll(/await decodesZstdCanary\(/g)].length;
    expect(
      canaryCalls,
      'the number of canary-called rungs moved; the Runtime-support section names two',
    ).toBe(2);
  });

  test('the fzstd rung is accepted on a successful import instead', () => {
    const peerImportAt = resolver.indexOf('import(fzstdName)');
    expect(
      peerImportAt,
      'the peer is no longer reached through `fzstdName`, so this guard reads the wrong region',
    ).toBeGreaterThan(0);
    expect(
      resolver.slice(peerImportAt),
      'a canary call appeared below the peer import, so the peer IS call-checked now and the '
      + 'pages say it is not',
    ).not.toContain('await decodesZstdCanary(');
  });
});

describe('compression docs — a zstd reader on a runtime without native zstd (#1419)', () => {
  test('registration probes the COMPRESS path, which is why configuring zstd can fail to start', () => {
    const source = read(COMPRESSION_SOURCE);
    const probe = source.slice(source.indexOf('export async function probeCompressionAvailability'));
    const zstdArm = probe.slice(probe.indexOf(".with('zstd'"));
    expect(
      zstdArm.slice(0, zstdArm.indexOf('\n', zstdArm.indexOf('})'))),
      'the zstd arm stopped probing the compress lazy, so a runtime that can only READ zstd '
      + 'would now start with `zstd` configured — and both pages say it cannot',
    ).toContain('zstdCompressLazy');
  });

  test('a read picks its decompressor from the body, never from the configuration', async () => {
    // The other half of the advice: `DecodeOptions` has no `compression` field
    // at all — there is nowhere for a reader's configured algorithm to enter —
    // so a store configured `gzip` reads a zstd body its peers wrote. Asserted
    // here at the codec, which is where the flag is read; the same round trip
    // through two differently-configured stores is what the smoke matrix does
    // with real backends.
    const payload = new TextEncoder().encode(JSON.stringify({ note: 'written by a zstd peer' }));

    const zstdBody = await decodeBody(await encodeBody(payload, { compression: 'zstd' }));
    expect(
      zstdBody.compression,
      'the body no longer reports the algorithm it was written with, so nothing tells a reader '
      + 'how to decode it',
    ).toBe('zstd');
    expect(zstdBody.payload).toEqual(payload);

    // The same call on a gzip body, so the assertion above is about the FLAG
    // rather than about a constant: one reader, two algorithms, nothing
    // configured on either read.
    const gzipBody = await decodeBody(await encodeBody(payload, { compression: 'gzip' }));
    expect(gzipBody.compression).toBe('gzip');
    expect(gzipBody.payload).toEqual(payload);
  });
});

/**
 * The `## …` section a heading opens, up to the next `## ` — scoped rather than
 * page-wide because both markers below occur elsewhere on the page (`none` is
 * an algorithm the whole document discusses), so a page-wide match would pass
 * on a section that lost the claim entirely.
 */
function sectionUnder(path: string, page: string, heading: string): string {
  const start = page.indexOf(`\n${heading}\n`);
  if (start < 0) {
    throw new Error(
      `${path}: the "${heading}" heading is gone, so this guard no longer reads the section it `
      + 'names. Re-point it rather than deleting the assertions.',
    );
  }
  const next = page.indexOf('\n## ', start + 1);
  return page.slice(start, next < 0 ? page.length : next);
}

describe('compression docs — both languages carry both claims', () => {
  const pages = [
    ['English', ENGLISH_PAGE, '## Runtime support', /fzstd[\s\S]{0,300}\*\*import\*\*/],
    ['German', GERMAN_PAGE, '## Runtime-Unterstützung', /fzstd[\s\S]{0,300}\*\*Import\*\*/],
  ] as const;

  test.each(pages)('%s: the fzstd rung is accepted on an import, said so', (
    language,
    path,
    heading,
    importMarker,
  ) => {
    expect(
      sectionUnder(path, read(path), heading),
      `${language} (${path}): the section no longer says the fzstd rung is accepted on an import. `
      + 'Either the resolver started call-checking it — then the assertions above change in the '
      + 'same commit — or the page went back to claiming all three rungs are called.',
    ).toMatch(importMarker);
  });

  test.each(pages)('%s: the reader on such a runtime is told to configure gzip or none', (
    language,
    path,
    heading,
  ) => {
    // `none` appearing in a section about zstd runtime support is the marker:
    // it has no other business there, and its absence is exactly the state this
    // change fixed — the section named the read fallback and never said what
    // such a reader must be configured with.
    const section = sectionUnder(path, read(path), heading);
    expect(
      section,
      `${language} (${path}): the section stopped naming the algorithm a non-native reader must `
      + 'be configured with, which is the advice the two bullets above it imply and do not state.',
    ).toContain('`none`');
    expect(section).toContain('`gzip`');
  });
});
