import { describe, expect, test } from 'bun:test';
import { Config, ConfigError } from '../../src/config/Config.js';
import type { ConfigObject, ConfigValue } from '../../src/config/HoconParser.js';
import { REFERENCE_CONF } from '../../src/config/Reference.js';
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
  withOverlay,
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

/** The value a dotted path holds in a parsed tree. */
function literalIn(tree: ConfigObject, path: string): ConfigValue {
  let node: ConfigValue = tree;
  for (const segment of path.split('.')) node = (node as ConfigObject)[segment]!;
  return node;
}

/** What `read` throws, or `undefined` when it answers. */
function refusalOf(read: () => unknown): unknown {
  try {
    read();
    return undefined;
  } catch (error) {
    return error;
  }
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
    expect(perturbationFor('x', '5m')).toMatchObject({ kind: 'duration', value: '6m', offKindValues: ['6KiB'] });
    expect(perturbationFor('x', '16M')).toMatchObject({ kind: 'size', value: '17M', offKindValues: ['17s'] });
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

  test('an object changes its first entry\'s value within that value\'s kind, and keeps every name', () => {
    expect(inferKind({ 'rsp:': 7000 })).toBe('object');
    expect(value('x', { 'rsp:': 7000, 'idem:': 2000 })).toEqual({ 'rsp:': 7001, 'idem:': 2000 });
    expect(value('x', { authorization: 'Bearer t0k3n' })).toEqual({ authorization: 'Bearer t0k3n-perturbed' });
    // A nested block changes one level down, in the kind of the leaf there.
    expect(value('x', { backend: { 'minimum-members-before-up': 2 } }))
      .toEqual({ backend: { 'minimum-members-before-up': 3 } });
    expect(value('x', { 'before-service-unbind': { timeout: '5s' } }))
      .toEqual({ 'before-service-unbind': { timeout: '6s' } });
    expect(value('x', {})).toEqual({ perturbed: 'perturbed' });
  });

  test('an empty literal gets a second value of its kind, non-empty and distinct from the first', () => {
    expect(perturbationFor('x', '')).toMatchObject({ value: 'perturbed', secondValue: 'disturbed' });
    expect(perturbationFor('x', [])).toMatchObject({ value: ['perturbed'], secondValue: ['disturbed'] });
    expect(perturbationFor('x', {}))
      .toMatchObject({ value: { perturbed: 'perturbed' }, secondValue: { perturbed: 'disturbed' } });
    expect(introductionFor('a.b', '', 'documented as a template'))
      .toMatchObject({ value: 'perturbed', secondValue: 'disturbed' });
    // A literal that is not empty already differs from its perturbation in
    // the value alone.
    for (const literal of ['hybrid', 'off', 0, 7, ['/user/*'], { 'rsp:': 7000 }]) {
      expect(perturbationFor('x', literal).secondValue, JSON.stringify(literal)).toBeUndefined();
    }
  });

  test('a literal with no kind is refused rather than guessed at', () => {
    expect(() => perturbationFor('x', null)).toThrow(/add an override/);
  });
});

test('a changed object laid over the one it was is exactly the changed object', () => {
  // The overlay merges an object into the one beneath it, so a perturbation
  // that renamed the entry would reach the reader beside the old one.
  const leaf = 'a.quotas';
  const introduced = withOverlay(Config.parseString('a.enabled = on'), { [leaf]: { 'rsp:': 7000 } });
  const changed = withOverlay(introduced, { [leaf]: perturbationFor(leaf, { 'rsp:': 7000 }).value });
  expect(changed.getObject(leaf)).toEqual({ 'rsp:': 7001 });
});

