import { describe, expect, test } from 'bun:test';
import { Config, ConfigError } from '../../../src/config/Config.js';
import { ConfigKeys } from '../../../src/config/ConfigKeys.js';
import type { ConfigObject, ConfigValue } from '../../../src/config/HoconParser.js';
import { holdsUnknownPersistenceKey } from '../../../src/persistence/PersistenceExtension.js';
import { refuseUnknownPersistenceKeys } from '../../../src/persistence/PersistenceUnknownKeys.js';

/**
 * #1729 — the keys under `actor-ts.persistence` the startup refuses, asked of
 * the check itself.  `PersistenceSelectorStartup.test.ts` pins that the
 * startup runs it and fails on its refusal; this file pins what it accepts,
 * and that the accepted set comes from `ConfigKeys` rather than a list beside
 * it, which no amount of startup cases can tell apart while the two agree.
 */

const reference = Config.loadReference();
const referenceTree = reference.toJSON();

type DeclaredKey = {
  /** Where `ConfigKeys` declares it, `ConfigKeys.persistence.journal.plugin`. */
  readonly accessor: string;
  readonly path: string;
};

/** Every string `ConfigKeys.persistence` declares, walked the way the check walks it. */
function declaredUnder(node: unknown, accessor: string): DeclaredKey[] {
  if (typeof node === 'string') return [{ accessor, path: node }];
  if (typeof node !== 'object' || node === null) return [];
  return Object.entries(node).flatMap(([name, child]) => declaredUnder(child, `${accessor}.${name}`));
}

const DECLARED: readonly DeclaredKey[] = declaredUnder(ConfigKeys.persistence, 'ConfigKeys.persistence');

const SELECTORS: readonly string[] = [
  ConfigKeys.persistence.journal.plugin,
  ConfigKeys.persistence.snapshotStore.plugin,
  ConfigKeys.persistence.durableState.plugin,
];
const AXES: readonly string[] = SELECTORS.map((selector) => selector.slice(0, selector.lastIndexOf('.')));

/** What reference.conf ships at `path`, or `undefined` for a key it leaves to a comment. */
function shippedAt(path: string): ConfigValue | undefined {
  let node: ConfigValue | undefined = referenceTree;
  for (const segment of path.split('.')) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return undefined;
    node = (node as ConfigObject)[segment];
  }
  return node;
}

/**
 * Whether a declared key is a block: a path other declared keys lie under, or
 * a plug-in's namespace directly in an axis — `journal.sqlite`,
 * `journal.in-memory` — which by the framework's rule is the plug-in's config
 * section, so its id is written as a block, never as a value.
 */
function isBlock(path: string): boolean {
  if (DECLARED.some((other) => other.path.startsWith(`${path}.`))) return true;
  return AXES.includes(path.slice(0, path.lastIndexOf('.'))) && !SELECTORS.includes(path);
}

/** A declared key as a deployment writes it: a block as a block, a leaf at what reference.conf ships, or at a value. */
function written(path: string): string {
  if (isBlock(path)) return `${path} {}`;
  return `${path} = ${JSON.stringify(shippedAt(path) ?? 'value')}`;
}

const WRITTEN: ReadonlyArray<readonly [string, string]> = DECLARED.map((key) => [key.accessor, written(key.path)]);

/** The refusal `run` throws, or a failure of the case when it throws none. */
function refusalOf(run: () => void): ConfigError {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected a ConfigError, and nothing was thrown');
}

describe('every key ConfigKeys declares under actor-ts.persistence is accepted (#1729)', () => {
  test('the walk finds keys of both kinds, all of them under actor-ts.persistence', () => {
    // Guards the guard: a walk that came back short, or found only the keys
    // reference.conf ships, would leave the cases below green over nothing.
    expect(DECLARED.length).toBeGreaterThan(200);
    expect(DECLARED.filter((key) => !key.path.startsWith('actor-ts.persistence.'))).toEqual([]);
    expect(DECLARED.filter((key) => shippedAt(key.path) === undefined).length).toBeGreaterThan(20);
    expect(DECLARED.filter((key) => !isBlock(key.path) && shippedAt(key.path) !== undefined).length)
      .toBeGreaterThan(100);
  });

  test('the shipped reference.conf passes as it stands', () => {
    expect(() => refuseUnknownPersistenceKeys(reference)).not.toThrow();
  });

  test.each(WRITTEN)('%s, written `%s` on its own, passes', (_accessor, hocon) => {
    expect(() => refuseUnknownPersistenceKeys(Config.parseString(hocon))).not.toThrow();
  });

  test.each(WRITTEN)('%s, written `%s` over the shipped reference.conf, passes', (_accessor, hocon) => {
    expect(() => refuseUnknownPersistenceKeys(Config.parseString(hocon).withFallback(reference))).not.toThrow();
  });
});

