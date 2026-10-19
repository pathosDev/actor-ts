import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { isPlainObject, parseHocon } from '../../../src/config/HoconParser.js';
import type { ConfigObject } from '../../../src/config/HoconParser.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import { CONFIG_READER_REGISTRY, UNPUBLISHED_LEAVES } from '../../util/ConfigReaderRegistry.js';

/**
 * AGENTS.md's account of the dead-key gate matches the gate (#1425).
 *
 * The `ConfigKeys` rule in *Code style* said a key had to be "read by
 * something in `src/`", which is what the gate checked while it searched
 * source text — and a comment, a sibling's accessor or a value read and then
 * dropped all satisfied it.  The gate now changes each leaf and asks the
 * registered readers whether their answer moved, and AGENTS.md is where an
 * agent learns what to do when it adds a key, so this holds the part of that
 * account a test can hold:
 *
 *   - the rule names the gate's files and tables, and every path or table it
 *     names exists as spelled, so a rename has to take the prose along;
 *   - the settings it calls outside the gate are outside it, so the sentence
 *     has to go once a change brings one in — the reference.conf page makes
 *     the same claim, held by `tests/unit/docs/ReferenceConfDeadKeySection.test.ts`;
 *   - it does not describe the text search the gate replaced.
 *
 * What it cannot see is the prose itself: a sentence asserting the opposite
 * of what the gate does keeps every check here green.  What the gate counts
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

/** How the rule described the gate while it searched source text. */
const RETIRED_CLAIMS: readonly RegExp[] = [
  /sub-?string/i,
  /same[\s-]file/i,
  /read by something in `src\/`/i,
  /matches `ConfigKeys\./i,
];

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

  test('every path it names exists, and every table it names is one the gate declares', () => {
    const gateSources = GATE_FILES.map((file) => readFileSync(join(REPOSITORY_ROOT, file), 'utf8'));
    const spans = codeSpansOf(keysRule());
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

  test('the registry has the contexts the rule tells a selector-gated block to use', () => {
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

  test('the gate still has keys to change', () => {
    // Guards the guard: an empty key list would make every setting "outside".
    expect(gatedKeys.length).toBeGreaterThan(400);
    expect(gatedKeys).toContain('actor-ts.coordinated-startup.phases');
  });

  test('the rule does not describe the text search the gate replaced', () => {
    for (const claim of RETIRED_CLAIMS) expect(wordsOf(keysRule())).not.toMatch(claim);
  });
});
