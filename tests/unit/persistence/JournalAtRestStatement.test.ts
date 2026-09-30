import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import {
  FilesystemObjectStorageBackend,
  FilesystemObjectStorageOptions,
  getSqliteDriver,
  InMemoryJournal,
  ObjectStorageSnapshotStore,
  ObjectStorageSnapshotStoreOptions,
  PersistenceExtensionId,
  PersistentActor,
  SqliteJournal,
  SqliteJournalOptions,
  type EncryptionConfig,
  type IntegrityConfig,
  type Journal,
  type JournalEntry,
  type PersistenceOptionSupport,
  type PersistentEvent,
  type SnapshotStore,
} from '../../../src/persistence/index.js';
import { unsupportedPersistenceOptionMessage } from '../../../src/persistence/PersistenceCapabilities.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

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
 *
 * And the sentence itself is held to the tree.  The mechanism half below
 * executes what it claims — the journal is never asked, `append` is handed
 * nothing but its three arguments, a SQLite row under both hooks is the
 * plaintext domain value, and that row edited in place folds without an
 * error — so a change that makes the sentence false turns this file red even
 * while every surface still says it.  Probed: `preStart` asking the journal,
 * `append` handed the options, and events wrapped before the journal sees
 * them each fail here.
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

/**
 * The run of `//` lines around the one line containing `marker`, comment
 * markers stripped — what a reader of a commented-out recipe takes in as one
 * note.  A line that is not a line comment ends the run, so the sentence in
 * a comment elsewhere in the file, or in a string the example prints, does
 * not count as annotating this recipe.
 */
function lineCommentRunAround(source: string, marker: string): string {
  const lines = source.split('\n');
  const matching = lines.flatMap((line, index) => (line.includes(marker) ? [index] : []));
  if (matching.length !== 1) {
    throw new Error(`expected exactly one line containing \`${marker}\`, found ${matching.length} — re-point this guard.`);
  }
  const isLineComment = (line: string | undefined): boolean => line !== undefined && /^\s*\/\//.test(line);
  const at = matching[0]!;
  if (!isLineComment(lines[at])) throw new Error(`\`${marker}\` is no longer inside a line comment.`);
  let first = at;
  while (isLineComment(lines[first - 1])) first -= 1;
  let last = at;
  while (isLineComment(lines[last + 1])) last += 1;
  return lines.slice(first, last + 1).map((line) => line.replace(/^\s*\/\/\s?/, '')).join('\n');
}

/* ================================ the mechanism ============================ */

/**
 * The sentence's claims, executed — so this file goes red the day the
 * sentence stops being true, and not only the day a surface stops saying it.
 * `DurableStateMoveDetectionClaims.test.ts` holds its pages to the mechanism
 * the same way.  Should the journal ever gain a seam for these hooks, these
 * fail first, and the sentence has to move with them.
 */

const MASTER_KEY = new Uint8Array(32).fill(0x31);
const INTEGRITY_KEY = new Uint8Array(32).fill(0x42);
const CLIENT_ENCRYPTION: EncryptionConfig = {
  mode: 'client-aes256-gcm',
  masterKey: MASTER_KEY,
  info: 'actor-ts/test/journal-at-rest/v1',
};
const HMAC_INTEGRITY: IntegrityConfig = { mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY };
const NONE_SUPPORTED: PersistenceOptionSupport = { encryption: false, compression: false, integrity: false };

/**
 * A stated cap for the two tests below, which build real stores in a temp
 * directory: a SQLite file and an object-storage tree, twice over.  Idle
 * that is tens of milliseconds; under a loaded parallel run it is not, and
 * bun's undeclared 5 000 ms default would report a stall without its label.
 */
const MECHANISM_TEST_CAP_MS = 20_000;
const MECHANISM_WAIT_BUDGET_MS = 4_000;

type DepositCommand = { readonly kind: 'deposit'; readonly amount: number };
type DepositedEvent = { readonly kind: 'deposited'; readonly amount: number };
type LedgerState = { readonly balance: number };

/** What a `Ledger` saw of its own recovery, which is unreachable from outside once it runs. */
type LedgerObservations = { recovered: LedgerState | null; failure: Error | null };

const LEDGER_ID = 'ledger-at-rest';

