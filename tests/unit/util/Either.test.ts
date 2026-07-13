import { describe, expect, test } from 'bun:test';
import { match, P } from 'ts-pattern';
import {
  Either,
  Left,
  Right,
  eitherOf,
  eitherSequence,
  left,
  right,
} from '../../../src/util/Either.js';

describe('Either — Right (primary, right-biased)', () => {
  test('right wraps a value; flags report correctly', () => {
    const either = right(42);
    expect(either.isRight()).toBe(true);
    expect(either.isLeft()).toBe(false);
    expect(either.value).toBe(42);
  });

  test('map transforms the Right value', () => {
    expect(right(3).map(n => n * 2).getOrElse(0)).toBe(6);
  });

  test('flatMap chains to another Either', () => {
    const ok = right(5).flatMap<string, number>(n => right(n + 1));
    expect((ok as Right<number>).value).toBe(6);
    const bad = right(5).flatMap<string, number>(() => left('err'));
    expect(bad.isLeft()).toBe(true);
  });

  test('mapLeft is a no-op on Right', () => {
    const either = right(10).mapLeft(() => 'err');
    expect((either as Right<number>).value).toBe(10);
  });

  test('fold applies onRight', () => {
    expect(right(7).fold(() => 'L', v => `R:${v}`)).toBe('R:7');
  });

  test('swap turns Right into Left', () => {
    const swapped = right(3).swap();
    expect(swapped.isLeft()).toBe(true);
    expect((swapped as Left<number>).value).toBe(3);
  });

  test('getOrElse returns Right value; fallback ignored', () => {
    expect(right(1).getOrElse(99)).toBe(1);
  });

  test('toNullable returns the Right value', () => {
    expect(right('x').toNullable()).toBe('x');
  });

  test('bimap on Right applies only onRight', () => {
    const either = right(10).bimap(() => 'never', (n) => n * 3);
    expect((either as Right<number>).value).toBe(30);
  });

  test('forEach on Right runs the side-effect', () => {
    const box: { seen: number | null } = { seen: null };
    right(7).forEach((n) => { box.seen = n; });
    expect(box.seen).toBe(7);
  });

  test('Right.orElse keeps itself, ignoring the alternative', () => {
    const result = right(1).orElse(right(99) as Either<never, number>);
    expect((result as Right<number>).value).toBe(1);
    // Thunk variant — never called.
    let called = 0;
    const r2 = right(1).orElse(() => { called++; return right(99) as Either<never, number>; });
    expect((r2 as Right<number>).value).toBe(1);
    expect(called).toBe(0);
  });

  test('mapLeft on Right passes through untouched', () => {
    // Sibling to the Left-side mapLeft test — the Right branch should
    // be a no-op for mapLeft.  Pin it explicitly so a future refactor
    // doesn't accidentally make Right.mapLeft do anything.
    const result = right(1).mapLeft(() => 'never');
    expect((result as Right<number>).value).toBe(1);
  });
});

describe('Either — Left (alternative)', () => {
  test('left wraps a value; flags report correctly', () => {
    const either = left('oops');
    expect(either.isLeft()).toBe(true);
    expect(either.isRight()).toBe(false);
    expect(either.value).toBe('oops');
  });

  test('map passes Left through untouched', () => {
    const either: Either<string, number> = left('err');
    expect(either.map(n => n * 2)).toBe(either as Either<string, number>);
  });

  test('flatMap passes Left through untouched', () => {
    const either: Either<string, number> = left('err');
    expect(either.flatMap(n => right(n))).toBe(either as Either<string, number>);
  });

  test('mapLeft transforms the Left value', () => {
    const either = left('raw').mapLeft((swapped) => `wrapped:${swapped}`);
    expect((either as Left<string>).value).toBe('wrapped:raw');
  });

  test('bimap on Left applies only onLeft', () => {
    const either = left(1).bimap((n) => n + 1, () => 'never');
    expect((either as Left<number>).value).toBe(2);
  });

  test('fold applies onLeft', () => {
    expect(left('bad').fold(l => `L:${l}`, () => 'R')).toBe('L:bad');
  });

  test('swap turns Left into Right', () => {
    const swapped = left('x').swap();
    expect(swapped.isRight()).toBe(true);
    expect((swapped as Right<string>).value).toBe('x');
  });

  test('getOrElse returns the fallback (value or computed)', () => {
    expect(left('err').getOrElse(5)).toBe(5);
    expect(left('err').getOrElse((l) => `fallback:${l}`)).toBe('fallback:err');
  });

  test('orElse substitutes an alternative', () => {
    const either: Either<string, number> = left('err');
    expect(either.orElse(right(42)).getOrElse(0)).toBe(42);
    expect(either.orElse(() => right(99)).getOrElse(0)).toBe(99);
  });

  test('toNullable returns null', () => {
    expect(left('err').toNullable()).toBeNull();
  });

  test('forEach on Left is a no-op', () => {
    let calls = 0;
    (left('x') as Either<string, number>).forEach(() => { calls++; });
    expect(calls).toBe(0);
  });
});

describe('Either — factories and helpers', () => {
  test('eitherOf captures a throwing thunk as Left', () => {
    expect(eitherOf(() => 1 + 1).getOrElse(-1)).toBe(2);
    const either = eitherOf<number>(() => { throw new Error('x'); });
    expect(either.isLeft()).toBe(true);
    expect((either as Left<Error>).value.message).toBe('x');
  });

  test('eitherOf coerces a non-Error throw into Error(String(value))', () => {
    // JS lets you `throw <anything>` — strings, numbers, plain objects.
    // The helper must wrap them so callers always get an Error on the
    // Left side, otherwise downstream consumers handling `Error.message`
    // would crash on a raw string.
    const e1 = eitherOf(() => { throw 'plain-string'; });
    expect(e1.isLeft()).toBe(true);
    expect((e1 as Left<Error>).value).toBeInstanceOf(Error);
    expect((e1 as Left<Error>).value.message).toBe('plain-string');

    const e2 = eitherOf(() => { throw 42; });
    expect((e2 as Left<Error>).value.message).toBe('42');

    const e3 = eitherOf(() => { throw { code: 'X' }; });
    // The default toString of a plain object — pin behaviour, not value.
    expect((e3 as Left<Error>).value).toBeInstanceOf(Error);
  });

  test('eitherSequence on empty array returns Right([])', () => {
    const out = eitherSequence<string, number>([]);
    expect(out.isRight()).toBe(true);
    expect((out as Right<number[]>).value).toEqual([]);
  });

  test('eitherSequence collects Rights or returns the first Left', () => {
    const all: Array<Either<string, number>> = [right(1), right(2), right(3)];
    const out = eitherSequence(all);
    expect(out.isRight()).toBe(true);
    expect((out as Right<number[]>).value).toEqual([1, 2, 3]);

    const mixed: Array<Either<string, number>> = [right(1), left('bad'), right(3)];
    const bad = eitherSequence(mixed);
    expect(bad.isLeft()).toBe(true);
    expect((bad as Left<string>).value).toBe('bad');
  });

  test('P.instanceOf pattern-matching works with ts-pattern', () => {
    const out = match<Either<string, number>>(right(7))
      .with(P.instanceOf(Right), (result) => `R:${result.value}`)
      .with(P.instanceOf(Left), (l) => `L:${l.value}`)
      .exhaustive();
    expect(out).toBe('R:7');
  });
});
