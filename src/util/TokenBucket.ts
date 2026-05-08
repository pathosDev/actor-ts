/**
 * Token bucket for rate-limiting (#83).  Deterministic, clock-injected,
 * single-threaded — fits the actor model.
 *
 * **Algorithm.**  The bucket holds at most `burst` tokens and refills at
 * `qps` tokens per second.  Every `tryConsume(n)` deducts `n` tokens
 * if available (returning true) or refuses (returning false) without
 * partial consumption.  Refill is computed lazily from elapsed
 * wall-clock time — no background timer, no per-message overhead beyond
 * a cheap subtraction.
 *
 * **Time injection.**  The constructor takes an optional `now: () =>
 * number` callback (defaults to `Date.now`).  Tests pass a mocked
 * function so they can advance time without `setTimeout`-based waits.
 *
 * **Burst semantics.**  Tokens accumulate up to `burst` while the
 * bucket is idle, so a brief idle period lets a workload "borrow"
 * future capacity for a quick spike.  `burst` defaults to `qps` (one
 * second's worth of capacity), the typical "smooth out small
 * variations" setting.
 */
export interface TokenBucketOptions {
  /** Token-refill rate, tokens per second.  Required; must be > 0. */
  readonly qps: number;
  /** Bucket capacity.  Default: `qps` (one second of refill). */
  readonly burst?: number;
  /** Time source.  Default: `Date.now`. */
  readonly now?: () => number;
}

export class TokenBucket {
  private readonly qps: number;
  private readonly capacity: number;
  private readonly now: () => number;
  /** Current token balance — fractional during refill, never negative. */
  private tokens: number;
  /** Wall-clock instant of the last refill calculation. */
  private lastRefillAt: number;

  constructor(opts: TokenBucketOptions) {
    if (!Number.isFinite(opts.qps) || opts.qps <= 0) {
      throw new Error(`TokenBucket: qps must be > 0, got ${opts.qps}`);
    }
    if (opts.burst !== undefined && (!Number.isFinite(opts.burst) || opts.burst <= 0)) {
      throw new Error(`TokenBucket: burst must be > 0, got ${opts.burst}`);
    }
    this.qps = opts.qps;
    this.capacity = opts.burst ?? opts.qps;
    this.now = opts.now ?? Date.now;
    // Start full so the first burst doesn't have to wait — workloads
    // typically expect "I can fire `burst` messages immediately".
    this.tokens = this.capacity;
    this.lastRefillAt = this.now();
  }

  /**
   * Attempt to consume `n` tokens (default 1).  Returns true if the
   * bucket had enough capacity (tokens deducted), false otherwise (no
   * partial consumption).
   */
  tryConsume(n: number = 1): boolean {
    if (n <= 0) return true;
    this.refill();
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }

  /**
   * Milliseconds until the bucket has at least `n` tokens (default 1).
   * Returns 0 when capacity is already there; useful for "schedule a
   * retry" decisions in the pause-on-empty mode of the per-actor
   * throttle (#83).
   */
  timeUntilNext(n: number = 1): number {
    this.refill();
    if (this.tokens >= n) return 0;
    const deficit = n - this.tokens;
    // qps tokens / 1000 ms = qps/1000 tokens per ms → deficit / (qps/1000).
    const ms = (deficit / this.qps) * 1000;
    // Round up — the bucket isn't ready until the next-whole-token
    // boundary at the earliest.
    return Math.ceil(ms);
  }

  /** Current token balance (refilled to "now").  Diagnostic only. */
  currentTokens(): number {
    this.refill();
    return this.tokens;
  }

  /** Reset the bucket to full immediately.  Test hook. */
  resetToFull(): void {
    this.tokens = this.capacity;
    this.lastRefillAt = this.now();
  }

  /** Lazy refill — compute tokens earned since the last call, cap at capacity. */
  private refill(): void {
    const now = this.now();
    const elapsedMs = now - this.lastRefillAt;
    if (elapsedMs <= 0) return;
    const earned = (elapsedMs / 1000) * this.qps;
    this.tokens = Math.min(this.capacity, this.tokens + earned);
    this.lastRefillAt = now;
  }
}