/** Both hooks set, exactly as the per-actor pages tell a reader to set them. */
class Ledger extends PersistentActor<DepositCommand, DepositedEvent, LedgerState> {
  readonly persistenceId = LEDGER_ID;

  constructor(private readonly observations: LedgerObservations) { super(); }

  initialState(): LedgerState { return { balance: 0 }; }

  onEvent(state: LedgerState, event: DepositedEvent): LedgerState {
    return { balance: state.balance + event.amount };
  }

  override encryption(): EncryptionConfig { return CLIENT_ENCRYPTION; }

  override integrity(): IntegrityConfig { return HMAC_INTEGRITY; }

  override onRecoveryComplete(state: LedgerState): void { this.observations.recovered = state; }

  /**
   * Records whatever `preStart` throws — a refusal is raised there, ahead of
   * recovery, and a recovery failure is rethrown through it by the default
   * `onRecoveryFailure` — so a test sees either at once instead of waiting
   * out its budget.
   */
  override async preStart(): Promise<void> {
    try {
      await super.preStart();
    } catch (e) {
      this.observations.failure = e instanceof Error ? e : new Error(String(e));
      throw e;
    }
  }

  async onCommand(_state: LedgerState, command: DepositCommand): Promise<void> {
    await this.persist({ kind: 'deposited', amount: command.amount });
  }
}

/**
 * A journal that declares it protects nothing, and records how it is called.
 * Were the journal ever asked about the hooks, this one would get the actor
 * refused; were `append` ever handed the actor's options, a fourth argument
 * would show up in `appendArity`.
 */
class DecliningJournal extends InMemoryJournal {
  readonly persistenceOptionSupport: PersistenceOptionSupport = NONE_SUPPORTED;
  readonly appendArity: number[] = [];

  override async append<E>(
    persistenceId: string,
    entries: ReadonlyArray<JournalEntry<E>>,
    expectedSeq: number,
    ...unexpected: unknown[]
  ): Promise<PersistentEvent<E>[]> {
    this.appendArity.push(3 + unexpected.length);
    return super.append(persistenceId, entries, expectedSeq);
  }
}

/** The store the pages recommend: it encrypts and verifies both hooks, on write and read. */
function objectStorageSnapshots(directory: string): ObjectStorageSnapshotStore {
  const backendOptions = FilesystemObjectStorageOptions.create().withDir(directory);
  const storeOptions = ObjectStorageSnapshotStoreOptions.create()
    .withBackend(new FilesystemObjectStorageBackend(backendOptions));
  return new ObjectStorageSnapshotStore(storeOptions);
}

function systemOver(name: string, journal: Journal, snapshotStore: SnapshotStore, log: RecordingLogger): ActorSystem {
  const systemOptions = ActorSystemOptions.create().withLogger(log);
  const system = ActorSystem.create(name, systemOptions);
  const persistence = system.extension(PersistenceExtensionId);
  persistence.setJournal(journal);
  persistence.setSnapshotStore(snapshotStore);
  return system;
}

/**
 * Best-effort, like `StorageIdentity.test.ts`'s cleanup and for its reason:
 * Windows can hold a closed SQLite handle past `close()`, and a cleanup EBUSY
 * says nothing about what the file held.
 */
function removeBestEffort(directory: string): void {
  try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
}

async function recovered(observations: LedgerObservations, label: string): Promise<void> {
  await awaitCondition(
    () => observations.recovered !== null || observations.failure !== null,
    { label, timeoutMs: MECHANISM_WAIT_BUDGET_MS },
  );
}

