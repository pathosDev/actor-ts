import {
  addrKey,
  type ClusterPartitionView,
  type DowningDecision,
  type DowningProvider,
} from './DowningProvider.js';

export interface KeepMajoritySettings {
  /** If set, only members carrying this role count toward the majority. */
  readonly role?: string;
}

/**
 * "Keep majority" — if the reachable side has strictly more than half of
 * the known members, the minority (unreachable) side is downed.  The minority
 * side, seeing itself in the minority, downs itself.  Ties (exactly 50/50)
 * stay pending — the operator must intervene or another strategy must take
 * over.
 *
 * With a `role` restriction only role-tagged members are counted; useful
 * when you run stateful and stateless nodes in the same cluster.
 */
export class KeepMajority implements DowningProvider {
  constructor(private readonly settings: KeepMajoritySettings = {}) {}

  decide(view: ClusterPartitionView): DowningDecision {
    const candidates = view.allMembers.filter((m) =>
      (m.status === 'up' || m.status === 'leaving' || m.status === 'unreachable') &&
      (!this.settings.role || m.hasRole(this.settings.role))
    );
    if (candidates.length === 0) return new Set();

    const reachable = candidates.filter((m) => !view.unreachable.has(addrKey(m)));
    const unreachable = candidates.filter((m) => view.unreachable.has(addrKey(m)));

    const n = candidates.length;
    const needed = Math.floor(n / 2) + 1;

    if (reachable.length >= needed) {
      // Majority on our side: down the unreachable partition.
      return new Set(unreachable.map(addrKey));
    }
    if (unreachable.length >= needed) {
      // We're the minority — down ourselves and every reachable peer on
      // this side of the split.
      return new Set(reachable.map(addrKey));
    }
    // Exact tie or insufficient info — remain pending.
    return new Set();
  }
}
