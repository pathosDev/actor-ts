import { NodeAddress } from './NodeAddress.js';
import type { MemberData, MemberStatus } from './Protocol.js';

/**
 * Immutable description of a cluster member at a point in time.  Member
 * instances are replaced (not mutated) as their status evolves.  The
 * `version` counter is incremented on every status change and acts as a
 * logical clock for gossip merges.
 */
export class Member {
  readonly roles: ReadonlySet<string>;

  constructor(
    public readonly address: NodeAddress,
    public readonly status: MemberStatus,
    public readonly version: number,
    roles: Iterable<string> = [],
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
    return {
      address: this.address.toJSON(),
      status: this.status,
      version: this.version,
      roles: Array.from(this.roles),
    };
  }

  static fromData(data: MemberData): Member {
    return new Member(
      NodeAddress.fromJSON(data.address),
      data.status,
      data.version,
      data.roles ?? [],
    );
  }

  withStatus(status: MemberStatus): Member {
    return new Member(this.address, status, this.version + 1, this.roles);
  }

  toString(): string {
    const r = this.roles.size > 0 ? ` roles=[${Array.from(this.roles).join(',')}]` : '';
    return `Member(${this.address}, ${this.status}, v${this.version}${r})`;
  }
}
