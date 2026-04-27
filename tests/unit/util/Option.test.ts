import { describe, expect, test } from 'bun:test';
import { match, P } from 'ts-pattern';
import {
  None,
  Some,
  firstSome,
  fromNullable,
  fromPredicate,
  none,
  some,
  type Option,
} from '../../../src/util/Option.js';

describe('Option — constructors', () => {
  test('some wraps a value', () => {
    const o = some(42);
    expect(o).toBeInstanceOf(Some);
    expect(o.value).toBe(42);
  });

  test('none is a shared singleton', () => {
    expect(none).toBeInstanceOf(None);
    // Same reference every time.
    expect(none).toBe(none);
  });

  test('fromNullable: null → None, undefined → None, value → Some', () => {
    expect(fromNullable(null)).toBeInstanceOf(None);
    expect(fromNullable(undefined)).toBeInstanceOf(None);
    expect(fromNullable(0)).toBeInstanceOf(Some);
    expect(fromNullable('').isSome()).toBe(true); // empty string still present
    expect(fromNullable(false).isSome()).toBe(true);
  });

  test('fromPredicate returns Some only if predicate holds', () => {
    expect(fromPredicate(5, (n) => n > 0).isSome()).toBe(true);
    expect(fromPredicate(-1, (n) => n > 0).isNone()).toBe(true);
  });

  test('firstSome picks the first present option', () => {
    expect(firstSome(none, none, some(3), some(4))).toBeInstanceOf(Some);
    expect(firstSome<number>(none, none)).toBeInstanceOf(None);
    expect(firstSome(some(1), some(2)).getOrElse(0)).toBe(1);
  });
});

describe('Option — map/flatMap/filter/forEach', () => {
  test('map transforms the inner value on Some', () => {
    expect(some(3).map((n) => n * 2).getOrElse(0)).toBe(6);
  });

  test('map is a no-op on None', () => {
    const mapped = (none as Option<number>).map((n) => n * 2);
    expect(mapped).toBeInstanceOf(None);
  });

  test('flatMap chains through to a new Option', () => {
    const divideByHalving = (n: number): Option<number> =>
      n % 2 === 0 ? some(n / 2) : none;
    expect(some(8).flatMap(divideByHalving).flatMap(divideByHalving).getOrElse(-1)).toBe(2);
    expect(some(7).flatMap(divideByHalving).isNone()).toBe(true);
  });

  test('filter keeps Some only when predicate holds', () => {
    expect(some(5).filter((n) => n > 0).isSome()).toBe(true);
    expect(some(-1).filter((n) => n > 0).isNone()).toBe(true);
  });

  test('filterNot is the inverse of filter', () => {
    expect(some(5).filterNot((n) => n > 0).isNone()).toBe(true);
    expect(some(-1).filterNot((n) => n > 0).isSome()).toBe(true);
    expect((none as Option<number>).filterNot((n) => n > 0).isNone()).toBe(true);
  });

  test('forEach runs side-effect on Some, skipped on None', () => {
    let seen: number | null = null;
    some(42).forEach((n) => { seen = n; });
    expect(seen).toBe(42);

    (none as Option<number>).forEach((n) => { seen = n; });
    expect(seen).toBe(42); // unchanged
  });
});

describe('Option — getOrElse / orElse', () => {
  test('Some.getOrElse returns its value, ignoring the fallback', () => {
    expect(some(10).getOrElse(0)).toBe(10);
    expect(some(10).getOrElse(() => { throw new Error('not called'); })).toBe(10);
  });

  test('None.getOrElse returns the fallback', () => {
    expect((none as Option<number>).getOrElse(99)).toBe(99);
  });

  test('None.getOrElse calls the thunk only when needed', () => {
    let calls = 0;
    const val = (none as Option<string>).getOrElse(() => { calls++; return 'fallback'; });
    expect(val).toBe('fallback');
    expect(calls).toBe(1);
  });

  test('Some.orElse keeps itself, ignoring the alternative', () => {
    const result = some(1).orElse(some(2));
    expect(result.getOrElse(-1)).toBe(1);
    expect(some(1).orElse(() => { throw new Error('not called'); }).getOrElse(-1)).toBe(1);
  });

  test('None.orElse returns the alternative (eager or lazy)', () => {
    expect((none as Option<number>).orElse(some(42)).getOrElse(-1)).toBe(42);
    expect((none as Option<number>).orElse(() => some(99)).getOrElse(-1)).toBe(99);
  });
});

