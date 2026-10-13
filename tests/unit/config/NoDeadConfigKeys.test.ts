import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { ConfigKeys } from '../../../src/config/ConfigKeys.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import { parseHocon, isPlainObject } from '../../../src/config/HoconParser.js';
import type { ConfigObject, ConfigValue } from '../../../src/config/HoconParser.js';
import {
  baselineOf,
  inferKind,
  introductionFor,
  KIND_DECLARATIONS,
  observeLeaf,
  PERTURBATION_OVERRIDES,
  PERTURBATION_WORD,
  perturbationFor,
  runProbe,
  type ConfigProbe,
  type LeafPerturbation,
  type LeafVerdict,
} from '../../util/ConfigPerturbation.js';
import {
  CONFIG_READER_REGISTRY,
  entryLabel,
  READERS_OUTSIDE_THE_REGISTRY,
  UNPUBLISHED_LEAVES,
} from '../../util/ConfigReaderRegistry.js';

/**
 * The guard #653 asked for: **no key in `reference.conf` may be dead** — a
 * documented key nothing reads leaves an operator's `application.conf`
 * inert, and neither fails nor warns.
 *
 * Two properties per leaf:
 *
 *   1. it is reachable from `ConfigKeys`, the file that calls itself the
 *      single source of truth — an exact entry, or a block root above it;
 *   2. a registered reader **reads** it.  Changed to another value of its own
 *      kind — inferred from the literal it ships with — at least one reader in
 *      `tests/util/ConfigReaderRegistry.ts` answers differently.  A refusal
 *      is not an answer: a value checked and then dropped is refused just the
 *      same.  A getter refusing it as the *wrong kind* fails the leaf, because
 *      it means the reader takes the leaf as another kind than it ships as.
 *      And a value of the kind it is most easily confused with — a fraction
 *      for a count, a size for a duration — must not be taken, since a bare
 *      integer reads the same through every numeric getter and only that
 *      value tells them apart.
 *
 * A key `reference.conf` does not publish has no literal to change, so it is
 * introduced at one value and changed to a second, and some reader has to
 * answer the two differently.  The key absent against the key present would
 * count a reader that answers only whether it is there —
 * `if (hasPath(key)) out.x = 10` — and, where the reference has no block for
 * the key, one that builds the block whenever it exists, since introducing the
 * key creates the block.  At two values the key and its block are there both
 * times.
 *
 * Property 2 used to be a substring search: a leaf passed when any file
 * under `src/` named its group and its last segment.  A comment, a sibling's
 * accessor (`cluster.gossip-interval` held up by pub-sub's), a `void keys.x;`,
 * a read whose value was dropped, and a block root holding up every leaf
 * beneath it (`actor-ts.logger.sinks.otlp`) all satisfied it; with every
 * read in `src/` deleted it still passed 459 of 493 leaves (#1425).
 *
 * **What it proves:** some registered reader reads each leaf, observed
 * through a value of the leaf's kind.  **What it does not:**
 *
 *   - that the runtime calls that reader.  A consumer that reads the same key
 *     beside its registered reader — a plugin selector, a constructor — or
 *     wiring that drops a reader's answer, as a sink `buildLoggerFromConfig`
 *     no longer builds would, leaves every reader answering and this gate
 *     green.  `ConsumersReadThroughRegisteredReaders.test.ts` pins the
 *     consumers that have done so to their readers; a consumer that calls its
 *     reader and still reads one key beside it, and wiring, stay with each
 *     subsystem's binding tests.
 *   - that the value is right.  The exact-object suite each registry entry
 *     names covers that.
 *   - keys `reference.conf` documents only in a comment.  A gate that
 *     perturbs published leaves never sets one; those a reader is known to
 *     read are listed as unpublished leaves in the registry and introduced
 *     instead, and the rest are outside it.
 *
 * The whole matrix — every leaf against every reader and context — is
 * computed once at module scope, where bun's per-test timeout does not
 * reach, and each test only reads its row.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');

/**
 * Keys that ship in `reference.conf` and that no registered reader observes,
 * knowingly.  Every entry carries the issue that will remove it: this list
 * exists so a deliberate gap stays visible, not so the next one can be waved
 * through.
 *
 * **Empty, and that now means none.**  Under the substring search it meant
 * none the search could see, which proved little.  An entry is excused only
 * while nothing observes its key, so the excuse cannot outlive the gap: once
 * a reader reads the key, the entry fails until it is deleted.
 */
