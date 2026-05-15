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
 *
 * **Slow / hung acquire (#142 split-brain hardening)**
 *
 * If `lease.acquire()` hasn't resolved by `acquireTimeoutMs`, the
 * defence-in-depth logic kicks in:
 *
 *   - **Epoch invalidation** — every kickoff captures a monotonic
 *     `acquireEpoch`.  The timeout-recovery bumps the epoch, so a
 *     late-arriving result from the timed-out attempt is dropped
 *     (it can't write a stale `decision`).
 *   - **Release-on-abandon** — we fire-and-forget `lease.release()`
 *     to undo any acquire that may have succeeded on the wire
 *     after we gave up locally.  Without this, an acquire that
 *     timed out on the client but succeeded on the server leaves
 *     the lease record claimed without anyone observing the win —
 *     a classic stale-token split-brain vector.
 *   - **Fail-safe on release failure** — if the abandoning release
 *     itself rejects, the lease state is now ambiguous (we may or
 *     may not hold it; we can't tell).  The strategy enters
 *     fail-safe: every subsequent `decide()` for the same partition
 *     view returns an empty decision, refusing to claim majority
 *     until the partition heals (which resets the fail-safe flag).
 *
 * **Fencing tokens (optional)**
 *
 * If the underlying `Lease` implements `acquireWithToken()` (K8s
 * Lease's `resourceVersion`, Redis SETNX with counter, etc.), the
 * strategy uses it instead of plain `acquire()`.  The token isn't
 * inspected at decide-time — the local epoch is the source of
 * truth for "is this result still valid?" — but having the token
 * means tighter integration with the underlying lease's native
 * fencing primitive (e.g. release-with-token semantics, when
 * future work adds them).
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

  /**
   * Monotonic counter incremented on every acquire kickoff AND on
   * every timeout / reset.  `runAcquire` captures the epoch at start
   * and drops its result if the epoch has moved on by the time it
   * resolves — that's the core of #142's stale-acquire protection.
   */
  private acquireEpoch = 0;

  /**
   * Set when an abandoning `release()` itself failed.  The lease's
   * holder identity is now ambiguous and we MUST NOT claim majority
   * until the partition heals (which clears the flag).  See #142.
   */
  private failSafe = false;

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

    // Fail-safe: a prior abandon-release failed and the lease state
    // is ambiguous.  Refuse to claim majority until the partition
    // heals (which clears the flag via reset()).  Refuses to even
    // kick off a fresh acquire — we don't know whether we already
    // hold the lease, so a fresh acquire might "succeed" trivially
    // (same-owner renew) and give us a false win.  #142.
    if (this.failSafe) {
      return new Set();
    }

    if (this.decision !== null) {
      // Cached from a prior tick on this same view.
      return this.decision;
    }

    if (this.acquiring) {
      // Recover if the acquire stalled past its budget.  The Lease
      // implementation is supposed to honour its own retry/timeout
      // settings, but defence-in-depth: if it hasn't resolved by
      // the deadline, bump the epoch (so the late result is dropped)
      // and proactively release any in-flight ownership — see #142.
      if (Date.now() > this.acquireDeadline) {
        this.acquiring = false;
        // Bump the epoch FIRST so the late runAcquire bails out before
        // it can touch `this.decision`.
        this.acquireEpoch += 1;
        // Fire-and-forget release.  If it rejects, the lease state is
        // ambiguous and we must enter fail-safe — see runAbandonRelease.
        void this.runAbandonRelease();
      }
      return new Set();
    }

    const surviveSet = new Set(unreachable.map(addrKey));
    const downSelfSet = new Set(reachable.map(addrKey));

    this.acquiring = true;
    this.acquireDeadline = Date.now() + (this.settings.acquireTimeoutMs ?? 5_000);
    this.acquireEpoch += 1;
    const myEpoch = this.acquireEpoch;
    void this.runAcquire(myEpoch, surviveSet, downSelfSet);
    return new Set();
  }

  /* ------------------------------ internals ------------------------------ */

  /**
   * Run a single acquire attempt, scoped to a captured epoch.  The
   * write to `this.decision` only happens if the epoch is still
   * current at resolve time — that's how we drop stale results
   * from a previously-timed-out attempt.
   */
  private async runAcquire(
    myEpoch: number,
    surviveSet: DowningDecision,
    downSelfSet: DowningDecision,
  ): Promise<void> {
    let won: boolean;
    try {
      // Prefer the fencing-token API when the backend implements it.
      // The token isn't inspected here (local epoch is sufficient for
      // stale detection at decide-time), but using the API where
      // available means the underlying lease's native fencing
      // primitive participates in the round-trip — useful for backend-
      // specific consistency checks and a stepping-stone for future
      // release-with-token semantics.
      if (typeof this.settings.lease.acquireWithToken === 'function') {
        const result = await this.settings.lease.acquireWithToken();
        won = result !== null;
      } else {
        won = await this.settings.lease.acquire();
      }
    } catch {
      // Lease backend unreachable — stay pending.  The next decide()
      // call sees `acquiring=false` (we clear it below) and restarts.
      // But only if our epoch is still current; otherwise the timeout
      // path has already moved on and we should not touch shared state.
      if (myEpoch === this.acquireEpoch) {
        this.acquiring = false;
      }
      return;
    }
    // Stale resolve: the defence-in-depth timeout (or a reset()) has
    // already invalidated this attempt.  Drop the result silently —
    // a fresh acquire is either already in flight or will be kicked
    // off on the next decide().  Critical for #142: without this
    // guard a slow `acquire() → true` could write `decision=surviveSet`
    // after the operator considered the attempt abandoned, producing
    // a split-brain where both sides "win".
    if (myEpoch !== this.acquireEpoch) {
      return;
    }
    this.acquiring = false;
    this.decision = won ? surviveSet : downSelfSet;
  }

  /**
   * Best-effort release of any in-flight ownership after a timeout.
   * If the release itself rejects, the lease state is ambiguous and
   * the strategy enters fail-safe.  Same epoch as the abandoned
   * acquire — if a fresh acquire has already kicked off (incremented
   * epoch beyond ours), the failure isn't ours to act on.
   */
  private async runAbandonRelease(): Promise<void> {
    const myEpoch = this.acquireEpoch;
    try {
      await this.settings.lease.release();
    } catch {
      // Release failed.  We may or may not hold the lease — we can't
      // tell.  Mark fail-safe so we don't claim majority on this
      // view.  But only if our epoch is still current; if a partition
      // heal has already reset() us, this older failure is moot.
      if (myEpoch === this.acquireEpoch) {
        this.failSafe = true;
      }
    }
  }

  private reset(): void {
    this.decision = null;
    this.acquiring = false;
    this.lastFingerprint = null;
    this.failSafe = false;
    // Bump the epoch so any in-flight runAcquire from before the
    // reset drops its result instead of writing to the cleared
    // decision.
    this.acquireEpoch += 1;
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
