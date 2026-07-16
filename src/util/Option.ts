/**
 * Option<T> — an explicit "might not have a value" type, classes-based so
 * it plays nicely with `ts-pattern`'s `P.instanceOf(Some)` matcher.
 *
 * Prefer this over `T | null` in every domain-API return and long-lived
 * field.  Nullable is still allowed at three places on purpose:
 *   1. Hot-path internal fields (Mailbox queues, per-tick timers) where
 *      allocating a `Some`/`None` wrapper would show up in profiles.
 *   2. Serialization boundaries (wire-JSON, HOCON parser, CBOR decoder)
 *      where we must round-trip through `null`.
 *   3. Optional parameters with ergonomic defaults (`fn(sender?: ActorRef)`).
 *      The call-site stays short; the stored form can be `fromNullable()`ed.
 *
 * Usage:
 *   const maybeLeader: Option<Member> = cluster.leader();
 *   maybeLeader.map(m => m.address).getOrElse('<no leader>');
 *
 *   match(maybeLeader)
 *     .with(P.instanceOf(Some), (s) => s.value)
 *     .with(P.instanceOf(None), () => defaultMember)
 *     .exhaustive();
 *
 * The API mirrors Scala's `Option` where practical — `exists`, `forall`,
 * `contains`, `fold`, `orElse`, `filter`, `filterNot`, `forEach`,
 * `toArray`, `isEmpty`, `nonEmpty`.
 */

/** A value is present. */
export class Some<T> {
  readonly _tag = 'Some' as const;
  constructor(readonly value: T) {}

  /** Map the inner value; stays `Some`. */
  map<U>(f: (value: T) => U): Option<U> { return new Some(f(this.value)); }

  /** Map to another Option; stays `Some` if result is Some, else becomes None. */
  flatMap<U>(f: (value: T) => Option<U>): Option<U> { return f(this.value); }

  /** Present → the value; fallback ignored. */
  getOrElse<U>(_fallback: U | (() => U)): T { return this.value; }

  /** Present → this; alternative ignored. */
  orElse<U>(_alternative: Option<U> | (() => Option<U>)): Option<T> { return this; }

  /** Run side-effect if present. */
  forEach(f: (value: T) => void): void { f(this.value); }

  /** Keep if predicate holds, else None. */
  filter(pred: (value: T) => boolean): Option<T> {
    return pred(this.value) ? this : none;
  }

  /** Drop if predicate holds, else keep.  Mirror of `filter`. */
  filterNot(pred: (value: T) => boolean): Option<T> {
    return pred(this.value) ? none : this;
  }

  /** `true` iff present and `pred(value)` is truthy. */
  exists(pred: (value: T) => boolean): boolean { return pred(this.value); }

  /** `true` iff absent OR `pred(value)` is truthy. */
  forall(pred: (value: T) => boolean): boolean { return pred(this.value); }

  /** `true` iff present and the value equals `other` (SameValue comparison). */
  contains(other: T): boolean { return Object.is(this.value, other); }

  /** Collapse to a single value: `onSome` is called with the present value. */
  fold<U>(_onNone: () => U, onSome: (value: T) => U): U { return onSome(this.value); }

  /** Type-narrowing check. */
  isSome(): this is Some<T> { return true; }
  isNone(): this is None { return false; }
  get isEmpty(): boolean { return false; }
  get nonEmpty(): boolean { return true; }
  get size(): 0 | 1 { return 1; }

  /** Materialise into a zero-or-one-element array. */
  toArray(): T[] { return [this.value]; }

  /** Bridge back to nullable — useful at serialization/API boundaries. */
  toNullable(): T { return this.value; }
}

/** No value. */
export class None {
  readonly _tag = 'None' as const;

  map<U>(_f: (value: never) => U): Option<U> { return this as unknown as Option<U>; }
  flatMap<U>(_f: (value: never) => Option<U>): Option<U> { return this as unknown as Option<U>; }
  forEach(_f: (value: never) => void): void { /* no-op */ }
  filter(_pred: (value: never) => boolean): Option<never> { return this; }
  filterNot(_pred: (value: never) => boolean): Option<never> { return this; }
  exists(_pred: (value: never) => boolean): boolean { return false; }
  /** Vacuously true — "all" elements of an empty collection satisfy any predicate. */
  forall(_pred: (value: never) => boolean): boolean { return true; }
  contains<U>(_other: U): boolean { return false; }
  fold<U>(onNone: () => U, _onSome: (value: never) => U): U { return onNone(); }

  /** Absent → fallback value (or lazy fallback from a thunk). */
  getOrElse<U>(fallback: U | (() => U)): U {
    return typeof fallback === 'function' ? (fallback as () => U)() : fallback;
  }

  /** Absent → use the alternative Option (lazy or eager). */
  orElse<U>(alternative: Option<U> | (() => Option<U>)): Option<U> {
    return typeof alternative === 'function' ? (alternative as () => Option<U>)() : alternative;
  }

  isSome(): this is Some<never> { return false; }
  isNone(): this is None { return true; }
  get isEmpty(): boolean { return true; }
  get nonEmpty(): boolean { return false; }
  get size(): 0 | 1 { return 0; }

  toArray(): [] { return []; }
  toNullable(): null { return null; }
}

/** Discriminated union form. */
export type Option<T> = Some<T> | None;

/**
 * Canonical absence singleton.  Shared because `None` is stateless —
 * allocating a fresh one per call would be wasteful.
 */
export const none: None = new None();

/** Factory for the `Some` case. */
export function some<T>(value: T): Some<T> { return new Some(value); }

/** Convert `T | null | undefined` to an `Option<T>`. */
export function fromNullable<T>(value: T | null | undefined): Option<T> {
  return value === null || value === undefined ? none : new Some(value);
}

/** Convenience: build an Option from a predicate. */
export function fromPredicate<T>(value: T, pred: (v: T) => boolean): Option<T> {
  return pred(value) ? new Some(value) : none;
}

/** First `Some` in the list, else `None`. */
export function firstSome<T>(...options: ReadonlyArray<Option<T>>): Option<T> {
  for (const option of options) {
    if (option.isSome()) return option;
  }
  return none;
}
