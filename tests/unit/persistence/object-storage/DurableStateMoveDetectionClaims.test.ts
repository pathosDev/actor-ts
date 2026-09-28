import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemObjectStorageBackend } from '../../../../src/persistence/object-storage/FilesystemObjectStorageBackend.js';
import { FilesystemObjectStorageOptions } from '../../../../src/persistence/object-storage/FilesystemObjectStorageOptions.js';
import { ObjectStorageDurableStateStore } from '../../../../src/persistence/durable-state-stores/ObjectStorageDurableStateStore.js';
import { ObjectStorageDurableStateStoreOptions } from '../../../../src/persistence/durable-state-stores/ObjectStorageDurableStateStoreOptions.js';
import { ObjectStorageSnapshotStore } from '../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStore.js';
import { ObjectStorageSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStoreOptions.js';
import { decodeBody } from '../../../../src/persistence/object-storage/BodyCodec.js';
import {
  OBJECT_STORAGE_DURABLE_STATE_LEAF,
  OBJECT_STORAGE_DURABLE_STATE_NAMESPACE,
  OBJECT_STORAGE_SNAPSHOT_NAMESPACE,
  SEQ_PADDING,
} from '../../../../src/persistence/Constants.js';
import { JournalError } from '../../../../src/persistence/JournalTypes.js';

/**
 * A drift guard over what the object-storage pages say catches a durable-state
 * record that was moved between storage keys (#1417).
 *
 * The issue it comes from claimed such a move is caught "only with opt-in
 * context binding".  The tree refutes that in both directions, and neither
 * direction was written down anywhere:
 *
 *   - With an authenticator configured — `hmac-sha256` or `client-aes256-gcm`
 *     — the storage key has gone into the authenticated bytes on every write
 *     since #612.  A moved body is refused with `requireContextBinding`
 *     *unset*.  The knob is a separate control that refuses bodies carrying no
 *     binding at all, i.e. the pre-#612 corpus.
 *   - With neither authenticator — the default, and the only shape a config
 *     file can express, because both need a 32-byte key — nothing at this
 *     layer notices.  The durable-state body is `{ revision, state, timestamp }`
 *     and names no entity, `load` returns the *requested* `persistenceId` with
 *     the *body's* state, and `requireContextBinding` is deliberately ignored
 *     (demanding a binding where nothing produces one would reject the store's
 *     own writes).  `ObjectStorageSnapshotStore` is not in that position: a
 *     snapshot body names its entity and the store disbelieves one that names
 *     another (#716).
 *
 * So the pages are asserted against the mechanism rather than against
 * themselves.  The tree half fails if the asymmetry ever closes — which is
 * exactly when the prose becomes wrong.
 *
 * The prose half comes in **two layers, and conflating them is what went wrong
 * the first time**:
 *
 *   - *Term* assertions ("the section still mentions move detection") are
 *     topic checks.  They are cheap and survive a rewrite, and they cannot
 *     tell a claim from its negation — a section that says a store with
 *     neither authenticator has move detection *at all times* mentions every
 *     term the claim does.  The commit that added them called one of them "the
 *     discriminating assertion"; it was not.
 *   - *Phrase* assertions over `claimText`, further down, are the claim
 *     checks.  Each is a proposition bound in **both** languages by one table
 *     entry, so the mirrors cannot drift into contradicting each other, plus a
 *     list of the refuted premise's known spellings.
 *
 * Both layers read `renderedProse`, so they see only what a reader sees.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..', '..');

const ENGLISH_ENCRYPTION_PAGE = 'docs/src/content/docs/persistence/object-storage/encryption.mdx';
const GERMAN_ENCRYPTION_PAGE = 'docs/src/content/docs/de/persistence/object-storage/encryption.mdx';
const ENGLISH_SNAPSHOT_PAGE = 'docs/src/content/docs/persistence/object-storage/snapshot-store-backend.mdx';
const GERMAN_SNAPSHOT_PAGE = 'docs/src/content/docs/de/persistence/object-storage/snapshot-store-backend.mdx';
const ENGLISH_DURABLE_STATE_PAGE = 'docs/src/content/docs/persistence/durable-state.mdx';
const GERMAN_DURABLE_STATE_PAGE = 'docs/src/content/docs/de/persistence/durable-state.mdx';

const INTEGRITY_KEY = new Uint8Array(32).fill(7);
/** The other authenticator's key material, same values as `ContextBinding.test.ts`. */
const MASTER_KEY = new Uint8Array(32).fill(9);
const ENCRYPTION_INFO = 'acme/test/state/v1';

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

/* =============================== the mechanism ============================ */

let dir: string;
let backend: FilesystemObjectStorageBackend;

/**
 * Budget for the per-test temp tree, stated rather than inherited — the same
 * reasoning (and number) as `ContextBinding.test.ts`: these hooks build and
 * delete a real object-storage tree, which is single-digit milliseconds idle
 * and unbounded in principle under whole-suite disk contention, against bun's
 * undeclared 5 000 ms hook cap that reports as `(unnamed)` without naming the
 * file or the hook kind.
 */
const TEMP_TREE_BUDGET_MS = 30_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'actor-ts-move-claims-'));
  backend = new FilesystemObjectStorageBackend(FilesystemObjectStorageOptions.create().withDir(dir));
}, TEMP_TREE_BUDGET_MS);

