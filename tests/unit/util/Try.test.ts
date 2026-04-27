import { describe, expect, test } from 'bun:test';
import { match, P } from 'ts-pattern';
import {
  Failure,
  Success,
  failure,
  success,
  tryOf,
  trySequence,
  type Try,
} from '../../../src/util/Try.js';

describe('Try — Success', () => {
  test('Success wraps a value; isSuccess/isFailure report correctly', () => {
    const t = success(42);
    expect(t.isSuccess()).toBe(true);
    expect(t.isFailure()).toBe(false);
    expect(t.value).toBe(42);
  });

  test('getOrElse returns the inner value; fallback ignored', () => {
    expect(success(1).getOrElse(99)).toBe(1);
    expect(success(1).getOrElse(() => 99)).toBe(1);
  });

  test('map transforms the inner value', () => {
    expect(success(3).map(n => n * 2).get()).toBe(6);
  });

  test('map catches a thrown mapper and becomes Failure', () => {
    const t = success(1).map(() => { throw new Error('boom'); });
    expect(t.isFailure()).toBe(true);
    expect(t.toError()?.message).toBe('boom');
  });

  test('flatMap chains into another Try', () => {
    expect(success(5).flatMap(n => success(n + 1)).get()).toBe(6);
    expect(success(5).flatMap(() => failure(new Error('x'))).isFailure()).toBe(true);
  });

  test('filter keeps Success when predicate holds, Failure when not', () => {
    expect(success(4).filter(n => n > 0).isSuccess()).toBe(true);
    expect(success(-1).filter(n => n > 0).isFailure()).toBe(true);
  });

  test('fold picks onSuccess', () => {
    expect(success(7).fold(() => 'err', v => `ok:${v}`)).toBe('ok:7');
  });

  test('toNullable returns the value; toError returns null', () => {
    expect(success(10).toNullable()).toBe(10);
    expect(success(10).toError()).toBeNull();
  });

  test('recover / recoverWith are no-ops on Success', () => {
    expect(success(1).recover(() => 99).get()).toBe(1);
    expect(success(1).recoverWith(() => success(99)).get()).toBe(1);
  });
});

describe('Try — Failure', () => {
  test('Failure wraps an error; flags invert', () => {
    const t = failure(new Error('nope'));
    expect(t.isSuccess()).toBe(false);
    expect(t.isFailure()).toBe(true);
    expect(t.error).toBeInstanceOf(Error);
  });

  test('getOrElse returns the fallback (value or computed from error)', () => {
    expect(failure(new Error()).getOrElse(5)).toBe(5);
    expect(failure(new Error('x')).getOrElse((e) => (e as Error).message)).toBe('x');
  });

  test('orElse substitutes the alternative Try', () => {
    expect(failure(new Error()).orElse(success(7)).get()).toBe(7);
    expect(failure(new Error()).orElse(() => success(7)).get()).toBe(7);
  });

  test('map / flatMap pass the Failure through untouched', () => {
    const err = new Error('stay');
    const t: Try<number> = failure(err);
    expect(t.map(n => n * 2).isFailure()).toBe(true);
    expect(t.flatMap(n => success(n + 1)).isFailure()).toBe(true);
  });

  test('recover produces a Success unless the recovery returns null', () => {
    expect(failure(new Error('x')).recover(() => 0).get()).toBe(0);
    expect(failure(new Error('x')).recover(() => null).isFailure()).toBe(true);
  });

  test('recoverWith can swap in a different Try', () => {
    const t = failure(new Error('x')).recoverWith((e) =>
      (e as Error).message === 'x' ? success(42) : failure(e),
    );
    expect(t.get()).toBe(42);
  });

  test('fold picks onFailure', () => {
    expect(failure(new Error('bad')).fold(e => `err:${(e as Error).message}`, () => 'ok'))
      .toBe('err:bad');
  });

  test('toNullable returns null; toError returns the Error', () => {
    expect(failure(new Error('x')).toNullable()).toBeNull();
    expect(failure(new Error('x')).toError().message).toBe('x');
  });

  test('get() re-throws', () => {
    expect(() => failure(new Error('boom')).get()).toThrow('boom');
  });
});

describe('Try — factories and helpers', () => {
  test('tryOf wraps a thunk — Success on return, Failure on throw', () => {
    expect(tryOf(() => 1 + 1).get()).toBe(2);
    const t = tryOf<number>(() => { throw new Error('x'); });
    expect(t.isFailure()).toBe(true);
  });

  test('trySequence collects Successes or short-circuits to the first Failure', () => {
    expect(trySequence([success(1), success(2), success(3)]).get()).toEqual([1, 2, 3]);
    const t = trySequence([success(1), failure(new Error('mid')), success(3)]);
    expect(t.isFailure()).toBe(true);
  });

  test('P.instanceOf works with ts-pattern', () => {
    const out = match<Try<number>>(tryOf(() => 7))
      .with(P.instanceOf(Success), (s) => `ok:${s.value}`)
      .with(P.instanceOf(Failure), () => 'err')
      .exhaustive();
    expect(out).toBe('ok:7');
  });
});
