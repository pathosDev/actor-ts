import { describe, expect, test } from 'bun:test';
import { Config, ConfigError } from '../../src/config/Config.js';
import {
  baselineOf,
  inferKind,
  introductionFor,
  isKindMismatch,
  KIND_DECLARATIONS,
  nestedOverlay,
  observeLeaf,
  PERTURBATION_OVERRIDES,
  perturbationFor,
  type ConfigProbe,
  type LeafPerturbation,
} from './ConfigPerturbation.js';

/**
 * The perturbation the dead-key gate runs every `reference.conf` leaf
 * through (#1425), pinned on its own: what value each kind of literal turns
 * into, and how a reader's answer to it is classified.
 *
 * The classification is the part a gate can quietly get wrong.  A probe
 * that refuses a value as the wrong kind has not shown that it reads the
 * leaf — it has shown that the value was not of the leaf's kind — so it must
 * come back as a failure of the leaf, never as a read.  Counted as a read,
 * it lets a `getBoolean` whose answer is thrown away pass.
 */

function value(leaf: string, literal: Parameters<typeof perturbationFor>[1]): unknown {
  return perturbationFor(leaf, literal).value;
}

describe('perturbationFor — a value of the literal\'s own kind', () => {
  test('a switch flips within its spelling, keeping its case', () => {
    expect(value('x', 'off')).toBe('on');
    expect(value('x', 'on')).toBe('off');
    expect(value('x', 'yes')).toBe('no');
    expect(value('x', 'NO')).toBe('YES');
    // A string, not the boolean: the spelling is what `getBoolean` reads.
    expect(value('x', 'true')).toBe('false');
    expect(inferKind('off')).toBe('switch');
  });

  test('a boolean literal flips', () => {
    expect(value('x', true)).toBe(false);
    expect(value('x', false)).toBe(true);
  });

  test('a duration or a size keeps its unit and gains one of it', () => {
    expect(value('x', '5s')).toBe('6s');
    expect(value('x', '1MiB')).toBe('2MiB');
    expect(value('x', '250ms')).toBe('251ms');
    expect(value('x', '1.5 h')).toBe('2.5 h');
    expect(inferKind('5s')).toBe('duration');
    expect(inferKind('1MiB')).toBe('size');
    expect(value('x', '512M')).toBe('513M');
  });

  test('m is minutes and M is mebibytes, though both parsers would take either', () => {
    // `getDuration('16M')` is sixteen minutes and `getBytes('5m')` five
    // mebibytes; the case is the only thing that says which one is meant.
    expect(perturbationFor('x', '5m')).toMatchObject({ kind: 'duration', value: '6m', offKindValue: '6KiB' });
    expect(perturbationFor('x', '16M')).toMatchObject({ kind: 'size', value: '17M', offKindValue: '17s' });
  });

  test('an integer gains one; a fraction moves a tenth and stays inside [0, 1]', () => {
    expect(value('x', 7)).toBe(8);
    expect(value('x', 0)).toBe(1);
    // Exactly 0.3, not the 0.30000000000000004 that `0.2 + 0.1` is.
    expect(value('x', 0.2)).toBe(0.3);
    expect(value('x', 0.95)).toBe(0.85);
    expect(value('x', 2.5)).toBe(2.6);
  });

  test('a string gains a suffix, and the empty string becomes one', () => {
    expect(value('x', 'hybrid')).toBe('hybrid-perturbed');
    expect(value('x', '')).toBe('perturbed');
    expect(inferKind('localhost:11211')).toBe('text');
  });

  test('a list gains an element of its element type', () => {
    expect(value('x', [])).toEqual(['perturbed']);
    expect(value('x', ['/user/*'])).toEqual(['/user/*', 'perturbed']);
    expect(value('x', [1, 4])).toEqual([1, 4, 5]);
  });

  test('a literal with no kind is refused rather than guessed at', () => {
    expect(() => perturbationFor('x', null)).toThrow(/add an override/);
  });
});

