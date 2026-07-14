/**
 * Try<T> — a synchronous computation that either yielded a value
 * (`Success<T>`) or threw (`Failure`).  Mirrors Scala's `scala.util.Try`.
 *
 * Why use it over try/catch directly?
 *   - **Composition:** `parse().map(...).flatMap(...).getOrElse(default)`
 *     reads top-to-bottom; try/catch blocks don't.
 *   - **Typed error context:** `Failure` holds the error as data, so you
 *     can log / rethrow / recover without touching control flow.
 *   - **Pattern matching:** plays with `ts-pattern` via
 *     `P.instanceOf(Success)` / `P.instanceOf(Failure)`.
 *
 * Usage:
 *   const parsed: Try<Config> = Try.of(() => JSON.parse(raw) as Config);
 *   const port = parsed.map(c => c.port).getOrElse(8080);
 *
 *   Try.of(() => riskyOp())
 *      .map(x => x * 2)
 *      .recover(err => err instanceof TimeoutError ? 0 : null)
 *      .fold(
 *        err => log.warn('failed', err),
 *        val => use(val),
 *      );
 *
 * `Try` is intentionally sync-only.  For the async case, use plain
 * `Promise` (which already models success/failure) or a library like
 * `fp-ts`'s `TaskEither`.
 */

/** The computation returned a value. */
export class Success<T = unknown> {
  readonly _tag = 'Success' as const;
  constructor(readonly value: T) {}

  isSuccess(): this is Success<T> { return true; }
  isFailure(): this is Failure { return false; }

  /** Always Success; fallback ignored. */
  getOrElse<U>(_fallback: U | ((err: unknown) => U)): T { return this.value; }

  /** Always Success; alternative ignored. */
  orElse<U>(_alt: Try<U> | (() => Try<U>)): Try<T> { return this; }

  /** Map the inner value.  A thrown mapper turns this into a Failure. */
  map<U>(f: (value: T) => U): Try<U> {
    try { return new Success(f(this.value)); }
    catch (e) { return new Failure(e); }
  }

  /** Chain to another Try.  A thrown mapper becomes Failure. */
  flatMap<U>(f: (value: T) => Try<U>): Try<U> {
    try { return f(this.value); }
    catch (e) { return new Failure(e); }
  }

  /** Always Success — no recovery runs. */
  recover<U>(_f: (err: unknown) => U | null): Try<T | U> { return this; }

  /** Always Success — no recovery runs. */
  recoverWith<U>(_f: (err: unknown) => Try<U>): Try<T | U> { return this; }

  /** Keep if predicate holds; else Failure with a `FilterError`. */
  filter(pred: (value: T) => boolean, makeError?: (value: T) => Error): Try<T> {
    try {
      if (pred(this.value)) return this;
      const err = makeError?.(this.value) ?? new Error(`Try.filter predicate returned false for ${String(this.value)}`);
      return new Failure(err);
    } catch (e) { return new Failure(e); }
  }

  /** Collapse both cases into one value. */
  fold<U>(_onFailure: (err: unknown) => U, onSuccess: (value: T) => U): U {
    return onSuccess(this.value);
  }

  /** Run a side-effect on the value. */
  forEach(f: (value: T) => void): void { f(this.value); }

  /** Convert to a "classic" value — the inner value. */
  get(): T { return this.value; }

  /** Convert to an Option-like shape (null on Failure). */
  toNullable(): T | null { return this.value; }

  /** Fresh copy of the error, or null. */
  toError(): Error | null { return null; }
}

/** The computation threw. */
export class Failure {
  readonly _tag = 'Failure' as const;
  /** The raw thrown value.  Usually an `Error` but could be anything JS allowed `throw`ing. */
  constructor(readonly error: unknown) {}

  /**
   * The error coerced to an `Error`.  Kept as an alias for back-compat
   * with code that used the previous pipeTo-style `Failure` (which named
   * the field `cause` and typed it as `Error`).  Prefer `.error` in new
   * code — `.cause` lies in the sense that we don't control the thrown
   * value's type, only its coercion.
   */
  get cause(): Error {
    return this.error instanceof Error ? this.error : new Error(String(this.error));
  }

  isSuccess(): this is Success<never> { return false; }
  isFailure(): this is Failure { return true; }

  getOrElse<U>(fallback: U | ((err: unknown) => U)): U {
    return typeof fallback === 'function'
      ? (fallback as (err: unknown) => U)(this.error)
      : fallback;
  }

  orElse<U>(alt: Try<U> | (() => Try<U>)): Try<U> {
    return typeof alt === 'function' ? (alt as () => Try<U>)() : alt;
  }

  map<U>(_f: (value: never) => U): Try<U> { return this as Try<U>; }
  flatMap<U>(_f: (value: never) => Try<U>): Try<U> { return this as Try<U>; }

  /** Apply the recovery fn; returned value is wrapped in Success.  `null` keeps the Failure. */
  recover<U>(f: (err: unknown) => U | null): Try<U> {
    try {
      const recovered = f(this.error);
      return recovered === null ? (this as Try<U>) : new Success(recovered);
    } catch (e) { return new Failure(e); }
  }

  /** Apply the recovery fn; its Try return value wholesale replaces this Failure. */
  recoverWith<U>(f: (err: unknown) => Try<U>): Try<U> {
    try { return f(this.error); }
    catch (e) { return new Failure(e); }
  }

  /** Failure passes through `filter` unchanged. */
  filter(_pred: (value: never) => boolean, _makeError?: (value: never) => Error): Try<never> { return this; }

  fold<U>(onFailure: (err: unknown) => U, _onSuccess: (value: never) => U): U {
    return onFailure(this.error);
  }

  forEach(_f: (value: never) => void): void { /* no-op */ }

  /** Throws the stored error (Scala parity). */
  get(): never {
    if (this.error instanceof Error) throw this.error;
    throw new Error(String(this.error));
  }

  toNullable(): null { return null; }

  toError(): Error { return this.error instanceof Error ? this.error : new Error(String(this.error)); }
}

export type Try<T> = Success<T> | Failure;

/** Run `compute` and wrap the outcome.  Any thrown value becomes `Failure`. */
export function tryOf<T>(compute: () => T): Try<T> {
  try { return new Success(compute()); }
  catch (e) { return new Failure(e); }
}

/** Factory shortcut for `Success`. */
export function success<T>(value: T): Success<T> { return new Success(value); }

/** Factory shortcut for `Failure`. */
export function failure(error: unknown): Failure { return new Failure(error); }

/** Collect successes; short-circuit to the first Failure seen. */
export function trySequence<T>(tries: ReadonlyArray<Try<T>>): Try<T[]> {
  const out: T[] = [];
  for (const attempt of tries) {
    if (attempt.isFailure()) return attempt;
    out.push(attempt.value);
  }
  return new Success(out);
}