describe('the mechanism the sentence describes — red the day it stops being true (#1430)', () => {
  test('the journal is never asked: one declaring it protects nothing still gets the actor, and three arguments', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'actor-ts-journal-at-rest-'));
    const journal = new DecliningJournal();
    const log = new RecordingLogger();
    const system = systemOver('journal-never-asked', journal, objectStorageSnapshots(directory), log);
    const observations: LedgerObservations = { recovered: null, failure: null };
    try {
      const ledger = system.spawn(() => new Ledger(observations), 'ledger');
      await recovered(observations, 'the ledger finished recovering');
      expect(
        observations.failure,
        'the actor was refused — something now asks the journal about encryption() or integrity(), '
        + 'so "the journal is never asked" and the sentence it backs are stale',
      ).toBeNull();

      ledger.tell({ kind: 'deposit', amount: 10 });
      await awaitCondition(
        async () => (await journal.highestSeq(LEDGER_ID)) >= 1,
        { label: 'the deposit reached the journal', timeoutMs: MECHANISM_WAIT_BUDGET_MS },
      );
      expect(
        journal.appendArity,
        'append received more than its three arguments — the actor now hands the journal something, '
        + 'which is the seam the sentence says does not exist',
      ).toEqual([3]);
      // The domain value itself reached the journal, not a ciphertext frame.
      const stored = await journal.read<DepositedEvent>(LEDGER_ID, 1);
      expect(stored.map((persisted) => persisted.event)).toEqual([{ kind: 'deposited', amount: 10 }]);
      expect(
        log.records.filter((record) => record.message.includes('#960')),
        'something now reports on the hooks at start — the pages say nothing refuses and nothing warns',
      ).toEqual([]);
    } finally {
      await system.terminate();
      removeBestEffort(directory);
    }
  }, MECHANISM_TEST_CAP_MS);

  test('under both hooks a SQLite row is plaintext JSON, and an edit to it folds without an error', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'actor-ts-journal-at-rest-'));
    const path = join(directory, 'journal.db');
    const journalOptions = SqliteJournalOptions.create().withPath(path);
    try {
      const writer: LedgerObservations = { recovered: null, failure: null };
      const journal = new SqliteJournal(journalOptions);
      const system = systemOver('journal-at-rest-write', journal, objectStorageSnapshots(join(directory, 'snapshots')),
        new RecordingLogger());
      try {
        const ledger = system.spawn(() => new Ledger(writer), 'ledger');
        await recovered(writer, 'the first incarnation finished recovering');
        ledger.tell({ kind: 'deposit', amount: 10 });
        await awaitCondition(
          async () => (await journal.highestSeq(LEDGER_ID)) >= 1,
          { label: 'the deposit reached the SQLite file', timeoutMs: MECHANISM_WAIT_BUDGET_MS },
        );
      } finally {
        await system.terminate();
        await journal.close();
      }

      // The row at rest, read the way anyone with access to the file reads it — then edited in place.
      const database = (await getSqliteDriver()).open(path);
      try {
        const row = database.prepare('SELECT payload FROM events WHERE persistence_id = ?').get<{ payload: string }>(LEDGER_ID);
        expect(
          JSON.parse(row!.payload),
          'the stored event is no longer the plaintext domain value — something now encrypts or wraps '
          + 'events, so "every journal stores events as plaintext JSON" is stale',
        ).toEqual({ kind: 'deposited', amount: 10 });
        database.prepare('UPDATE events SET payload = ? WHERE persistence_id = ?')
          .run(JSON.stringify({ kind: 'deposited', amount: 1_000_000 }), LEDGER_ID);
      } finally {
        database.close();
      }

      const reader: LedgerObservations = { recovered: null, failure: null };
      const reopened = new SqliteJournal(journalOptions);
      const restarted = systemOver('journal-at-rest-recover', reopened,
        objectStorageSnapshots(join(directory, 'snapshots')), new RecordingLogger());
      try {
        restarted.spawn(() => new Ledger(reader), 'ledger');
        await recovered(reader, 'the second incarnation finished recovering');
      } finally {
        await restarted.terminate();
        await reopened.close();
      }
      expect(
        reader.failure,
        'recovery refused the edited row — something now verifies events, so "nothing detects an '
        + 'event edited in place" is stale',
      ).toBeNull();
      expect(reader.recovered).toEqual({ balance: 1_000_000 });
    } finally {
      removeBestEffort(directory);
    }
  }, MECHANISM_TEST_CAP_MS);
});

/* ============================ the source surfaces ========================== */

