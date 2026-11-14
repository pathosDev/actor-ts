import type { Cluster } from '../../../src/cluster/Cluster.js';
import type { Member } from '../../../src/cluster/Member.js';
import type { MultiNodeSpec } from '../../../src/testkit/MultiNodeSpec.js';

/**
 * Bookkeeping invariants for specs that run several fault episodes against
 * one cluster (#1379).
 *
 * A single-episode spec asserts that the cluster *converged*; these assert
 * that recovery left nothing behind.  The difference is the residue a first
 * recovery hides: a parked-peer entry, a reachability verdict, a tombstone, a
 * gossip high-water mark for a run that is gone.  None of it is visible in a
 * converged membership view, and all of it is what the next episode trips
 * over — so each check here is phrased as "proportional to the current member
 * count", never as "the same as last time", which would bless a residue that
 * was already there after the first episode.
 *
 * The per-node maps are private to `Cluster`.  Reading them is deliberate: the
 * public surface (`getMembers()`) filters tombstones out, and a residue that
 * only the public surface could see would not be residue.
 */

/** The private per-peer maps of one `Cluster`, as sizes and contents. */
type ClusterInternals = {
  readonly members: Map<string, Member>;
  readonly reachability: Map<string, boolean>;
  readonly acceptedGossipSequences: Map<string, number>;
  readonly gossipSenderClocks: Map<string, unknown>;
  readonly parkedWithoutResolver: Set<string>;
  readonly parkedForProvider: Set<string>;
  readonly refusedBy: Set<string>;
  readonly reportedIslands: Set<string>;
};

function internalsOf(cluster: Cluster): ClusterInternals {
  return cluster as unknown as ClusterInternals;
}

/**
 * One node's view, reduced to what two converged nodes must agree on: every
 * member as `address#incarnation=status`, sorted.  The incarnation is in it on
 * purpose — two nodes that agree on statuses but hold different runs of one
 * address are not one cluster.
 */
export function membershipViewOf(cluster: Cluster): string {
  return cluster.getMembers()
    .map((member) => `${member.address.toString()}#${member.address.incarnation ?? '?'}=${member.status}`)
    .sort()
    .join(', ');
}

/** The incarnation `observer` holds for `subject`, or `undefined` when it holds none. */
export function incarnationSeen(spec: MultiNodeSpec, observer: string, subject: string): string | undefined {
  const address = spec.addressFor(subject);
  return spec.clusterFor(observer).getMembers()
    .find((member) => member.address.equals(address))?.address.incarnation;
}

/**
 * Every running role sees exactly `roles`, all `up`, in one identical view
 * (incarnations included), under one leader.  The convergence half — what the
 * single-episode specs already ask.
 */
export function converged(spec: MultiNodeSpec, roles: ReadonlyArray<string>): boolean {
  const views = roles.map((role) => spec.clusterFor(role));
  const reference = membershipViewOf(views[0]!);
  return views.every((cluster) =>
    cluster.getMembers().length === roles.length
    && cluster.getMembers().every((member) => member.status === 'up')
    && membershipViewOf(cluster) === reference
    && roles.every((role) => cluster.getMembers().some((member) => member.address.equals(spec.addressFor(role)))));
}

/**
 * Every bookkeeping violation on every running role, as readable lines; empty
 * when the cluster carries no residue.  Called once `converged` holds, so it
 * can demand the strict form: nothing parked, nothing unreachable, no
 * tombstone, no per-peer entry for anything that is not a current peer.
 */
export function bookkeepingViolations(
  spec: MultiNodeSpec,
  roles: ReadonlyArray<string>,
  options: { readonly tombstonesFor?: ReadonlyArray<string> } = {},
): string[] {
  const violations: string[] = [];
  const currentAddresses = new Set(roles.map((role) => spec.addressFor(role).toString()));
  const tombstoned = new Set((options.tombstonesFor ?? []).map((role) => spec.addressFor(role).toString()));
  const leaders = new Set<string>();
  for (const role of roles) {
    const cluster = spec.clusterFor(role);
    const internals = internalsOf(cluster);
    const self = spec.addressFor(role).toString();
    // A tombstone is still a record in the member map, and the per-peer
    // gossip marks are bounded by that map rather than by the live members
    // (they leave with `deleteMember`), so a tombstoned address may keep them.
    const peers = new Set([...currentAddresses, ...tombstoned].filter((address) => address !== self));

    // The member map holds tombstones too: a converged cluster holds exactly
    // the current members plus one tombstone per removal the caller expects.
    const expectedRecords = roles.length + tombstoned.size;
    if (internals.members.size !== expectedRecords) {
      violations.push(`${role}: member map holds ${internals.members.size} records, expected ${expectedRecords} (${[...internals.members.values()].map((member) => `${member.address.toString()}=${member.status}`).join(', ')})`);
    }
    for (const member of internals.members.values()) {
      const address = member.address.toString();
      if (tombstoned.has(address)) {
        if (member.status !== 'removed') violations.push(`${role}: ${address} should be a tombstone, is ${member.status}`);
        continue;
      }
      if (member.status !== 'up') violations.push(`${role}: ${address} is ${member.status}`);
      if (!currentAddresses.has(address)) violations.push(`${role}: holds a record for ${address}, not a current member`);
    }
    for (const [address, reachable] of internals.reachability) {
      if (!reachable) violations.push(`${role}: still holds ${address} unreachable`);
      if (!currentAddresses.has(address)) violations.push(`${role}: reachability entry for ${address}, not a current member`);
    }
    for (const [name, keys] of [
      ['accepted gossip sequence', internals.acceptedGossipSequences.keys()],
      ['gossip sender clock', internals.gossipSenderClocks.keys()],
    ] as const) {
      for (const address of keys) {
        if (!peers.has(address)) violations.push(`${role}: ${name} for ${address}, not a current peer`);
      }
    }
    for (const [name, set] of [
      ['parked without resolver', internals.parkedWithoutResolver],
      ['parked for provider', internals.parkedForProvider],
      ['refused by', internals.refusedBy],
      ['reported foreign island', internals.reportedIslands],
    ] as const) {
      if (set.size > 0) violations.push(`${role}: ${name} still holds ${[...set].join(', ')}`);
    }
    leaders.add(cluster.leader().fold(() => 'none', (member) => member.address.toString()));
  }
  if (leaders.size !== 1) violations.push(`the nodes name ${leaders.size} leaders: ${[...leaders].join(', ')}`);
  return violations;
}
