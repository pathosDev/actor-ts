import {
  addrKey,
  type ClusterPartitionView,
  type DowningDecision,
  type DowningProvider,
} from './DowningProvider.js';
import type { StaticQuorumOptions } from './StaticQuorumOptions.js';

export interface StaticQuorumSettings {
  /** Exact size of the quorum needed on the reachable side. */
  readonly quorumSize: number;
  /** If set, only members carrying this role count toward quorum. */
  readonly role?: string;
}

/**
 * "Static quorum" — as long as at least `quorumSize` reachable members are
 * up on this side, keep them and down the rest.  Otherwise, down ourselves.
 *
 * This is the safest SBR choice when you know the expected cluster size
 * and want to avoid split-brain at the cost of availability when sections
 * shrink below the threshold.
 */
export class StaticQuorum implements DowningProvider {
  private readonly settings: StaticQuorumSettings;

  constructor(options: StaticQuorumOptions | Partial<StaticQuorumSettings>) {
    this.settings = options as StaticQuorumSettings;
    if (this.settings.quorumSize < 1) {
      throw new Error('StaticQuorum: quorumSize must be >= 1');
    }
  }

  decide(view: ClusterPartitionView): DowningDecision {
    const candidates = view.allMembers.filter((m) =>
      (m.status === 'up' || m.status === 'leaving' || m.status === 'unreachable') &&
      (!this.settings.role || m.hasRole(this.settings.role))
    );

    const reachable = candidates.filter((m) => !view.unreachable.has(addrKey(m)));
    const unreachable = candidates.filter((m) => view.unreachable.has(addrKey(m)));

    if (reachable.length >= this.settings.quorumSize) {
      return new Set(unreachable.map(addrKey));
    }
    // Not enough reachable — we're below quorum, down ourselves.
    return new Set(reachable.map(addrKey));
  }
}
