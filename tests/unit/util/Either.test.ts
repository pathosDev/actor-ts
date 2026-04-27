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
    const e = right(42);
    expect(e.isRight()).toBe(true);
    expect(e.isLeft()).toBe(false);
    expect(e.value).toBe(42);
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
    const e = right(10).mapLeft(() => 'err');
    expect((e as Right<number>).value).toBe(10);
  });

  test('fold applies onRight', () => {
    expect(right(7).fold(() => 'L', v => `R:${v}`)).toBe('R:7');
  });

  test('swap turns Right into Left', () => {
    const s = right(3).swap();
    expect(s.isLeft()).toBe(true);
    expect((s as Left<number>).value).toBe(3);
  });

  test('getOrElse returns Right value; fallback ignored', () => {
    expect(right(1).getOrElse(99)).toBe(1);
  });

  test('toNullable returns the Right value', () => {
    expect(right('x').toNullable()).toBe('x');
  });
});

describe('Either — Left (alternative)', () => {
  test('left wraps a value; flags report correctly', () => {
    const e = left('oops');
    expect(e.isLeft()).toBe(true);
    expect(e.isRight()).toBe(false);
    expect(e.value).toBe('oops');
  });

  test('map passes Left through untouched', () => {
    const e: Either<string, number> = left('err');
    expect(e.map(n => n * 2)).toBe(e as Either<string, number>);
  });

  test('flatMap passes Left through untouched', () => {
    const e: Either<string, number> = left('err');
    expect(e.flatMap(n => right(n))).toBe(e as Either<string, number>);
  });

  test('mapLeft transforms the Left value', () => {
    const e = left('raw').mapLeft((s) => `wrapped:${s}`);
    expect((e as Left<string>).value).toBe('wrapped:raw');
  });

  test('bimap on Left applies only onLeft', () => {
    const e = left(1).bimap((n) => n + 1, () => 'never');
    expect((e as Left<number>).value).toBe(2);
  });

  test('fold applies onLeft', () => {
    expect(left('bad').fold(l => `L:${l}`, () => 'R')).toBe('L:bad');
  });

  test('swap turns Left into Right', () => {
    const s = left('x').swap();
    expect(s.isRight()).toBe(true);
    expect((s as Right<string>).value).toBe('x');
  });

  test('getOrElse returns the fallback (value or computed)', () => {
    expect(left('err').getOrElse(5)).toBe(5);
    expect(left('err').getOrElse((l) => `fallback:${l}`)).toBe('fallback:err');
  });

  test('orElse substitutes an alternative', () => {
    const e: Either<string, number> = left('err');
    expect(e.orElse(right(42)).getOrElse(0)).toBe(42);
    expect(e.orElse(() => right(99)).getOrElse(0)).toBe(99);
  });

  test('toNullable returns null', () => {
    expect(left('err').toNullable()).toBeNull();
  });
});

describe('Either — factories and helpers', () => {
  test('eitherOf captures a throwing thunk as Left', () => {
    expect(eitherOf(() => 1 + 1).getOrElse(-1)).toBe(2);
    const e = eitherOf<number>(() => { throw new Error('x'); });
    expect(e.isLeft()).toBe(true);
    expect((e as Left<Error>).value.message).toBe('x');
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
      .with(P.instanceOf(Right), (r) => `R:${r.value}`)
      .with(P.instanceOf(Left), (l) => `L:${l.value}`)
      .exhaustive();
    expect(out).toBe('R:7');
  });
});
