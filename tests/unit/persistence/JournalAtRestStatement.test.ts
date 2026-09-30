import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import { unsupportedPersistenceOptionMessage } from '../../../src/persistence/PersistenceCapabilities.js';

/**
 * The journal at-rest statement (#1430).
 *
 * `encryption()` and `integrity()` on a `PersistentActor` reach the snapshot
 * store and nothing else.  `PersistentActor.preStart` asks the snapshot store
 * whether it honours them (#960); the `Journal` contract takes no
 * `PersistenceOptions` at all, and every journal writes its events through
 * `encodePayload` as JSON text.  Executed while this guard was written: an
 * actor with both hooks over an encrypting, verifying object-storage snapshot
 * store and a SQLite journal starts, its event row sits in the database file
 * as `{"kind":"deposited","amount":10}`, and the row edited to
 * `"amount":1000000` is folded on recovery with no error.  No page said so,
 * and several said the opposite.
 *
 * So one sentence per language is pinned on every surface that tells a reader
 * what these hooks protect.  One sentence rather than a wording per page, on
 * purpose: whoever changes the claim — #1430's decision half may — changes it
 * everywhere at once, or this goes red on the surface they missed.  The
 * sentence says "today" and promises nothing about how the gap closes, so it
 * holds under every answer to that question.
 *
 * What a surface is held to comes in two parts, the same pair
 * `CollationAdvisory.test.ts` asserts for its pages: the sentence must be
 * there, and a known inversion of it must not.  Requiring the sentence alone
 * is satisfied by a surface that states it and then contradicts it; the
 * inversion list alone is satisfied by deleting the claim.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');

/** The sentence, per language, as an author writes it — code spans and all. */
const STATEMENT = {
  english: '`encryption()` and `integrity()` on a `PersistentActor` protect its snapshots only: every '
    + 'journal stores events as plaintext JSON, nothing detects an event edited in place, and '
    + 'database-side controls — transparent data encryption, an encrypted volume, access control — '
    + 'are the only protection for events today.',
  german: '`encryption()` und `integrity()` an einem `PersistentActor` schützen nur seine Snapshots: '
    + 'Jedes Journal speichert Events als Klartext-JSON, nichts erkennt ein an Ort und Stelle '
    + 'manipuliertes Event, und datenbankseitige Kontrollen — Transparent Data Encryption, ein '
    + 'verschlüsseltes Volume, Zugriffskontrolle — sind heute der einzige Schutz für Events.',
} as const;

type Language = keyof typeof STATEMENT;

/**
 * Spellings of the premise the sentence refutes, matched against
 * {@link normalised} text.  Each is a way the claim has actually been made or
 * would plausibly be made back: the per-actor-policies page said persistent
 * and durable-state actors "both honor them", the journal pages implied the
 * journal is asked, and the rest are the direct inversions.
 *
 * Not what makes the guard discriminate — the required sentence is — and
 * inherently incomplete: a new phrasing of the same falsehood passes it.
 * Written down plainly rather than implied to be exhaustive.  Each pattern
 * stops short of a negation on purpose ("the journal is never asked" must
 * not match "the journal is … asked").
 */
const REFUTED_PREMISE: Readonly<Record<Language, readonly RegExp[]>> = {
  english: [
    /protects? (?:both )?(?:its |the |their )?snapshots and (?:its |the |their )?events/,
    /\bevents are (?:also )?(?:encrypted|signed)\b/,
    /\bthe journal is (?:also )?(?:encrypted|signed|asked)\b/,
    /\bboth honou?r them\b/,
  ],
  german: [
    /schützen (?:sie )?(?:sowohl )?(?:seine |die |ihre )?snapshots (?:als auch|und) (?:seine |die |ihre )?events/,
    /\bevents (?:werden|sind) (?:auch |ebenfalls )?(?:verschlüsselt|signiert)\b/,
    // German moves the verb ahead of its subject after an adverbial.
    /\b(?:werden|sind) (?:die |seine |ihre )?events (?:auch |ebenfalls )?(?:verschlüsselt|signiert)\b/,
    /\bdas journal wird (?:auch |ebenfalls )?(?:verschlüsselt|signiert|gefragt)\b/,
    /\bhonorieren beide\b/,
  ],
};

