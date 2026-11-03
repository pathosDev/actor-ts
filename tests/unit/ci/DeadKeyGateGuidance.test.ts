import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { ConfigKeys } from '../../../src/config/ConfigKeys.js';
import { isPlainObject, parseHocon } from '../../../src/config/HoconParser.js';
import type { ConfigObject, ConfigValue } from '../../../src/config/HoconParser.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import {
  readCassandraJournalOptionsFromConfig,
  readCassandraSnapshotStoreOptionsFromConfig,
} from '../../../src/persistence/journals/CassandraPluginOptions.js';
import { baselineOf, introductionFor, observeLeaf, perturbationFor } from '../../util/ConfigPerturbation.js';
import type { LeafKind, LeafPerturbation } from '../../util/ConfigPerturbation.js';
import { CONFIG_READER_REGISTRY, UNPUBLISHED_LEAVES } from '../../util/ConfigReaderRegistry.js';

/**
 * AGENTS.md's account of the dead-key gate matches the gate (#1425).
 *
 * The `ConfigKeys` rule in *Code style* said a key had to be "read by
 * something in `src/`", and the *Constants* rules warned that moving a
 * reader out of the file naming its `ConfigKeys` group would break the gate.
 * Both described the gate as it was when it searched source text, and a
 * comment, a sibling's accessor or a value read and then dropped all
 * satisfied it.  The gate now changes each leaf and asks the registered
 * readers whether their answer moved, and AGENTS.md is where an agent learns
 * what to do when it adds a key or moves a reader, so this holds the part of
 * that account a test can hold:
 *
 *   - the rule names the gate's files and tables, and every path or table a
 *     passage about the gate names exists as spelled, so a rename has to take
 *     the prose along;
 *   - the settings it calls outside the gate are outside it, so the sentence
 *     has to go once a change brings one in — the reference.conf page makes
 *     the same claim, held by `tests/unit/docs/ReferenceConfDeadKeySection.test.ts`;
 *   - what it says keeps `replication.data-centers` out is what does: a
 *     registry entry nobody has written, which the gate's own functions show
 *     would be enough, and not a value the gate lacks;
 *   - the exceptions to its rule about a reader of another kind are the ones
 *     the gate makes: every getter the gate lets read a leaf of another kind
 *     is named, and nothing else is, asked of the gate itself;
 *   - no passage about the gate describes the text search it replaced, no
 *     passage anywhere keeps the old constants rule — by its title or in other
 *     words — and the constants rule names what does catch a moved reader.
 *
 * What it cannot see is what the prose means: the checks refuse the old
 * claims and the plainest denials, and a sentence asserting the opposite in
 * other words still keeps them green.  Each pattern they refuse is exercised
 * here too, on a passage kept in this file that it alone refuses — AGENTS.md
 * is clean, so its own passages exercise none of them, and a pattern deleted
 * would otherwise leave every check green.  What the gate counts
 * as a read is pinned where it is decided, in
 * `tests/util/ConfigPerturbation.test.ts`.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');

/** AGENTS.md as a reader sees it: HTML comments render nothing, and a checkout may end its lines in CRLF. */
const guide = readFileSync(join(REPOSITORY_ROOT, 'AGENTS.md'), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/<!--[\s\S]*?-->/g, '');

/**
 * Its top-level bullets and paragraphs, each with its continuation lines and
 * its whitespace collapsed: a passage ends at a blank line no indented
 * continuation follows, and before a top-level bullet, heading or numbered
 * item.
 */
