import {
  addrKey,
  type ClusterPartitionView,
  type DowningDecision,
  type DowningProvider,
} from './DowningProvider.js';
import { StaticQuorumOptionsValidator } from './StaticQuorumOptions.js';
import type { StaticQuorumOptions, StaticQuorumOptionsType } from './StaticQuorumOptions.js';

/**
 * "Static quorum" — when some member is unreachable, and at least
 * `quorumSize` reachable members are up on this side, keep them and down the
 * rest; otherwise, down ourselves.  With nothing unreachable it decides
 * nothing, however small the cluster is (#933).
 *
 * This is the safest SBR choice when you know the expected cluster size
 * and want to avoid split-brain at the cost of availability when sections
 * shrink below the threshold.
 */
export class StaticQuorum implements DowningProvider {
  private readonly options: StaticQuorumOptionsType;

  constructor(options: StaticQuorumOptions) {
    this.options = options as StaticQuorumOptionsType;
    new StaticQuorumOptionsValidator().validate(this.options);
  }

  decide(view: ClusterPartitionView): DowningDecision {
    const candidates = view.allMembers.filter((m) =>
      (m.status === 'up' || m.status === 'leaving' || m.status === 'unreachable') &&
      (!this.options.role || m.hasRole(this.options.role))
    );

    const reachable = candidates.filter((m) => !view.unreachable.has(addrKey(m)));
    const unreachable = candidates.filter((m) => view.unreachable.has(addrKey(m)));
    // Nothing unreachable is no partition, and a cluster that is merely smaller
    // than `quorumSize` — one still bootstrapping, one scaled down — is not a
    // split to resolve.  Without this the first stable view of a node that had
    // just started downed it (#933).
    if (unreachable.length === 0) return new Set();

    if (reachable.length >= this.options.quorumSize) {
      return new Set(unreachable.map(addrKey));
    }
    // Not enough reachable — we're below quorum, down ourselves.
    return new Set(reachable.map(addrKey));
  }
}