describe('what the check refuses, naming the full key and what to do (#1729)', () => {
  test('a key directly under actor-ts.persistence that is no axis and no key a reader takes', () => {
    const refusal = refusalOf(() =>
      refuseUnknownPersistenceKeys(Config.parseString('actor-ts.persistence.jornal { plugin = "x" }')));

    expect(refusal.message).toBe(
      'Config at "actor-ts.persistence.jornal" is not a key actor-ts.persistence takes — it takes the journal, '
        + 'snapshot-store and durable-state blocks and max-concurrent-recoveries, recovery-timeout, '
        + 'snapshot-is-optional, allow-fully-compacted-recovery, journal-breaker, snapshot-breaker and '
        + 'auto-start.  Read by nothing, it would '
        + 'leave a default in force, so it is refused rather than ignored: correct the spelling, or move a '
        + 'plug-in\'s settings into its block under the axis it serves, such as '
        + 'actor-ts.persistence.journal.<plug-in> { … }.',
    );
  });

  test('a value directly in an axis block other than its selector', () => {
    const refusal = refusalOf(() =>
      refuseUnknownPersistenceKeys(Config.parseString('actor-ts.persistence.journal.plugn = "x"')));

    expect(refusal.message).toBe(
      'Config at "actor-ts.persistence.journal.plugn" is not a key the journal block takes — it takes plugin = '
        + '"<plugin id>" beside the blocks of its plug-ins.  Read by nothing, it would leave the store its plugin '
        + 'field selects in force, so it is refused rather than ignored: correct the spelling, or move a '
        + 'plug-in\'s settings into its block, actor-ts.persistence.journal.<plug-in> { … }.',
    );
  });

  test.each([
    { hocon: 'actor-ts.persistence.snapshot-store.keep-n = 3', key: 'actor-ts.persistence.snapshot-store.keep-n', block: 'snapshot-store' },
    { hocon: 'actor-ts.persistence.durable-state.table = "state"', key: 'actor-ts.persistence.durable-state.table', block: 'durable-state' },
    // A plug-in's id where its block belongs: the id names a section, not a value.
    { hocon: 'actor-ts.persistence.durable-state.object-storage = "bucket"', key: 'actor-ts.persistence.durable-state.object-storage', block: 'durable-state' },
    { hocon: 'actor-ts.persistence.journal.in-memory = true', key: 'actor-ts.persistence.journal.in-memory', block: 'journal' },
  ])('$key in the $block block, over the shipped reference.conf', ({ hocon, key, block }) => {
    const refusal = refusalOf(() => refuseUnknownPersistenceKeys(Config.parseString(hocon).withFallback(reference)));

    expect(refusal.message).toStartWith(`Config at "${key}" is not a key the ${block} block takes — `);
  });

  test.each(['null', '[a, b]', 'true', '3', '"x"'])('a value of any kind beside the selector, here %s', (value) => {
    const refusal = refusalOf(() =>
      refuseUnknownPersistenceKeys(Config.parseString(`actor-ts.persistence.journal.table = ${value}`)));

    expect(refusal.message).toStartWith('Config at "actor-ts.persistence.journal.table" is not a key ');
  });

  test('a key no bare HOCON key can spell is named quoted, as it was written', () => {
    const refusal = refusalOf(() =>
      refuseUnknownPersistenceKeys(Config.parseString('actor-ts.persistence.journal { "my.plugin" = 1 }')));

    expect(refusal.message).toStartWith('Config at "actor-ts.persistence.journal."my.plugin"" is not a key ');
  });
});

