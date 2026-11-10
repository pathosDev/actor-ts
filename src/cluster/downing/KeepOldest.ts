import {
  addrKey,
  type ClusterPartitionView,
  type DowningDecision,
  type DowningProvider,
} from './DowningProvider.js';
import { DEFAULT_KEEP_OLDEST_DOWN_IF_ALONE } from './KeepOldestOptions.js';
import type { KeepOldestOptions, KeepOldestOptionsType } from './KeepOldestOptions.js';

/**
 * "Keep oldest" — whichever partition contains the oldest cluster member
 * survives; the other side is downed.  "Oldest" is the lowest address when
 * addresses are compared lexicographically — consistent with the leader
 * election in this project.
 *
 * With `downIfAlone` (on by default) an oldest that is the only member on its
 * side loses against a group of two or more on the other, so a crash of the
 * oldest leaves the rest running instead of downing every survivor (#932).
 *
 * Which means the name promises something it does not deliver, and it is worth
 * being blunt about it because an operator picks this strategy *for* its
 * tiebreak: no join sequence travels in the gossip payload, so a member that
 * joined a minute ago outranks one that has been up for a week whenever its
 * address sorts lower.  Choose it for a deterministic, agreed tiebreak and pin
 * the address of the node that should survive — not in the expectation that a
 * long-running coordinator wins (#525).
 */
export class KeepOldest implements DowningProvider {
  private readonly options: KeepOldestOptionsType;

  constructor(options: KeepOldestOptions = {}) {
    this.options = options as KeepOldestOptionsType;
  }

  decide(view: ClusterPartitionView): DowningDecision {
    const candidates = view.allMembers.filter((m) =>
      (m.status === 'up' || m.status === 'leaving' || m.status === 'unreachable') &&
      (!this.options.role || m.hasRole(this.options.role))
    );
    const reachable = candidates.filter((m) => !view.unreachable.has(addrKey(m)));
    const unreachable = candidates.filter((m) => view.unreachable.has(addrKey(m)));
    // No partition among the candidates, nothing to resolve.
    if (unreachable.length === 0) return new Set();

    // Oldest = lowest address (sorted by compareTo).
    const oldest = [...candidates].sort((a, b) => a.address.compareTo(b.address))[0]!;
    const downIfAlone = this.options.downIfAlone ?? DEFAULT_KEEP_OLDEST_DOWN_IF_ALONE;

    if (!view.unreachable.has(addrKey(oldest))) {
      // The oldest is on this side, which survives — unless the oldest is all
      // this side is, against a group on the other.
      if (downIfAlone && reachable.length === 1 && unreachable.length >= 2) {
        return new Set(reachable.map(addrKey));
      }
      return new Set(unreachable.map(addrKey));
    }
    // The oldest is on the other side, which survives — unless it is alone
    // there and this side is a group: crashed, or cut off on its own.  Without
    // this arm the crash of the oldest made every survivor down itself (#932).
    if (downIfAlone && unreachable.length === 1 && reachable.length >= 2) {
      return new Set(unreachable.map(addrKey));
    }
    return new Set(reachable.map(addrKey));
  }
}