const PERSISTENT_ACTOR = 'src/persistence/PersistentActor.ts';
const PERSISTENCE_OPTIONS = 'src/persistence/PersistenceOptions.ts';
const S3_SNAPSHOT_EXAMPLE = 'examples/persistence/s3-snapshot-bank-account.ts';

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

  test('the example\'s per-actor encryption recipe says what it protects', () => {
    // The recipe sits on an actor whose journal is an InMemoryJournal, and a
    // reader who uncomments it believes the account is now encrypted.
    const recipe = lineCommentRunAround(read(S3_SNAPSHOT_EXAMPLE), 'override encryption(): EncryptionConfig {');
    expect(
      statementViolations(recipe, 'english'),
      `${S3_SNAPSHOT_EXAMPLE}: the commented encryption() recipe no longer states the journal at-rest `
      + 'sentence, or states its inversion.',
    ).toEqual([]);
  });

  test('the example\'s plugin-wide encryption recipe says the events are not covered', () => {
    const recipe = normalised(lineCommentRunAround(read(S3_SNAPSHOT_EXAMPLE), '.withEncryption({'));
    expect(recipe).toContain('the snapshots, never the journal\'s events');
  });

  test('the refusal text carries the same sentence as the pages', () => {
    // `PersistenceCapabilities.test.ts` asserts the clause at the actor seam;
    // this holds its wording to the one the pages are held to, so the message
    // and the docs cannot drift into two different claims.
    const message = unsupportedPersistenceOptionMessage('snapshot-store', 'PostgresSnapshotStore', 'integrity');
    expect(statementViolations(message, 'english')).toEqual([]);
  });
});

/* ============================== the page surfaces ========================== */

/**
 * A slice of an MDX page reduced to what a reader sees — the three removals
 * `DurableStateMoveDetectionClaims.test.ts` makes, for the reasons it gives.
 * A fenced block renders, but a sentence inside one is an example, not a
 * claim.  An MDX comment and an ESM statement render nothing at all, and a
 * guard that reads them goes green on a page where no reader can see the
 * claim.  One widening over that file: a fence may be indented, because
 * inside an `<Aside>` every line is, and the danger aside below is exactly
 * where a statement would be tucked into one.
 */
function renderedProse(section: string): string {
  return section
    .replace(/^[ \t]*```[\s\S]*?^[ \t]*```/gm, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^(?:import|export)\s.*$/gm, '');
}

/**
 * The page with every fenced block's content blanked, same length, so a
 * `# comment` line inside a HOCON or shell fence is not taken for a heading.
 * Offsets stay valid against the original page.
 */
function withFencesBlanked(page: string): string {
  return page.replace(/^[ \t]*```[\s\S]*?^[ \t]*```/gm, (fence) => fence.replace(/[^\n]/g, ' '));
}

/**
 * The section a heading opens, up to the next heading of the same level or
 * above.  Scoped rather than page-wide on purpose: the sentence belongs where
 * a reader meets the claim it corrects — three sections away from the
 * paragraph that recommends the split configuration, it corrects nothing.
 */
function headingSection(path: string, page: string, heading: string): string {
  const scan = withFencesBlanked(page);
  const start = scan.indexOf(`\n${heading}\n`);
  if (start < 0) {
    throw new Error(`${path}: the "${heading}" heading is gone — re-point this guard rather than deleting it.`);
  }
  const level = heading.indexOf(' ');
  const bodyStart = start + heading.length + 2;
  let end = page.length;
  for (let depth = 1; depth <= level; depth += 1) {
    const at = scan.indexOf(`\n${'#'.repeat(depth)} `, bodyStart - 1);
    if (at >= 0 && at < end) end = at;
  }
  return page.slice(bodyStart, end);
}

/** The body of the one `<Aside>` titled `title`, up to its `</Aside>`. */
function asideBody(path: string, page: string, title: string): string {
  const opening = `title="${title}">`;
  const at = page.indexOf(opening);
  if (at < 0 || page.indexOf(opening, at + 1) >= 0) {
    throw new Error(`${path}: expected exactly one aside titled "${title}" — re-point this guard.`);
  }
  const close = page.indexOf('</Aside>', at);
  if (close < 0) throw new Error(`${path}: the aside titled "${title}" is never closed.`);
  return page.slice(at + opening.length, close);
}

type HeadingScope = { readonly kind: 'heading'; readonly heading: string };
type AsideScope = { readonly kind: 'aside'; readonly title: string };
type WholePageScope = { readonly kind: 'page' };
type PageScope = HeadingScope | AsideScope | WholePageScope;

