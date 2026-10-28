import { ConfigError, type Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import type { HealthCheckRegistry, HealthCheckResult } from '../management/HealthCheck.js';
import { shardRegionRegistered } from '../management/ReadinessChecks.js';
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
 * fails only when the node expects at least one peer and can reach none of
 * them.  A partial partition leaves the node able to gossip, converge and
 * route, so taking it out of rotation would remove capacity from a cluster
 * that is coping; being cut off from *all* of it is the case where
 * continuing to serve is the split-brain hazard, and it is also the one a
 * node cannot detect from its membership view alone — `maySpeakFor` refuses
 * any peer-supplied downgrade of the local record, so an isolated node's own
 * view of itself stays `up` forever.
 *
 * "Expects a peer" counts every member other than self that is not already
 * terminal, `unreachable` included — except one in `parked`, the peers this
 * node has parked past `down-after` because no downing provider is configured
 * and `failure-detector.auto-down` is off (#1426).  A lone survivor is
 * therefore ready again at `down-after` whichever way the deployment chose:
 * under the shipped `auto-down = on` its dead peer is removed then, and under
 * the opt-out it is parked then, and a parked peer is one nothing will bring
 * back short of its own next heartbeat — which, should it come, makes the peer
 * expected again.  A peer that is unreachable but not yet past `down-after`
 * still counts, so a short blip reads as it always did, and so does one a
 * configured provider is holding: that provider decides, and until it does
 * the survivor stays out of rotation.  A single-node cluster expects nobody
 * and always passes.
 *
 * **"Reachable" needs both an open socket and a failure detector that has
 * not written the peer off**, and needing both is what makes the check see
 * the partition it exists for.  An open socket alone proves nothing: a
 * `TcpTransport` peer is listed by `peers()` from the moment its handshake
 * completes until a FIN or an RST arrives, and the canonical partition —
 * `iptables -j DROP`, a black-holed route, a wedged peer — produces
 * neither.  Nothing in `src/` calls `Transport.disconnect`, and an idle
 * established connection arms no deadline, so the sockets sit in `byPeer`
 * for as long as the kernel keeps retrying: minutes, while the node is
 * exchanging nothing with anybody.  Reading `peers()` on its own therefore
 * missed every silent partition (#655).  Requiring the member not to be
 * `unreachable` hands that half of the judgement to the failure detector,
 * which is the one component that does notice silence.
 *
 * What it still does not detect, stated so the limits are chosen ones:
 *
 *   - **the failure detector's own latency.**  Between the partition and
 *     the detector firing, the node looks ready.  That is the same window
 *     the rest of the cluster reacts on, and shortening it here would only
 *     move the guesswork.
 *   - **a one-way partition in which this node still receives.**  Its peers
 *     keep looking `up`, so it keeps looking ready while nothing it sends
 *     arrives.  Catching that needs an acknowledged round trip — a failure
 *     detector change, not a readiness-check one.
 *   - **an application that cannot serve for its own reasons.**  Readiness
 *     is the conjunction of every registered check; this is one of them.
 */
export function transportReachesCluster(
  members: ReadonlyArray<Member>,
  self: NodeAddress,
  connectedPeers: ReadonlyArray<NodeAddress>,
  parked: ReadonlySet<string> = new Set<string>(),
): boolean {
  const expected = expectedPeers(members, self, parked);
  if (expected.length === 0) return true;
  const connected = new Set(connectedPeers.map((peer) => peer.toString()));
  // Reachability is asserted about an *expected member*, never about a bare
  // connection: `peers()` also lists a `ClusterClient`'s inbound socket, and
  // counting that would let an attached client keep a fully isolated node in
  // the load balancer.
  return expected.some((member) =>
    member.status !== 'unreachable' && connected.has(member.address.toString()));
}

/**
 * Members other than self that this node still expects to be able to reach —
 * neither terminal nor in `parked`, keyed like the member map.
 */
function expectedPeers(
  members: ReadonlyArray<Member>,
  self: NodeAddress,
  parked: ReadonlySet<string>,
): ReadonlyArray<Member> {
  return members.filter((member) =>
    !member.address.equals(self)
    && member.status !== 'down'
    && member.status !== 'removed'
    && !parked.has(member.address.toString()));
}

/**
 * Read `actor-ts.sharding.healthcheck.names` (#1465): the sharded types whose
 * region has to be registered with its coordinator before this node reports
 * ready — one `shardRegionRegistered` check each, installed beside the
 * cluster's own pair.
 *
 * Unset and `[]` read alike, as no check at all, which keeps the key free for
 * every deployment that does not ask.  A type listed twice is gated once.  An
 * empty name is refused rather than gated on: `ClusterSharding.start` refuses
 * one too, so its check could never pass and the node would stay out of
 * rotation for good behind a detail about a region nobody can start.
 */
export function readShardingHealthCheckNamesFromConfig(config: Config): ReadonlyArray<string> {
  const key = ConfigKeys.sharding.healthcheck.names;
  if (!config.hasPath(key)) return [];
  const names = config.getStringList(key);
  for (const [index, name] of names.entries()) {
    if (name.length === 0) {
      throw new ConfigError(
        `${key}[${index}] is empty: list the type name a region is started with, `
        + 'or take the entry out — a check for an empty name could never pass',
      );
    }
  }
  return [...new Set(names)];
}

/**
 * The checks installed on each registry — the cluster pair and one per
 * `healthcheck.names` type — so that a second `Cluster.join` on one system
 * *replaces* its predecessor's checks instead of adding to them.
 *
 * Module-scoped and weakly keyed rather than held on `Cluster`, because the
 * two clusters involved are different objects: `join` builds a new instance
 * every time, and the outgoing one is precisely what nobody holds a
 * reference to any more.  Keyed by the registry because that is the scope
 * the invariant belongs to — one system, one answer to "is this node
 * ready".
 *
 * This is what pays for `leave()` no longer un-registering.  A left cluster
 * keeps reporting DOWN forever (its own view of itself never leaves
 * `leaving`), which is correct for a node that stays left and would be
 * wrong for one that re-joins; retiring the pair at the *registration*
 * point, not at the leave point, is what separates those two cases.
 */
const installedByRegistry = new WeakMap<HealthCheckRegistry, () => void>();

/**
 * Install the cluster's framework-owned readiness checks on `health`, and
 * hand back the undo.
 *
 * Called from `Cluster._start`, so the checks exist from the moment the
 * transport is bound — long before anything builds a management route tree
 * or a gRPC health service.  Readiness only: none of these signals is
 * something a process restart could repair, so none belongs in liveness.
 *
 * Registering retires whatever was on this registry already, so the call is
 * safe to repeat and a re-joined system never inherits a dead incarnation's
 * answer.
 *
 * Beside the pair, one `shardRegionRegistered` check per type
 * `actor-ts.sharding.healthcheck.names` lists (#1465).  Installed here, with
 * the cluster, rather than when `cluster.sharding` is first touched: that
 * facade is built lazily, so a node that never starts a named type would never
 * carry the one check that has to keep it out of rotation.
 */
export function registerClusterHealthChecks(
  cluster: Cluster,
  health: HealthCheckRegistry,
): () => void {
  installedByRegistry.get(health)?.();
  const removals = [
    health.addReadiness(
      () => clusterMembershipResult(cluster.getMembers(), cluster.selfAddress),
    ),
    health.addReadiness(
      () => clusterTransportResult(
        cluster.getMembers(), cluster.selfAddress, cluster.transport.peers(), cluster._parkedPeers(),
      ),
    ),
    ...cluster._shardingHealthCheckNames.map(
      (typeName) => health.addReadiness(shardRegionRegistered(cluster, typeName)),
    ),
  ];
  const remove = (): void => {
    for (const removal of removals) removal();
    // Only clear the slot if it is still ours — a later `join` may already
    // have claimed it, and dropping *its* undo would let the next one
    // accumulate a second pair.
    if (installedByRegistry.get(health) === remove) installedByRegistry.delete(health);
  };
  installedByRegistry.set(health, remove);
  return remove;
}

/**
 * The `cluster-membership` result for one member view.
 *
 * Exported as a pure function so the exact wording an operator reads off
 * `/ready` is assertable without a bound transport — the detail is the only
 * thing that says *why* a node is out of rotation.
 */
export function clusterMembershipResult(
  members: ReadonlyArray<Member>,
  self: NodeAddress,
): HealthCheckResult {
  if (selfIsFullMember(members, self)) {
    return { name: CLUSTER_MEMBERSHIP_CHECK_NAME, status: true };
  }
  const me = members.find((member) => member.address.equals(self));
  return {
    name: CLUSTER_MEMBERSHIP_CHECK_NAME,
    status: false,
    detail: `this node is ${me ? `'${me.status}'` : 'absent'} in its own member view, not 'up'`,
  };
}

/**
 * The `cluster-transport` result for one member view and connection set.
 *
 * The two failure shapes are told apart, because they are not the same
 * operational story: *no socket at all* is a peer that went away, whereas
 * *sockets open and nobody reachable* is a black hole — the partition that
 * leaves every connection intact and delivers nothing.  An operator reading
 * `/ready` should not have to guess which one they have.
 *
 * `parked` is what {@link transportReachesCluster} takes: the peers parked
 * past `down-after` under `auto-down = off`, which the counts in the detail
 * leave out exactly as the verdict does.
 */
export function clusterTransportResult(
  members: ReadonlyArray<Member>,
  self: NodeAddress,
  connectedPeers: ReadonlyArray<NodeAddress>,
  parked: ReadonlySet<string> = new Set<string>(),
): HealthCheckResult {
  if (transportReachesCluster(members, self, connectedPeers, parked)) {
    return { name: CLUSTER_TRANSPORT_CHECK_NAME, status: true };
  }
  const expected = expectedPeers(members, self, parked);
  const connected = new Set(connectedPeers.map((peer) => peer.toString()));
  const stillConnected = expected.filter((member) => connected.has(member.address.toString()));
  return {
    name: CLUSTER_TRANSPORT_CHECK_NAME,
    status: false,
    detail: stillConnected.length === 0
      ? `no transport connection to any of the ${expected.length} peer(s) this node still expects`
      : `no reachable peer among the ${expected.length} this node still expects: `
        + `${stillConnected.length} connection(s) are still open and every peer behind them `
        + `is 'unreachable'`,
  };
}