afterEach(
  () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } },
  TEMP_TREE_BUDGET_MS,
);

/** On-disk path of a durable-state record, namespace segment included (#716). */
function durableStateFileFor(persistenceId: string): string {
  return join(dir, OBJECT_STORAGE_DURABLE_STATE_NAMESPACE, persistenceId, OBJECT_STORAGE_DURABLE_STATE_LEAF);
}

/** On-disk path of a snapshot, the sequence number zero-padded as the store writes it. */
function snapshotFileFor(persistenceId: string, sequenceNumber: number): string {
  return join(
    dir,
    OBJECT_STORAGE_SNAPSHOT_NAMESPACE,
    persistenceId,
    `${String(sequenceNumber).padStart(SEQ_PADDING, '0')}.json`,
  );
}

async function caught(run: () => Promise<unknown>): Promise<Error | null> {
  try { await run(); return null; } catch (e) { return e as Error; }
}

describe('durable-state move detection — the mechanism the pages describe (#1417)', () => {
  test('with no authenticator a moved record is adopted, and the body names no entity', async () => {
    // The default configuration: no encryption, no integrity.  Nothing
    // authenticates the body, so nothing binds it to the key it sits at.
    const storeOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' });
    const store = new ObjectStorageDurableStateStore(storeOptions);

    await store.upsert('alice', 0, { balance: 1_000_000 });
    await store.upsert('bob', 0, { balance: 1 });

    // Both are at revision 1, so the in-process rollback floor has nothing to
    // say about this move — it is purely a question of key-to-body binding.
    writeFileSync(durableStateFileFor('bob'), readFileSync(durableStateFileFor('alice')));
    store.forgetEtagForTest('bob');

    const loaded = (await store.load<{ balance: number }>('bob')).toNullable();
    expect(
      loaded,
      'a moved plaintext record stopped loading, so something now detects the move and the pages '
      + 'saying a store with neither authenticator has no move detection are stale',
    ).not.toBeNull();
    expect(loaded!.state.balance).toBe(1_000_000);
    expect(
      loaded!.persistenceId,
      'load stopped answering with the REQUESTED persistenceId, which is the half of the '
      + 'mechanism that turns a moved body into another entity\'s state',
    ).toBe('bob');

    // The other half, read off the wire rather than inferred: there is no
    // entity name in the body for a comparison to be made against.
    const decoded = await decodeBody(new Uint8Array(readFileSync(durableStateFileFor('bob'))));
    const payload = JSON.parse(new TextDecoder().decode(decoded.payload)) as Record<string, unknown>;
    expect(
      Object.keys(payload).sort(),
      'the durable-state body shape moved; if it now carries a persistenceId, the pages claiming '
      + 'the durable-state store has no body-carried id to compare must change in the same commit',
    ).toEqual(['revision', 'state', 'timestamp']);
  });

  test('requireContextBinding changes nothing on a store with no authenticator', async () => {
    // The knob the issue named as the control.  Where the gap actually is, it
    // is a no-op by construction: the demand is only passed to the codec when
    // something authenticates, because otherwise it would reject the store's
    // own writes.
    const storeOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withRequireContextBinding();
    const store = new ObjectStorageDurableStateStore(storeOptions);

    await store.upsert('alice', 0, { balance: 1_000_000 });
    await store.upsert('bob', 0, { balance: 1 });
    writeFileSync(durableStateFileFor('bob'), readFileSync(durableStateFileFor('alice')));
    store.forgetEtagForTest('bob');

    const loaded = (await store.load<{ balance: number }>('bob')).toNullable();
    expect(
      loaded?.state.balance,
      '`requireContextBinding` started catching a move on a store with no authenticator, so the '
      + 'pages calling it a no-op there are stale',
    ).toBe(1_000_000);
  });

  test('an authenticator catches the move with requireContextBinding unset', async () => {
    // The control the pages now name.  Nothing opt-in is set here.
    const storeOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY });
    const store = new ObjectStorageDurableStateStore(storeOptions);

    await store.upsert('alice', 0, { balance: 1_000_000 });
    await store.upsert('bob', 0, { balance: 1 });
    writeFileSync(durableStateFileFor('bob'), readFileSync(durableStateFileFor('alice')));
    store.forgetEtagForTest('bob');

    const error = await caught(() => store.load('bob'));
    expect(
      error,
      'a moved body verified at a foreign key under a configured authenticator — the binding is '
      + 'what the pages name as the control, so this failing means the pages are wrong',
    ).toBeInstanceOf(JournalError);
  });

  test('client-aes256-gcm catches the move too, with requireContextBinding unset', async () => {
    // The other half of "an authenticator", and it was bound by nothing.
    // Both pages name `client-aes256-gcm` and `hmac-sha256` together as the
    // control, while the mechanism half tested only the HMAC — so a
    // regression in the AES-GCM AAD path would have made the prose wrong with
    // every test in the tree still green, which is the exact failure mode
    // this file exists to prevent, on the authenticator it did not cover.
    // (`ContextBinding.test.ts` has two client-aes256-gcm move cases, but both
    // construct `ObjectStorageSnapshotStore`, whose body names its own entity
    // and so proves nothing about the store that has no id to compare.)
    const storeOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withEncryption({ mode: 'client-aes256-gcm', masterKey: MASTER_KEY, info: ENCRYPTION_INFO });
    const store = new ObjectStorageDurableStateStore(storeOptions);

    await store.upsert('alice', 0, { balance: 1_000_000 });
    await store.upsert('bob', 0, { balance: 1 });

    // The control that keeps this from passing for the wrong reason: a store
    // that could not read its OWN writes would also throw below, and the
    // assertion would then be reporting a broken configuration as a caught
    // move.  This has to succeed first.
    const own = (await store.load<{ balance: number }>('bob')).toNullable();
    expect(
      own?.state.balance,
      'the AES-GCM store cannot read a record it wrote itself, so the refusal below would say '
      + 'nothing about move detection',
    ).toBe(1);

    writeFileSync(durableStateFileFor('bob'), readFileSync(durableStateFileFor('alice')));
    store.forgetEtagForTest('bob');

    const error = await caught(() => store.load('bob'));
    expect(
      error,
      'a moved body decrypted at a foreign key under client-aes256-gcm. The storage key is the '
      + 'AAD, so this failing means the binding is gone on the encryption path and both pages are '
      + 'wrong to name that authenticator as the control.',
    ).toBeInstanceOf(JournalError);
  });

  test('the snapshot store compares the entity its body names, with nothing configured', async () => {
    // The asymmetry the pages now state: same backend, same absence of an
    // authenticator, a body that DOES name its entity — and a store that
    // disbelieves one naming another (#716).
    const storeOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' });
    const store = new ObjectStorageSnapshotStore(storeOptions);

    await store.save('alice', 1, { balance: 1_000_000 });
    await store.save('bob', 1, { balance: 1 });
    writeFileSync(snapshotFileFor('bob', 1), readFileSync(snapshotFileFor('alice', 1)));

    const reader = new ObjectStorageSnapshotStore(storeOptions);
    const loaded = (await reader.loadLatest<{ balance: number }>('bob')).toNullable();
    expect(
      loaded,
      'the snapshot store returned a body naming another entity, so the asymmetry the pages '
      + 'describe is gone and they say the snapshot half has a check it no longer has',
    ).toBeNull();
  });
});

