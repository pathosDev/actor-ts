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
    const attempt = success(42);
    expect(attempt.isSuccess()).toBe(true);
    expect(attempt.isFailure()).toBe(false);
    expect(attempt.value).toBe(42);
  });

  test('getOrElse returns the inner value; fallback ignored', () => {
    expect(success(1).getOrElse(99)).toBe(1);
    expect(success(1).getOrElse(() => 99)).toBe(1);
  });

  test('map transforms the inner value', () => {
    expect(success(3).map(n => n * 2).get()).toBe(6);
  });

  test('map catches a thrown mapper and becomes Failure', () => {
    const attempt = success(1).map(() => { throw new Error('boom'); });
    expect(attempt.isFailure()).toBe(true);
    expect(attempt.toError()?.message).toBe('boom');
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

  test('forEach runs side-effect on Success', () => {
    const box: { seen: number | null } = { seen: null };
    success(42).forEach((n) => { box.seen = n; });
    expect(box.seen).toBe(42);
  });

  test('filter with a custom error factory uses the provided Error', () => {
    const attempt = success(3).filter((n) => n > 100, (v) => new RangeError(`too small: ${v}`));
    expect(attempt.isFailure()).toBe(true);
    expect((attempt as Failure).error).toBeInstanceOf(RangeError);
    expect((attempt as Failure).toError().message).toBe('too small: 3');
  });

  test('filter catches a throwing predicate as Failure', () => {
    const attempt = success(1).filter(() => { throw new Error('pred-threw'); });
    expect(attempt.isFailure()).toBe(true);
    expect((attempt as Failure).toError().message).toBe('pred-threw');
  });

  test('flatMap catches a throwing mapper as Failure', () => {
    const attempt = success(1).flatMap(() => { throw new Error('flatmap-threw'); });
    expect(attempt.isFailure()).toBe(true);
    expect((attempt as Failure).toError().message).toBe('flatmap-threw');
  });
});

describe('Try — Failure', () => {
  test('Failure wraps an error; flags invert', () => {
    const attempt = failure(new Error('nope'));
    expect(attempt.isSuccess()).toBe(false);
    expect(attempt.isFailure()).toBe(true);
    expect(attempt.error).toBeInstanceOf(Error);
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
    const attempt: Try<number> = failure(err);
    expect(attempt.map(n => n * 2).isFailure()).toBe(true);
    expect(attempt.flatMap(n => success(n + 1)).isFailure()).toBe(true);
  });

  test('recover produces a Success unless the recovery returns null', () => {
    expect(failure(new Error('x')).recover(() => 0).get()).toBe(0);
    expect(failure(new Error('x')).recover(() => null).isFailure()).toBe(true);
  });

  test('recoverWith can swap in a different Try', () => {
    const attempt = failure(new Error('x')).recoverWith((e) =>
      (e as Error).message === 'x' ? success(42) : failure(e),
    );
    expect(attempt.get()).toBe(42);
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

  test('get() on a non-Error failure throws a coerced Error', () => {
    // `throw "string"` is legal JS — Failure stores the raw value
    // but get() should still throw an Error so callers reading
    // `.message` don't crash.
    const failedAttempt = failure('raw-string');
    expect(() => failedAttempt.get()).toThrow('raw-string');
  });

  test('cause / toError coerce a non-Error value', () => {
    const f1 = failure('string-error');
    expect(f1.cause).toBeInstanceOf(Error);
    expect(f1.cause.message).toBe('string-error');
    expect(f1.toError().message).toBe('string-error');

    const f2 = failure(123);
    expect(f2.toError()).toBeInstanceOf(Error);
    expect(f2.toError().message).toBe('123');
  });

  test('cause returns the original Error when one was thrown', () => {
    const original = new TypeError('typed');
    const failedAttempt = failure(original);
    expect(failedAttempt.cause).toBe(original);
    expect(failedAttempt.toError()).toBe(original);
  });

  test('recover wraps the recovery value as Success', () => {
    expect(failure(new Error()).recover(() => 7).get()).toBe(7);
  });

  test('recover that throws inside the recovery becomes a fresh Failure', () => {
    const attempt = failure(new Error('orig')).recover(() => { throw new Error('recovery-threw'); });
    expect(attempt.isFailure()).toBe(true);
    expect((attempt as Failure).toError().message).toBe('recovery-threw');
  });

  test('recoverWith catches a throwing recovery as Failure', () => {
    const attempt = failure(new Error('orig')).recoverWith(() => { throw new Error('recovery-threw'); });
    expect(attempt.isFailure()).toBe(true);
    expect((attempt as Failure).toError().message).toBe('recovery-threw');
  });

  test('forEach on Failure is a no-op', () => {
    let calls = 0;
    failure(new Error()).forEach(() => { calls++; });
    expect(calls).toBe(0);
  });

  test('filter on Failure passes through unchanged', () => {
    const orig = failure(new Error('keep-me'));
    const filtered = orig.filter(() => true);
    expect(filtered).toBe(orig);
  });
});

describe('Try — factories and helpers', () => {
  test('tryOf wraps a thunk — Success on return, Failure on throw', () => {
    expect(tryOf(() => 1 + 1).get()).toBe(2);
    const attempt = tryOf<number>(() => { throw new Error('x'); });
    expect(attempt.isFailure()).toBe(true);
  });

  test('tryOf with a non-Error throw stores the raw value', () => {
    // Mirror of eitherOf — but Try keeps the RAW value on `.error`
    // (Failure.error is `unknown`) and only coerces via `.cause` /
    // `.toError()`.  Pin that contract.
    const attempt = tryOf(() => { throw 'string-error'; }) as Failure;
    expect(attempt.isFailure()).toBe(true);
    expect(attempt.error).toBe('string-error');
    expect(attempt.cause.message).toBe('string-error');
  });

  test('trySequence on empty array returns Success([])', () => {
    expect(trySequence<number>([]).get()).toEqual([]);
  });

  test('trySequence with all failures short-circuits to the first', () => {
    const first = failure(new Error('first'));
    const second = failure(new Error('second'));
    expect(trySequence([first, second])).toBe(first);
  });

  test('trySequence collects Successes or short-circuits to the first Failure', () => {
    expect(trySequence([success(1), success(2), success(3)]).get()).toEqual([1, 2, 3]);
    const attempt = trySequence([success(1), failure(new Error('mid')), success(3)]);
    expect(attempt.isFailure()).toBe(true);
  });

  test('P.instanceOf works with ts-pattern', () => {
    const out = match<Try<number>>(tryOf(() => 7))
      .with(P.instanceOf(Success), (s) => `ok:${s.value}`)
      .with(P.instanceOf(Failure), () => 'err')
      .exhaustive();
    expect(out).toBe('ok:7');
  });
});