describe('perturbationFor — the off-kind values', () => {
  function offKinds(literal: Parameters<typeof perturbationFor>[1]): readonly ConfigValue[] | undefined {
    return perturbationFor('x', literal).offKindValues;
  }

  /** The one off-kind value of a kind that has one. */
  function offKind(literal: Parameters<typeof perturbationFor>[1]): ConfigValue {
    const values = offKinds(literal);
    expect(values).toHaveLength(1);
    return values![0]!;
  }

  test('each is refused by the leaf\'s own accessor', () => {
    const [fractionAsDuration, fractionAsSize] = offKinds(0.2)!;
    const config = Config.parseString(`
      integer = ${String(offKind(7))}
      duration = ${String(offKind('5s'))}
      size = ${String(offKind('1MiB'))}
      fraction-as-duration = ${String(fractionAsDuration)}
      fraction-as-size = ${String(fractionAsSize)}
      switch = ${String(offKind('off'))}
      object = ${String(offKind({ 'rsp:': 7000 }))}
    `);
    expect(() => config.getInt('integer')).toThrow(ConfigError);
    expect(() => config.getDuration('duration')).toThrow(/Unknown duration unit/);
    expect(() => config.getBytes('size')).toThrow(/Unknown size unit/);
    expect(() => config.getNumber('fraction-as-duration')).toThrow(ConfigError);
    expect(() => config.getNumber('fraction-as-size')).toThrow(ConfigError);
    expect(() => config.getBoolean('switch')).toThrow(ConfigError);
    expect(() => config.getObject('object')).toThrow(ConfigError);
  });

  test('and taken by the accessors they are most easily confused with', () => {
    expect(offKinds(7)).toEqual([8.5]);                // getNumber, getDuration, getBytes
    expect(offKinds('5s')).toEqual(['6KiB']);          // getBytes
    expect(offKinds('1MiB')).toEqual(['2s']);          // getDuration
    expect(offKinds(0.2)).toEqual(['0.3s', '0.3KiB']); // getDuration, then getBytes
    expect(offKinds([])).toEqual(['perturbed']);       // getString
    expect(offKinds({ 'rsp:': 7000 })).toEqual(['perturbed']); // getString
  });

  test('a fraction has one for each getter of a quantity, since neither takes the other\'s unit', () => {
    // With the duration alone, `getBytes` refused the off-kind value as
    // readily as `getNumber`, so a reader taking a fraction as a size passed
    // the gate (#1425).
    const [asDuration, asSize] = offKinds(0.2)!;
    const config = Config.parseString(`as-duration = ${String(asDuration)}\nas-size = ${String(asSize)}`);
    expect(config.getDuration('as-duration')).toBe(300);
    expect(() => config.getBytes('as-duration')).toThrow(/Unknown size unit/);
    expect(config.getBytes('as-size')).toBe(Math.round(0.3 * 1024));
    expect(() => config.getDuration('as-size')).toThrow(/Unknown duration unit/);
  });

  test('a string has none: every accessor of a string takes any string', () => {
    expect(offKinds('hybrid')).toBeUndefined();
  });
});