/* ================================ the prose =============================== */

/**
 * A section reduced to the text this guard is entitled to read a claim out of.
 *
 * Two different removals, for two different reasons, and it is worth keeping
 * them apart:
 *
 *   - **Fenced code blocks** *do* render — they are visible to a reader — but
 *     a marker inside one is an *example*, not a claim, and these pages are
 *     mostly fences.  Found by attacking the guard rather than anticipated:
 *     with the claim deleted from the prose and the words `// move detection:
 *     only with an authenticator configured` added inside a ```ts fence in the
 *     same section, every assertion here stayed green.
 *   - **MDX comments and ESM statements render nothing at all.**  This is the
 *     strictly worse half of the same hole and it shipped unnoticed: the
 *     pre-claim page plus one trailing
 *     `Editorial note. {/* … *​/}` under each of the two headings left this
 *     file at 22 pass / 0 fail and `tests/unit/docs` at 1456 pass / 0 fail,
 *     exit 0, with no reader able to see a word of the claim.  Confirmed
 *     against the compiler the docs build actually uses: @mdx-js/mdx compiles
 *     that line to `_jsx(_components.p, {children: "Editorial note. "})` and
 *     hoists the markers into a bare JS comment.  Only the *line-leading* form
 *     is caught elsewhere (by `NoBraceLedLines`); the trailing form evaded
 *     everything.
 *
 * The asymmetry that makes this urgent: every other hole in a prose guard
 * produces a false RED, which someone investigates.  Text that renders nothing
 * produces a false GREEN, which is indistinguishable from the prose being fine.
 *
 * Asserting on the *rendered* text instead of stripping the source would be
 * better still, and is deliberately not done: `@mdx-js/mdx` lives only under
 * `docs/node_modules` and is not a root dependency, so importing it here would
 * make `bun test` depend on the docs install having been run.  The three
 * constructs below are the complete set of invisible ones — probed, not
 * assumed: an HTML comment is not one, because MDX refuses to compile it.
 *
 * Inline code spans are deliberately kept: `ObjectStorageSnapshotStore` and
 * `{ revision, state, timestamp }` are asserted on, and they are prose.
 */
