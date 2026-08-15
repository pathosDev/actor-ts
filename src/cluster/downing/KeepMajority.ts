import {
  addrKey,
  type ClusterPartitionView,
  type DowningDecision,
  type DowningProvider,
} from './DowningProvider.js';
import type { KeepMajorityOptions, KeepMajorityOptionsType } from './KeepMajorityOptions.js';

/**
 * "Keep majority" — if the reachable side has strictly more than half of
 * the known members, the minority (unreachable) side is downed.  The minority
 * side, seeing itself in the minority, downs itself.  On an exact 50/50 split
 * **both sides down themselves**, so the cluster stops rather than forking.
 *
 * That last case trades availability for integrity, deliberately.  Returning
 * "pending" instead would leave both halves running for as long as the
 * partition lasts — the view on each side is stable once it settles, so
 * pending is not a transient state here but the permanent outcome — and
 * dual-active is the exact thing a downing strategy exists to prevent (#1170).
 * Prefer an odd member count so the tie never arises; the tie path is the
 * fail-safe, not the plan.
 *
 * With a `role` restriction only role-tagged members are counted; useful
 * when you run stateful and stateless nodes in the same cluster.
 */
export class KeepMajority implements DowningProvider {
  private readonly options: KeepMajorityOptionsType;

  constructor(options: KeepMajorityOptions = {}) {
    this.options = options as KeepMajorityOptionsType;
  }

  decide(view: ClusterPartitionView): DowningDecision {
    const candidates = view.allMembers.filter((m) =>
      (m.status === 'up' || m.status === 'leaving' || m.status === 'unreachable') &&
      (!this.options.role || m.hasRole(this.options.role))
    );
    if (candidates.length === 0) return new Set();

    const reachable = candidates.filter((m) => !view.unreachable.has(addrKey(m)));
    const unreachable = candidates.filter((m) => view.unreachable.has(addrKey(m)));

    const count = candidates.length;
    const needed = Math.floor(count / 2) + 1;

    if (reachable.length >= needed) {
      // Majority on our side: down the unreachable partition.
      return new Set(unreachable.map(addrKey));
    }
    if (unreachable.length >= needed) {
      // We're the minority — down ourselves and every reachable peer on
      // this side of the split.
      return new Set(reachable.map(addrKey));
    }
    // An exact 50/50 split, and only that: with an odd candidate count one
    // side always reaches `needed`, so reaching here means the two sides are
    // equal.  Down our own side.  Each half runs the same computation over
    // its own view, so both halves reach this line and both down themselves —
    // the cluster stops whole instead of forking into two live halves.
    return new Set(reachable.map(addrKey));
  }
}