/**
 * Text reduced to what a phrase is compared against: code-span backticks and
 * emphasis markers dropped, every run of whitespace — line breaks and a
 * comment's `*` gutter included — collapsed to one space, case folded.  A
 * reflow, a code span or a bolded word must not turn this red; a changed
 * word must.
 */
function normalised(text: string): string {
  return text
    .replace(/[`*_]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Why `text` fails to carry the statement — empty when it carries it.
 *
 * Reasons rather than a boolean, so the same predicate can be pointed at a
 * fixture (the self-tests below) and at a live surface, and the fixtures
 * prove the predicate discriminates before the surfaces rely on it.
 */
function statementViolations(text: string, language: Language): string[] {
  const haystack = normalised(text);
  const reasons: string[] = [];
  if (!haystack.includes(normalised(STATEMENT[language]))) {
    reasons.push(`does not carry the ${language} statement`);
  }
  for (const premise of REFUTED_PREMISE[language]) {
    if (premise.test(haystack)) reasons.push(`asserts the refuted premise ${String(premise)}`);
  }
  return reasons;
}

/**
 * CRLF folded to LF.  Not cosmetic: this repository checks out with
 * `core.autocrlf=true` on Windows, and every anchor below is spelled with
 * `\n` — an anchor that silently matches nothing is how a guard over prose
 * turns green without reading anything.
 */
function withUnixLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function read(path: string): string {
  return withUnixLineEndings(readFileSync(join(REPOSITORY_ROOT, path), 'utf8'));
}

/**
 * The JSDoc block that documents the declaration beginning with `declaration`
 * — the block whose closing delimiter is followed by nothing but whitespace
 * before it, so a comment elsewhere in the file, or one parted from the
 * declaration by a line comment, is not read as documenting it.  The
 * declaration must occur exactly once, or the guard would be reading
 * whichever copy came first.
 */
function jsDocAbove(source: string, declaration: string): string {
  const at = source.indexOf(declaration);
  if (at < 0 || source.indexOf(declaration, at + 1) >= 0) {
    throw new Error(
      `expected exactly one \`${declaration.trim()}\` — the declaration moved or was duplicated, `
      + 'so this guard no longer knows which JSDoc to read. Re-point it rather than deleting it.',
    );
  }
  const before = source.slice(0, at);
  const close = before.lastIndexOf('*/');
  const open = close < 0 ? -1 : before.lastIndexOf('/**', close);
  if (open < 0 || before.slice(close + 2).trim() !== '') {
    throw new Error(`no JSDoc block sits directly above \`${declaration.trim()}\``);
  }
  return before.slice(open + 3, close);
}

/* ============================ the source surfaces ========================== */

const PERSISTENT_ACTOR = 'src/persistence/PersistentActor.ts';
const PERSISTENCE_OPTIONS = 'src/persistence/PersistenceOptions.ts';

/**
 * The declarations whose JSDoc an IDE shows at the moment someone configures
 * the hooks.  Both hooks carry the sentence, because a hover over
 * `integrity()` shows `integrity()`'s block and nothing else.
 */
const SOURCE_SURFACES = [
  ['PersistentActor.encryption()', PERSISTENT_ACTOR, '\n  encryption(): EncryptionConfig | undefined {'],
  ['PersistentActor.integrity()', PERSISTENT_ACTOR, '\n  integrity(): IntegrityConfig | undefined {'],
  ['the PersistenceOptions type', PERSISTENCE_OPTIONS, '\nexport type PersistenceOptions = {'],
] as const;

describe('the journal at-rest statement — source surfaces (#1430)', () => {
  test.each(SOURCE_SURFACES)('%s documents that the hooks protect snapshots only', (_name, path, declaration) => {
    expect(
      statementViolations(jsDocAbove(read(path), declaration), 'english'),
      `${path}: the JSDoc above \`${declaration.trim()}\` no longer states the journal at-rest sentence, `
      + 'or states its inversion. That block is what an IDE shows at the moment the hook is configured.',
    ).toEqual([]);
  });

  test('PersistenceOptions no longer calls itself a bag any persistence store may accept', () => {
    // The journal cannot accept it: `Journal.append` and `Journal.read` take
    // no options.  "Any persistence store" read as including the one that
    // holds the events.
    const block = normalised(jsDocAbove(read(PERSISTENCE_OPTIONS), '\nexport type PersistenceOptions = {'));
    expect(block).not.toContain('any persistence store may accept');
  });

  test('the refusal text carries the same sentence as the pages', () => {
    // `PersistenceCapabilities.test.ts` asserts the clause at the actor seam;
    // this holds its wording to the one the pages are held to, so the message
    // and the docs cannot drift into two different claims.
    const message = unsupportedPersistenceOptionMessage('snapshot-store', 'PostgresSnapshotStore', 'integrity');
    expect(statementViolations(message, 'english')).toEqual([]);
  });
});