type PageSurface = { readonly path: string; readonly scope: PageScope };

/**
 * One surface, bound in both languages by one entry.  A pair rather than two
 * rows, so that a claim cannot be stated for English and forgotten for
 * German — the drift `DurableStateMoveDetectionClaims.test.ts` caught its own
 * verifier making.
 */
type MirroredSurface = {
  readonly surface: string;
  readonly english: PageSurface;
  readonly german: PageSurface;
};

const underHeading = (heading: string): HeadingScope => ({ kind: 'heading', heading });
const insideAside = (title: string): AsideScope => ({ kind: 'aside', title });
const WHOLE_PAGE: WholePageScope = { kind: 'page' };

function docsPage(language: Language, path: string): string {
  return `docs/src/content/docs/${language === 'german' ? 'de/' : ''}${path}`;
}

/** The slice of `page` a scope names — a value helper, so the dispatch stays inline. */
function scopedSlice(path: string, page: string, scope: PageScope): string {
  if (scope.kind === 'heading') return headingSection(path, page, scope.heading);
  if (scope.kind === 'aside') return asideBody(path, page, scope.title);
  return page;
}

/** What a reader sees of one surface. */
function surfaceText(surface: PageSurface): string {
  return renderedProse(scopedSlice(surface.path, read(surface.path), surface.scope));
}

const PER_ACTOR_POLICIES = 'persistence/object-storage/per-actor-policies.mdx';
const SNAPSHOTS = 'persistence/snapshots.mdx';
const PERSISTENT_ACTOR_PAGE = 'persistence/persistent-actor.mdx';
const OBJECT_STORAGE_ENCRYPTION = 'persistence/object-storage/encryption.mdx';
const SNAPSHOT_STORE_BACKEND = 'persistence/object-storage/snapshot-store-backend.mdx';

/**
 * The journal pages whose pitfall aside discusses `PersistenceOptions`.  Each
 * page also documents its backend's snapshot and durable-state stores, which
 * *are* asked and refuse — which is how three of the asides came to say an
 * unhonourable override "refuses the actor at start" on a page about the one
 * store that is never asked.
 */
function journalPages(): readonly string[] {
  return ['postgres', 'mssql', 'libsql', 'mariadb', 'mongodb', 'dynamodb', 'cloudflare-d1'];
}

function journalPage(language: Language, backend: string): string {
  return docsPage(language, `persistence/journals/${backend}.mdx`);
}

const JOURNAL_ASIDE_TITLE = {
  english: 'Per-actor encryption and integrity do not protect events',
  german: 'Per-Actor-Verschlüsselung und -Integrität schützen keine Events',
} as const;

/**
 * Every section that tells a reader what the per-actor hooks protect, and so
 * has to say what they do not.
 */
const PAGE_SURFACES: readonly MirroredSurface[] = [
  {
    surface: 'the per-actor policies danger aside on which stores read the hooks',
    english: {
      path: docsPage('english', PER_ACTOR_POLICIES),
      scope: insideAside('Only the object-storage stores read this hook'),
    },
    german: {
      path: docsPage('german', PER_ACTOR_POLICIES),
      scope: insideAside('Nur die Object-Storage-Stores lesen diesen Hook'),
    },
  },
  {
    surface: 'the snapshot-store table and the "mix them" recommendation',
    english: { path: docsPage('english', SNAPSHOTS), scope: underHeading('## Where snapshots live') },
    german: { path: docsPage('german', SNAPSHOTS), scope: underHeading('## Wo Snapshots leben') },
  },
  {
    surface: 'the PersistentActor page\'s snapshot section',
    english: { path: docsPage('english', PERSISTENT_ACTOR_PAGE), scope: underHeading('## Snapshots') },
    german: { path: docsPage('german', PERSISTENT_ACTOR_PAGE), scope: underHeading('## Snapshots') },
  },
  {
    surface: 'the object-storage encryption page\'s snapshot integrity section',
    english: { path: docsPage('english', OBJECT_STORAGE_ENCRYPTION), scope: underHeading('### Snapshots need it too') },
    german: {
      path: docsPage('german', OBJECT_STORAGE_ENCRYPTION),
      scope: underHeading('### Snapshots brauchen es ebenso'),
    },
  },
  {
    surface: 'the snapshot-store backend\'s per-actor overrides',
    english: { path: docsPage('english', SNAPSHOT_STORE_BACKEND), scope: underHeading('## Per-actor overrides') },
    german: { path: docsPage('german', SNAPSHOT_STORE_BACKEND), scope: underHeading('## Per-Actor-Overrides') },
  },
  ...journalPages().map((backend): MirroredSurface => ({
    surface: `the ${backend} journal page's pitfall aside`,
    english: { path: journalPage('english', backend), scope: insideAside(JOURNAL_ASIDE_TITLE.english) },
    german: { path: journalPage('german', backend), scope: insideAside(JOURNAL_ASIDE_TITLE.german) },
  })),
];