describe('Option — exists / forall / contains / fold', () => {
  test('exists: true iff Some and predicate holds', () => {
    expect(some(5).exists((n) => n > 0)).toBe(true);
    expect(some(-1).exists((n) => n > 0)).toBe(false);
    expect((none as Option<number>).exists((n) => n > 0)).toBe(false);
  });

  test('forall: true iff None OR Some and predicate holds', () => {
    expect(some(5).forall((n) => n > 0)).toBe(true);
    expect(some(-1).forall((n) => n > 0)).toBe(false);
    // Vacuously true on None — "for all zero elements, P holds".
    expect((none as Option<number>).forall((n) => n > 0)).toBe(true);
  });

  test('contains: true iff Some and value ===', () => {
    expect(some(5).contains(5)).toBe(true);
    expect(some(5).contains(6)).toBe(false);
    expect((none as Option<number>).contains(5)).toBe(false);
  });

  test('fold collapses to a single value', () => {
    expect(some(7).fold(() => -1, (n) => n * 2)).toBe(14);
    expect((none as Option<number>).fold(() => -1, (n) => n * 2)).toBe(-1);
  });
});

describe('Option — collection-ish helpers', () => {
  test('isEmpty / nonEmpty / size', () => {
    expect(some(1).isEmpty).toBe(false);
    expect(some(1).nonEmpty).toBe(true);
    expect(some(1).size).toBe(1);

    expect(none.isEmpty).toBe(true);
    expect(none.nonEmpty).toBe(false);
    expect(none.size).toBe(0);
  });

  test('toArray yields 0- or 1-element array', () => {
    expect(some(42).toArray()).toEqual([42]);
    expect(none.toArray()).toEqual([]);
  });
});

describe('Option — nullable interop', () => {
  test('toNullable: Some → value, None → null', () => {
    expect(some(3).toNullable()).toBe(3);
    expect((none as Option<number>).toNullable()).toBe(null);
  });

  test('round-trip through fromNullable/toNullable preserves presence', () => {
    const roundTrip = <T>(v: T | null): T | null => fromNullable(v).toNullable();
    expect(roundTrip(42)).toBe(42);
    expect(roundTrip(null)).toBe(null);
    expect(roundTrip(0)).toBe(0);
  });
});

describe('Option — type-guards narrow', () => {
  test('isSome narrows to Some inside an if branch', () => {
    const o: Option<string> = some('hi');
    if (o.isSome()) {
      expect(o.value.toUpperCase()).toBe('HI'); // no `.value` without guard
    } else {
      throw new Error('unreachable');
    }
  });

  test('isNone narrows to None', () => {
    const o: Option<string> = none;
    expect(o.isNone()).toBe(true);
  });
});

describe('Option — ts-pattern integration', () => {
  test('match via P.instanceOf(Some)/P.instanceOf(None)', () => {
    const describe_ = (o: Option<number>): string =>
      match(o)
        .with(P.instanceOf(Some), (s) => `got ${s.value}`)
        .with(P.instanceOf(None), () => 'empty')
        .exhaustive();

    expect(describe_(some(7))).toBe('got 7');
    expect(describe_(none as Option<number>)).toBe('empty');
  });

  test('match via discriminated union on _tag', () => {
    const toNumber = (o: Option<string>): number =>
      match(o)
        .with({ _tag: 'Some' }, (s) => s.value.length)
        .with({ _tag: 'None' }, () => -1)
        .exhaustive();

    expect(toNumber(some('hello'))).toBe(5);
    expect(toNumber(none as Option<string>)).toBe(-1);
  });
});
