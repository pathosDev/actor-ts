import type { HealthCheckRegistry, HealthCheckResult } from '../management/HealthCheck.js';
import type { Cluster } from './Cluster.js';
import type { Member } from './Member.js';
import type { NodeAddress } from './NodeAddress.js';

/**
 * The `name` of the "self is a full member" readiness check.
 *
 * Exported because `managementRoutes` reads the result back out of the
 * aggregate by name to fill `/ready`'s `clusterReady` field — computing it
 * a second time in the HTTP layer is how the endpoint and the gRPC health
 * service would drift apart.
 *
 * Both names stay here rather than in `src/cluster/Constants.ts`: they are
 * the vocabulary of the results this file produces and of the JSON body a
 * client matches on, not tuned values.
 */
export const CLUSTER_MEMBERSHIP_CHECK_NAME = 'cluster-membership';

/** The `name` of the "not cut off from the cluster" readiness check. */
export const CLUSTER_TRANSPORT_CHECK_NAME = 'cluster-transport';

/**
 * Does this node consider *itself* a full member?
 *
 * Readiness, not liveness: a node still in `joining` is running perfectly
 * well, it has simply not been admitted yet, and routing requests to it
 * before its sharded regions and singletons exist is what a load balancer
 * needs to be told to avoid.
 *
 * `weakly-up` deliberately does not pass.  A weakly-up node was promoted
 * *because* convergence had not been reached, so the cluster does not yet
 * agree it holds anything.
 */
export function selfIsFullMember(members: ReadonlyArray<Member>, self: NodeAddress): boolean {
  return members.some((member) => member.address.equals(self) && member.status === 'up');
}

/**
 * Can this node still reach the cluster it believes it is part of?
 *
 * The predicate is **total isolation**, not "every peer is reachable": it
 * fails only when the node expects at least one peer and has no connection
 * to any of them.  A partial partition leaves the node able to gossip,
 * converge and route, so taking it out of rotation would remove capacity
 * from a cluster that is coping; being cut off from *all* of it is the
 * case where continuing to serve is the split-brain hazard, and it is also
 * the one a node cannot detect from its membership view alone — nothing
 * monitors the local transport, and `maySpeakFor` refuses any peer-supplied
 * downgrade of the local record, so an isolated node's own view of itself
 * stays `up` forever.
 *
 * "Expects a peer" counts every member other than self that is not already
 * terminal, `unreachable` included.  Excluding unreachable members would
 * make the check go green again the moment the failure detector fires —
 * that is, a few seconds into every partition — which is exactly when the
 * answer matters.  A lone survivor whose dead peer was downed (by an
 * operator or a downing provider) has no expected peers left and passes;
 * one whose peer nobody ever downed does not, which is the honest reading
 * of a cluster configured to resolve nothing automatically.
 *
 * A single-node cluster expects nobody and always passes.
 */
export function transportReachesCluster(
  members: ReadonlyArray<Member>,
  self: NodeAddress,
  connectedPeers: ReadonlyArray<NodeAddress>,
): boolean {
  const expected = members.filter((member) =>
    !member.address.equals(self)
    && member.status !== 'down'
    && member.status !== 'removed');
  return expected.length === 0 || connectedPeers.length > 0;
}

/**
 * Install the cluster's framework-owned readiness checks on `health`, and
 * hand back the undo.
 *
 * Called from `Cluster._start`, so the checks exist from the moment the
 * transport is bound — long before anything builds a management route tree
 * or a gRPC health service.  Readiness only: neither signal is something a
 * process restart could repair, so neither belongs in liveness.
 */
export function registerClusterHealthChecks(
  cluster: Cluster,
  health: HealthCheckRegistry,
): () => void {
  const removeMembership = health.addReadiness(() => clusterMembershipResult(cluster));
  const removeTransport = health.addReadiness(() => clusterTransportResult(cluster));
  return () => {
    removeMembership();
    removeTransport();
  };
}

function clusterMembershipResult(cluster: Cluster): HealthCheckResult {
  const members = cluster.getMembers();
  if (selfIsFullMember(members, cluster.selfAddress)) {
    return { name: CLUSTER_MEMBERSHIP_CHECK_NAME, status: true };
  }
  const self = members.find((member) => member.address.equals(cluster.selfAddress));
  return {
    name: CLUSTER_MEMBERSHIP_CHECK_NAME,
    status: false,
    detail: `this node is ${self ? `'${self.status}'` : 'absent'} in its own member view, not 'up'`,
  };
}

function clusterTransportResult(cluster: Cluster): HealthCheckResult {
  const members = cluster.getMembers();
  const peers = cluster.transport.peers();
  if (transportReachesCluster(members, cluster.selfAddress, peers)) {
    return { name: CLUSTER_TRANSPORT_CHECK_NAME, status: true };
  }
  const expected = members.filter((member) => !member.address.equals(cluster.selfAddress)).length;
  return {
    name: CLUSTER_TRANSPORT_CHECK_NAME,
    status: false,
    detail: `no transport connection to any of the ${expected} peer(s) this node still expects`,
  };
}