const KNOWN_DEAD_KEYS: ReadonlyMap<string, string> = new Map<string, string>();

/** Every dotted leaf path in a parsed HOCON tree, in declaration order. */
function leafPaths(tree: ConfigObject, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) out.push(...leafPaths(value, path));
    else out.push(path);
  }
  return out;
}

/** Every `actor-ts.*` path in the ConfigKeys tree, mapped to its accessor. */
function configKeyPaths(
  tree: Record<string, unknown>,
  accessor: string[] = [],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [key, value] of Object.entries(tree)) {
    const trail = [...accessor, key];
    if (typeof value === 'string') {
      // The worker IPC sentinels live in this tree too and are message-kind
      // strings, not paths — the `actor-ts.` prefix is what tells them apart.
      if (value.startsWith('actor-ts.')) out.set(value, trail);
    } else if (value && typeof value === 'object') {
      for (const [path, nested] of configKeyPaths(value as Record<string, unknown>, trail)) {
        out.set(path, nested);
      }
    }
  }
  return out;
}

/**
 * `source` with its comments and string literals blanked, so only code is
 * searched: a reader's name in a test title, or a commented-out
 * `expectExactOptions(`, binds nothing.  Not a full lexer — a regular
 * expression literal holding a quote or `//` reads as a string or a comment —
 * but blanking can only hide a name, never invent one.
 */
function codeOf(source: string): string {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    const next = source[index + 1];
    if (character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index++;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      out += ' ';
      continue;
    }
    if (character === '\'' || character === '"' || character === '`') {
      index++;
      while (index < source.length && source[index] !== character) index += source[index] === '\\' ? 2 : 1;
      index++;
      out += ' ';
      continue;
    }
    out += character;
    index++;
  }
  return out;
}

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const referenceLeaves = leafPaths(parseHocon(REFERENCE_CONF));
const keyPathsToAccessor = configKeyPaths(ConfigKeys);

/** The ConfigKeys entry covering `leaf` — an exact match, or a config root above it. */
function coveringAccessor(leaf: string): string[] | null {
  const exact = keyPathsToAccessor.get(leaf);
  if (exact) return exact;
  // A plugin root (`actor-ts.cache.in-memory`, `actor-ts.http.websocket`) is
  // read as a block, with its own leaves appended by the reader.
  for (const [path, accessor] of keyPathsToAccessor) {
    if (leaf.startsWith(`${path}.`)) return accessor;
  }
  return null;
}

/* ------------------------- the perturbation matrix ------------------------- */

const reference = Config.parseString(REFERENCE_CONF);
const referenceTree = reference.toJSON();

function literalAt(path: string): ConfigValue {
  let node: ConfigValue = referenceTree;
  for (const segment of path.split('.')) node = (node as ConfigObject)[segment]!;
  return node;
}

const probes: readonly ConfigProbe[] = CONFIG_READER_REGISTRY.flatMap((entry) => [
  { label: entryLabel(entry), read: entry.read },
  ...(entry.contexts ?? []).map((context): ConfigProbe => ({
    label: `${entryLabel(entry)} [${context.name}]`,
    read: entry.read,
    overlay: context.overlay,
  })),
]);
const baselines = probes.map((probe) => baselineOf(probe, reference));
const secondAnswers = new Map(baselines.map((baseline) => [baseline.probe.label, runProbe(baseline.probe, baseline.config)]));

const perturbations: readonly LeafPerturbation[] = [
  ...referenceLeaves.map((leaf) => perturbationFor(leaf, literalAt(leaf))),
  ...[...UNPUBLISHED_LEAVES].map(([leaf, unpublished]) =>
    introductionFor(leaf, unpublished.value, unpublished.reason, unpublished.override)),
];
const verdicts = new Map(perturbations.map((perturbation) => [perturbation.leaf, observeLeaf(perturbation, baselines)]));
const gatedLeaves = [...verdicts.keys()];

function verdictOf(leaf: string): LeafVerdict {
  return verdicts.get(leaf)!;
}

/** The block a leaf sits in: its path without the last segment. */
function blockOf(leaf: string): string {
  return leaf.slice(0, leaf.lastIndexOf('.'));
}

