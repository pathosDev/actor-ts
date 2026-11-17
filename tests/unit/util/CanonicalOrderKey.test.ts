/**
 * `canonicalOrderKey` is the last key of the last-writer-wins tie-break in
 * `LWWRegister.merge` and `LastWriterWinsResolver.resolve` (#950, #1841).  A
 * merge is commutative on a full tie exactly when two values share a key only
 * if they are interchangeable, so the two halves pinned here are injectivity
 * over distinct values and a tie over structurally equal ones — plus totality,
 * because a throw would fail a gossip round or a replay fold.
 */
import { describe, expect, test } from 'bun:test';
import { canonicalOrderKey } from '../../../src/util/CanonicalOrderKey.js';

class Point {
  constructor(readonly x: number) {}
}

const cycleOnSelf: { self?: unknown } = {};
cycleOnSelf.self = cycleOnSelf;
const cycleThroughChild: { child?: { parent?: unknown } } = {};
cycleThroughChild.child = { parent: cycleThroughChild };
const cycleInArray: unknown[] = [];
cycleInArray.push(cycleInArray);

/** Values that must all key apart — every pair a lossy key has confused, and their neighbours. */
const distinctValues: ReadonlyArray<readonly [string, unknown]> = [
  ['undefined', undefined],
  ['null', null],
  ['true', true],
  ['false', false],
  ['the string "true"', 'true'],
  ['the string "null"', 'null'],
  ['the empty string', ''],
  ['0', 0],
  ['-0', -0],
  ['1', 1],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['the string "1"', '1'],
  ['1n', 1n],
  ['the string "1n"', '1n'],
  ['-1n', -1n],
  ['a function', () => 1],
  ['another function', () => 2],
  ['a symbol', Symbol('s')],
  ['the string "s"', 's'],
  ['an empty object', {}],
  ['an empty array', []],
  ['an object with an undefined field', { v: undefined }],
  ['an object with a null field', { v: null }],
  ['{ v: 1 }', { v: 1 }],
  ['{ v: 2 }', { v: 2 }],
  ['{ v: 1n }', { v: 1n }],
  ['{ v: "1n" }', { v: '1n' }],
  ['{ w: 1 }', { w: 1 }],
  ['{ v: 1, w: 1 }', { v: 1, w: 1 }],
  ['[1]', [1]],
  ['[1, 1]', [1, 1]],
  ['["1"]', ['1']],
  ['[[1]]', [[1]]],
  ['["a,b"]', ['a,b']],
  ['["a", "b"]', ['a', 'b']],
  ['a Point', new Point(1)],
  ['a plain object shaped like a Point', { x: 1 }],
  ['a Date', new Date(0)],
  ['an empty Map', new Map()],
  ['a Map', new Map([[1, 'a']])],
  ['an empty Set', new Set()],
  ['a Set', new Set([1])],
  ['a Uint8Array', new Uint8Array([1, 2])],
  ['an Int8Array with the same bytes', new Int8Array([1, 2])],
  ['a cycle on itself', cycleOnSelf],
  ['a cycle through a child', cycleThroughChild],
  ['a cycle in an array', cycleInArray],
];

describe('canonicalOrderKey', () => {
  test('keys every distinct value apart', () => {
    const owners = new Map<string, string>();
    for (const [label, value] of distinctValues) {
      const key = canonicalOrderKey(value);
      expect({ label, sharesKeyWith: owners.get(key) }).toEqual({ label, sharesKeyWith: undefined });
      owners.set(key, label);
    }
  });

  test('ties structurally equal values, whatever order their parts were built in', () => {
    expect(canonicalOrderKey({ a: 1, b: [2n, 'x'] })).toBe(canonicalOrderKey({ b: [2n, 'x'], a: 1 }));
    expect(canonicalOrderKey(new Map([[1, 'a'], [2, 'b']]))).toBe(canonicalOrderKey(new Map([[2, 'b'], [1, 'a']])));
    expect(canonicalOrderKey(new Set([1, 2]))).toBe(canonicalOrderKey(new Set([2, 1])));
    expect(canonicalOrderKey(new Date(5))).toBe(canonicalOrderKey(new Date(5)));
    expect(canonicalOrderKey(new Point(3))).toBe(canonicalOrderKey(new Point(3)));
    // A prototype-less object is a plain record to every decoder.
    expect(canonicalOrderKey(Object.assign(Object.create(null) as object, { v: 1 }))).toBe(canonicalOrderKey({ v: 1 }));
    const otherCycle: { self?: unknown } = {};
    otherCycle.self = otherCycle;
    expect(canonicalOrderKey(otherCycle)).toBe(canonicalOrderKey(cycleOnSelf));
  });

  test('encodes a shared, non-cyclic reference in full at each place it appears', () => {
    const shared = { v: 1 };
    expect(canonicalOrderKey([shared, shared])).toBe(canonicalOrderKey([{ v: 1 }, { v: 1 }]));
  });

  test('never throws: a throwing getter and a refusing Proxy still key', () => {
    const throwingGetter = Object.defineProperty({}, 'boom', {
      enumerable: true,
      get(): never { throw new Error('getter'); },
    });
    const refusingProxy = new Proxy({}, { ownKeys(): never { throw new Error('ownKeys'); } });
    expect(() => canonicalOrderKey(throwingGetter)).not.toThrow();
    expect(() => canonicalOrderKey(refusingProxy)).not.toThrow();
    expect(() => canonicalOrderKey([throwingGetter, refusingProxy])).not.toThrow();
    // A key, not merely no throw: `undefined > undefined` is false both ways,
    // which is the order-dependence a key exists to remove.
    expect(typeof canonicalOrderKey(throwingGetter)).toBe('string');
    expect(typeof canonicalOrderKey(refusingProxy)).toBe('string');
  });

  test('keys binary views by their bytes, including a view with no indexed fields', () => {
    // A `DataView` has no own keys, so a field walk would tie every one of them.
    const first = new DataView(new Uint8Array([1, 2]).buffer);
    const second = new DataView(new Uint8Array([1, 3]).buffer);
    expect(canonicalOrderKey(first)).not.toBe(canonicalOrderKey(second));
    expect(canonicalOrderKey(first)).toBe(canonicalOrderKey(new DataView(new Uint8Array([1, 2]).buffer)));
  });

  test('a key never depends on which value it is compared against', () => {
    // The tie-break compares two keys with `>`; that is a total order only if
    // each key is a pure function of its own value.
    for (const [, value] of distinctValues) {
      expect(canonicalOrderKey(value)).toBe(canonicalOrderKey(value));
    }
  });
});
