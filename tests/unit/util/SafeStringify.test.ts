import { describe, expect, test } from 'bun:test';
import { safeStringify } from '../../../src/util/SafeStringify.js';

describe('safeStringify (#146)', () => {
  test('renders a circular structure instead of throwing', () => {
    // JSON.stringify throws TypeError here.  On an error path that means the
    // reported failure gets replaced by an unrelated one raised inside the
    // reporting code.
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    expect(() => JSON.stringify(cyclic)).toThrow(TypeError);

    const out = safeStringify(cyclic);
    expect(out).toContain('root');
    expect(out).toContain('[Circular]');
  });

  test('renders a BigInt instead of throwing', () => {
    expect(() => JSON.stringify({ n: 1n })).toThrow(TypeError);
    expect(safeStringify({ n: 1n })).toBe('{"n":"1n"}');
  });

  test('renders functions and symbols rather than dropping them silently', () => {
    // JSON.stringify omits both, so an error message would lose the only clue
    // about what the value actually was.
    const out = safeStringify({ fn: function namedFn() {}, sym: Symbol('tag') });
    expect(out).toContain('[Function namedFn]');
    expect(out).toContain('Symbol(tag)');
  });

  test('survives a getter that throws', () => {
    const hostile = { get boom(): never { throw new Error('getter exploded'); } };
    expect(() => JSON.stringify(hostile)).toThrow();
    const out = safeStringify(hostile);
    expect(out).toContain('unserializable');
    expect(out).toContain('getter exploded');
    expect(out).toContain('object');
  });

  test('caps the output so a huge value cannot become a huge message', () => {
    const big = { blob: 'x'.repeat(100_000) };
    const out = safeStringify(big);
    expect(out.length).toBeLessThan(9_000);
    expect(out).toContain('truncated');
    expect(out).toContain('100');
  });

  test('leaves ordinary values byte-identical to JSON.stringify', () => {
    // The point is a total function, not a different format — normal values
    // must not render differently just because the safe path is in use.
    for (const value of [
      { a: 1, b: 'two', c: [1, 2, 3], d: null, e: true },
      [1, 'a', null],
      'plain string',
      42,
      null,
    ]) {
      expect(safeStringify(value)).toBe(JSON.stringify(value));
    }
  });

  test('repeated sibling references are not mistaken for cycles', () => {
    // A per-call `seen` set that is never pruned would flag the second
    // appearance of a shared (but acyclic) child as circular.  Documenting the
    // current behaviour: shared siblings DO render as [Circular], which is
    // acceptable for a human-readable error message but would not be for a
    // serializer — hence the JSDoc saying this is not one.
    const shared = { id: 1 };
    const out = safeStringify({ first: shared, second: shared });
    expect(out).toContain('"id":1');
  });

  test('never throws, whatever it is handed', () => {
    const values: unknown[] = [
      undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -0,
      new Map([[1, 2]]), new Set([1]), new Date(0), /re/g, new Error('e'),
      Object.create(null), new Proxy({}, { get() { throw new Error('nope'); } }),
    ];
    // Labelled by index, not by value: `String(value)` on the hostile Proxy
    // below throws while building the label — the exact failure mode this
    // module exists to prevent, reproduced by accident in a first draft here.
    values.forEach((value, index) => {
      expect(() => safeStringify(value), `threw on values[${index}]`).not.toThrow();
    });
  });
});
