import { NodeAddress } from './NodeAddress.js';
import type { MemberData, MemberStatus } from './Protocol.js';

/**
 * Immutable description of a cluster member at a point in time.  Member
 * instances are replaced (not mutated) as their status evolves.  The
 * `version` counter is incremented on every status change and acts as a
 * logical clock for gossip merges.
 *
 * `removedAt` is set only on tombstone members (status === 'removed'),
 * via {@link withRemoved}.  It carries the wall-clock instant at which
 * the tombstone was created and gossips to peers so every node prunes
 * the tombstone at roughly the same wall-clock time — see
 * `Cluster.tombstonePruneTick` (#75).
 */
export class Member {
  readonly roles: ReadonlySet<string>;

  constructor(
    public readonly address: NodeAddress,
    public readonly status: MemberStatus,
    public readonly version: number,
    roles: Iterable<string> = [],
    public readonly removedAt?: number,
  ) {
    this.roles = new Set(roles);
  }

  hasRole(role: string): boolean { return this.roles.has(role); }

  isReachable(): boolean {
    return this.status === 'up'
      || this.status === 'weakly-up'
      || this.status === 'joining'
      || this.status === 'leaving';
  }

  toData(): MemberData {
    const data: MemberData = {
      address: this.address.toJSON(),
      status: this.status,
      version: this.version,
      roles: Array.from(this.roles),
    };
    // `removedAt` only ever set on tombstones — omit otherwise to
    // keep gossip bytes proportional to status, not member count.
    return this.removedAt !== undefined
      ? { ...data, removedAt: this.removedAt }
      : data;
  }

  static fromData(data: MemberData): Member {
    return new Member(
      NodeAddress.fromJSON(data.address),
      data.status,
      data.version,
      data.roles ?? [],
      data.removedAt,
    );
  }

  withStatus(status: MemberStatus): Member {
    return new Member(this.address, status, this.version + 1, this.roles, this.removedAt);
  }

  /**
   * Transition into the `removed` tombstone state with a fresh
   * `removedAt` timestamp.  Cluster paths that definitively remove a
   * peer (graceful leave, downing-provider force-down) call this
   * instead of `withStatus('removed')` so the tombstone carries an
   * age — required for `Cluster.tombstonePruneTick` to drop expired
   * tombstones cluster-wide (#75).
   */
  withRemoved(removedAt: number): Member {
    return new Member(this.address, 'removed', this.version + 1, this.roles, removedAt);
  }

  toString(): string {
    const rolesSuffix = this.roles.size > 0 ? ` roles=[${Array.from(this.roles).join(',')}]` : '';
    return `Member(${this.address}, ${this.status}, v${this.version}${rolesSuffix})`;
  }
}
