/**
 * Lazy<T> — a value computed on first access, then memoised.  Mirrors
 * Scala's `lazy val` and Kotlin's `lazy { }` — the thunk you pass in
 * runs at most once; every subsequent `.get()` returns the cached
 * result.  A thrown thunk caches the failure and re-throws on every
 * subsequent access, matching the Scala semantics.
 *
 * Usage — plain memoised compute:
 *   const config = Lazy.of(() => loadHoconFromEnv());
 *   config.get();   // reads + parses once
 *   config.get();   // same reference, zero work
 *
 * Usage — test reset:
 *   const driver = Lazy.of(() => pickDriverForRuntime());
 *   driver.reset();            // forget cached value
 *   driver.setOverride(mock);  // force a specific value (test hook)
 *
 * Usage — mapping:
 *   const port = Lazy.of(() => parseInt(process.env.PORT ?? '0', 10));
 *   const url  = port.map((p) => `http://localhost:${p}`);
 *   // `url.get()` evaluates `port.get()` on demand, then formats.
 *
 * For values whose computation is async, wrap the `Promise` — `Lazy.of
 * (async () => …)` caches the Promise itself, so concurrent callers all
 * await the same in-flight work (no duplicate initialisation).
 */

type ThunkState<T> =
  | { readonly kind: 'pending' }
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'error'; readonly error: unknown };

export class Lazy<T> {
  private state: ThunkState<T> = { kind: 'pending' };
  private overrideValue: { value: T } | null = null;

  private constructor(private readonly compute: () => T) {}

  /** Build a lazy cell from a thunk.  Preferred entry point. */
  static of<T>(compute: () => T): Lazy<T> { return new Lazy(compute); }

  /** Build a lazy cell that's already evaluated to `value` (no thunk runs). */
  static evaluated<T>(value: T): Lazy<T> {
    const cell = new Lazy<T>(() => value);
    cell.state = { kind: 'value', value };
    return cell;
  }

  /**
   * Get the memoised value.  Runs the thunk on first call; subsequent
   * calls return the cached result.  If the thunk threw, the same error
   * is re-thrown on every subsequent access.
   */
  get(): T {
    if (this.overrideValue !== null) return this.overrideValue.value;
    if (this.state.kind === 'value') return this.state.value;
    if (this.state.kind === 'error') throw this.state.error;
    try {
      const value = this.compute();
      this.state = { kind: 'value', value };
      return value;
    } catch (e) {
      this.state = { kind: 'error', error: e };
      throw e;
    }
  }

  /**
   * `true` once `.get()` can return without running the thunk — either
   * the thunk has already been executed (success or failure both count),
   * or an override is active.  `false` only in the initial pending
   * state.
   */
  get isEvaluated(): boolean {
    return this.overrideValue !== null || this.state.kind !== 'pending';
  }

  /** Return the cached value if already evaluated, else `undefined`. */
  peek(): T | undefined {
    if (this.overrideValue !== null) return this.overrideValue.value;
    return this.state.kind === 'value' ? this.state.value : undefined;
  }

  /**
   * Derive a new `Lazy` whose value is `f(this.get())`.  The derivation
   * is itself lazy — `map(f)` does not force the source.
   */
  map<U>(f: (value: T) => U): Lazy<U> {
    return Lazy.of(() => f(this.get()));
  }

  /**
   * Derive a new `Lazy` whose value flattens a `Lazy<Lazy<U>>`.  Same
   * laziness contract as `map`.
   */
  flatMap<U>(f: (value: T) => Lazy<U>): Lazy<U> {
    return Lazy.of(() => f(this.get()).get());
  }

  /**
   * Run a side effect against the evaluated value.  Forces evaluation;
   * idempotent by virtue of the cache.
   */
  forEach(f: (value: T) => void): void { f(this.get()); }

  /**
   * Forget the memoised value so the next `get()` re-runs the thunk.
   * Primarily a test hook — also clears any override set via
   * `setOverride`.  In hot production paths, prefer building a new
   * `Lazy` rather than resetting.
   */
  reset(): void {
    this.state = { kind: 'pending' };
    this.overrideValue = null;
  }

  /**
   * Test hook: force `.get()` to return `value` without touching the
   * thunk or the cache.  Call `reset()` (or `setOverride(null)`) to
   * restore normal evaluation.
   */
  setOverride(value: T | null): void {
    this.overrideValue = value === null ? null : { value };
  }
}

/** Shorthand alias matching Scala's `lazy val`. */
export const lazy = Lazy.of;