describe('what the check leaves to others (#1729)', () => {
  test('a block in an axis is a plug-in\'s, a third-party plug-in\'s included, whatever it holds', () => {
    const config = Config.parseString(
      'actor-ts.persistence.journal.my-plugin { tabel = "events", nested { anything = 1 } }',
    ).withFallback(reference);

    expect(() => refuseUnknownPersistenceKeys(config)).not.toThrow();
  });

  test.each([
    'actor-ts.persistence = "postgres"',
    'actor-ts.persistence.journal = "actor-ts.persistence.journal.sqlite"',
    'actor-ts.persistence.journal.plugin = null',
    'actor-ts.persistence.snapshot-store.plugin = { a = 1 }',
    'actor-ts = "x"',
  ])('the selection reader\'s own refusals pass through untouched: %s', (hocon) => {
    expect(() => refuseUnknownPersistenceKeys(Config.parseString(hocon))).not.toThrow();
  });

  test('a configuration with nothing under actor-ts.persistence', () => {
    expect(() => refuseUnknownPersistenceKeys(Config.parseString('actor-ts.cluster { }'))).not.toThrow();
    expect(() => refuseUnknownPersistenceKeys(Config.empty())).not.toThrow();
  });
});

describe('what the check accepts comes from ConfigKeys, not a list beside it (#1729)', () => {
  test('a key ConfigKeys gains directly under actor-ts.persistence is accepted the day it is declared', () => {
    const grown = { ...ConfigKeys.persistence, futureSetting: 'actor-ts.persistence.future-setting' };
    const config = Config.parseString('actor-ts.persistence.future-setting = 1');

    expect(() => refuseUnknownPersistenceKeys(config))
      .toThrow('Config at "actor-ts.persistence.future-setting" is not a key ');
    expect(() => refuseUnknownPersistenceKeys(config, grown)).not.toThrow();
  });

  test('so is a group of them, found however deep ConfigKeys nests it', () => {
    const grown = {
      ...ConfigKeys.persistence,
      query: { root: 'actor-ts.persistence.query', pageSize: 'actor-ts.persistence.query.page-size' },
    };
    const config = Config.parseString('actor-ts.persistence.query { page-size = 10 }');

    expect(() => refuseUnknownPersistenceKeys(config)).toThrow('Config at "actor-ts.persistence.query" is not a key ');
    expect(() => refuseUnknownPersistenceKeys(config, grown)).not.toThrow();
  });

  test('an axis takes the leaf its own plugin entry names', () => {
    const renamed = {
      ...ConfigKeys.persistence,
      journal: { ...ConfigKeys.persistence.journal, plugin: 'actor-ts.persistence.journal.selector' },
    };
    const config = Config.parseString('actor-ts.persistence.journal.selector = "x"');

    expect(() => refuseUnknownPersistenceKeys(config))
      .toThrow('Config at "actor-ts.persistence.journal.selector" is not a key the journal block takes');
    expect(() => refuseUnknownPersistenceKeys(config, renamed)).not.toThrow();
  });
});

/**
 * The question the `ActorSystem` constructor asks under `autoStart: false` set
 * in code, before it decides to build persistence inside `create` (#1729).
 * Exactly the check's answer: a yes for anything else would build the
 * extension under an opt-out for a file the refusal has nothing to say about.
 */
describe('holdsUnknownPersistenceKey answers whether the check refuses, and nothing more (#1729)', () => {
  test.each([
    'actor-ts.persistence.journal.plugn = "x"',
    'actor-ts.persistence.jornal { plugin = "x" }',
    'actor-ts.persistence.recovery-timout = 5s',
  ])('yes for a key the check refuses: %s', (hocon) => {
    expect(holdsUnknownPersistenceKey(Config.parseString(hocon).withFallback(reference))).toBe(true);
  });

  test.each([
    '',
    'actor-ts.persistence.journal.plugin = "actor-ts.persistence.journal.sqlite"',
    'actor-ts.persistence.journal.my-plugin { tabel = "events" }',
    'actor-ts.persistence.max-concurrent-recoveries = -1',
  ])('no for a file the check accepts: "%s"', (hocon) => {
    expect(holdsUnknownPersistenceKey(Config.parseString(hocon).withFallback(reference))).toBe(false);
  });

  test.each([
    'actor-ts.persistence.journal = "actor-ts.persistence.journal.sqlite"',
    'actor-ts.persistence.durable-state.plugin = null',
    'actor-ts.persistence = "postgres"',
  ])('no for a mistake the selection reader refuses instead: %s', (hocon) => {
    expect(holdsUnknownPersistenceKey(Config.parseString(hocon).withFallback(reference))).toBe(false);
  });
});