describe('perturbationFor — the off-kind value', () => {
  function offKind(literal: Parameters<typeof perturbationFor>[1]): unknown {
    return perturbationFor('x', literal).offKindValue;
  }

  test('each is refused by the leaf\'s own accessor', () => {
    const config = Config.parseString(`
      integer = ${String(offKind(7))}
      duration = ${String(offKind('5s'))}
      size = ${String(offKind('1MiB'))}
      fraction = ${String(offKind(0.2))}
      switch = ${String(offKind('off'))}
    `);
    expect(() => config.getInt('integer')).toThrow(ConfigError);
    expect(() => config.getDuration('duration')).toThrow(/Unknown duration unit/);
    expect(() => config.getBytes('size')).toThrow(/Unknown size unit/);
    expect(() => config.getNumber('fraction')).toThrow(ConfigError);
    expect(() => config.getBoolean('switch')).toThrow(ConfigError);
  });

  test('and taken by the accessor it is most easily confused with', () => {
    expect(offKind(7)).toBe(8.5);          // getNumber, getDuration, getBytes
    expect(offKind('5s')).toBe('6KiB');    // getBytes
    expect(offKind('1MiB')).toBe('2s');    // getDuration
    expect(offKind(0.2)).toBe('0.3s');     // getDuration
    expect(offKind([])).toBe('perturbed'); // getString
  });

  test('a string has none: every accessor of a string takes any string', () => {
    expect(offKind('hybrid')).toBeUndefined();
  });
});

describe('the override and declaration tables', () => {
  test('an override wins over the literal, and its kind is the override\'s', () => {
    const level = perturbationFor('actor-ts.logger.level', 'info');
    expect(level.value).toBe('debug');
    expect(level.reason).toMatch(/maps an unknown level name/);
    const size = perturbationFor('actor-ts.offload-pool.size', 'auto');
    expect(size).toMatchObject({ kind: 'integer', value: 3, offKindValue: 3.5 });
  });

  test('a declared kind replaces the inferred one', () => {
    const factor = perturbationFor('actor-ts.circuit-breaker.default.backoff-factor', 1);
    expect(factor).toMatchObject({ kind: 'fraction', value: 0.9, offKindValue: '0.9s' });
    const timeToLive = perturbationFor('actor-ts.cache.in-memory.time-to-live', 0);
    expect(timeToLive).toMatchObject({ kind: 'duration', value: 1, offKindValue: '1KiB' });
  });

  test('an unpublished leaf is introduced at its value, with the kind and off-kind value read off it', () => {
    expect(introductionFor('a.max-retries', 3, 'documented as a template')).toEqual({
      leaf: 'a.max-retries',
      kind: 'integer',
      literal: undefined,
      value: 3,
      offKindValue: 3.5,
      reason: 'documented as a template',
    });
    expect(introductionFor('a.min-backoff', '250ms', 'r')).toMatchObject({ kind: 'duration', offKindValue: '250KiB' });
  });

  test('every entry gives its reason', () => {
    for (const [leaf, override] of PERTURBATION_OVERRIDES) {
      expect(override.reason.length, leaf).toBeGreaterThan(20);
    }
    for (const [leaf, declaration] of KIND_DECLARATIONS) {
      expect(declaration.reason.length, leaf).toBeGreaterThan(20);
    }
  });
});

describe('isKindMismatch', () => {
  const config = Config.parseString('duration = 5s, word = hello, list = [1, { a = 1 }]');

  test('names the getters\' and parsers\' own refusals', () => {
    for (const read of [
      () => config.getInt('duration'),
      () => config.getBoolean('word'),
      () => config.getDuration('word'),
      () => config.getBytes('duration'),
      () => config.getStringList('word'),
      () => config.getStringList('list'),
    ]) {
      let caught: unknown;
      try { read(); } catch (error) { caught = error; }
      expect(caught, String(read)).toBeDefined();
      expect(isKindMismatch(caught), String(read)).toBe(true);
    }
  });

  test('and nothing else — a missing path, a reader\'s own refusal', () => {
    let missing: unknown;
    try { config.getString('absent'); } catch (error) { missing = error; }
    expect(isKindMismatch(missing)).toBe(false);
    expect(isKindMismatch(new ConfigError('x.y must be one of a | b (got "c")'))).toBe(false);
    expect(isKindMismatch(new Error('Invalid duration'))).toBe(false);
  });
});

