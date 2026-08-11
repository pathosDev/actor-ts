/**
 * The two pure pieces behind cursor-paginated persistence-id queries (#156):
 * `persistenceIdPage`, which defines what "one ascending page after a cursor"
 * means for every backend, and `resolvePageSize`, which is the guard between a
 * caller's number and a row cap that reaches SQL as literal text.
 *
 * Both are unit-testable without a journal, and both are where a subtle error
 * would be invisible at the integration level: an off-by-one in the cursor
 * only shows up as one id missing out of thousands.
 */
import { describe, expect, test } from 'bun:test';
import { persistenceIdPage } from '../../../src/persistence/Journal.js';
import {
  defaultPersistenceIdPageSize,
  resolvePageSize,
} from '../../../src/persistence/query/PersistenceQuery.js';

describe('persistenceIdPage', () => {
  test('sorts ascending regardless of the order the journal enumerated in', () => {
    expect(persistenceIdPage(['c', 'a', 'b'], undefined, 10)).toEqual(['a', 'b', 'c']);
  });

  test('caps the page at the limit', () => {
    expect(persistenceIdPage(['a', 'b', 'c', 'd'], undefined, 2)).toEqual(['a', 'b']);
  });

  test('the cursor is exclusive — the id it names is not repeated', () => {
    expect(persistenceIdPage(['a', 'b', 'c'], 'a', 10)).toEqual(['b', 'c']);
  });

  test('a cursor that is not itself an id still splits the range', () => {
    // The resume value may name an id that has since been compacted away, or
    // one the caller derived rather than read.  Only the ordering matters.
    expect(persistenceIdPage(['a', 'c', 'e'], 'b', 10)).toEqual(['c', 'e']);
  });

  test('a cursor at or past the last id yields an empty page', () => {
    expect(persistenceIdPage(['a', 'b'], 'b', 10)).toEqual([]);
    expect(persistenceIdPage(['a', 'b'], 'z', 10)).toEqual([]);
  });

  test('an empty journal yields an empty page', () => {
    expect(persistenceIdPage([], undefined, 10)).toEqual([]);
  });

  test('duplicates collapse — "each id once per sweep" holds even for a repeating enumeration', () => {
    expect(persistenceIdPage(['b', 'a', 'b', 'a'], undefined, 10)).toEqual(['a', 'b']);
  });

  test('walking page by page visits every id exactly once', () => {
    const all = ['account-1', 'account-2', 'order-9', 'order-10', 'user-x'];
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = persistenceIdPage(all, cursor, 2);
      seen.push(...page);
      if (page.length < 2) break;
      cursor = page[page.length - 1];
    }
    // Sorted, so 'order-10' precedes 'order-9' — lexicographic, not numeric.
    expect(seen).toEqual(['account-1', 'account-2', 'order-10', 'order-9', 'user-x']);
  });
});

describe('resolvePageSize', () => {
  test('unset falls back to the documented default', () => {
    expect(resolvePageSize(undefined)).toBe(defaultPersistenceIdPageSize);
  });

  test('a fractional size is floored — the count reaches SQL as literal text', () => {
    expect(resolvePageSize(10.9)).toBe(10);
  });

  test('zero and negatives floor to 1 rather than producing a non-terminating walk', () => {
    expect(resolvePageSize(0)).toBe(1);
    expect(resolvePageSize(-5)).toBe(1);
  });

  test('Infinity and NaN fall back to the default instead of reaching the statement', () => {
    // The original design sketch suggested `batchSize: Infinity` as a way to
    // ask for "no pagination"; that would render as `LIMIT Infinity`.
    expect(resolvePageSize(Number.POSITIVE_INFINITY)).toBe(defaultPersistenceIdPageSize);
    expect(resolvePageSize(Number.NaN)).toBe(defaultPersistenceIdPageSize);
  });

  test('an ordinary size passes through', () => {
    expect(resolvePageSize(32)).toBe(32);
  });
});
