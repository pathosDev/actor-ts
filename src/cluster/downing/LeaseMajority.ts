import {
  addrKey,
  type ClusterPartitionView,
  type DowningDecision,
  type DowningProvider,
} from './DowningProvider.js';
import { LeaseMajorityOptionsValidator } from './LeaseMajorityOptions.js';
import type { LeaseMajorityOptions, LeaseMajorityOptionsType } from './LeaseMajorityOptions.js';

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
 *   - **Release-on-abandon** — an acquire that timed out on the
 *     client but succeeded on the server leaves the lease record
 *     claimed with nobody observing the win, and the backend then
 *     renews it forever.  So the abandoned attempt is *tracked*, and
 *     when it finally reports back a win, `lease.release()` undoes
 *     it.  The release deliberately does not fire at timeout time
 *     (#600): the backend has not taken the lease yet at that point,
 *     and `Lease.release()` is contractually a no-op when not held,
 *     so a release fired there could never undo anything.
 *   - **No overlapping attempts** — while an abandoned acquire is
 *     unresolved, `decide()` stays in the waiting state instead of
 *     kicking off a fresh one.  A fresh attempt racing the undo is
 *     the one way this cleanup could cause harm: the same owner
 *     re-acquires cleanly, writes `decision=surviveSet`, and the
 *     late release then deletes the record the strategy is actively
 *     claiming — a split-brain introduced by the fix.
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

  /**
   * Epoch of an acquire we timed out on and stopped watching, until it
   * reports back.  Non-null means an attempt is still in flight with
   * nobody accepting its result — a win has to be released before any
   * fresh attempt may start, so `decide()` waits.  Survives `reset()`
   * on purpose: a partition healing does not make the outstanding
   * ownership go away.  See #600.
   *
   * It clears however the attempt reports — won, lost or rejected — so
   * the wait lasts exactly as long as the backend takes to settle.  A
   * backend whose `acquire()` never settles at all would leave the
   * strategy waiting, which is the same conservative posture it already
   * takes while an acquire is pending; `KubernetesLease` caps its own
   * requests (`k8sApi`'s 10 s socket timeout) so it always settles.
   */
  private abandonedAcquireEpoch: number | null = null;

  private readonly options: LeaseMajorityOptionsType;

  constructor(options: LeaseMajorityOptions) {
    this.options = options as LeaseMajorityOptionsType;
    new LeaseMajorityOptionsValidator().validate(this.options);
  }

  decide(view: ClusterPartitionView): DowningDecision {
    const candidates = view.allMembers.filter((m) =>
      (m.status === 'up' || m.status === 'leaving' || m.status === 'unreachable') &&
      (!this.options.role || m.hasRole(this.options.role)),
    );
    if (candidates.length === 0) return new Set();

    const reachable = candidates.filter((m) => !view.unreachable.has(addrKey(m)));
    const unreachable = candidates.filter((m) => view.unreachable.has(addrKey(m)));
    const count = candidates.length;
    const needed = Math.floor(count / 2) + 1;
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
      // options, but defence-in-depth: if it hasn't resolved by the
      // deadline, stop watching it — see #142.
      if (Date.now() > this.acquireDeadline) {
        this.acquiring = false;
        // Remember which attempt we walked away from, then bump the
        // epoch so the late runAcquire bails out before it can touch
        // `this.decision`.  The undo happens where the backend really
        // holds the lease — runAcquire's stale-resolve branch (#600).
        this.abandonedAcquireEpoch = this.acquireEpoch;
        this.acquireEpoch += 1;
      }
      return new Set();
    }

    // An abandoned attempt has not reported back yet.  Wait rather than
    // start a fresh one: until we know whether it took the lease, a new
    // attempt would race the undo, and the same owner re-acquiring is
    // exactly the case where the undo turns destructive (#600).
    if (this.abandonedAcquireEpoch !== null) {
      return new Set();
    }

    const surviveSet = new Set(unreachable.map(addrKey));
    const downSelfSet = new Set(reachable.map(addrKey));

    this.acquiring = true;
    this.acquireDeadline = Date.now() + (this.options.acquireTimeoutMs ?? 5_000);
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
      if (typeof this.options.lease.acquireWithToken === 'function') {
        const result = await this.options.lease.acquireWithToken();
        won = result !== null;
      } else {
        won = await this.options.lease.acquire();
      }
    } catch {
      // Lease backend unreachable — stay pending.  The next decide()
      // call sees `acquiring=false` (we clear it below) and restarts.
      // But only if our epoch is still current; otherwise the timeout
      // path has already moved on and we should not touch shared state.
      if (myEpoch === this.abandonedAcquireEpoch) {
        // The abandoned attempt reported back, as a failure: it never
        // took the lease, so there is nothing to undo.  Lift the block
        // on fresh attempts.
        this.abandonedAcquireEpoch = null;
      }
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
      if (myEpoch === this.abandonedAcquireEpoch) {
        await this.runAbandonRelease(won);
      }
      return;
    }
    this.acquiring = false;
    this.decision = won ? surviveSet : downSelfSet;
  }

  /**
   * Undo an abandoned acquire, once it has finally reported back.
   *
   * This is where the release belongs (#600).  Firing it from the
   * timeout branch — as the original #142 fix did — could never work:
   * the backend sets its `held` flag only when the network round-trip
   * resolves, and `Lease.release()` is contractually a no-op before
   * then, so the release returned having done nothing while the
   * acquire went on to land, take the lease and start renewing it.
   *
   * If the release itself rejects, the lease state is ambiguous — we
   * may or may not hold it, and we cannot tell — so the strategy
   * enters fail-safe.  That is set unconditionally rather than under
   * an epoch check: a heal that already cleared the flag will clear it
   * again on its next tick, and if a fresh split has appeared instead,
   * refusing to claim majority is the correct posture for a lease we
   * cannot account for.
   */
  private async runAbandonRelease(won: boolean): Promise<void> {
    try {
      // Nothing to undo when the abandoned attempt lost: the backend
      // never took the lease.
      if (won) await this.options.lease.release();
    } catch {
      this.failSafe = true;
    } finally {
      // Cleared last, so `decide()` keeps waiting for the whole
      // duration of the undo rather than racing it with a fresh
      // acquire.
      this.abandonedAcquireEpoch = null;
    }
  }

  private reset(): void {
    this.decision = null;
    this.acquiring = false;
    this.lastFingerprint = null;
    this.failSafe = false;
    // `abandonedAcquireEpoch` is deliberately NOT cleared: an attempt we
    // stopped watching may still take the lease on the wire, and a healed
    // partition does nothing about that.  It clears when that attempt
    // reports back and has been undone.
    // Bump the epoch so any in-flight runAcquire from before the
    // reset drops its result instead of writing to the cleared
    // decision.
    this.acquireEpoch += 1;
  }

  private fingerprintOf(
    reachable: ReadonlyArray<{ address: { toString(): string } }>,
    unreachable: ReadonlyArray<{ address: { toString(): string } }>,
  ): string {
    const reachableKey = reachable.map((m) => m.address.toString()).sort().join(',');
    const unreachableKey = unreachable.map((m) => m.address.toString()).sort().join(',');
    return `R[${reachableKey}]|U[${unreachableKey}]`;
  }
}