describe('the override and declaration tables', () => {
  test('an override wins over the literal, and its kind is the override\'s', () => {
    const level = perturbationFor('actor-ts.logger.level', 'info');
    expect(level.value).toBe('debug');
    expect(level.reason).toMatch(/maps an unknown level name/);
    const size = perturbationFor('actor-ts.offload-pool.size', 'auto');
    expect(size).toMatchObject({ kind: 'integer', value: 3, offKindValues: [3.5] });
  });

  test('an override of an empty literal names its own second value, since no word is surely another member', () => {
    expect(perturbationFor('actor-ts.persistence.snapshot-store.object-storage.backend', ''))
      .toMatchObject({ kind: 'text', value: 'filesystem', secondValue: 's3' });
    expect(() => introductionFor('a.backend', '', 'comment-only', { value: 'filesystem', reason: 'an enum' }))
      .toThrow(/a\.backend starts empty, so its override needs a secondValue/);
  });

  test('a declared kind replaces the inferred one', () => {
    const factor = perturbationFor('actor-ts.circuit-breaker.default.backoff-factor', 1);
    expect(factor).toMatchObject({ kind: 'fraction', value: 0.9, offKindValues: ['0.9s', '0.9KiB'] });
    const timeToLive = perturbationFor('actor-ts.cache.in-memory.time-to-live', 0);
    expect(timeToLive).toMatchObject({ kind: 'duration', value: '1ms', offKindValues: ['1KiB'] });
    const documentBytes = perturbationFor('actor-ts.serialization.read-constraints.max-document-bytes', 0);
    expect(documentBytes).toMatchObject({ kind: 'size', value: '1B', offKindValues: ['1s'] });
  });

  test('a declared duration or size is set with its unit, which its own accessor takes and no integer one does', () => {
    // A bare count reads through `getInt` and `getNumber` exactly as through
    // `getDuration` or `getBytes`, so a declared leaf perturbed to one left a
    // reader that switched to an integer accessor counted as reading it, and
    // its off-kind value is refused by both alike (#1425).  So the value
    // carries the unit a bare count stands in, and each accessor is asked.
    const reference = Config.parseString(REFERENCE_CONF);
    const tree = reference.toJSON();
    const declared = [...KIND_DECLARATIONS].filter(([, { kind }]) => kind === 'duration' || kind === 'size');
    expect(declared.map(([leaf]) => leaf)).toEqual(expect.arrayContaining([
      'actor-ts.cache.in-memory.time-to-live',
      'actor-ts.cache.in-memory.time-to-idle',
      'actor-ts.serialization.read-constraints.max-document-bytes',
    ]));
    for (const [leaf, { kind }] of declared) {
      const { value } = perturbationFor(leaf, literalIn(tree, leaf));
      const config = withOverlay(reference, { [leaf]: value });
      const own = kind === 'duration' ? () => config.getDuration(leaf) : () => config.getBytes(leaf);
      const shipped = kind === 'duration' ? reference.getDuration(leaf) : reference.getBytes(leaf);
      expect(own(), `${leaf} (${kind}) = ${JSON.stringify(value)} reads as the quantity it ships as`).not.toBe(shipped);
      const others: ReadonlyArray<readonly [string, () => unknown]> = [
        ['getInt', () => config.getInt(leaf)],
        ['getNumber', () => config.getNumber(leaf)],
        // The other quantity, so the unit cannot be one both read (`m`).
        kind === 'duration' ? ['getBytes', () => config.getBytes(leaf)] : ['getDuration', () => config.getDuration(leaf)],
      ];
      for (const [accessor, read] of others) {
        expect(isKindMismatch(refusalOf(read)), `${leaf} (${kind}) = ${JSON.stringify(value)} is taken by ${accessor}`)
          .toBe(true);
      }
    }
  });

  test('an unpublished leaf is introduced at its value, then changed within its kind as a literal would be', () => {
    expect(introductionFor('a.max-retries', 3, 'documented as a template')).toEqual({
      leaf: 'a.max-retries',
      kind: 'integer',
      literal: undefined,
      introducedAs: 3,
      value: 4,
      offKindValues: [4.5],
      reason: 'documented as a template',
    });
    expect(introductionFor('a.min-backoff', '250ms', 'r'))
      .toMatchObject({ kind: 'duration', introducedAs: '250ms', value: '251ms', offKindValues: ['251KiB'] });
    expect(introductionFor('a.quotas', { 'rsp:': 7000 }, 'r'))
      .toMatchObject({ kind: 'object', introducedAs: { 'rsp:': 7000 }, value: { 'rsp:': 7001 } });
  });

  test('an unpublished leaf\'s override replaces the inferred second value, and its kind is the override\'s', () => {
    // A `*-file` leaf the reader opens: the first value suffixed is a path to
    // nothing, which is refused, so the second value is another real file.
    const certFile = introductionFor('a.cert-file', '/tls/a.pem', 'comment-only', {
      value: '/tls/b.pem',
      reason: 'a path to nothing is refused, so another fixture',
    });
    expect(certFile).toMatchObject({ kind: 'text', introducedAs: '/tls/a.pem', value: '/tls/b.pem' });
    expect(certFile.reason).toMatch(/another fixture/);
    const count = introductionFor('a.count', 'auto', 'comment-only', { value: 3, reason: 'the count arm of auto-or-a-count' });
    expect(count).toMatchObject({ kind: 'integer', introducedAs: 'auto', value: 3, offKindValues: [3.5] });
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

  test('a fraction read with getBytes or getDuration is a read, and an off-kind acceptance', () => {
    // Both getters take a bare fraction, so both answer to the in-kind value
    // and only an off-kind value can tell them from `getNumber`.  With the
    // duration as its one off-kind value, `getBytes` refused it as readily as
    // `getNumber` does, and a reader of a fraction as a size passed (#1425).
    const factor = (read: (config: Config) => number): ConfigProbe['read'] =>
      (config) => ({ factor: config.hasPath('a.factor') ? read(config) : undefined });
    const observe = (read: (config: Config) => number) =>
      observeLeaf(introductionFor('a.factor', 0.5, 'a fraction'), [baselineOf({ label: 'probe', read: factor(read) }, reference)]);
    const asSize = observe((config) => config.getBytes('a.factor'));
    expect(asSize.observedBy).toEqual(['probe']);
    expect(asSize.offKindAcceptedBy).toEqual(['probe']);
    const asDuration = observe((config) => config.getDuration('a.factor'));
    expect(asDuration.observedBy).toEqual(['probe']);
    expect(asDuration.offKindAcceptedBy).toEqual(['probe']);
    const asNumber = observe((config) => config.getNumber('a.factor'));
    expect(asNumber.observedBy).toEqual(['probe']);
    expect(asNumber.offKindAcceptedBy).toEqual([]);
  });

  test('an object read with getObject answers to the object introduced, and refuses the off-kind word', () => {
    const quotas = observeLeaf(introductionFor('a.quotas', { 'rsp:': 7000 }, 'comment-only'), [
      baselineOf({
        label: 'probe',
        read: (config) => ({ quotas: config.hasPath('a.quotas') ? config.getObject('a.quotas') : undefined }),
      }, reference),
    ]);
    expect(quotas.observedBy).toEqual(['probe']);
    expect(quotas.kindMismatches).toEqual([]);
    expect(quotas.offKindAcceptedBy).toEqual([]);
  });

  test('an unpublished key read only for its presence is not a read', () => {
    // `if (hasPath(key)) out.x = 10` answers differently with the key absent
    // and present, and reads nothing: introduced at one value and changed to
    // another, it answers the same.  Nor does it take the off-kind value as a
    // read, since it answers that the same way too.
    const presenceOnly = (config: Config) => (config.hasPath('a.max-connections') ? { maxConnections: 10 } : {});
    const presence = observeLeaf(introductionFor('a.max-connections', 10, 'comment-only'), [
      baselineOf({ label: 'probe', read: presenceOnly }, reference),
    ]);
    expect(presence.observedBy).toEqual([]);
    expect(presence.offKindAcceptedBy).toEqual([]);

    const valueRead = (config: Config) =>
      (config.hasPath('a.max-connections') ? { maxConnections: config.getInt('a.max-connections') } : {});
    const read = observeLeaf(introductionFor('a.max-connections', 10, 'comment-only'), [
      baselineOf({ label: 'probe', read: valueRead }, reference),
    ]);
    expect(read.observedBy).toEqual(['probe']);
  });

  test('a leaf that starts empty is read only by a probe that tells two non-empty values apart', () => {
    // From "" to "perturbed" a reader that keeps only whether the value is
    // empty — a host name answered as 'localhost' whenever one is given —
    // answers differently as surely as one that keeps the value (#1425).
    const emptinessOnly = (config: Config) => ({ name: config.getString('a.name') === '' ? undefined : 'localhost' });
    expect(verdict('a.name', '', emptinessOnly).observedBy).toEqual([]);
    const valueKept = (config: Config) => ({ name: config.getString('a.name') || undefined });
    expect(verdict('a.name', '', valueKept).observedBy).toEqual(['probe']);
    // Nor by one that keeps only the length, as a redaction that masks each
    // character does: the two values are as long as each other.
    const lengthOnly = (config: Config) => ({ masked: '*'.repeat(config.getString('a.name').length) });
    expect(verdict('a.name', '', lengthOnly).observedBy).toEqual([]);

    // The same holds for a key introduced empty.
    const labelSet = (config: Config) =>
      (config.hasPath('a.label') && config.getString('a.label') !== '' ? { label: 'set' } : {});
    const introduced = observeLeaf(introductionFor('a.label', '', 'comment-only'), [
      baselineOf({ label: 'probe', read: labelSet }, reference),
    ]);
    expect(introduced.observedBy).toEqual([]);
  });

  test('nor is a block built whenever it exists, whatever becomes of the key', () => {
    // Introducing a key in a block the config lacks creates the block, so this
    // reader answered the block appearing rather than the topic.
    const buildsWill = (config: Config) => (config.hasPath('b.will') ? { will: { topic: '' } } : {});
    const will = observeLeaf(introductionFor('b.will.topic', 'devices/42/status', 'comment-only'), [
      baselineOf({ label: 'probe', read: buildsWill }, reference),
    ]);
    expect(will.observedBy).toEqual([]);
  });

  test('the introduced value refused as the wrong kind fails the leaf, as the changed one would', () => {
    // Skipped like a probe whose reference baseline threw, it would pass a
    // getInt over a duration-valued key unremarked.
    const window = observeLeaf(introductionFor('a.window', '5s', 'comment-only'), [
      baselineOf({
        label: 'probe',
        read: (config) => (config.hasPath('a.window') ? { window: config.getInt('a.window') } : {}),
      }, reference),
    ]);
    expect(window.kindMismatches).toEqual(['probe: Config at "a.window" is not a number (got string)']);
    expect(window.observedBy).toEqual([]);
  });

  test('a getter refusing the block above the leaf refuses the block\'s shape, not the leaf\'s kind', () => {
    // A union read through its string arm whenever the block has no `kind`:
    // any key introduced into the block makes it an object the getter
    // refuses, whatever key it is, so the refusal says nothing about the key.
    const union = (config: Config) => {
      if (config.hasPath('c.policy.kind')) return { policy: config.getString('c.policy.kind') };
      return config.hasPath('c.policy') ? { policy: config.getString('c.policy') } : {};
    };
    const beside = observeLeaf(introductionFor('c.policy.start-seq', 5, 'comment-only'), [
      baselineOf({ label: 'probe', read: union }, reference),
    ]);
    expect(beside.kindMismatches).toEqual([]);
    expect(beside.refusedBy).toEqual(['probe: Config at "c.policy" is not a string (got object)']);

    // The leaf's own path refused stays the leaf's kind mismatch — and so does
    // a read through a sub-config, which names the leaf relative to its block.
    const own = observeLeaf(introductionFor('c.policy', { kind: 'by-start-sequence' }, 'comment-only'), [
      baselineOf({ label: 'probe', read: (config) => (config.hasPath('c.policy') ? config.getString('c.policy') : '') }, reference),
    ]);
    expect(own.kindMismatches).toEqual(['probe: Config at "c.policy" is not a string (got object)']);
    const relative = observeLeaf(introductionFor('c.phase.timeout', 5, 'comment-only'), [
      baselineOf({
        label: 'probe',
        read: (config) => (config.hasPath('c.phase') ? config.getConfig('c.phase').getBoolean('timeout') : null),
      }, reference),
    ]);
    expect(relative.kindMismatches).toEqual(['probe: Config at "timeout" is not a boolean (got number)']);
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
