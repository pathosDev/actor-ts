/**
 * One memory of who is in the cluster.
 *
 * The cluster panel and the overview both answer "how many nodes?", and
 * they answered it differently: the panel kept a departed node listed
 * for an hour while the overview read the live membership, so a cluster
 * of three that had lost one showed three rows and "2 / 2 up".  Both now
 * read from here.
 */
import type { Cluster } from '../../cluster/Cluster.js';
import type { Member } from '../../cluster/Member.js';
import {
  CLUSTER_MEMBER_RETENTION_MS,
  type ClusterMemberInfo,
  type ClusterStatsSummary,
} from '../protocol/index.js';

export class ClusterMembership {
  private readonly seen = new Map<string, ClusterMemberInfo>();

  constructor(private readonly cluster: Cluster) {}

  /**
   * Fold the live membership in and age out what has been gone too long.
   *
   * Rebuilt from the cluster's own view each time rather than
   * accumulated from events: the cluster is authoritative, and starting
   * from it means a missed event cannot leave a ghost behind.
   */
  refresh(nowMs = Date.now()): void {
    const live = new Set<string>();
    for (const member of this.cluster.getMembers()) {
      const info = this.toMemberInfo(member, nowMs);
      live.add(info.address);
      this.seen.set(info.address, info);
    }
    for (const [address, info] of this.seen) {
      if (live.has(address)) continue;
      if (nowMs - info.lastSeenAtMs >= CLUSTER_MEMBER_RETENTION_MS) {
        this.seen.delete(address);
      } else if (!info.gone) {
        this.seen.set(address, { ...info, gone: true });
      }
    }
  }

  /** Live members plus everyone recently in the membership. */
  members(nowMs = Date.now()): ReadonlyArray<ClusterMemberInfo> {
    this.refresh(nowMs);
    return [...this.seen.values()];
  }

  /** True once every retained member is gone as well as absent. */
  hasRetained(): boolean {
    for (const info of this.seen.values()) if (info.gone) return true;
    return false;
  }

  /**
   * The overview's cluster tile.
   *
   * `members` counts the retained too, so a cluster of three that has
   * lost one reads "2 / 3 up" rather than quietly becoming a cluster of
   * two — which is the number that matters when something is wrong.
   */
  summary(nowMs = Date.now()): ClusterStatsSummary {
    const all = this.members(nowMs);
    return {
      members: all.length,
      up: all.filter((member) => !member.gone && member.status === 'up').length,
      unreachable: all.filter((member) => member.gone || member.status === 'unreachable').length,
      leader: this.cluster.leader().fold(() => null as string | null, (m) => m.address.toString()),
      selfAddress: this.cluster.selfAddress.toString(),
    };
  }

  private toMemberInfo(member: Member, nowMs: number): ClusterMemberInfo {
    return {
      address: member.address.toString(),
      status: member.status,
      roles: [...member.roles],
      version: member.version,
      isSelf: member.address.equals(this.cluster.selfAddress),
      lastSeenAtMs: nowMs,
      gone: false,
    };
  }
}
