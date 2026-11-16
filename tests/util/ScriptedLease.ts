import type { Lease } from '../../src/coordination/Lease.js';

type PendingAcquire = {
  readonly resolve: (got: boolean) => void;
  readonly reject: (error: Error) => void;
};

/**
 * A lease whose every `acquire()` waits until the test settles it — granted,
 * denied, or **rejected**, the outcome no backend in the tree can be made to
 * produce on demand (`InMemoryLease` answers contention with `false` and never
 * throws).  A rejection is what a backend that cannot be reached does, and a
 * holder has to treat it as "not held": serve nothing, and try again after its
 * retry interval.
 *
 * Calls are settled oldest first.  `held` follows the last settled outcome, a
 * `release`, and {@link lose}; `onLost` handlers are counted so a test can
 * assert a holder let go of its subscription.
 */
export class ScriptedLease implements Lease {
  private readonly pending: PendingAcquire[] = [];
  private readonly lostHandlers = new Set<(reason: string) => void>();
  private held = false;
  /** Every `acquire()` made so far, settled or not. */
  acquireCalls = 0;
  /** Every `release()` made so far. */
  releases = 0;

  acquire(): Promise<boolean> {
    this.acquireCalls++;
    return new Promise<boolean>((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }

  async release(): Promise<void> {
    this.held = false;
    this.releases++;
  }

  checkAlive(): boolean { return this.held; }

  onLost(handler: (reason: string) => void): () => void {
    this.lostHandlers.add(handler);
    return () => { this.lostHandlers.delete(handler); };
  }

  /** How many `acquire()` calls are waiting to be settled. */
  get pendingAcquires(): number { return this.pending.length; }

  /** How many `onLost` handlers are subscribed. */
  get lostListeners(): number { return this.lostHandlers.size; }

  /** Let the oldest waiting `acquire()` succeed. */
  grant(): void {
    this.held = true;
    this.next().resolve(true);
  }

  /** Answer the oldest waiting `acquire()` with contention: another holder has it. */
  deny(): void {
    this.held = false;
    this.next().resolve(false);
  }

  /** Reject the oldest waiting `acquire()`, as a backend that cannot be reached does. */
  fail(error: Error = new Error('lease backend unreachable')): void {
    this.held = false;
    this.next().reject(error);
  }

  /** Take the lease away from its holder, the way a renewal that found it gone reports it. */
  lose(reason = 'taken by another holder'): void {
    this.held = false;
    for (const handler of Array.from(this.lostHandlers)) handler(reason);
  }

  private next(): PendingAcquire {
    const call = this.pending.shift();
    if (call === undefined) throw new Error('no acquire() is waiting to be settled');
    return call;
  }
}
