import { describe, expect, test } from 'bun:test';
import { changedOnly, diffStates } from '../src/panels/timetravel/stateDiff.js';

describe('diffStates', () => {
  test('reports a changed leaf with both values', () => {
    const entries = diffStates({ total: 10 }, { total: 30 });
    expect(entries).toEqual([{ path: 'total', kind: 'changed', before: 10, after: 30 }]);
  });

  test('reports an added and a removed key', () => {
    const entries = diffStates({ a: 1 }, { b: 2 });
    expect(entries).toEqual([
      { path: 'a', kind: 'removed', before: 1, after: undefined },
      { path: 'b', kind: 'added', before: undefined, after: 2 },
    ]);
  });

  test('keeps unchanged leaves, so "nothing changed here" is visible', () => {
    const entries = diffStates({ a: 1, b: 2 }, { a: 1, b: 3 });
    expect(entries.map((e) => [e.path, e.kind])).toEqual([['a', 'unchanged'], ['b', 'changed']]);
    expect(changedOnly(entries).map((e) => e.path)).toEqual(['b']);
  });

  test('walks nested objects and reports dotted paths', () => {
    const entries = changedOnly(diffStates(
      { user: { name: 'ada', age: 36 } },
      { user: { name: 'ada', age: 37 } },
    ));
    expect(entries).toEqual([
      { path: 'user.age', kind: 'changed', before: 36, after: 37 },
    ]);
  });

  test('walks arrays by index', () => {
    const entries = changedOnly(diffStates({ items: ['a', 'b'] }, { items: ['a', 'c'] }));
    expect(entries.map((e) => e.path)).toEqual(['items.1']);
  });

  test('a longer array reports the new entries as additions', () => {
    const entries = changedOnly(diffStates({ items: ['a'] }, { items: ['a', 'b'] }));
    expect(entries).toEqual([
      { path: 'items.1', kind: 'added', before: undefined, after: 'b' },
    ]);
  });

  test('treats null as a scalar, so null → object is one change', () => {
    // Walking into null would report a pile of phantom additions.
    const entries = changedOnly(diffStates({ x: null }, { x: { a: 1 } }));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe('x');
    expect(entries[0]!.kind).toBe('changed');
  });

  test('compares a scalar root without a path', () => {
    expect(diffStates(1, 2)).toEqual([{ path: '', kind: 'changed', before: 1, after: 2 }]);
  });

  test('identical states produce no changes', () => {
    const state = { a: 1, b: { c: [1, 2, 3] } };
    expect(changedOnly(diffStates(state, structuredClone(state)))).toEqual([]);
  });

  test('a type change at a leaf is one change, not a walk', () => {
    const entries = changedOnly(diffStates({ x: 1 }, { x: 'one' }));
    expect(entries).toEqual([{ path: 'x', kind: 'changed', before: 1, after: 'one' }]);
  });

  test('handles an empty object on either side', () => {
    expect(changedOnly(diffStates({}, { a: 1 })).map((e) => e.kind)).toEqual(['added']);
    expect(changedOnly(diffStates({ a: 1 }, {})).map((e) => e.kind)).toEqual(['removed']);
    expect(diffStates({}, {})).toEqual([]);
  });
});