function shippedAs(perturbation: LeafPerturbation): string {
  return perturbation.literal === undefined
    ? `unpublished, introduced at ${JSON.stringify(perturbation.introducedAs)}`
    : `shipped as ${JSON.stringify(perturbation.literal)}`;
}

/** Where a second value the reader takes goes: the override table, or the unpublished leaf's own entry. */
function secondValueRemedy(perturbation: LeafPerturbation): string {
  return perturbation.literal === undefined
    ? 'give its UNPUBLISHED_LEAVES entry an override the reader takes'
    : 'give PERTURBATION_OVERRIDES one it takes';
}

function unreadMessage(verdict: LeafVerdict): string {
  const { leaf, kind, value } = verdict.perturbation;
  const refusals = verdict.refusedBy.length === 0
    ? ''
    : ` ${verdict.refusedBy.length} refused it on its merits (${verdict.refusedBy.join('; ')}), which shows a check, `
      + `not a read: if the reader keeps the leaf but takes only some values, ${secondValueRemedy(verdict.perturbation)}.`;
  return `${leaf} (${kind}, ${shippedAs(verdict.perturbation)}) is read by no registered reader: `
    + `set to ${JSON.stringify(value)}, none of the ${probes.length} probes answered to its value.${refusals} `
    + 'Fix the reader that should read it, register that reader (an entry in tests/util/ConfigReaderRegistry.ts '
    + 'and the exact-object suite it names), delete the key, or — if it is knowingly unimplemented — list it in '
    + 'KNOWN_DEAD_KEYS with the issue that will remove it.';
}

function kindMismatchMessage(verdict: LeafVerdict): string {
  const { leaf, kind, value } = verdict.perturbation;
  const remedy = verdict.perturbation.literal === undefined
    ? 'fix the accessor, or introduce the leaf in tests/util/ConfigReaderRegistry.ts at a value of the kind it has.'
    : 'fix the accessor, or, where the literal cannot show the kind, add the leaf to PERTURBATION_OVERRIDES or '
      + 'KIND_DECLARATIONS in tests/util/ConfigPerturbation.ts with the reason.';
  return `${leaf} (${kind}, ${shippedAs(verdict.perturbation)}) set to ${JSON.stringify(value)} was refused `
    + `as the wrong kind — ${verdict.kindMismatches.join('; ')}. A getter refusing a value of the leaf's own kind `
    + `means the reader takes the leaf as another kind than it ships as: ${remedy}`;
}

function offKindMessage(verdict: LeafVerdict): string {
  const { leaf, kind, offKindValue } = verdict.perturbation;
  return `${leaf} (${kind}, ${shippedAs(verdict.perturbation)}) is read with an accessor of another kind: `
    + `${verdict.offKindAcceptedBy.join(', ')} took ${JSON.stringify(offKindValue)}, which the accessor of the `
    + `leaf's own kind refuses, and answered differently. Read it with that accessor — or, where the literal `
    + 'does not show the kind (1.0 parses as 1, a byte count shipped without its unit, an enum with an off '
    + 'member), declare it in KIND_DECLARATIONS in tests/util/ConfigPerturbation.ts with the reason.';
}

