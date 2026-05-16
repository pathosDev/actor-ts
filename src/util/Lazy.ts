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
  /**
   * Set after the cached value (a Promise) resolves — `getSync()`
   * reads this when the lazy was async-initialised.  Unset before
   * settlement; unset on rejection (rejection is surfaced through
   * the Promise itself, not via getSync).
   */
  private resolvedAsyncValue: { value: unknown } | undefined = undefined;

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
      // For `Lazy.of(async () => …)`, the cached value IS the
      // Promise.  Wire up a then-handler that stashes the eventual
      // settled value so `getSync()` can read it later without
      // awaiting again.  We allow the unhandled-rejection because
      // a downstream `.get()` caller is expected to await + throw.
      if (isThenable(value)) {
        const thenable = value as PromiseLike<unknown>;
        thenable.then(
          (resolved) => { this.resolvedAsyncValue = { value: resolved }; },
          () => { /* leave resolvedAsyncValue unset; getSync will throw */ },
        );
      }
      return value;
    } catch (e) {
      this.state = { kind: 'error', error: e };
      throw e;
    }
  }

  /**
   * Synchronous variant of {@link get}.  Returns the cached value if
   * already evaluated; throws otherwise.
   *
   * For `Lazy<Promise<U>>` (i.e. async-initialised lazy), `getSync`
   * returns the **resolved** value of type `U` once the underlying
   * Promise has settled successfully — meaning callers no longer
   * have to `await` after they know the lazy has been forced.
   *
   *   const sdk = Lazy.of(async () => await import('@aws-sdk/client-s3'));
   *   await sdk.get();                  // force + await once
   *   const mod = sdk.getSync<SdkType>(); // type-safe sync access after
   *
   * Throws when:
   *   - the lazy has not been forced at all (`get()` was never called);
   *   - the lazy is forced but the underlying Promise hasn't resolved yet;
   *   - the underlying Promise rejected (the rejection error is re-thrown);
   *   - the thunk itself threw (the original error is re-thrown).
   *
   * The generic parameter `U` lets callers narrow the return type for
   * the async case — `Lazy<Promise<X>>.getSync<X>()` returns `X` while
   * `Lazy<X>.getSync()` still returns `X` (the cached non-Promise value).
   */
  getSync<U = T>(): U {
    if (this.overrideValue !== null) {
      return this.overrideValue.value as unknown as U;
    }
    if (this.state.kind === 'error') throw this.state.error;
    if (this.state.kind === 'pending') {
      throw new Error('Lazy.getSync(): value has not been evaluated yet — call get() first');
    }
    // state.kind === 'value'.  If the cached value is a Promise we
    // need its resolved form; otherwise return as-is.
    if (isThenable(this.state.value)) {
      if (this.resolvedAsyncValue === undefined) {
        throw new Error(
          'Lazy.getSync(): underlying Promise has not resolved yet — await get() first',
        );
      }
      return this.resolvedAsyncValue.value as U;
    }
    return this.state.value as unknown as U;
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
    this.resolvedAsyncValue = undefined;
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

/**
 * Duck-typed thenable check — Promise instances and any object
 * exposing `.then(...)`.  Used by `Lazy` to detect when the
 * cached value is an async result whose resolved form
 * `getSync` should expose post-settlement.
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
