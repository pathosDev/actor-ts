import { describe, expect, test } from 'bun:test';
import {
  BidirectionalMap,
  BidirectionalMultiMap,
  lazyImportModule,
  randomHex,
  randomId,
  randomString,
  safeStringify,
} from '../../src/index.js';
import type {
  BidirectionalMapJson,
  BidirectionalMultiMapJson,
  LazyImportOptions,
  RandomStringOptions,
} from '../../src/index.js';

/**
 * The util helpers are part of the published surface (#1034), and that surface
 * is exactly what the barrels emit: `package.json` ships only `dist/` and its
 * `exports` map has no wildcard, so a name `src/index.ts` drops is a name that
 * left the package.  Every other test of these modules imports them by deep
 * relative path (`tests/unit/util/RandomString.test.ts` and its siblings) and
 * so keeps passing whatever the barrel says — this file is the only one that
 * reads them the way a consumer has to.
 *
 * Assertions are behavioural rather than `typeof === 'function'`: a re-export
 * wired to the wrong module would satisfy the weaker check.  Depth belongs to
 * the per-module tests; one round-trip each is enough to prove the name
 * resolves to the implementation it claims.
 */
describe('util helpers are reachable from the barrel (#1034)', () => {
  describe('RandomString', () => {
    test('randomHex draws from the hex alphabet at the exact length', () => {
      expect(randomHex(16)).toMatch(/^[0-9a-f]{16}$/);
    });

    test('randomId is hex too — the distinction is intent, not alphabet', () => {
      expect(randomId(12)).toMatch(/^[0-9a-f]{12}$/);
    });

    test('randomString honours the character-class options', () => {
      const lowercaseOnly: RandomStringOptions = { upperCase: false, digits: false };
      expect(randomString(32, lowercaseOnly)).toMatch(/^[a-z]{32}$/);
      expect(randomString(24)).toMatch(/^[A-Za-z0-9]{24}$/);
    });

    test('two draws differ — the export is not a constant behind a random name', () => {
      expect(randomHex(32)).not.toBe(randomHex(32));
    });
  });

  describe('SafeStringify', () => {
    test('a cycle collapses to a marker instead of throwing', () => {
      const cyclic: { name: string; self?: unknown } = { name: 'loop' };
      cyclic.self = cyclic;
      const rendered = safeStringify(cyclic);
      expect(rendered).toContain('[Circular]');
      expect(rendered).toContain('loop');
      // The point of the helper: `JSON.stringify` on the same value does not
      // return at all, it throws — and would do so from inside whatever error
      // path built the message.
      expect(() => JSON.stringify(cyclic)).toThrow();
    });

    test('the length cap applies', () => {
      expect(safeStringify('x'.repeat(500), 64)).toContain('[truncated');
    });
  });

  describe('LazyImport', () => {
    test('a missing package rejects with the package name and an install command', async () => {
      const options: LazyImportOptions = { context: 'MyBrokerActor' };
      const attempt = lazyImportModule('actor-ts-no-such-peer-dependency', options);
      await expect(attempt).rejects.toThrow(
        /MyBrokerActor requires the 'actor-ts-no-such-peer-dependency' package/,
      );
      await expect(attempt).rejects.toThrow(
        /npm install actor-ts-no-such-peer-dependency/,
      );
    });

    test('installHint overrides the suggested command', async () => {
      await expect(
        lazyImportModule('actor-ts-no-such-peer-dependency', { installHint: 'bun add whatever' }),
      ).rejects.toThrow(/bun add whatever/);
    });

    test('a module that does exist resolves to it', async () => {
      const nodePath = await lazyImportModule<typeof import('node:path')>('node:path');
      expect(nodePath.join('a', 'b')).toBe(['a', 'b'].join(nodePath.sep));
    });
  });
});

describe('BidirectionalMap is reachable from the barrel (#1035)', () => {
  test('the export is the class, not a look-alike', () => {
    const map = new BidirectionalMap([['a', 1]]);
    expect(map).toBeInstanceOf(BidirectionalMap);
    expect(map.getKey(1)).toBe('a');
  });

  test('the JSON type is exported alongside it', () => {
    const wire: BidirectionalMapJson<string, number> = new BidirectionalMap([['a', 1]]).toJSON();
    expect(BidirectionalMap.fromJSON(wire).get('a')).toBe(1);
  });
});

describe('BidirectionalMultiMap is reachable from the barrel (#1037)', () => {
  test('the export is the class, not a look-alike', () => {
    const map = new BidirectionalMultiMap([['news', 'ada'], ['sport', 'ada']]);
    expect(map).toBeInstanceOf(BidirectionalMultiMap);
    expect([...map.getKeys('ada')]).toEqual(['news', 'sport']);
  });

  test('the JSON type is exported alongside it', () => {
    const wire: BidirectionalMultiMapJson<string, string> =
      new BidirectionalMultiMap([['news', 'ada']]).toJSON();
    expect(BidirectionalMultiMap.fromJSON(wire).has('news', 'ada')).toBe(true);
  });
});