/* ======================== the guard's own regression tests ================= */

/**
 * Pointed at fixtures rather than the live surfaces, so they stay red on a
 * predicate that cannot tell the claim from its negation even while every
 * surface happens to be correct — the state in which a guard's hole ships.
 */
describe('the journal at-rest guard — what it accepts and refuses', () => {
  const ENGLISH = STATEMENT.english;

  test('the statement survives a reflow, a code span and emphasis', () => {
    const reflowed = ENGLISH
      .replace('every journal', 'every\n * journal')
      .replace('`PersistentActor`', '**PersistentActor**')
      .replace('plaintext JSON', '`plaintext JSON`');
    expect(statementViolations(reflowed, 'english')).toEqual([]);
  });

  test('the statement with its inversion appended is refused', () => {
    for (const inversion of [
      'In practice encryption() protects its snapshots and its events alike.',
      'With an object-storage snapshot store the events are also encrypted.',
      'The journal is asked as well and refuses the actor at start.',
      'Persistent actors and durable-state actors both honor them.',
    ]) {
      expect(statementViolations(`${ENGLISH} ${inversion}`, 'english'), inversion).not.toEqual([]);
    }
    for (const inversion of [
      'Tatsächlich schützen sie seine Snapshots und seine Events.',
      'Mit Object Storage werden die Events ebenfalls verschlüsselt.',
      'Das Journal wird ebenfalls gefragt.',
      'Persistent Actors und Durable State Actors honorieren beide.',
    ]) {
      expect(statementViolations(`${STATEMENT.german} ${inversion}`, 'german'), inversion).not.toEqual([]);
    }
  });

  test('the corrected claims are not mistaken for inversions', () => {
    // The mirror of the test above: a pattern set so eager that the true
    // sentences trip it would go red on every correct surface and get deleted.
    expect(statementViolations(`${ENGLISH} The journal is never asked.`, 'english')).toEqual([]);
    expect(statementViolations(`${STATEMENT.german} Das Journal wird nie gefragt.`, 'german')).toEqual([]);
  });

  test('a changed word is refused, and so is the other language', () => {
    expect(statementViolations(ENGLISH.replace('snapshots only', 'snapshots first'), 'english')).not.toEqual([]);
    expect(statementViolations(ENGLISH.replace(' today', ''), 'english')).not.toEqual([]);
    expect(statementViolations(ENGLISH, 'german')).not.toEqual([]);
  });

  test('a JSDoc parted from its declaration by a line comment is not read as documenting it', () => {
    const source = `/** ${ENGLISH} */\n// an unrelated note\n  encryption(): EncryptionConfig | undefined {`;
    expect(() => jsDocAbove(source, '\n  encryption(): EncryptionConfig | undefined {')).toThrow(/directly above/);
  });

  test('the statement on a neighbouring declaration does not count for this one', () => {
    const source = `/** ${ENGLISH} */\n  compression(): CompressionConfig | undefined {}\n`
      + '/** Per-actor encryption. */\n  encryption(): EncryptionConfig | undefined {}\n';
    const block = jsDocAbove(source, '\n  encryption(): EncryptionConfig | undefined {');
    expect(statementViolations(block, 'english')).not.toEqual([]);
  });

  test('a declaration that appears twice is refused rather than guessed at', () => {
    const source = '/** a */\n  encryption(): EncryptionConfig | undefined {}\n'
      + '/** b */\n  encryption(): EncryptionConfig | undefined {}\n';
    expect(() => jsDocAbove(source, '\n  encryption(): EncryptionConfig | undefined {')).toThrow(/exactly one/);
  });

  test('CRLF sources read like LF ones', () => {
    const crlf = `/**\r\n * ${ENGLISH}\r\n */\r\n  encryption(): EncryptionConfig | undefined {`;
    const block = jsDocAbove(withUnixLineEndings(crlf), '\n  encryption(): EncryptionConfig | undefined {');
    expect(statementViolations(block, 'english')).toEqual([]);
  });
});