describe('reference.conf has no dead keys', () => {
  test('the reference config actually parses into leaves', () => {
    // Guards the guard: a parser change that yielded nothing would make
    // every assertion below vacuously pass.
    expect(referenceLeaves.length).toBeGreaterThan(20);
    expect(referenceLeaves).toContain('actor-ts.sharding.passivation-idle');
  });

  test.each(referenceLeaves)('%s is reachable from ConfigKeys', (leaf) => {
    if (KNOWN_DEAD_KEYS.has(leaf)) return;
    const accessor = coveringAccessor(leaf);

    expect(
      accessor,
      `${leaf} ships in reference.conf but no ConfigKeys entry covers it. `
      + 'Add one, delete the key, or — if it is knowingly unimplemented — '
      + 'list it in KNOWN_DEAD_KEYS with the issue that will remove it.',
    ).not.toBeNull();
  });

  test.each(gatedLeaves)('%s is read by a registered reader', (leaf) => {
    if (KNOWN_DEAD_KEYS.has(leaf)) return;
    const verdict = verdictOf(leaf);

    expect(verdict.kindMismatches, kindMismatchMessage(verdict)).toEqual([]);
    expect(verdict.observedBy.length, unreadMessage(verdict)).toBeGreaterThan(0);
  });

  test.each(gatedLeaves)('%s is read with an accessor of its kind', (leaf) => {
    const verdict = verdictOf(leaf);

    expect(verdict.offKindAcceptedBy, offKindMessage(verdict)).toEqual([]);
  });

  test('every KNOWN_DEAD_KEYS entry is still a real reference.conf key', () => {
    // Otherwise the exception outlives the key and quietly excuses nothing.
    for (const [key, reason] of KNOWN_DEAD_KEYS) {
      expect(referenceLeaves, `${key} is excused (${reason}) but no longer in reference.conf`)
        .toContain(key);
    }
  });

  test('every KNOWN_DEAD_KEYS entry names the issue that will remove it', () => {
    for (const [key, reason] of KNOWN_DEAD_KEYS) {
      expect(reason, `${key} needs an issue reference, not just a note`).toMatch(/#\d+/);
    }
  });

  test('every KNOWN_DEAD_KEYS entry is still read by nothing', () => {
    for (const [key, reason] of KNOWN_DEAD_KEYS) {
      expect(verdictOf(key).observedBy, `${key} is excused (${reason}) but a reader observes it now`)
        .toEqual([]);
    }
  });
});

describe('the reader registry', () => {
  const probeLabels = probes.map((probe) => probe.label);

  test('names every reader once per variant', () => {
    expect(new Set(probeLabels).size).toBe(probeLabels.length);
    expect(CONFIG_READER_REGISTRY.length).toBeGreaterThan(100);
  });

  test.each(probeLabels)('%s answers the reference config', (label) => {
    const baseline = baselines.find((candidate) => candidate.probe.label === label)!;

    expect(
      baseline.outcome.kind === 'threw' ? String(baseline.outcome.error) : 'answered',
      `${label} throws over the reference config${baseline.probe.overlay ? ' and its context' : ''}, so no leaf can `
      + 'be observed through it. A context needs the companion leaves its branch requires.',
    ).toBe('answered');
  });

  test.each(probeLabels)('%s answers the same twice', (label) => {
    const baseline = baselines.find((candidate) => candidate.probe.label === label)!;
    const second = secondAnswers.get(label)!;

    // A reader whose answer moves on its own — a fresh closure, a clock, a
    // random id — would count every leaf as read.
    expect(
      baseline.outcome.kind === 'returned' && second.kind === 'returned'
        && Bun.deepEquals(second.value, baseline.outcome.value, true),
      `${label} answers the same config differently on a second call; project its answer onto the data it read`,
    ).toBe(true);
  });

  test.each(probeLabels)('%s reads at least one leaf', (label) => {
    // An entry that observes nothing helps no leaf pass, and is a reader
    // registered against the wrong block or one that no longer reads config.
    const observed = gatedLeaves.filter((leaf) => verdictOf(leaf).observedBy.includes(label));
    expect(observed.length, `${label} observes no leaf at all`).toBeGreaterThan(0);
  });

  test.each(CONFIG_READER_REGISTRY.map((entry) => [entryLabel(entry), entry.name, entry.suite] as const))(
    '%s is bound by the suite it names',
    (_label, name, suite) => {
      // The suite has to carry exact-object cases, not merely the reader's
      // name: `toEqual` passes a result with an own `undefined` key, so a
      // suite that names its reader and asserts it with `toEqual` alone binds
      // the values and not the absent keys (#1447).  Per file, not per reader:
      // a suite naming two readers passes while it binds one of them.
      const path = join(REPOSITORY_ROOT, suite);
      expect(existsSync(path), `${suite} does not exist`).toBe(true);
      const code = codeOf(readFileSync(path, 'utf8'));
      expect(
        new RegExp(`\\b${name}\\b`).test(code),
        `${suite} does not name ${name} in its code: the registry entry has to name the suite whose `
        + 'exact-object cases bind it',
      ).toBe(true);
      expect(
        /\bexpectExactOptions\(/.test(code),
        `${suite} names ${name} but asserts nothing with expectExactOptions (tests/util/ExactOptions.ts): `
        + 'give it the exact-object reference case, or name the suite that has one',
      ).toBe(true);
    },
  );

  test('every exported config reader in src/ is an entry, or is excused by name', () => {
    const exported = new Set<string>();
    const pattern = /export function (read\w*FromConfig|is\w*SinkEnabled|isRemoteTlsRequested)\s*\(/g;
    for (const file of sourceFiles(join(REPOSITORY_ROOT, 'src'))) {
      for (const match of readFileSync(file, 'utf8').matchAll(pattern)) exported.add(match[1]!);
    }
    const registered = new Set(CONFIG_READER_REGISTRY.map((entry) => entry.name));

    expect(exported.size, 'the export scan found almost nothing: the pattern no longer matches the readers')
      .toBeGreaterThan(80);
    expect(
      [...exported].filter((name) => !registered.has(name) && !READERS_OUTSIDE_THE_REGISTRY.has(name)).sort(),
      'exported readers the gate never runs: register each (and name the suite that binds it), or excuse it in '
      + 'READERS_OUTSIDE_THE_REGISTRY with the reason',
    ).toEqual([]);
    for (const name of [...registered, ...READERS_OUTSIDE_THE_REGISTRY.keys()]) {
      expect(exported, `${name} is listed but no longer exported from src/`).toContain(name);
    }
  });

  test('every override and kind declaration is a leaf the gate perturbs, and changes what it would infer', () => {
    for (const [leaf, override] of PERTURBATION_OVERRIDES) {
      expect(referenceLeaves, `PERTURBATION_OVERRIDES names ${leaf}, which reference.conf does not ship`).toContain(leaf);
      expect(override.value, `${leaf}'s override is its own literal`).not.toEqual(literalAt(leaf));
    }
    for (const [leaf, declaration] of KIND_DECLARATIONS) {
      expect(referenceLeaves, `KIND_DECLARATIONS names ${leaf}, which reference.conf does not ship`).toContain(leaf);
      expect(declaration.kind, `${leaf}'s declared kind is the one its literal already shows`)
        .not.toBe(inferKind(literalAt(leaf)));
    }
  });

  test('every context key is a reference.conf leaf, a key ConfigKeys names, or an unpublished leaf', () => {
    // A misspelt selector would overlay a path nothing reads and quietly
    // select the reference branch again.  An unpublished leaf is held to the
    // gate itself, introduced and required to be read, so a misspelt one fails
    // there; it is how a companion leaf composed under a broker root, which
    // ConfigKeys cannot name, can be set at all.
    for (const entry of CONFIG_READER_REGISTRY) {
      for (const context of entry.contexts ?? []) {
        for (const key of Object.keys(context.overlay)) {
          expect(
            referenceLeaves.includes(key) || keyPathsToAccessor.has(key) || UNPUBLISHED_LEAVES.has(key),
            `${entryLabel(entry)} [${context.name}] sets ${key}, which is no key at all`,
          ).toBe(true);
        }
      }
    }
  });

  test('every unpublished leaf is a key ConfigKeys covers and reference.conf does not ship', () => {
    for (const [leaf, unpublished] of UNPUBLISHED_LEAVES) {
      expect(referenceLeaves, `${leaf} is published now: drop it from UNPUBLISHED_LEAVES`).not.toContain(leaf);
      expect(coveringAccessor(leaf), `no ConfigKeys entry covers ${leaf}`).not.toBeNull();
      expect(unpublished.reason.length, leaf).toBeGreaterThan(20);
      if (unpublished.override !== undefined) {
        expect(unpublished.override.value, `${leaf}'s override is the value it is introduced at`)
          .not.toEqual(unpublished.value);
        expect(unpublished.override.reason.length, leaf).toBeGreaterThan(20);
      }
    }
  });

  test('no probe observes a key no reader has', () => {
    // The canary for a registry that launders: a probe answering with a
    // whole config block would "read" every leaf in it, a renamed one
    // included.  A key that nothing defines, beside every gated leaf, must
    // leave every answer as it was — introduced and changed as an unpublished
    // leaf is, so the blocks reference.conf does not ship are covered too,
    // where introducing the key creates the block.
    const blocks = [...new Set(gatedLeaves.map(blockOf))];
    expect(blocks.filter((block) => !reference.hasPath(block)).length, 'no block outside reference.conf is covered')
      .toBeGreaterThan(10);
    const observed = blocks.flatMap((block) => {
      const canary = introductionFor(`${block}.no-such-leaf`, PERTURBATION_WORD, 'a key no reader has');
      const verdict = observeLeaf(canary, baselines);
      return [...verdict.observedBy, ...verdict.kindMismatches].map((probe) => `${canary.leaf}: ${probe}`);
    });
    expect(observed).toEqual([]);
  });
});