/** A corrected claim beside the statement: the new wording present, the old one gone. */
type PhraseBinding = {
  readonly path: string;
  readonly scope: PageScope;
  readonly mustSay: string;
  readonly mustNotSay: RegExp;
};

type MirroredPhrase = {
  readonly claim: string;
  readonly english: PhraseBinding;
  readonly german: PhraseBinding;
};

/**
 * Sentences that said the opposite of the statement, each asserted as a pair
 * — the stale wording gone *and* the corrected one present — because either
 * half alone is satisfied by deleting the sentence.  Matched against
 * {@link normalised} text, so `mustSay` is lower case.
 */
const CORRECTED_CLAIMS: readonly MirroredPhrase[] = [
  {
    claim: 'a persistent actor\'s hooks reach its snapshots and never its events',
    english: {
      path: docsPage('english', PER_ACTOR_POLICIES),
      scope: underHeading('## Working with the snapshot store'),
      mustSay: 'never its events',
      mustNotSay: /both honou?r them/,
    },
    german: {
      path: docsPage('german', PER_ACTOR_POLICIES),
      scope: underHeading('## Mit dem Snapshot-Store arbeiten'),
      mustSay: 'nie seine events',
      mustNotSay: /honorieren beide/,
    },
  },
  {
    claim: 'object-storage encryption covers a snapshot or a durable state, never an event',
    english: {
      path: docsPage('english', OBJECT_STORAGE_ENCRYPTION),
      scope: underHeading('## What it encrypts'),
      mustSay: 'never an event',
      mustNotSay: /state \/ event \/ snapshot/,
    },
    german: {
      path: docsPage('german', OBJECT_STORAGE_ENCRYPTION),
      scope: underHeading('## Was es verschlüsselt'),
      mustSay: 'nie ein event',
      mustNotSay: /state \/ event \/ snapshot/,
    },
  },
  // Page-wide rather than aside-scoped on purpose: the unqualified refusal
  // must not survive anywhere on a journal page, including in a second aside.
  ...journalPages().map((backend): MirroredPhrase => ({
    claim: `the ${backend} journal page says the journal is never asked, and no refusal reads as covering it`,
    english: {
      path: journalPage('english', backend),
      scope: WHOLE_PAGE,
      mustSay: 'the journal is never asked',
      mustNotSay: /override against a store that cannot honou?r it/,
    },
    german: {
      path: journalPage('german', backend),
      scope: WHOLE_PAGE,
      mustSay: 'das journal wird nie gefragt',
      mustNotSay: /override gegen einen store, der es nicht honorieren kann/,
    },
  })),
];

