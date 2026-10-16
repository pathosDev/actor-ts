import { parsePathSegments } from '../ActorPath.js';
import type { Cluster } from '../cluster/Cluster.js';
import type { ShardRegionRegistrationRefused } from '../cluster/ClusterEvents.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { SystemGroups, shardRegionName, systemActorPath } from '../internal/SystemPaths.js';
import type { HealthCheckResult } from './HealthCheck.js';

/**
 * The `name` a {@link shardRegionRegistered} check reports under:
 * `shard-region:<typeName>`.
 *
 * One name per sharded type, so two gated types are two entries on `/ready`
 * and the one that is failing names itself.  A function rather than a prefix
 * constant, so the format lives in one place and a caller reading the
 * aggregate back finds its result without re-spelling it.
 */
export function shardRegionCheckName(typeName: string): string {
  return `shard-region:${typeName}`;
}

/**
 * A readiness check that passes once this node's region for `typeName` is
 * registered with the coordinator — `ClusterSharding.isRegistered(typeName)`
 * (#1317), reported under {@link shardRegionCheckName} (#1541).
 *
 * The question membership convergence does not answer: a region registers
 * with the coordinator on the leader over a retry timer of its own, so a fully
 * converged cluster can still hold a region the coordinator has not
 * acknowledged, and no shard of the type is placed on a node whose region it
 * has not.  `actor-ts.sharding.healthcheck.names` registers one of these per
 * named type when the node joins (#1465); this is the same check for a type
 * only the code knows about:
 *
 * ```ts
 * healthChecksOf(system).addReadiness(shardRegionRegistered(cluster, 'orders'));
 * ```
 *
 * **It fails rather than going away.**  Nothing removes it on the way out of
 * service — an empty readiness set reads as healthy, so a check taken out
 * would make "not registered" and "nothing gates readiness" the same answer
 * (see `isHealthy`).  It reports `status: false` and stays.
 *
 * The detail tells the three ways of not being registered apart, because each
 * wants something different done: **no region is running** for the type on
 * this node — never started here, or stopped — so start it, or stop gating on
 * it; **the coordinator refused it** over `number-of-shards`, which stays
 * refused until the counts agree or a leader change reaches a coordinator that
 * accepts it; or the region is **running and not acknowledged yet** — after
 * it starts, after a leader change and after an eviction — which resolves on
 * its own.  "Running" is read off the actor tree at the region's well-known
 * path rather than from anything `ClusterSharding` keeps, because its record
 * of started types outlives a region that stopped.
 *
 * Synchronous, because every input is a field read: the check answers what is
 * true now and never waits out a registration inside the probe deadline.  The
 * sharding facade is resolved here, once, rather than on each probe, so a
 * probe never builds one — the first `cluster.sharding` subscribes to the
 * cluster's events, which is work for the moment a check is registered, not
 * for a load balancer's poll.
 *
 * @throws a `RangeError` for an empty `typeName`, which `ClusterSharding.start`
 *   refuses too: a check for it could never pass.
 */
export function shardRegionRegistered(cluster: Cluster, typeName: string): () => HealthCheckResult {
  if (typeName.length === 0) {
    throw new RangeError('shardRegionRegistered: typeName must be a non-empty string');
  }
  const name = shardRegionCheckName(typeName);
  const sharding = cluster.sharding;
  const regionSegments = parsePathSegments(
    systemActorPath(cluster.system.name, SystemGroups.clusterSharding, shardRegionName(typeName)),
  );
  return () => {
    if (sharding.isRegistered(typeName)) return { name, status: true };
    const regionRunning = cluster.system._resolvePath(regionSegments).isSome();
    return {
      name,
      status: false,
      detail: notRegisteredDetail(typeName, regionRunning, sharding.registrationRefusal(typeName)),
    };
  };
}

/** Why the region for `typeName` is not registered, in the words an operator reading `/ready` needs. */
function notRegisteredDetail(
  typeName: string,
  regionRunning: boolean,
  refusal: ShardRegionRegistrationRefused | null,
): string {
  if (!regionRunning) {
    return `no shard region for '${typeName}' is running on this node: it was never started here, or it has stopped`;
  }
  if (refusal !== null) {
    return `the coordinator refused this node's region for '${typeName}': this node is configured with `
      + `${refusal.regionNumShards} shards and the coordinator governs the type with ${refusal.coordinatorNumShards}. `
      + `It stays out of rotation until ${ConfigKeys.sharding.numberOfShards} agrees, or a leader change `
      + 'reaches a coordinator that accepts it';
  }
  return `the shard region for '${typeName}' is running and not registered with the coordinator yet: `
    + 'a region registers after it starts, after a leader change, and again after the coordinator evicts it';
}
