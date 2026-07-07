import {
  addrKey,
  type ClusterPartitionView,
  type DowningDecision,
  type DowningProvider,
} from './DowningProvider.js';
import type { KeepRefereeOptions } from './KeepRefereeOptions.js';

export interface KeepRefereeSettings {
  /**
   * Fixed "referee" address; whichever partition contains it survives.
   * Must match the address format returned by `NodeAddress.toString()`.
   */
  readonly refereeAddress: string;
  /** Additional quorum a.k.a. down-all-if-referee-reachable-but-too-few. */
  readonly downAllIfBelowQuorum?: number;
}

/**
 * "Keep referee" — the partition containing the designated referee node
 * wins.  If the referee is unreachable, this side downs itself.  Optionally
 * enforce a minimum-quorum rule even when the referee is reachable: if the
 * reachable set has fewer than `downAllIfBelowQuorum` members including the
 * referee, shut everyone down rather than run with a shaky majority.
 */
export class KeepReferee implements DowningProvider {
  private readonly settings: KeepRefereeSettings;

  constructor(options: KeepRefereeOptions | Partial<KeepRefereeSettings>) {
    this.settings = options as KeepRefereeSettings;
    if (!this.settings.refereeAddress) throw new Error('KeepReferee: refereeAddress required');
  }

  decide(view: ClusterPartitionView): DowningDecision {
    const candidates = view.allMembers.filter((m) =>
      m.status === 'up' || m.status === 'leaving' || m.status === 'unreachable'
    );
    const referee = candidates.find((m) => addrKey(m) === this.settings.refereeAddress);
    if (!referee) return new Set(); // unknown referee — wait
    const refereeReachable = !view.unreachable.has(addrKey(referee));

    const reachable = candidates.filter((m) => !view.unreachable.has(addrKey(m)));
    const unreachable = candidates.filter((m) => view.unreachable.has(addrKey(m)));

    if (refereeReachable) {
      if (this.settings.downAllIfBelowQuorum && reachable.length < this.settings.downAllIfBelowQuorum) {
        // Even the referee side doesn't meet the quorum — down everyone.
        return new Set(reachable.concat(unreachable).map(addrKey));
      }
      return new Set(unreachable.map(addrKey));
    }
    // Referee is on the other side — we lose.
    return new Set(reachable.map(addrKey));
  }
}
