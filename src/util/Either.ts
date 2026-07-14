/**
 * Either<L, R> — a value that is either `Left<L>` (by convention: the
 * error / alternative) or `Right<R>` (by convention: the success /
 * primary value).  Mirrors Scala's `scala.util.Either`.
 *
 * Why pick `Either` over `Try`?
 *   - `Try` is fixed to thrown `Error`s on the failure side.  `Either`
 *     lets the failure type be anything — a typed error enum, a
 *     validation-message list, a pair of {code, reason}.
 *   - `Either` is "right-biased" by default: `map` / `flatMap` operate
 *     on the Right side and let Left pass through, matching the Scala
 *     2.12+ convention.
 *
 * Why pick `Either` over `Option`?
 *   - `Option` discards WHY a value was absent.  `Either` keeps it.
 *
 * Usage:
 *   type ParseError = { line: number; msg: string };
 *
 *   function parseConfig(src: string): Either<ParseError, Config> {
 *     try { return Either.right(JSON.parse(src) as Config); }
 *     catch (e) { return Either.left({ line: 0, msg: (e as Error).message }); }
 *   }
 *
 *   parseConfig(raw)
 *     .map(c => c.port)
 *     .fold(
 *       err => log.error(`bad config on line ${err.line}: ${err.msg}`),
 *       port => listen(port),
 *     );
 */

/** The Left branch — by convention the error / alternative. */
export class Left<L> {
  readonly _tag = 'Left' as const;
  constructor(readonly value: L) {}

  isLeft(): this is Left<L> { return true; }
  isRight(): this is Right<never> { return false; }

  /** Right-biased `map` — Left passes through. */
  map<U>(_f: (r: never) => U): Either<L, U> { return this as Either<L, U>; }

  /** Right-biased `flatMap` — Left passes through. */
  flatMap<R2>(_f: (r: never) => Either<L, R2>): Either<L, R2> { return this as Either<L, R2>; }

  /** Map the Left side. */
  mapLeft<U>(f: (l: L) => U): Either<U, never> { return new Left(f(this.value)); }

  /** Map BOTH sides. */
  bimap<U, V>(onLeft: (l: L) => U, _onRight: (r: never) => V): Either<U, V> {
    return new Left(onLeft(this.value));
  }

  /** Collapse to a single value. */
  fold<T>(onLeft: (l: L) => T, _onRight: (r: never) => T): T { return onLeft(this.value); }

  /** Swap the sides. */
  swap(): Either<never, L> { return new Right(this.value); }

  /** Left → fallback. */
  getOrElse<U>(fallback: U | ((l: L) => U)): U {
    return typeof fallback === 'function'
      ? (fallback as (l: L) => U)(this.value)
      : fallback;
  }

  /** Left → alternative; Right → self. */
  orElse<R2>(alt: Either<L, R2> | (() => Either<L, R2>)): Either<L, R2> {
    return typeof alt === 'function' ? (alt as () => Either<L, R2>)() : alt;
  }

  /** Side-effect runs on Right; no-op on Left. */
  forEach(_f: (r: never) => void): void { /* no-op */ }

  /** Optional conversion — Left → null. */
  toNullable(): null { return null; }
}

/** The Right branch — by convention the primary value. */
export class Right<R> {
  readonly _tag = 'Right' as const;
  constructor(readonly value: R) {}

  isLeft(): this is Left<never> { return false; }
  isRight(): this is Right<R> { return true; }

  /** Right-biased `map` — transform the inner value. */
  map<U>(f: (r: R) => U): Either<never, U> { return new Right(f(this.value)); }

  /** Right-biased `flatMap`. */
  flatMap<L2, R2>(f: (r: R) => Either<L2, R2>): Either<L2, R2> { return f(this.value); }

  /** Right passes through `mapLeft` untouched. */
  mapLeft<U>(_f: (l: never) => U): Either<U, R> { return this as Either<U, R>; }

  /** Map BOTH sides. */
  bimap<U, V>(_onLeft: (l: never) => U, onRight: (r: R) => V): Either<U, V> {
    return new Right(onRight(this.value));
  }

  /** Collapse to a single value. */
  fold<T>(_onLeft: (l: never) => T, onRight: (r: R) => T): T { return onRight(this.value); }

  /** Swap the sides. */
  swap(): Either<R, never> { return new Left(this.value); }

  /** Right → the value; fallback ignored. */
  getOrElse<U>(_fallback: U | ((l: never) => U)): R { return this.value; }

  /** Right → self; alternative ignored. */
  orElse<R2>(_alt: Either<never, R2> | (() => Either<never, R2>)): Either<never, R> { return this; }

  /** Side-effect on the Right value. */
  forEach(f: (r: R) => void): void { f(this.value); }

  /** Optional conversion — Right → the value. */
  toNullable(): R { return this.value; }
}

export type Either<L, R> = Left<L> | Right<R>;

/** Factory for Left. */
export function left<L>(value: L): Left<L> { return new Left(value); }

/** Factory for Right. */
export function right<R>(value: R): Right<R> { return new Right(value); }

/** Collect Right values; short-circuit to the first Left encountered. */
export function eitherSequence<L, R>(
  values: ReadonlyArray<Either<L, R>>,
): Either<L, R[]> {
  const out: R[] = [];
  for (const either of values) {
    if (either.isLeft()) return either as Either<L, R[]>;
    out.push(either.value);
  }
  return new Right(out);
}

/**
 * Convert a thunk into `Either<Error, R>` — Right on return, Left with
 * the thrown value (coerced to Error) on throw.
 */
export function eitherOf<R>(compute: () => R): Either<Error, R> {
  try { return new Right(compute()); }
  catch (e) { return new Left(e instanceof Error ? e : new Error(String(e))); }
}