describe('the journal at-rest statement — page surfaces, both languages (#1430)', () => {
  for (const mirrored of PAGE_SURFACES) {
    for (const language of ['english', 'german'] as const) {
      const surface = mirrored[language];
      test(`${language}: ${mirrored.surface}`, () => {
        expect(
          statementViolations(surfaceText(surface), language),
          `${surface.path}: ${mirrored.surface} no longer states the journal at-rest sentence where a `
          + 'reader configures the hooks, or states its inversion. Re-word it everywhere at once — the '
          + 'constant above, every page, the JSDoc and the refusal text — or not at all.',
        ).toEqual([]);
      });
    }
  }

  for (const corrected of CORRECTED_CLAIMS) {
    for (const language of ['english', 'german'] as const) {
      const binding = corrected[language];
      test(`${language}: ${corrected.claim}`, () => {
        const text = normalised(surfaceText(binding));
        expect({
          stillSaysTheOpposite: binding.mustNotSay.test(text),
          saysTheCorrection: text.includes(binding.mustSay),
        }).toEqual({ stillSaysTheOpposite: false, saysTheCorrection: true });
      });
    }
  }

  test('every surface is bound in both languages, each to its own language\'s page', () => {
    for (const mirrored of [...PAGE_SURFACES, ...CORRECTED_CLAIMS]) {
      expect(mirrored.english.path.includes('/docs/de/'), `${mirrored.english.path} is a German page`).toBe(false);
      expect(mirrored.german.path.includes('/docs/de/'), `${mirrored.german.path} is not a German page`).toBe(true);
      expect(mirrored.german.path.replace('/docs/de/', '/docs/')).toBe(mirrored.english.path);
    }
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

  test('a recipe is annotated by its own comment run, not by a string or a distant comment', () => {
    const recipeLine = '  //   override encryption(): EncryptionConfig {';
    const printed = [`  console.log(${JSON.stringify(ENGLISH)});`, recipeLine, '  //   }'].join('\n');
    expect(statementViolations(lineCommentRunAround(printed, 'override encryption()'), 'english')).not.toEqual([]);
    const distant = [`  // ${ENGLISH}`, '  compression() { return undefined; }', recipeLine].join('\n');
    expect(statementViolations(lineCommentRunAround(distant, 'override encryption()'), 'english')).not.toEqual([]);
    const annotated = [`  // ${ENGLISH}`, recipeLine, '  //   }'].join('\n');
    expect(statementViolations(lineCommentRunAround(annotated, 'override encryption()'), 'english')).toEqual([]);
  });

  test('a statement no reader can see is not a statement', () => {
    // Each construct carries the whole sentence, so any one of the removals
    // failing leaves it readable and turns this red.
    const invisible = [
      `Intro. {/* ${ENGLISH} */}`,
      '',
      '  ```ts',
      `  // ${ENGLISH}`,
      '  ```',
      '',
      `export const note = "${ENGLISH}";`,
      '',
    ].join('\n');
    expect(statementViolations(renderedProse(invisible), 'english')).not.toEqual([]);
    // ...while the same sentence as prose is read, inside an aside's indent too.
    expect(statementViolations(renderedProse(`Intro.\n\n  ${ENGLISH}\n`), 'english')).toEqual([]);
  });

  test('a section ends at the next heading of its level, and a fenced # line is not one', () => {
    const fencedComment = [
      '', '## Snapshots', '', '```hocon', '# a comment, not a heading', '```', '', ENGLISH, '',
      '## Tagging events', '', 'unrelated', '',
    ].join('\n');
    expect(statementViolations(renderedProse(headingSection('fixture', fencedComment, '## Snapshots')), 'english'))
      .toEqual([]);
    const inTheNextSection = ['', '## Snapshots', '', 'Nothing here.', '', '## Tagging events', '', ENGLISH, '']
      .join('\n');
    expect(statementViolations(renderedProse(headingSection('fixture', inTheNextSection, '## Snapshots')), 'english'))
      .not.toEqual([]);
  });

  test('an aside is read on its own, not with the one beside it', () => {
    const page = [
      '<Aside type="danger" title="Only the object-storage stores read this hook">',
      '  Nothing here.',
      '</Aside>',
      '',
      '<Aside type="caution" title="Another">',
      `  ${ENGLISH}`,
      '</Aside>',
      '',
    ].join('\n');
    const body = asideBody('fixture', page, 'Only the object-storage stores read this hook');
    expect(statementViolations(body, 'english')).not.toEqual([]);
  });

  test('a CRLF page is only found once its line endings are folded', () => {
    // Load-bearing, not cosmetic: without the fold the anchor matches nothing.
    const crlf = ['', '## Snapshots', '', ENGLISH, ''].join('\r\n');
    expect(() => headingSection('fixture', crlf, '## Snapshots')).toThrow(/heading is gone/);
    const folded = headingSection('fixture', withUnixLineEndings(crlf), '## Snapshots');
    expect(statementViolations(folded, 'english')).toEqual([]);
  });
});
