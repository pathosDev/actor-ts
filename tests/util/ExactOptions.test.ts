import { describe, expect, test } from 'bun:test';
import { expectExactOptions, ownKeyPaths } from './ExactOptions.js';

/**
 * The helper exists because `toEqual` cannot see the one thing a config
 * reader's absence tests are about (#1447, #1450).  So every case here pairs
 * the blind spot with the helper's answer to it: the hole passes `toEqual`, and
 * fails `expectExactOptions`.  A helper that stopped seeing it would turn the
 * suites that call it back into assertions about nothing, silently — this file
 * is the only place that would notice.
 */

/** The shape a reader returns: every field optional, absent unless configured. */
type ReaderResult = {
  gossipIntervalMs?: number;
  maxTopics?: number;
  failureDetector?: { unreachableAfterMs?: number; downAfterMs?: number };
  seeds?: Array<string | undefined>;
  routes?: Array<{ path?: string; method?: string }>;
};

describe('expectExactOptions', () => {
  test('passes when value and own keys agree, whatever order they were written in', () => {
    const read: ReaderResult = { maxTopics: 8, gossipIntervalMs: 250 };

    expectExactOptions(read, { gossipIntervalMs: 250, maxTopics: 8 });
  });

  test('fails on the hole a `hasPath ? read : undefined` reader punches, which toEqual lets through', () => {
    const holed: ReaderResult = { maxTopics: 8, gossipIntervalMs: undefined };

    expect(holed).toEqual({ maxTopics: 8 });
    expect(() => expectExactOptions(holed, { maxTopics: 8 })).toThrow(/own keys differ/);
  });

  test('fails on an absent block that came back as a bag of undefined', () => {
    const holed: ReaderResult = { gossipIntervalMs: undefined, maxTopics: undefined };

    expect(holed).toEqual({});
    expect(() => expectExactOptions(holed, {})).toThrow(/own keys differ/);
  });

  test('fails on a hole inside a nested block, which a top-level key check misses', () => {
    const holed: ReaderResult = { failureDetector: { downAfterMs: 900, unreachableAfterMs: undefined } };

    // Everything short of descending is satisfied: the value, and the top level.
    expect(holed).toEqual({ failureDetector: { downAfterMs: 900 } });
    expect(Object.keys(holed)).toEqual(['failureDetector']);
    expect(() => expectExactOptions(holed, { failureDetector: { downAfterMs: 900 } }))
      .toThrow(/own keys differ/);
  });

  test('fails on a hole inside an object held in a list', () => {
    const holed: ReaderResult = { routes: [{ path: '/a', method: undefined }] };

    expect(holed).toEqual({ routes: [{ path: '/a' }] });
    expect(() => expectExactOptions(holed, { routes: [{ path: '/a' }] })).toThrow(/own keys differ/);
  });

  test('fails on an undefined list item, which bun\'s toEqual lets through as well', () => {
    const holed: ReaderResult = { seeds: ['app@10.0.0.5:2552', undefined] };

    expect(holed).toEqual({ seeds: ['app@10.0.0.5:2552'] });
    expect(() => expectExactOptions(holed, { seeds: ['app@10.0.0.5:2552'] })).toThrow(/own keys differ/);
  });

  test('is exact in both directions: an expected own undefined the result omits fails too', () => {
    const read: ReaderResult = {};

    expect(() => expectExactOptions(read, { gossipIntervalMs: undefined })).toThrow(/own keys differ/);
  });

  test('a wrong value is still reported as one, before any key is compared', () => {
    const read: ReaderResult = { maxTopics: 8 };

    expect(() => expectExactOptions(read, { maxTopics: 9 })).toThrow(/toEqual/);
    expect(() => expectExactOptions(read, { maxTopics: 9 })).not.toThrow(/own keys differ/);
  });

  test('a builder counts by its own fields, so it meets a plain literal', () => {
    // What `toStrictEqual` would refuse on the prototype alone.  A builder IS
    // its options bag (`OptionsBuilder.set` writes own fields; the `withX`
    // methods live on the prototype), so its own keys are the whole question.
    class FieldBag {
      withMaxTopics(maxTopics: number): this {
        (this as ReaderResult).maxTopics = maxTopics;
        return this;
      }
    }

    expectExactOptions<object>(new FieldBag().withMaxTopics(8), { maxTopics: 8 });
    expect(() => expectExactOptions<object>(new FieldBag().withMaxTopics(8), { maxTopics: 8, gossipIntervalMs: undefined }))
      .toThrow(/own keys differ/);
  });

  test('an asymmetric matcher in the expected object is a leaf, not a block to descend into', () => {
    const read = { failureDetector: { unreachableAfterMs: 400, downAfterMs: 900 } };

    expectExactOptions(read, { failureDetector: expect.objectContaining({ downAfterMs: 900 }) });
  });
});

describe('ownKeyPaths', () => {
  test('lists every own key as a sorted path, descending into blocks and lists', () => {
    const value = { seeds: ['a', 'b'], failureDetector: { downAfterMs: 1, unreachableAfterMs: 2 }, maxTopics: 3 };

    expect(ownKeyPaths(value)).toEqual([
      'failureDetector',
      'failureDetector.downAfterMs',
      'failureDetector.unreachableAfterMs',
      'maxTopics',
      'seeds',
      'seeds[0]',
      'seeds[1]',
    ]);
  });

  test('counts an own undefined as the key it is', () => {
    expect(ownKeyPaths({ gossipIntervalMs: undefined })).toEqual(['gossipIntervalMs']);
    expect(ownKeyPaths({})).toEqual([]);
  });

  test('enumerates the top level whatever its prototype, and stops at a class instance below it', () => {
    class Provider {
      readonly role = 'backend';
    }
    class FieldBag {
      downing = new Provider();
      withNothing(): this { return this; }
    }

    // The builder's own field is listed; the provider it holds is a leaf, so
    // its `role` is left to the value comparison rather than walked into.
    expect(ownKeyPaths(new FieldBag())).toEqual(['downing']);
  });
});
