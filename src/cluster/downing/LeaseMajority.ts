import type { Lease } from '../../coordination/Lease.js';
import {
  addrKey,
  type ClusterPartitionView,
  type DowningDecision,
  type DowningProvider,
} from './DowningProvider.js';

export interface LeaseMajoritySettings {
  /**
   * External arbiter — typically a `KubernetesLease` so both sides
   * of a partition reach the same K8s API and only one acquires.
   * Each replica owns its own `Lease` instance with a distinct
   * `owner` (its node address); the underlying lease record is
   * shared (same `name`).
   */
  readonly lease: Lease;
  /**
   * Hard ceiling on a single `acquire()` attempt.  After this we
   * return no decision and let the next failure-detection tick
   * trigger a fresh attempt.  Default: 5 s.
   */
  readonly acquireTimeoutMs?: number;
  /** If set, only members carrying this role count toward the majority. */
  readonly role?: string;
}

/**
 * Split-brain resolver that uses an external `Lease` to break ties
 * when the cluster splits into equal-sized partitions — the case
 * where membership-only strategies (KeepOldest, KeepReferee,
 * KeepMajority) cannot make a deterministic call.
 *
 * Algorithm per partition observation (one side of the split):
 *
 *   1. Run the standard `KeepMajority` math.
 *      - Reachable side has strict majority → down the unreachable side.
 *      - Reachable side is the strict minority → down ourselves
 *        (and every reachable peer on this side).
 *   2. Equal-size partition (or insufficient info) → start
 *      `lease.acquire()`.  Return no decision while the acquire is
 *      pending so the cluster waits.
 *   3. When acquire resolves:
 *      - `true` → we are the surviving side.  Down the unreachable side.
 *      - `false` → some other side won.  Down our own side.
 *
 * The `decide()` interface stays sync (the rest of the resolver
 * pipeline is sync).  Async work happens off-band — this strategy
 * is **stateful**: the first equal-size observation kicks off the
 * acquire; subsequent ticks read the cached result.
 *
 * **Lease unavailable** (network problem reaching the K8s API):
 * `acquire()` rejects → strategy stays in pending state and returns
 * an empty decision.  Better to wait than to risk both sides
 * surviving.
 */
export class LeaseMajority implements DowningProvider {
  /** Cached decision once acquire has resolved.  Cleared on a fresh
   *  partition view so a new split triggers a new acquire. */
  private decision: DowningDecision | null = null;

  /** True while an `acquire()` is in flight. */
  private acquiring = false;

  /** Fingerprint of the partition view we last evaluated.  Used to
   *  detect a *new* split (different unreachable set) so we restart
   *  the acquire flow. */
  private lastFingerprint: string | null = null;

  /** Wall-clock deadline of the in-flight acquire — used to recover
   *  if `acquire()` hangs longer than the user's budget. */
  private acquireDeadline = 0;

  constructor(private readonly settings: LeaseMajoritySettings) {}

  decide(view: ClusterPartitionView): DowningDecision {
    const candidates = view.allMembers.filter((m) =>
      (m.status === 'up' || m.status === 'leaving' || m.status === 'unreachable') &&
      (!this.settings.role || m.hasRole(this.settings.role)),
    );
    if (candidates.length === 0) return new Set();

    const reachable = candidates.filter((m) => !view.unreachable.has(addrKey(m)));
    const unreachable = candidates.filter((m) => view.unreachable.has(addrKey(m)));
    const n = candidates.length;
    const needed = Math.floor(n / 2) + 1;
    const fingerprint = this.fingerprintOf(reachable, unreachable);

    // No partition (everyone reachable) → reset state, no decision.
    if (unreachable.length === 0) {
      this.reset();
      return new Set();
    }

    // Partition view changed since last evaluation → drop cached
    // decision so a fresh split triggers a fresh acquire.
    if (fingerprint !== this.lastFingerprint) {
      this.reset();
      this.lastFingerprint = fingerprint;
    }

    // Strict majority — no Lease needed.
    if (reachable.length >= needed) {
      this.decision = new Set(unreachable.map(addrKey));
      return this.decision;
    }
    // Strict minority — also no Lease needed.
    if (unreachable.length >= needed) {
      this.decision = new Set(reachable.map(addrKey));
      return this.decision;
    }

    // Equal-size partition (or stuck-quorum corner case) — Lease
    // arbitration kicks in.
    if (this.decision !== null) {
      // Cached from a prior tick on this same view.
      return this.decision;
    }

    if (this.acquiring) {
      // Recover if the acquire stalled past its budget.  The Lease
      // implementation is supposed to honour its own retry/timeout
      // settings, but defence-in-depth: if it hasn't resolved by
      // the deadline, treat it as a transient failure and let the
      // next tick try again.
      if (Date.now() > this.acquireDeadline) {
        this.acquiring = false;
      }
      return new Set();
    }

    const surviveSet = new Set(unreachable.map(addrKey));
    const downSelfSet = new Set(reachable.map(addrKey));

    this.acquiring = true;
    this.acquireDeadline = Date.now() + (this.settings.acquireTimeoutMs ?? 5_000);
    void this.runAcquire(surviveSet, downSelfSet);
    return new Set();
  }

  /* ------------------------------ internals ------------------------------ */

  private async runAcquire(
    surviveSet: DowningDecision,
    downSelfSet: DowningDecision,
  ): Promise<void> {
    let won: boolean;
    try {
      won = await this.settings.lease.acquire();
    } catch {
      // Lease backend unreachable — stay pending.  The next decide()
      // call sees `acquiring=false` (we clear it below) and restarts.
      this.acquiring = false;
      return;
    }
    this.acquiring = false;
    this.decision = won ? surviveSet : downSelfSet;
  }

  private reset(): void {
    this.decision = null;
    this.acquiring = false;
    this.lastFingerprint = null;
  }

  private fingerprintOf(
    reachable: ReadonlyArray<{ address: { toString(): string } }>,
    unreachable: ReadonlyArray<{ address: { toString(): string } }>,
  ): string {
    const r = reachable.map((m) => m.address.toString()).sort().join(',');
    const u = unreachable.map((m) => m.address.toString()).sort().join(',');
    return `R[${r}]|U[${u}]`;
  }
}
