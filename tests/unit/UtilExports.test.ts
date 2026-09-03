import { describe, expect, test } from 'bun:test';
import {
  BidirectionalMap,
  BidirectionalMultiMap,
  lazyImportModule,
  randomHex,
  randomId,
  randomString,
  randomUuid,
  redactUrlCredentials,
  redactedUrlLabel,
  safeStringify,
} from '../../src/index.js';
import type {
  BidirectionalMapJson,
  BidirectionalMultiMapJson,
  ExistsPredicate,
  LazyImportOptions,
  RandomStringOptions,
} from '../../src/index.js';
import {
  DEFAULT_ASK_TIMEOUT_MS,
  PATH_TRAVERSAL_SEGMENTS,
  SafeHtml,
  TokenBucket,
  addressMatchesPins,
  addressPinRejection,
  cidrMatches,
  escapeHtml,
  html,
  isCidrEntry,
  mergeOptions,
  parseAddressPin,
  parseCidr,
  rawHtml,
  stripSurrounding,
  stripTrailing,
  stripUndefined,
  wrapError,
} from '../../src/util/index.js';
import type { AddressPin, ParsedCidr, TokenBucketOptions } from '../../src/util/index.js';

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

    test('randomUuid is a v4 UUID, not a dashed hex string (#1109)', () => {
      expect(randomUuid()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    test('randomString honours the character-class options', () => {
      const lowercaseOnly: RandomStringOptions = { upperCase: false, digits: false };
      expect(randomString(32, lowercaseOnly)).toMatch(/^[a-z]{32}$/);
      expect(randomString(24)).toMatch(/^[A-Za-z0-9]{24}$/);
    });

    test('two draws differ — the export is not a constant behind a random name', () => {
      expect(randomHex(32)).not.toBe(randomHex(32));
    });

    test('the collision predicate is honoured through the barrel (#1141)', () => {
      // The named annotation is the point: `ExistsPredicate` has to be exported
      // as a *type* for a consumer to write this line at all, and a barrel that
      // shipped the functions without it would still pass an inline arrow.
      const taken = new Set('012345678'.split(''));
      const exists: ExistsPredicate = (candidate) => taken.has(candidate);
      expect(randomString(1, { lowerCase: false, upperCase: false }, exists)).toBe('9');
    });

    test('randomUuid takes the predicate in its only slot', () => {
      const seen: string[] = [];
      const value = randomUuid((candidate) => {
        seen.push(candidate);
        return seen.length === 1;
      });
      expect(seen).toHaveLength(2);
      expect(value).toBe(seen[1]);
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

  describe('RedactUrlCredentials (#590, #592)', () => {
    test('redactUrlCredentials masks the userinfo and touches nothing else', () => {
      expect(redactUrlCredentials('amqp://user:pass@rabbit:5672/vhost'))
        .toBe('amqp://***@rabbit:5672/vhost');
      expect(redactUrlCredentials('not a url')).toBe('not a url');
    });

    test('redactedUrlLabel drops the query as well as the userinfo', () => {
      expect(redactedUrlLabel('wss://user:pass@example.com/ws/orders?token=abc'))
        .toBe('wss://example.com/ws/orders');
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
    // The 1:1 counts reach the barrel too (#1199) — always equal to `size`.
    expect(map.keySize).toBe(1);
    expect(map.valueSize).toBe(1);
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
    // The participant counts reach the barrel too (#1199), and here they differ
    // from the pair count and from each other: two pairs, two lefts, one right.
    expect(map.size).toBe(2);
    expect(map.leftSize).toBe(2);
    expect(map.rightSize).toBe(1);
  });

  test('the JSON type is exported alongside it', () => {
    const wire: BidirectionalMultiMapJson<string, string> =
      new BidirectionalMultiMap([['news', 'ada']]).toJSON();
    expect(BidirectionalMultiMap.fromJSON(wire).has('news', 'ada')).toBe(true);
  });
});

/**
 * The other half of the same surface (#1404).  The names imported from the
 * root above are the ones `src/index.ts` lists, added one at a time by #1034,
 * #1035, #1037, #1141 and #1199; the ones below are the rest of the directory,
 * reachable only through the `actor-ts/util` subpath the barrel now publishes.
 * Imported from `src/util/index.js` for that reason: it is the only door, so
 * it is the only import form that proves the door opens.
 *
 * `tests/unit/ExportSurface.test.ts` asserts the barrel is *complete* — every
 * value any module in the directory exports, derived from the tree rather than
 * listed.  What is here instead is the part a derived check cannot do: that a
 * name resolves to the implementation it claims, and that the types are
 * exported as types (each is written as an annotation, the only form that
 * fails to compile when the type export is missing).
 */
describe('the rest of the util toolbox is reachable on actor-ts/util (#1404)', () => {
  describe('OptionsMerge', () => {
    test('undefined on a higher layer falls through instead of shadowing', () => {
      type Settings = { retries: number; label: string };
      // The rule AGENTS.md documents by this function's name, and the whole
      // reason a consumer writing an options family needs the function rather
      // than a spread: an explicit object carrying a field it never assigned
      // must not blank out the config underneath it.
      const merged = mergeOptions<Settings>(
        { retries: 1, label: 'built-in' },
        { retries: 5, label: 'from-hocon' },
        { retries: undefined, label: 'explicit' },
      );
      expect(merged).toEqual({ retries: 5, label: 'explicit' });
    });

    test('stripUndefined removes the key, not just the value', () => {
      // `toEqual` treats a present `undefined` and an absent key as equal, so
      // the assertion has to read the keys — which is also the property the
      // merge above depends on.
      expect(Object.keys(stripUndefined({ retries: 1, label: undefined }))).toEqual(['retries']);
    });
  });

  describe('WrapError', () => {
    class CacheError extends Error {
      constructor(message: string, cause?: unknown) {
        super(message, { cause });
      }
    }

    test('a foreign error is wrapped in the target class, carrying the cause', () => {
      const original = new Error('ECONNREFUSED');
      const wrapped = wrapError(original, CacheError, 'RedisCache.get failed');
      expect(wrapped).toBeInstanceOf(CacheError);
      expect(wrapped.message).toBe('RedisCache.get failed');
      expect(wrapped.cause).toBe(original);
    });

    test('an error already of the target class is returned as-is', () => {
      // Not re-wrapped: the helper is called at every layer of a call chain,
      // and a message stack N deep would say nothing the first one did not.
      const already = new CacheError('boom');
      expect(wrapError(already, CacheError, 'ignored')).toBe(already);
    });
  });

  describe('TokenBucket', () => {
    test('burst is spent, then refilled from the injected clock', () => {
      let clock = 0;
      const options: TokenBucketOptions = { qps: 2, burst: 2, now: () => clock };
      const bucket = new TokenBucket(options);

      expect(bucket.tryConsume()).toBe(true);
      expect(bucket.tryConsume()).toBe(true);
      expect(bucket.tryConsume()).toBe(false);

      // One second at 2 qps refills the whole bucket.  The clock is injected
      // rather than waited on, which is the property that makes the class
      // usable in a consumer's own tests too.
      clock = 1_000;
      expect(bucket.tryConsume(2)).toBe(true);
      expect(bucket.tryConsume()).toBe(false);
    });
  });

  describe('Html', () => {
    test('escapeHtml neutralises element content', () => {
      expect(escapeHtml('<script>alert(1)</script>')).toBe(
        '&lt;script&gt;alert(1)&lt;/script&gt;',
      );
    });

    test('the html tag escapes interpolations and brands the result', () => {
      const userName = '<script>';
      const rendered: SafeHtml = html`<li>${userName}</li>`;
      expect(rendered).toBeInstanceOf(SafeHtml);
      expect(rendered.toString()).toBe('<li>&lt;script&gt;</li>');
    });

    test('rawHtml interpolates verbatim, and nests inside the tag', () => {
      const trusted = rawHtml('<b>ok</b>');
      expect(html`<p>${trusted}</p>`.value).toBe('<p><b>ok</b></p>');
    });
  });

  describe('StripCharacters', () => {
    test('a run is stripped from the end, and only from the end', () => {
      expect(stripTrailing('/orders///', '/')).toBe('/orders');
      expect(stripSurrounding('///orders///', '/')).toBe('orders');
    });

    test('nothing to strip returns the argument itself', () => {
      // The allocation-free common case the module header promises; `toBe` is
      // the assertion that can tell the difference.
      const untouched = '/orders';
      expect(stripTrailing(untouched, '/')).toBe(untouched);
    });
  });

  describe('CidrMatch', () => {
    test('a parsed CIDR matches inside its network and not outside', () => {
      const network: ParsedCidr = parseCidr('10.0.0.0/8', 'UtilExports');
      expect(cidrMatches('10.1.2.3', network)).toBe(true);
      expect(cidrMatches('11.0.0.1', network)).toBe(false);
    });

    test('isCidrEntry is the discriminant between the two pin shapes', () => {
      expect(isCidrEntry('10.0.0.0/8')).toBe(true);
      expect(isCidrEntry('svc.cluster.local')).toBe(false);
    });

    test('a host-suffix pin matches on a label boundary', () => {
      const pins: readonly AddressPin[] = ['10.0.0.0/8', 'svc.cluster.local'].map((entry) =>
        parseAddressPin(entry, 'UtilExports'),
      );
      expect(addressMatchesPins('10.1.2.3', pins)).toBe(true);
      expect(addressMatchesPins('api.svc.cluster.local', pins)).toBe(true);
      // The whole point of the suffix rule: a longer label does not slip past.
      expect(addressMatchesPins('evilsvc.cluster.local', pins)).toBe(false);
    });

    test('addressPinRejection returns the reason clause, or null', () => {
      expect(addressPinRejection('10.0.0.0/8')).toBeNull();
      expect(addressPinRejection('   ')).toBe('entries must be non-empty');
    });
  });

  describe('Constants', () => {
    test('the cross-subsystem defaults are readable rather than restated', () => {
      // Deliberately not pinned to a literal: a test that repeats the number
      // is a second place it lives, and the reason these are exported is that
      // a consumer sizing its own timeout below the ask timeout should read
      // the value rather than copy it.
      expect(DEFAULT_ASK_TIMEOUT_MS).toBeGreaterThan(0);
      expect(Number.isFinite(DEFAULT_ASK_TIMEOUT_MS)).toBe(true);
    });

    test('the traversal denylist is the shared set both validators guard with', () => {
      expect(PATH_TRAVERSAL_SEGMENTS.has('.')).toBe(true);
      expect(PATH_TRAVERSAL_SEGMENTS.has('..')).toBe(true);
      expect(PATH_TRAVERSAL_SEGMENTS.has('orders')).toBe(false);
    });
  });
});