function renderedProse(section: string): string {
  return section
    // Fences first: a brace-comment inside one is an example like any other,
    // and a fence inside a comment is not a fence.
    .replace(/^```[\s\S]*?^```/gm, '')
    // `{/* … */}`, including the multi-line form.  Non-greedy so two comments
    // in one section do not swallow the prose between them.
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    // An `export const note = '…'` or an `import` is valid MDX mid-page and
    // renders nothing.  Line-anchored: this can only ever remove a hard-wrapped
    // prose line that happens to begin with the word, which costs a false RED
    // someone will investigate — never the false GREEN this function exists to
    // prevent.
    .replace(/^(?:import|export)\s.*$/gm, '');
}

/**
 * The guard's own regression tests.
 *
 * Every assertion further down reads whatever `renderedProse` hands it, so a
 * loosening there silently unbinds all of them at once — which is exactly how
 * the MDX-comment hole survived.  These pin the extractor against fixtures
 * instead of against the live pages, so they stay red on the defect even when
 * the pages happen to be correct.
 */
describe('durable-state move detection — what the guard may read a claim out of', () => {
  const MARKERS = ['move detection', 'neither authenticator', 'no knob'] as const;

  test('a trailing MDX comment carries no claim — it renders nothing', () => {
    // The exact shape that defeated every assertion in this file.
    const section = 'Editorial note. {/* move detection - neither authenticator; no knob. */}\n';
    for (const marker of MARKERS) expect(renderedProse(section)).not.toContain(marker);
  });

  test('a line-leading and a multi-line MDX comment carry no claim either', () => {
    // Caught by `NoBraceLedLines` in the line-leading case, but this guard
    // must not depend on a different file's guard staying in place.
    expect(renderedProse('{/* no knob */}\n')).not.toContain('no knob');
    expect(renderedProse('Note.\n\n{/*\n  move detection\n*/}\n')).not.toContain('move detection');
  });

  test('an ESM statement carries no claim', () => {
    const section = "export const note = 'move detection with no knob';\n\nNote.\n";
    expect(renderedProse(section)).not.toContain('move detection');
    expect(renderedProse(section)).toContain('Note.');
  });

  test('a marker inside a fence is an example, not a claim', () => {
    const section = '```ts\n// move detection: only with an authenticator\n```\n';
    expect(renderedProse(section)).not.toContain('move detection');
  });

  test('two comments in one section do not swallow the prose between them', () => {
    // A greedy pattern would erase everything from the first `{/*` to the last
    // `*/}` — including a real claim — and that erasure reads as a missing
    // claim, i.e. a red this guard would be blamed for rather than a hole.
    const section = '{/* a */}\nA store with neither authenticator has none.\n{/* b */}\n';
    expect(renderedProse(section)).toContain('neither authenticator has none');
  });

  test('ordinary prose survives, emphasis and inline code included', () => {
    // The mirror of every test above: the extractor must not be so eager that
    // a real claim disappears and the guard passes on an empty string.
    const section = 'A store with **neither authenticator** has no move detection at all.\n'
      + '`ObjectStorageSnapshotStore` is not in that position.\n';
    for (const marker of MARKERS.slice(0, 2)) expect(renderedProse(section)).toContain(marker);
    expect(renderedProse(section)).toContain('ObjectStorageSnapshotStore');
  });
});

