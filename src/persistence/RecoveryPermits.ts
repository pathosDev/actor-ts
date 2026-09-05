/**
 * A counting semaphore, sized once and held for the duration of one journal
 * replay — the mechanism behind `actor-ts.persistence.max-concurrent-recoveries`.
 *
 * Deliberately not in `src/util/`.  Nothing else in the tree needs one today,
 * and `src/util/index.ts` publishes every module in that directory as public
 * API, so putting it there would ship a general-purpose concurrency primitive
 * whose fairness and cancellation semantics nobody has had to think about yet.
 * Here it is an implementation detail of one extension, with exactly the
 * properties that one call site needs.
 *
 * FIFO, because the alternative starves.  A LIFO or unordered queue under a
 * restart storm lets the entities that asked last go first, and the ones that
 * asked first sit behind them until the storm ends — which is precisely the
 * window `recovery-timeout` is measuring.
 */
export class RecoveryPermits {
  private available: number;
  private readonly waiting: Array<() => void> = [];
  private _peakInFlight = 0;

  constructor(private readonly permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error(`RecoveryPermits expects an integer >= 1, got ${permits}`);
    }
    this.available = permits;
  }

  /** Permits currently held. */
  get inFlight(): number { return this.permits - this.available; }

  /** Callers queued behind a permit. */
  get queued(): number { return this.waiting.length; }

  /**
   * The largest {@link inFlight} seen so far.
   *
   * Diagnostic, and the only thing that makes "recoveries are capped"
   * assertable without racing the very interleaving under test: a test that
   * sampled `inFlight` would only ever see the value at the moments it
   * happened to look.
   */
  get peakInFlight(): number { return this._peakInFlight; }

  /**
   * Run `work` holding one permit, releasing it however `work` settles.
   *
   * The release is in a `finally` rather than after the await: a recovery
   * that throws is the *common* case this cap exists for — a journal outage
   * fails every replay it is holding back — and a permit leaked per failure
   * would wedge the system permanently at exactly the moment it recovers.
   */
  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
    } else {
      // The permit is handed over by `release`, which does not put it back
      // into `available` first — see there.
      await new Promise<void>((resolve) => { this.waiting.push(resolve); });
    }
    if (this.inFlight > this._peakInFlight) this._peakInFlight = this.inFlight;
  }

  private release(): void {
    const next = this.waiting.shift();
    // Hand the permit straight to the head of the queue rather than
    // returning it to the pool and waking that waiter to re-take it.  The
    // waiter resumes in a later microtask, so between the wake-up and its
    // continuation a fresh `acquire` would find a free permit and take the
    // one that was just handed over — leaving two callers inside a cap of
    // one, with `available` gone negative and no assertion to notice.
    if (next) { next(); return; }
    this.available++;
  }
}