describe('observeLeaf — what counts as a read', () => {
  const reference = Config.parseString(`
    a {
      enabled = off
      timeout = 5s
      count = 7
      name = ""
    }
  `);

  function verdict(leaf: string, literal: Parameters<typeof perturbationFor>[1], read: ConfigProbe['read']) {
    const perturbation: LeafPerturbation = perturbationFor(leaf, literal);
    return observeLeaf(perturbation, [baselineOf({ label: 'probe', read }, reference)]);
  }

  test('an answer that follows the leaf is a read', () => {
    const observed = verdict('a.enabled', 'off', (config) => ({ enabled: config.getBoolean('a.enabled') }));
    expect(observed.observedBy).toEqual(['probe']);
    expect(observed.kindMismatches).toEqual([]);
  });

  test('a getBoolean whose answer is thrown away is not', () => {
    const discarded = verdict('a.enabled', 'off', (config) => {
      config.getBoolean('a.enabled');
      return {};
    });
    expect(discarded.observedBy).toEqual([]);
    expect(discarded.kindMismatches).toEqual([]);
  });

  test('a kind mismatch is a failure of the leaf, not a read', () => {
    // The `auto`-or-a-count shape: the shipped word passes, and any other
    // word reaches `getInt` and is refused as the wrong kind.  That says the
    // perturbation picked a value of another kind than the reader takes — not
    // that the reader reads the leaf.
    const workers = Config.parseString('a.workers = auto');
    const mismatched = observeLeaf(perturbationFor('a.workers', 'auto'), [
      baselineOf({
        label: 'probe',
        read: (config) => {
          const raw = config.getString('a.workers');
          return raw === 'auto' ? {} : { workers: config.getInt('a.workers') };
        },
      }, workers),
    ]);
    expect(mismatched.observedBy).toEqual([]);
    expect(mismatched.kindMismatches).toEqual(['probe: Config at "a.workers" is not a number (got string)']);
  });

  test('a refusal on the value\'s merits is recorded, and is not a read on its own', () => {
    // Checked and dropped: the reader refuses `perturbed`, but a value it
    // accepted would vanish all the same.
    const refused = verdict('a.name', '', (config) => {
      const name = config.getString('a.name');
      if (name !== '') new URL(name);
      return {};
    });
    expect(refused.observedBy).toEqual([]);
    expect(refused.refusedBy).toHaveLength(1);
    expect(refused.refusedBy[0]).toStartWith('probe: ');
    expect(refused.kindMismatches).toEqual([]);
  });

  test('an enum the reader keeps answers to another member', () => {
    const strategy = Config.parseString('actor-ts.cluster.split-brain-resolver.active-strategy = off');
    const leaf = 'actor-ts.cluster.split-brain-resolver.active-strategy';
    const kept = observeLeaf(perturbationFor(leaf, 'off'), [
      baselineOf({
        label: 'probe',
        read: (config) => {
          const raw = config.getString(leaf);
          if (raw !== 'off' && raw !== 'keep-majority') throw new ConfigError(`${leaf} must be one of off | keep-majority`);
          return { strategy: raw };
        },
      }, strategy),
    ]);
    expect(kept.observedBy).toEqual(['probe']);
  });

  test('an integer read with getDuration is a read, and an off-kind acceptance', () => {
    const wrongAccessor = verdict('a.count', 7, (config) => ({ count: config.getDuration('a.count') }));
    expect(wrongAccessor.observedBy).toEqual(['probe']);
    expect(wrongAccessor.offKindAcceptedBy).toEqual(['probe']);
    const rightAccessor = verdict('a.count', 7, (config) => ({ count: config.getInt('a.count') }));
    expect(rightAccessor.observedBy).toEqual(['probe']);
    expect(rightAccessor.offKindAcceptedBy).toEqual([]);
  });

  test('a probe that throws at baseline is skipped, not counted either way', () => {
    const broken = verdict('a.count', 7, () => { throw new Error('boom'); });
    expect(broken).toMatchObject({ observedBy: [], refusedBy: [], kindMismatches: [], offKindAcceptedBy: [] });
  });
});

test('nestedOverlay nests a dotted path, so the value lands where a reader looks', () => {
  // `Config.fromObject({ 'a.b': 1 })` would keep `a.b` as one literal key.
  const overlay = Config.fromObject(nestedOverlay({ 'a.b.c': 1, 'a.b.d': 'x' }));
  expect(overlay.getInt('a.b.c')).toBe(1);
  expect(overlay.getString('a.b.d')).toBe('x');
});