/**
 * The section a heading opens, up to the next heading of the same level or
 * above — scoped rather than page-wide because several markers below occur
 * elsewhere on these pages (`requireContextBinding` has its own section), so a
 * page-wide match would pass on a section that lost the claim entirely.
 */
function sectionUnder(path: string, page: string, heading: string): string {
  const start = page.indexOf(`\n${heading}\n`);
  if (start < 0) {
    throw new Error(
      `${path}: the "${heading}" heading is gone, so this guard no longer reads the section it `
      + 'names. Re-point it rather than deleting the assertions.',
    );
  }
  const level = heading.slice(0, heading.indexOf(' ')).length;
  const rest = page.slice(start + 1);
  let next = -1;
  for (let depth = 2; depth <= level; depth += 1) {
    const at = rest.indexOf(`\n${'#'.repeat(depth)} `);
    if (at >= 0 && (next < 0 || at < next)) next = at;
  }
  return renderedProse(next < 0 ? rest : rest.slice(0, next));
}

/**
 * The four sections that carry the claim, per language.  `movedRecord` is the
 * term the pages use for the thing being detected; asserting the term rather
 * than a sentence is what lets the prose be rewritten without this going red.
 */
const CLAIM_SECTIONS = [
  ['English', ENGLISH_ENCRYPTION_PAGE, '### What encryption does not cover', /move\s+detection/i],
  ['German', GERMAN_ENCRYPTION_PAGE, '### Was Verschlüsselung nicht abdeckt', /Verschiebungserkennung/i],
  ['English', ENGLISH_SNAPSHOT_PAGE, '### Two stores, one prefix', /move\s+detection/i],
  ['German', GERMAN_SNAPSHOT_PAGE, '### Zwei Stores, ein Prefix', /Verschiebungserkennung/i],
] as const;

describe('durable-state move detection — both languages name the control (#1417)', () => {
  test.each(CLAIM_SECTIONS)('%s %s: the section names move detection as the thing at stake', (
    language,
    path,
    heading,
    term,
  ) => {
    expect(
      sectionUnder(path, read(path), heading),
      `${language} (${path}): the section stopped naming move detection, which is the concept the `
      + 'whole claim is about.',
    ).toMatch(term);
  });

  test.each(CLAIM_SECTIONS)('%s %s: the section names the no-authenticator case', (
    language,
    path,
    heading,
  ) => {
    // The configuration the gap is in, and the only one a config file can
    // express.  A page that names only the configured cases describes a store
    // nobody is running by default.
    //
    // A bare /neither/ was the first spelling of this marker and it passed on
    // three of the four sections before a word of the claim existed: the
    // snapshot page's upgrade Aside says "neither client-side encryption nor
    // an integrity HMAC" about the migration pass, and the encryption page
    // says "neither by encryption alone" about the two replay shapes.  Pairing
    // the negation with the term these pages use for the thing being negated
    // is what makes it read the claim rather than the topic.
    //
    // `\s+` rather than a literal space, and not defensively: these pages are
    // hard-wrapped at about 70 columns, and the English marker first failed on
    // the snapshot page for no reason other than "neither" ending a line and
    // "authenticator" starting the next.  A guard over prose that a reflow can
    // turn red is a guard people delete.
    const marker = language === 'English'
      ? /neither\s+authenticator/i
      : /ohne\s+einen\s+der\s+beiden\s+Authentifikatoren/i;
    expect(
      sectionUnder(path, read(path), heading),
      `${language} (${path}): the section stopped naming the store with NEITHER authenticator — `
      + 'the default, and the one configuration where nothing at this layer detects a move.',
    ).toMatch(marker);
  });

  test.each(CLAIM_SECTIONS)('%s %s: the section states the asymmetry with the snapshot store', (
    language,
    path,
    heading,
  ) => {
    // Both stores sit on one backend under one prefix, and only one of them
    // compares a body-carried id.  Naming the other store is what makes the
    // claim a comparison rather than a bare limitation.
    const section = sectionUnder(path, read(path), heading);
    expect(
      section,
      `${language} (${path}): the section no longer names both stores, so the asymmetry — the `
      + 'snapshot half compares the entity its body names, the durable-state half has no id to '
      + 'compare — is not stated anywhere on the page.',
    ).toContain('ObjectStorageSnapshotStore');
    expect(section).toContain('ObjectStorageDurableStateStore');
  });
});

