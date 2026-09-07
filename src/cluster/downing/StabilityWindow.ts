import {
  unreachableArbitrationDeadlineMs,
  unstableEscalationDeadlineMs,
} from './SplitBrainResolverOptions.js';

/**
 * The stability window in front of the split-brain resolver (#839) — when a
 * `DowningProvider` may be consulted, and when a view that never settles
 * escalates instead.
 *
 * A class of its own rather than three fields and two methods on `Cluster`,
 * because every guard in here is load-bearing and none of them was reachable
 * from a test while they lived there.  Four separate lines could be deleted
 * with the whole cluster suite staying green — the first-observation conjunct
 * below differs from its absence by a single tick, which no live cluster can
 * be made to observe reliably.  With the clock injected, each is a two-line
 * unit test.
 *
 * No timer of its own: `Cluster.evaluateDowning` calls {@link observe} from
 * the failure-detection tick, so the window's resolution is
 * `failure-detector.heartbeat-interval`.  All three methods take `now` from
 * that one call site so a single tick cannot straddle two readings of the
 * clock.
 *
 * The intended call order is {@link observe}, then — only when it answered
 * `false` — {@link takeEscalation} and then {@link hasOutlastedChurn}.
 * `observe` is what maintains the state the other two read, and escalation is
 * asked first because stopping a cluster that cannot converge outranks
 * arbitrating one peer inside it.
 */
export class StabilityWindow {
  /**
   * The view fingerprint {@link stableSince} refers to, and when it was first
   * seen — the ordinary window's whole state.
   *
   * Deliberately separate from `Cluster`'s `lastDownedView`, which answers a
   * different question: that one is "did we already act on this exact view",
   * this one is "has this view held long enough to be worth acting on".
   * Collapsing them would make an applied decision reset the window and an
   * unchanged view suppress it, which are each other's opposite.
   */
  private currentView: string | null = null;
  private stableSince = 0;
  /**
   * When the current run of view changes began, or `null` while the view is
   * settled — the only state `down-all-when-unstable` needs.
   *
   * Cleared the moment a full `stableAfterMs` elapses without a change, so the
   * escalation deadline measures *uninterrupted* churn rather than the age of
   * the cluster's last quiet moment.
   */
  private unstableSince: number | null = null;
  /**
   * When each currently-unreachable address was *first* seen unreachable in an
   * uninterrupted run — the state behind {@link hasOutlastedChurn}.
   *
   * An address that recovers loses its entry, so a peer that flaps starts its
   * clock again and never accumulates its way past the deadline.
   */
  private readonly unreachableSince = new Map<string, number>();

  constructor(
    private readonly stableAfterMs: number,
    private readonly downAllWhenUnstable: boolean,
  ) {}

  /**
   * Fold this tick's view into the window; `true` once the whole view has held
   * still for `stableAfterMs`, which is the ordinary way a provider is
   * consulted.
   *
   * Three states, in the order they are tested: the view just moved (record
   * when, and it is by definition not stable); it has held but not long
   * enough; it has held for a whole window, which also ends whatever run of
   * changes preceded it.
   *
   * The **first** observation is deliberately not counted as a change.  A node
   * that has just started has no previous view to differ from, so treating it
   * as churn would begin every node's life inside an instability run —
   * `down-all-when-unstable` would then be measuring cluster formation.
   */
  observe(fingerprint: string, unreachable: ReadonlySet<string>, now: number): boolean {
    this.trackUnreachableSince(unreachable, now);
    if (fingerprint !== this.currentView) {
      if (this.currentView !== null && this.unstableSince === null) this.unstableSince = now;
      this.currentView = fingerprint;
      this.stableSince = now;
      return false;
    }
    if (now - this.stableSince < this.stableAfterMs) return false;
    this.unstableSince = null;
    return true;
  }

  /**
   * How long the current uninterrupted run of view changes has lasted, once it
   * is long enough for `down-all-when-unstable` to fire — or `null`, which is
   * every other case.
   *
   * **Consuming**: a non-null answer clears the run, so the caller escalates
   * exactly once.  Applying that decision downs this node too, and a second
   * escalation on the way out would announce the whole thing again from a
   * cluster that is already leaving.
   *
   * Two guards before the deadline, and both are load-bearing.  The switch is
   * off unless a deployment asked for it, because this is the one action in
   * the subsystem that ends the cluster rather than a side of it.  And nothing
   * escalates while `unreachable` is empty: a view that moves because members
   * join and leave cleanly is churn, not a partition, and a rolling deploy
   * whose replacements arrive faster than the window is exactly that shape.
   */
  takeEscalation(unreachable: ReadonlySet<string>, now: number): number | null {
    if (!this.downAllWhenUnstable) return null;
    if (unreachable.size === 0) return null;
    const since = this.unstableSince;
    if (since === null) return null;
    const unstableForMs = now - since;
    if (unstableForMs <= unstableEscalationDeadlineMs(this.stableAfterMs)) return null;
    this.unstableSince = null;
    return unstableForMs;
  }

  /**
   * Whether some peer has now been continuously unreachable for longer than
   * {@link unreachableArbitrationDeadlineMs}, which is when the resolver is
   * consulted even though the view is still moving.
   *
   * This is the ceiling on the window.  Without it, churn *anywhere* starves
   * arbitration *everywhere*: the fingerprint covers every member's status, so
   * any join, leave or transition restarts the window, and a deployment whose
   * membership moves more often than `stable-after` never arbitrates a
   * partition at all.
   */
  hasOutlastedChurn(now: number): boolean {
    const deadline = unreachableArbitrationDeadlineMs(this.stableAfterMs);
    for (const since of this.unreachableSince.values()) {
      if (now - since >= deadline) return true;
    }
    return false;
  }

  /**
   * Start a clock for each newly-unreachable address and drop the ones that
   * are no longer unreachable, so {@link hasOutlastedChurn} measures one
   * peer's *uninterrupted* silence rather than the age of the oldest incident.
   */
  private trackUnreachableSince(unreachable: ReadonlySet<string>, now: number): void {
    for (const key of this.unreachableSince.keys()) {
      if (!unreachable.has(key)) this.unreachableSince.delete(key);
    }
    for (const key of unreachable) {
      if (!this.unreachableSince.has(key)) this.unreachableSince.set(key, now);
    }
  }
}