const passages = guide
  .split(/\n[ \t]*\n(?![ \t])|\n(?=- |#{1,6} |\d+\. )/)
  .map((passage) => passage.replace(/\s+/g, ' ').trim());

/** The `ConfigKeys` rule in *Code style*, which describes the gate; `undefined` once it is gone. */
const keysRulePassage = passages.find((passage) => passage.startsWith('- HOCON config keys go through'));

function keysRule(): string {
  expect(keysRulePassage, 'AGENTS.md lost the ConfigKeys rule in Code style, which this file pins').toBeDefined();
  return keysRulePassage!;
}

/** Every passage about the dead-key gate, wherever in AGENTS.md it sits. */
const gatePassages = passages.filter(isGatePassage);

/** Whether a passage is about the dead-key gate. */
function isGatePassage(passage: string): boolean {
  return /NoDeadConfigKeys|dead-key/i.test(passage);
}

/** The passages of the *Constants* subsection, up to the next heading. */
function constantsSection(): string[] {
  const start = passages.indexOf('### Constants');
  expect(start, 'AGENTS.md lost its Constants subsection').toBeGreaterThan(-1);
  const end = passages.findIndex((passage, index) => index > start && passage.startsWith('#'));
  return passages.slice(start + 1, end === -1 ? undefined : end);
}

/** Every inline code span of a passage. */
function codeSpansOf(passage: string): string[] {
  return [...passage.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
}

/** A passage's words with the emphasis markers dropped, so `**A refusal** is` reads as it renders. */
function wordsOf(passage: string): string {
  return passage.replace(/\*/g, '');
}

/**
 * The settings a passage says the gate leaves out: every dotted, setting-shaped
 * code span of a sentence that speaks of something outside the gate.  Read off
 * the prose rather than listed here, so a setting added to that sentence is
 * held to the gate as well.
 */
function settingsNamedOutside(passage: string): string[] {
  return passage
    .split(/(?<=[.!?])\s+(?=[A-Z*`])/)
    .filter((sentence) => /outside the gate/i.test(sentence))
    .flatMap(codeSpansOf)
    .filter((span) => /^[a-z][\w-]*(?:\.[a-z][\w-]*)+$/.test(span));
}

/** The files the gate is made of: a table AGENTS.md names is declared in one of them. */
const GATE_FILES = [
  'tests/unit/config/NoDeadConfigKeys.test.ts',
  'tests/util/ConfigPerturbation.ts',
  'tests/util/ConfigReaderRegistry.ts',
] as const;

/** The settings the registry keeps outside the gate, each with its reason, as the rule spells them. */
const OUTSIDE_THE_GATE = ['coordinated-shutdown.phases', 'replication.data-centers'] as const;

/**
 * The sub-paragraph of the `ConfigKeys` rule that names `span`, whitespace
 * collapsed: narrower than the rule's whole passage, which names the gate's
 * tables in other paragraphs and would answer for this one.
 */
function ruleParagraphNaming(span: string): string {
  const paragraph = guide
    .split(/\n[ \t]*\n/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .find((part) => part.includes(span) && keysRule().includes(part));
  expect(paragraph, `the ConfigKeys rule no longer names ${span}`).toBeDefined();
  return paragraph!;
}

/**
 * The two Cassandra blocks whose `replication.data-centers` the rule keeps
 * outside the gate, each with its reader and the leaf that selects the
 * replication class the data centers are read under.
 */
const DATA_CENTER_BLOCKS = [
  {
    block: 'journal',
    read: (config: Config): unknown => readCassandraJournalOptionsFromConfig(config),
    leaf: ConfigKeys.persistence.journal.cassandra.replicationDataCenters,
    selector: ConfigKeys.persistence.journal.cassandra.replicationClass,
  },
  {
    block: 'snapshot store',
    read: (config: Config): unknown => readCassandraSnapshotStoreOptionsFromConfig(config),
    leaf: ConfigKeys.persistence.snapshotStore.cassandra.replicationDataCenters,
    selector: ConfigKeys.persistence.snapshotStore.cassandra.replicationClass,
  },
] as const;

/** A Cassandra reader's answer with the data centers it read dropped: the reader the gate must not count. */
function withoutDataCenters(options: unknown): unknown {
  const { replication } = options as { readonly replication?: object };
  return replication === undefined ? options : { ...(options as object), replication: { ...replication, dataCenters: undefined } };
}

/**
 * Reasons that say the gate lacks a value for `replication.data-centers` —
 * the one the rule gave, the registry's, and the shapes either would take
 * reworded, and the plain denial that it is a gap.  The gate has the value: an
 * entry's `override` is the second list, and the entry is what nobody has
 * written.
 */
const RETIRED_DATA_CENTER_REASONS: readonly RegExp[] = [
  /\b(?:no|not an?|isn't an?) gap\b/i,
  /\bno (?:second|other|further) value\b/i,
  /\bno value to (?:introduce|change|perturb)\b/i,
  /\bperturbs? (?:only )?a list of strings\b/i,
  /\bcannot (?:be )?(?:chang|perturb|introduc|var)\w*/i,
];

/**
 * How AGENTS.md described the gate while it searched source text, in words
 * specific enough to refuse anywhere in the file — a passage that keeps the
 * old claim without naming the gate is refused too.
 *
 * The old constants rule is refused by its title as well as by its body.  The
 * title alone, over the body that replaced it, still tells an agent to keep a
 * read where it is, and it is the first thing a skimming reader takes in; the
 * body is refused by where it put the read — in the file that names its group
 * — so a rewording that keeps the place keeps failing.
 */
const RETIRED_CLAIMS: readonly RegExp[] = [
  /read by something in `src\/`/i,
  /matches `ConfigKeys\./i,
  /relocat\w* (?:a|the) (?:`ConfigKeys` )?read/i,
  /constants move\W+(?:but\s+)?`?ConfigKeys`? reads (?:do not|don't|stay)/i,
  /\bfile (?:that names|which names|naming) its (?:`ConfigKeys` )?group\b/i,
];

/**
 * The old constants rule's own wording, refused in any passage that names
 * `ConfigKeys`: elsewhere it is plain English that may describe another rule.
 * The second is the claim with the place left vague — a read that fails for
 * having moved to another file — where the rule that replaced it says a read
 * fails only once no registered reader makes it.
 */
const RETIRED_CONFIG_KEYS_WORDS: readonly RegExp[] = [
  /even when behaviou?r is identical/i,
  /\breads? (?:moved|relocated) (?:elsewhere|to another file|out of (?:the|its) file)\b[^.;]*\b(?:fail|break)/i,
];

/**
 * The search's own vocabulary, refused only where the gate is the subject:
 * AGENTS.md says "the same file" and "substring" about other things.
 */
const RETIRED_SEARCH_WORDS: readonly RegExp[] = [/sub-?string/i, /same[\s-]file/i];

/**
 * The retired wording a passage carries: each pattern that applies where the
 * passage stands — the old claims anywhere, the search's vocabulary where the
 * gate is the subject, the old constants rule's words where `ConfigKeys` is
 * named — and that the passage's words match.
 */
function retiredWordingIn(passage: string): RegExp[] {
  const applicable = [
    ...RETIRED_CLAIMS,
    ...(isGatePassage(passage) ? RETIRED_SEARCH_WORDS : []),
    ...(passage.includes('`ConfigKeys`') ? RETIRED_CONFIG_KEYS_WORDS : []),
  ];
  return applicable.filter((pattern) => pattern.test(wordsOf(passage)));
}

/** The reasons of {@link RETIRED_DATA_CENTER_REASONS} that `text`'s words match. */
function dataCenterReasonsIn(text: string): RegExp[] {
  return RETIRED_DATA_CENTER_REASONS.filter((reason) => reason.test(wordsOf(text)));
}

/** A kind sentence that names its exceptions only to deny them. */
const KIND_EXCEPTION_DENIAL = /\b(?:without|no) exceptions?\b/i;

/*
 * Passages the retired-wording checks must refuse.  AGENTS.md is clean, so its
 * own passages exercise none of the patterns, and any one could be deleted
 * with every check on AGENTS.md still green; these are refused the same way an
 * AGENTS.md passage is.
 */

/** The shapes the old constants rule came back in: its title over the new body, restated naming the gate, restated without. */
const RETIRED_CONSTANTS_RULE_SHAPES: readonly string[] = [
  '- **Constants move, `ConfigKeys` reads do not.** The dead-key gate watches what the registered readers answer, '
    + 'not which file writes an accessor, so moving a read changes nothing it checks while a registered reader still makes it.',
  '- **Constants move, `ConfigKeys` reads do not.** Relocating a `ConfigKeys` read out of the file that names its group '
    + 'breaks the dead-key gate, even when behaviour is identical.',
  '- **Constants move, `ConfigKeys` reads do not.** Keep each `ConfigKeys` read in the file that names its group: a read '
    + 'moved elsewhere fails the config check even when behaviour is identical.',
];

/**
 * One passage per pattern of the three lists, each worded so that its pattern
 * alone refuses it — the search's words inside a passage that names the gate,
 * the constants rule's inside one that names `ConfigKeys` — so deleting any
 * single pattern leaves a passage through.
 */
const ONE_RETIRED_WORDING_EACH: readonly string[] = [
  'A key in `reference.conf` must be read by something in `src/`.',
  'The check matches `ConfigKeys.` paths in the source.',
  'Relocating a reader breaks the build.',
  '- **Constants move, `ConfigKeys` reads do not.**',
  'Keep each read in the file that names its group.',
  'Moving a `ConfigKeys` accessor breaks the build even when behaviour is identical.',
  'A `ConfigKeys` read moved to another file fails the check.',
  'The dead-key gate finds a key by substring.',
  'The dead-key gate wants each read in the same file as its key.',
];

/** One passage per reason of {@link RETIRED_DATA_CENTER_REASONS}, each refused by its reason alone. */
const ONE_DATA_CENTER_REASON_EACH: readonly string[] = [
  'The list of objects is no gap.',
  'A list of objects, which the gate has no second value for.',
  'There is no value to introduce.',
  'The gate perturbs a list of strings.',
  'A list the gate cannot change.',
];

/**
 * Hold a list of patterns to its passages: each passage refused by exactly one
 * pattern, and each pattern refusing exactly one passage.  A pattern deleted,
 * or narrowed until it matches nothing, leaves its passage refused by none; a
 * pattern added without a passage of its own refuses none.
 */
function expectOnePatternEach(
  patterns: readonly RegExp[],
  passagesOfTheirOwn: readonly string[],
  refusalsOf: (passage: string) => readonly RegExp[],
): void {
  const refusals = passagesOfTheirOwn.map(refusalsOf);
  passagesOfTheirOwn.forEach((passage, index) => {
    expect(refusals[index]!.map(String), `"${passage}" is to be refused by one pattern alone`).toHaveLength(1);
  });
  for (const pattern of patterns) {
    expect(refusals.filter((refused) => refused.includes(pattern)).length, `${pattern} refuses no passage of its own`)
      .toBe(1);
  }
}

function leafPaths(tree: ConfigObject, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) out.push(...leafPaths(value, path));
    else out.push(path);
  }
  return out;
}

/** Every key the gate changes: the leaves reference.conf publishes, and the ones the registry introduces. */
const gatedKeys = [...leafPaths(parseHocon(REFERENCE_CONF)), ...UNPUBLISHED_LEAVES.keys()];

/* ------------------------------ the kind sentence ----------------------------- */

/** Every `Config` getter a reader can take a leaf with. */
const ACCESSORS = {
  getBoolean: (config: Config, path: string): unknown => config.getBoolean(path),
  getBytes: (config: Config, path: string): unknown => config.getBytes(path),
  getDuration: (config: Config, path: string): unknown => config.getDuration(path),
  getInt: (config: Config, path: string): unknown => config.getInt(path),
  getList: (config: Config, path: string): unknown => config.getList(path),
  getNumber: (config: Config, path: string): unknown => config.getNumber(path),
  getObject: (config: Config, path: string): unknown => config.getObject(path),
  getString: (config: Config, path: string): unknown => config.getString(path),
  getStringList: (config: Config, path: string): unknown => config.getStringList(path),
} as const;

type Accessor = keyof typeof ACCESSORS;

/**
 * The getter each kind is read with, as the gate is built to expect it.  Any
 * other takes the leaf as another kind than it ships as — `getString` on a
 * switch or `getNumber` on an integer too, which the gate's off-kind values
 * are chosen to catch.
 */
const OWN_ACCESSORS: Readonly<Record<LeafKind, readonly Accessor[]>> = {
  boolean: ['getBoolean'],
  switch: ['getBoolean'],
  integer: ['getInt'],
  fraction: ['getNumber'],
  duration: ['getDuration'],
  size: ['getBytes'],
  text: ['getString'],
  list: ['getList', 'getStringList'],
  object: ['getObject'],
};

/** A leaf, a getter of another kind, and the value the leaf ships as — or is introduced at. */
type KindGap = {
  readonly leaf: string;
  readonly kind: LeafKind;
  readonly shipsAs: ConfigValue | undefined;
  readonly accessor: Accessor;
};

/**
 * The exceptions the kind sentence has words for, each with the gaps it
 * covers.  A gap neither covers fails the test outright: the sentence has no
 * words for it, so the sentence and this list grow together.
 */
const KIND_EXCEPTIONS = [
  {
    words: /\bbare count\b/,
    covers: (gap: KindGap): boolean =>
      (gap.kind === 'duration' || gap.kind === 'size') && typeof gap.shipsAs === 'number',
  },
  { words: /\b[Ff]ractions?\b/, covers: (gap: KindGap): boolean => gap.kind === 'fraction' },
] as const;

/** Every leaf the gate changes, perturbed exactly as `NoDeadConfigKeys` perturbs it. */
function gatePerturbations(): LeafPerturbation[] {
  const tree = parseHocon(REFERENCE_CONF);
  const literalAt = (path: string): ConfigValue =>
    path.split('.').reduce<ConfigValue>((node, segment) => (node as ConfigObject)[segment]!, tree);
  return [
    ...leafPaths(tree).map((leaf) => perturbationFor(leaf, literalAt(leaf))),
    ...[...UNPUBLISHED_LEAVES].map(([leaf, unpublished]) =>
      introductionFor(leaf, unpublished.value, unpublished.reason, unpublished.override)),
  ];
}

/**
 * Ask the gate, leaf by leaf, about a reader that takes the leaf with each
 * getter of another kind: the pairs it would let through are the exceptions
 * to the sentence.  A getter that refuses what the leaf ships as is skipped —
 * a registered reader doing that fails the registry's own sanity test — and
 * a pair counts as caught when the gate reports a kind mismatch, an off-kind
 * value accepted, or no read at all.
 */
function scanKinds(): { readonly gaps: readonly KindGap[]; readonly caught: readonly KindGap[] } {
  const reference = Config.parseString(REFERENCE_CONF);
  const gaps: KindGap[] = [];
  const caught: KindGap[] = [];
  for (const perturbation of gatePerturbations()) {
    const { leaf, kind } = perturbation;
    const shipsAs = perturbation.introducedAs ?? perturbation.literal;
    for (const accessor of Object.keys(ACCESSORS) as Accessor[]) {
      if (OWN_ACCESSORS[kind].includes(accessor)) continue;
      const read = (config: Config): unknown => (config.hasPath(leaf) ? ACCESSORS[accessor](config, leaf) : undefined);
      const baseline = baselineOf({ label: accessor, read }, reference);
      if (baseline.outcome.kind === 'threw') continue;
      const verdict = observeLeaf(perturbation, [baseline]);
      const failsTheGate = verdict.kindMismatches.length > 0
        || verdict.offKindAcceptedBy.length > 0
        || verdict.observedBy.length === 0;
      (failsTheGate ? caught : gaps).push({ leaf, kind, shipsAs, accessor });
    }
  }
  return { gaps, caught };
}

/** The `ConfigKeys` rule's sentence about a reader of another kind, with the sentence after it. */
function kindSentence(): string {
  const sentences = keysRule().split(/(?<=[.!?])\s+(?=[A-Z*`])/);
  const at = sentences.findIndex((sentence) => sentence.includes('another kind than it ships as'));
  expect(at, 'the ConfigKeys rule lost its sentence about a reader of another kind').toBeGreaterThan(-1);
  return sentences.slice(at, at + 2).join(' ');
}

/**
 * The getters the kind sentence names as exceptions, by the exception whose
 * words come last before each: everything from the word "exception" on, so a
 * getter the sentence names as an example of what fails is not counted.
 * Getters named before any exception's words come back as unassigned.
 */
function namedExceptions(sentence: string): { readonly named: ReadonlyArray<ReadonlySet<string>>; readonly unassigned: readonly string[] } {
  const named = KIND_EXCEPTIONS.map(() => new Set<string>());
  const unassigned: string[] = [];
  const at = sentence.search(/\bexceptions?\b/i);
  if (at === -1) return { named, unassigned };
  let current = -1;
  for (const token of sentence.slice(at).matchAll(/`(get[A-Z]\w*)`|\bbare count\b|\b[Ff]ractions?\b/g)) {
    if (token[1] === undefined) current = KIND_EXCEPTIONS.findIndex((exception) => exception.words.test(token[0]));
    else if (current === -1) unassigned.push(token[1]);
    else named[current]!.add(token[1]);
  }
  return { named, unassigned };
}

describe('AGENTS.md describes the dead-key gate as it is (#1425)', () => {
  test('the ConfigKeys rule names the gate, its registry, its tables and the consumer pin', () => {
    expect(codeSpansOf(keysRule())).toEqual(expect.arrayContaining([
      'tests/unit/config/NoDeadConfigKeys.test.ts',
      'tests/util/ConfigReaderRegistry.ts',
      'contexts',
      'PERTURBATION_OVERRIDES',
      'UNPUBLISHED_LEAVES',
      'KNOWN_DEAD_KEYS',
      'tests/unit/config/ConsumersReadThroughRegisteredReaders.test.ts',
      ...OUTSIDE_THE_GATE,
    ]));
  });

  test('it says a refusal is not a read', () => {
    // The assumption work on this gate keeps making the other way round: a
    // reader that throws on the changed value has shown that it checks the
    // leaf, not that it keeps it, so only a changed answer counts.
    expect(wordsOf(keysRule())).toMatch(/a refusal is not a read/i);
  });

  test('the kind sentence names every reader of another kind the gate lets through, and no other', () => {
    // "A reader that takes the leaf as another kind than it ships as fails
    // it" is a rule about the gate, so it is held to the gate: every pair the
    // gate lets through is an exception the sentence names, with its getters,
    // and a getter it names is one the gate does let through.  When a change
    // to the gate closes an exception, this fails until the sentence drops it.
    const { gaps, caught } = scanKinds();
    // Guards the guard: the scan reaches the gate's leaves, and it does catch
    // a reader of another kind — getInt on a duration that carries its unit.
    expect(gaps.length + caught.length).toBeGreaterThan(1000);
    expect(caught.some((pair) => pair.kind === 'duration' && typeof pair.shipsAs === 'string' && pair.accessor === 'getInt'))
      .toBe(true);

    const unworded = gaps.filter((gap) => !KIND_EXCEPTIONS.some((exception) => exception.covers(gap)));
    expect(
      unworded.map((gap) => `${gap.accessor} on ${gap.leaf} (${gap.kind})`),
      'the gate lets these readers through and the kind sentence has no words for them',
    ).toEqual([]);

    const sentence = kindSentence();
    // Naming the getters is not enough when the sentence says they fail.
    expect(sentence, 'the kind sentence denies the exceptions it names').not.toMatch(KIND_EXCEPTION_DENIAL);
    const { named, unassigned } = namedExceptions(sentence);
    expect(unassigned, 'the kind sentence names a getter before saying which exception it belongs to').toEqual([]);
    KIND_EXCEPTIONS.forEach((exception, index) => {
      const letThrough = [...new Set(gaps.filter(exception.covers).map((gap) => gap.accessor))].sort();
      expect(
        [...named[index]!].sort(),
        `the getters the kind sentence names after "${exception.words.source}" are the ones the gate lets through there`,
      ).toEqual(letThrough);
    });
    if (gaps.length === 0) {
      expect(sentence, 'the gate lets no reader of another kind through, and the sentence still names an exception')
        .not.toMatch(/\bexceptions?\b/i);
    }
  });

  test('every path a passage about the gate names exists, and every table it names is one the gate declares', () => {
    const gateSources = GATE_FILES.map((file) => readFileSync(join(REPOSITORY_ROOT, file), 'utf8'));
    const spans = gatePassages.flatMap(codeSpansOf);
    const paths = spans.filter((span) => /^[\w.-]+(?:\/[\w.-]+)+$/.test(span));
    const tables = spans.filter((span) => /^[A-Z][A-Z\d]*(?:_[A-Z\d]+)+$/.test(span));

    // Guards the guard: a span pattern that matched nothing would pass any prose.
    expect(paths.length).toBeGreaterThan(3);
    expect(tables.length).toBeGreaterThan(2);
    for (const path of paths) {
      expect(existsSync(join(REPOSITORY_ROOT, path)), `AGENTS.md names ${path}, which does not exist`).toBe(true);
    }
    for (const table of tables) {
      expect(
        gateSources.some((source) => new RegExp(`\\bconst ${table}\\b`).test(source)),
        `AGENTS.md names ${table}, which none of ${GATE_FILES.join(', ')} declares`,
      ).toBe(true);
    }
  });

  test('the registry has the contexts the rule tells selector-gated leaves to use', () => {
    expect(CONFIG_READER_REGISTRY.some((entry) => (entry.contexts ?? []).length > 0)).toBe(true);
  });

  test('it names the settings the registry keeps outside the gate', () => {
    expect(settingsNamedOutside(keysRule())).toEqual(expect.arrayContaining([...OUTSIDE_THE_GATE]));
  });

  test('every setting it says the gate leaves out is outside it', () => {
    const named = settingsNamedOutside(keysRule());
    const gated = named.flatMap((setting) => gatedKeys
      .filter((key) => key === `actor-ts.${setting}` || key.endsWith(`.${setting}`)
        || key.startsWith(`actor-ts.${setting}.`))
      .map((key) => `${setting} (the gate changes ${key})`));

    expect(named.length).toBeGreaterThan(0);
    expect(gated, 'AGENTS.md says the gate leaves these out, and it changes them now: drop them from that sentence')
      .toEqual([]);
  });

  test('replication.data-centers needs only an entry: given an override and a context, the gate observes it', () => {
    // What the rule's sentence rests on, asked of the gate's own functions.
    // Without an override the gate's second list is the first with a word
    // appended, which the reader refuses; with one, a reader run under
    // network-topology-strategy answers the two lists differently, a reader
    // that drops the data centers does not, and without the context the reader
    // refuses the leaf — so a context is needed as well, and nothing else is.
    const reference = Config.parseString(REFERENCE_CONF);
    const first = [{ name: 'dc1', 'replication-factor': 3 }];
    const second = { value: [{ name: 'dc1', 'replication-factor': 2 }], reason: 'a second list of data centers' };
    for (const { block, read, leaf, selector } of DATA_CENTER_BLOCKS) {
      const networkTopology = { [selector]: 'network-topology-strategy' };
      const keeps = baselineOf({ label: `${block} under network-topology-strategy`, read, overlay: networkTopology }, reference);
      const drops = baselineOf({
        label: `${block} dropping its data centers`,
        read: (config) => withoutDataCenters(read(config)),
        overlay: networkTopology,
      }, reference);
      const unselected = baselineOf({ label: `${block} under the default class`, read }, reference);

      const inferred = observeLeaf(introductionFor(leaf, first, 'a list of data centers'), [keeps]);
      expect(inferred.observedBy, `${block}: the gate's own second list is one the reader takes now`).toEqual([]);

      const verdict = observeLeaf(introductionFor(leaf, first, 'a list of data centers', second), [keeps, drops, unselected]);
      expect(verdict.observedBy, `${block}: only the reader that keeps the data centers answers to them`)
        .toEqual([keeps.probe.label]);
      expect(verdict.refusedBy.some((refusal) => refusal.startsWith(`${unselected.probe.label}:`)),
        `${block}: the reader takes data centers without the context that selects their class`).toBe(true);
    }
  });

  test('it calls replication.data-centers a gap and names what would close it, not a value the gate lacks', () => {
    const account = ruleParagraphNaming('`replication.data-centers`');
    expect(account).toMatch(/\bgap\b/i);
    expect(codeSpansOf(account)).toEqual(expect.arrayContaining(['UNPUBLISHED_LEAVES', 'override', 'contexts']));
    expect(dataCenterReasonsIn(account).map(String), 'AGENTS.md says the gate lacks a value for replication.data-centers')
      .toEqual([]);
  });

  test('the gate still has keys to change', () => {
    // Guards the guard: an empty key list would make every setting "outside".
    expect(gatedKeys.length).toBeGreaterThan(400);
    expect(gatedKeys).toContain('actor-ts.coordinated-startup.phases');
  });

  test('no passage about the gate describes the text search it replaced', () => {
    // Guards the guard: the two passages it exists for are among those it reads.
    expect(gatePassages).toContain(keysRule());
    expect(gatePassages.filter((passage) => constantsSection().includes(passage)).length).toBeGreaterThan(0);
    for (const passage of passages) {
      expect(retiredWordingIn(passage).map(String), `AGENTS.md still describes the gate's old text search: ${passage.slice(0, 90)}…`)
        .toEqual([]);
    }
  });

  test('the retired wording it is held to is refused, every pattern on a passage of its own', () => {
    for (const shape of RETIRED_CONSTANTS_RULE_SHAPES) {
      expect(retiredWordingIn(shape).length, `the retired-wording check lets this through: ${shape.slice(0, 90)}…`)
        .toBeGreaterThan(0);
    }
    expectOnePatternEach(
      [...RETIRED_CLAIMS, ...RETIRED_SEARCH_WORDS, ...RETIRED_CONFIG_KEYS_WORDS],
      ONE_RETIRED_WORDING_EACH,
      retiredWordingIn,
    );
  });

  test('the reasons and the denial the data-center and kind checks refuse are refused, each on a passage of its own', () => {
    expectOnePatternEach(RETIRED_DATA_CENTER_REASONS, ONE_DATA_CENTER_REASON_EACH, dataCenterReasonsIn);
    expect('A reader of another kind fails it without exception.').toMatch(KIND_EXCEPTION_DENIAL);
  });

  test('the constants rule names what catches a moved reader', () => {
    // A reader moved to another module leaves the registry importing it from
    // the old one, which the dev typecheck reports; a read moved out of every
    // registered reader leaves its leaf unread, which the gate reports.
    const rule = constantsSection().find((passage) => gatePassages.includes(passage));
    expect(rule, 'the Constants subsection no longer says what becomes of a moved ConfigKeys read').toBeDefined();
    expect(codeSpansOf(rule!)).toEqual(expect.arrayContaining([
      'tests/util/ConfigReaderRegistry.ts',
      'bun run typecheck:dev',
      'NoDeadConfigKeys',
    ]));
  });
});