/* ------------------------- the claim, not the topic ----------------------- */

/**
 * A section normalised for phrase matching.
 *
 * `renderedProse` removes what a reader never sees; this additionally drops
 * emphasis markers and collapses runs of whitespace, so a phrase can be
 * asserted without `\s+` between every pair of words and without knowing
 * whether `**neither authenticator**` was bolded on the day.  That also
 * retires the hazard the term markers were written around: these pages are
 * hard-wrapped at about 70 columns, and a reflow used to be able to turn this
 * guard red by moving a line break into the middle of a marker.
 */
function claimText(section: string): string {
  return renderedProse(section)
    .replace(/[*_]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One language's binding of a proposition to a section that must assert it. */
type ClaimBinding = {
  readonly path: string;
  readonly heading: string;
  readonly mustSay: readonly RegExp[];
};

/**
 * A proposition, bound in **both** languages.
 *
 * The pair is a single object rather than two rows on purpose: it is not
 * possible to state a claim for English and forget German, which is the drift
 * this shape exists to prevent (see the suite below).
 */
type MirroredClaim = {
  readonly proposition: string;
  readonly english: ClaimBinding;
  readonly german: ClaimBinding;
};

/**
 * "The binding needs nothing switched on", per language.
 *
 * Named, because the exact shape of these two is the defect this block
 * repairs and the self-tests below pin them directly.  The previous spelling
 * was `/no\s+(knob|opt-in|option)/i`, which matches the substring "no knob"
 * inside "there is no knob-free path to move detection" — a sentence asserting
 * the reverse.  The trailing `(?!-)` is what separates the claim from a
 * hyphenated compound that negates it; `\b` alone does not, because a word
 * boundary sits between `knob` and `-`.
 */
const NEEDS_NO_KNOB_ENGLISH = /\bno\s+(knob|opt-in|option)s?\b(?!-)/i;
const NEEDS_NO_KNOB_GERMAN = /\b(kein|keinen|keine)\s+(Schalter|Opt-in|Option)(en)?\b(?!-)/i;

/**
 * Spellings of the premise these pages exist to refute — #1417's own "caught
 * only with opt-in context binding" and the inversions actually written during
 * review.  A section asserting any of them contradicts the mechanism tests
 * above, so it fails whatever else it says.
 *
 * This list is **not** what makes the guard discriminate; `mustSay` is.  It is
 * a second net under the specific sentences that have been observed, and it is
 * inherently incomplete — a new phrasing of the same falsehood would pass it.
 * Recorded plainly rather than implied to be exhaustive.
 */
const REFUTED_PREMISE = {
  English: [
    /knob-?free/i,
    /opt-?in-?free/i,
    /only with (opt-in )?context binding/i,
    /has move detection at all times/i,
    /move detection only with/i,
  ],
  German: [
    /Schalter-?frei/i,
    /Opt-?in-?frei/i,
    /nur mit (Opt-in-)?Kontextbindung/i,
    /Verschiebungserkennung zu jeder Zeit/i,
    /jederzeit eine Verschiebungserkennung/i,
    /Verschiebungserkennung nur mit/i,
  ],
} as const;

/**
 * Why this text fails to assert the proposition — empty when it asserts it.
 *
 * Returning reasons rather than a boolean is what lets the same predicate be
 * pointed at a fixture (below) and at a live page, so the fixtures prove the
 * predicate discriminates and the pages then rely on the proven one.
 */
function claimViolations(text: string, language: 'English' | 'German', mustSay: readonly RegExp[]): string[] {
  const reasons: string[] = [];
  for (const marker of mustSay) {
    if (!marker.test(text)) reasons.push(`does not assert ${String(marker)}`);
  }
  for (const marker of REFUTED_PREMISE[language]) {
    if (marker.test(text)) reasons.push(`asserts the refuted premise ${String(marker)}`);
  }
  return reasons;
}

/**
 * The claim the pages make, per proposition, in both languages.
 *
 * These are **phrases**, where everything above this line is terms.  The
 * difference is the whole point of this block: a term match reads the topic,
 * and the verifier demonstrated that a section can discuss the topic while
 * asserting the reverse.  `/no\s+(knob|opt-in|option)/i` — the marker this
 * replaces, and the one the previous commit message called "the discriminating
 * assertion" — matches the substring "no knob" inside "there is **no
 * knob-free path** to move detection", which says the opposite.
 */
const MIRRORED_CLAIMS: readonly MirroredClaim[] = [
  {
    proposition: 'the binding is on every write and needs nothing switched on',
    english: {
      path: ENGLISH_ENCRYPTION_PAGE,
      heading: '### What encryption does not cover',
      mustSay: [/on every write/i, NEEDS_NO_KNOB_ENGLISH],
    },
    german: {
      path: GERMAN_ENCRYPTION_PAGE,
      heading: '### Was Verschlüsselung nicht abdeckt',
      mustSay: [/bei jedem Write/i, NEEDS_NO_KNOB_GERMAN],
    },
  },
  {
    proposition: 'requireContextBinding is not the control that catches a moved body',
    english: {
      path: ENGLISH_ENCRYPTION_PAGE,
      heading: '### Requiring the binding',
      mustSay: [/on every write/i, NEEDS_NO_KNOB_ENGLISH],
    },
    german: {
      path: GERMAN_ENCRYPTION_PAGE,
      heading: '### Die Bindung verlangen',
      mustSay: [/bei jedem Write/i, NEEDS_NO_KNOB_GERMAN],
    },
  },
  {
    proposition: 'a store with neither authenticator has no move detection',
    english: {
      path: ENGLISH_ENCRYPTION_PAGE,
      heading: '### What encryption does not cover',
      mustSay: [/neither authenticator has no move detection/i],
    },
    german: {
      path: GERMAN_ENCRYPTION_PAGE,
      heading: '### Was Verschlüsselung nicht abdeckt',
      mustSay: [/ohne einen der beiden Authentifikatoren hat überhaupt keine Verschiebungserkennung/i],
    },
  },
  {
    proposition: 'the snapshot half compares a body-carried id, the durable-state half has none',
    english: {
      path: ENGLISH_SNAPSHOT_PAGE,
      heading: '### Two stores, one prefix',
      mustSay: [/neither authenticator has none/i],
    },
    german: {
      path: GERMAN_SNAPSHOT_PAGE,
      heading: '### Zwei Stores, ein Prefix',
      mustSay: [/ohne einen der beiden Authentifikatoren hat keine/i],
    },
  },
];

describe('durable-state move detection — the claim, not the topic (#1417)', () => {
  for (const claim of MIRRORED_CLAIMS) {
    for (const [language, binding] of [['English', claim.english], ['German', claim.german]] as const) {
      test(`${language} ${binding.path} — ${claim.proposition}`, () => {
        const text = claimText(sectionUnder(binding.path, read(binding.path), binding.heading));
        expect(
          claimViolations(text, language, binding.mustSay),
          `${language} (${binding.path}, "${binding.heading}") no longer asserts: ${claim.proposition}. `
          + 'This is the proposition the mechanism tests above prove, so a page that stops making it '
          + '— or makes its negation — is the drift this guard exists for. Re-point the marker only '
          + 'after checking the prose still says the same thing.',
        ).toEqual([]);
      });
    }
  }

  /**
   * The predicate's own regression tests.
   *
   * Pointed at fixtures rather than the live pages, so they stay red on a
   * marker that cannot tell a claim from its negation even while the pages
   * happen to be correct — which is the state the previous commit shipped in,
   * and why it went unnoticed.
   */
  describe('the markers reject the claim\'s negation', () => {
    const ENGLISH_NEGATION = 'Closed only by opt-in context binding. A moved body is still adopted '
      + 'until you also set `requireContextBinding`: there is no knob-free path to move detection. '
      + 'A store with neither authenticator has move detection at all times, so '
      + '`ObjectStorageDurableStateStore` and `ObjectStorageSnapshotStore` behave identically.';
    const GERMAN_NEGATION = '`requireContextBinding` ist die Kontrolle, die einen verschobenen Body '
      + 'fängt. Es gibt keinen Schalter-freien Weg zur Verschiebungserkennung: bleibt die Option '
      + 'ungesetzt, wird ein verschobener Datensatz übernommen.';

    test('the no-knob marker does not match a hyphenated compound that negates it', () => {
      // The defect itself, pinned at the smallest scale it exists at, because
      // at any larger scale another marker can mask it: the section assertions
      // above also require "on every write", which the negation happens not to
      // contain, so a page test would go red for the wrong reason and leave
      // this free to rot. `/no\s+(knob|opt-in|option)/i` matched every string
      // on the left below.
      expect('there is no knob-free path to move detection').not.toMatch(NEEDS_NO_KNOB_ENGLISH);
      expect('no opt-in-free route exists').not.toMatch(NEEDS_NO_KNOB_ENGLISH);
      expect('es gibt keinen Schalter-freien Weg').not.toMatch(NEEDS_NO_KNOB_GERMAN);

      // ...and still matches the claim it is for.
      expect('a moved body stops verifying with no knob to set').toMatch(NEEDS_NO_KNOB_ENGLISH);
      expect('the binding above already does that, on every write and with no knob')
        .toMatch(NEEDS_NO_KNOB_ENGLISH);
      expect('dafür ist kein Schalter nötig').toMatch(NEEDS_NO_KNOB_GERMAN);
    });

    test('English: the knob named as the control is refused', () => {
      const binding = MIRRORED_CLAIMS[0]!.english;
      expect(
        claimViolations(ENGLISH_NEGATION, 'English', binding.mustSay),
        'the English markers accepted prose asserting the exact premise #1417 was filed on. '
        + 'That is a guard reading the topic, not the claim.',
      ).not.toEqual([]);
    });

    test('German: the knob named as the control is refused', () => {
      const binding = MIRRORED_CLAIMS[0]!.german;
      expect(
        claimViolations(GERMAN_NEGATION, 'German', binding.mustSay),
        'the German markers accepted prose asserting the refuted premise.',
      ).not.toEqual([]);
    });

    test('the true claim is still accepted, in both languages', () => {
      // The other direction, and not a formality: a marker set tightened until
      // nothing passes would satisfy both tests above while binding nothing.
      const english = 'Configure one and the storage key goes into the authenticated bytes on every '
        + 'write, so a moved body stops verifying with no knob to set.';
      const german = 'Konfiguriere einen davon, und der Storage-Key geht bei jedem Write in die '
        + 'authentifizierten Bytes ein; ein verschobener Body verifiziert dann nicht mehr, und '
        + 'dafür ist kein Schalter nötig.';
      expect(claimViolations(english, 'English', MIRRORED_CLAIMS[0]!.english.mustSay)).toEqual([]);
      expect(claimViolations(german, 'German', MIRRORED_CLAIMS[0]!.german.mustSay)).toEqual([]);
    });
  });

  test('every proposition is bound in both languages', () => {
    // The EN and DE mirrors were left free to contradict each other: the
    // verifier made the English encryption page say a store with neither
    // authenticator "has move detection at all times" while the German one
    // said it has none, and got 22 pass / 0 fail. The pair-shaped table above
    // is what stops that — both languages are pinned to one proposition — and
    // this asserts the shape itself, so a claim cannot be half-bound by
    // deleting a mirror's markers.
    for (const claim of MIRRORED_CLAIMS) {
      expect(claim.english.mustSay.length, `English half of: ${claim.proposition}`).toBeGreaterThan(0);
      expect(claim.german.mustSay.length, `German half of: ${claim.proposition}`).toBeGreaterThan(0);
      expect(claim.english.path.includes('/de/'), `${claim.proposition}: English half points at a German page`).toBe(false);
      expect(claim.german.path.includes('/de/'), `${claim.proposition}: German half points at an English page`).toBe(true);
    }
  });
});

describe('durable-state move detection — the control is the binding, not the knob (#1417)', () => {
  const DURABLE_STATE_PAGES = [
    ['English', ENGLISH_DURABLE_STATE_PAGE, '## Encryption + compression + integrity'],
    ['German', GERMAN_DURABLE_STATE_PAGE, '## Verschlüsselung + Kompression + Integrität'],
  ] as const;

  test.each(DURABLE_STATE_PAGES)('%s %s: the durable-state page points at the authenticator', (
    language,
    path,
    heading,
  ) => {
    // The page a durable-state reader actually opens.  It documented the three
    // per-actor overrides as a privacy feature and said nothing about the
    // second thing configuring one buys.
    const section = sectionUnder(path, read(path), heading);
    const marker = language === 'English' ? /move\s+detection/i : /Verschiebungserkennung/i;
    expect(
      section,
      `${language} (${path}): the section stopped saying that configuring an authenticator is `
      + 'what buys move detection, so a durable-state reader is never told the default has none.',
    ).toMatch(marker);
  });
});
