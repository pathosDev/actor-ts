/**
 * Which membership view the last applied downing decision was made on, so the
 * same view is not decided twice (#934).
 *
 * The guard exists for one case: a decision that changes nothing — it names
 * members already down, or none this node holds — leaves the view exactly as
 * it was, and without it the provider would be asked, and its verdict applied,
 * on every detection tick for as long as the view held.
 *
 * It used to be a bare field that was written on every decision and never
 * cleared.  Membership is keyed on `system@host:port`, without the incarnation,
 * so a partition that recurred at the same addresses — a node removed,
 * restarted at the same port, and partitioned off again — produced the very
 * fingerprint the first decision had been applied on, and the second
 * partition was skipped without a line in any log.  The fix is to forget the
 * view as soon as the cluster has moved on from it: any change at all, not
 * only a return to full reachability, because a member parked as unreachable
 * the whole time would keep the view from ever being fully reachable.
 *
 * Kept apart from {@link StabilityWindow}, which answers the other question —
 * has a view held long enough to be worth deciding on — and must not be reset
 * by a decision.
 */
export class AppliedDecision {
  private appliedOn: string | null = null;

  /**
   * Show the guard the current view.  Called on every evaluation, ahead of the
   * stability window, so the views a cluster passes through while the window
   * is still holding — a removed member's tombstone, its restart joining —
   * clear the guard too, and are not lost to an early return.
   */
  observe(fingerprint: string): void {
    if (this.appliedOn !== null && this.appliedOn !== fingerprint) this.appliedOn = null;
  }

  /** Whether a decision was already applied on exactly this view. */
  covers(fingerprint: string): boolean {
    return this.appliedOn === fingerprint;
  }

  /** A decision was applied on this view. */
  record(fingerprint: string): void {
    this.appliedOn = fingerprint;
  }
}
