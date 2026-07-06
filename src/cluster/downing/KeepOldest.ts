import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import {
  addrKey,
  type ClusterPartitionView,
  type DowningDecision,
  type DowningProvider,
} from './DowningProvider.js';

export interface KeepOldestSettings {
  /** If set, only members with this role are eligible "oldest". */
  readonly role?: string;
  /**
   * When true, if the oldest member is unreachable the *other* side wins
   * (this flips the rule for paranoid setups where the oldest might be
   * the one that failed).  Default: false.
   */
  readonly downIfAlone?: boolean;
}

/**
 * Fluent builder for {@link KeepOldestSettings}:
 *
 *     new KeepOldest(KeepOldestOptions.create().withRole('backend'));
 */
export class KeepOldestOptions extends OptionsBuilder<KeepOldestSettings> {
  /** Start a fresh builder. */
  static create(): KeepOldestOptions {
    return new KeepOldestOptions();
  }

  /** Only members with this role are eligible to be the "oldest". */
  withRole(role: string): this {
    return this.set('role', role);
  }

  /** When true, if the oldest member is unreachable the other side wins.  Default false. */
  withDownIfAlone(downIfAlone = true): this {
    return this.set('downIfAlone', downIfAlone);
  }
}

/**
 * "Keep oldest" — whichever partition contains the oldest cluster member
 * survives; the other side is downed.  "Oldest" is the lowest address when
 * addresses are compared lexicographically — consistent with the leader
 * election in this project.
 */
export class KeepOldest implements DowningProvider {
  private readonly settings: KeepOldestSettings;

  constructor(options: KeepOldestOptions = KeepOldestOptions.create()) {
    this.settings = options.build() as KeepOldestSettings;
  }

  decide(view: ClusterPartitionView): DowningDecision {
    const candidates = view.allMembers.filter((m) =>
      (m.status === 'up' || m.status === 'leaving' || m.status === 'unreachable') &&
      (!this.settings.role || m.hasRole(this.settings.role))
    );
    if (candidates.length === 0) return new Set();

    // Oldest = lowest address (sorted by compareTo).
    const sorted = [...candidates].sort((a, b) => a.address.compareTo(b.address));
    const oldest = sorted[0]!;
    const oldestReachable = !view.unreachable.has(addrKey(oldest));

    const reachable = candidates.filter((m) => !view.unreachable.has(addrKey(m)));
    const unreachable = candidates.filter((m) => view.unreachable.has(addrKey(m)));

    if (oldestReachable) {
      // Oldest is on our side — down the other side.
      return new Set(unreachable.map(addrKey));
    }

    // Oldest is unreachable.  Default: treat it as if we lose — down ourselves.
    if (this.settings.downIfAlone) {
      return new Set(reachable.map(addrKey));
    }
    // Without the override, the conservative default is still: keep the
    // side with the oldest — which is the *other* side, so we down this one.
    return new Set(reachable.map(addrKey));
  }
}
