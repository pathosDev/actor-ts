/**
 * Where the framework's own actors live.
 *
 * `/user` is the application's namespace; everything the framework spawns for
 * itself belongs under `/system`, grouped by subsystem.  The split is what
 * lets a reader of the actor tree — DevTools, a metric label, a log source —
 * tell "my actors" from "the framework's" without knowing a dozen well-known
 * names, and it gives shutdown a boundary to order against.
 *
 * Group paths are the single source of truth for two things that used to
 * drift: the parent a framework actor is spawned under, and the well-known
 * path a remote node addresses it by.  Those were maintained as separate
 * hand-written string literals, and a mismatch does not throw — it falls
 * through to `Cluster.dispatchEnvelope`'s path-resolution fallback, which
 * delivers the raw body past the handler that was supposed to wrap it.
 * Deriving both from here removes the possibility.
 */
import type { ActorRef } from '../ActorRef.js';
import {
  defaultStrategy,
  stoppingStrategy,
  type SupervisorStrategy,
} from '../Supervision.js';

/**
 * Group paths under `/system`, relative to the system guardian.
 *
 * Nested where a subsystem owns several actors, flat where it owns one:
 * the receptionist is the only actor in its subsystem, so it sits directly
 * in `cluster` rather than getting a level of its own.
 */
export const SystemGroups = {
  devtools: 'devtools',
  cluster: 'cluster',
  clusterSharding: 'cluster/sharding',
  clusterSingleton: 'cluster/singleton',
  clusterPubSub: 'cluster/pubsub',
  clusterCrdt: 'cluster/crdt',
  persistenceProjection: 'persistence/projection',
  delivery: 'delivery',
} as const;

/** A group path a framework actor may be spawned into. */
export type SystemGroup = typeof SystemGroups[keyof typeof SystemGroups];

/** How a group guardian treats its children. */
export type SystemGroupPolicy = {
  /**
   * Applied to the group's children when they fail.  Defaults to restarting,
   * which is what these actors got as children of `/user` — the move to
   * `/system` must not quietly turn a crash into a disappearance.
   */
  readonly strategy: SupervisorStrategy;
  /**
   * Mark the whole subtree as tooling — see `ActorOptionsType.internal`.  Set on
   * the group rather than on each actor because `ActorCell` inherits the mark
   * from the parent, so one flag covers everything the subsystem spawns.
   */
  readonly internal: boolean;
};

const DEFAULT_POLICY: SystemGroupPolicy = {
  strategy: defaultStrategy,
  internal: false,
};

/**
 * DevTools is the one subsystem that stops instead of restarting: its actors
 * observe the system, so a probe that fails on what it observed would fail
 * again on the restart, and a restart loop inside the debugger is worse than
 * a missing panel.  Marking it tooling is what keeps a debugger from tracing
 * itself.
 */
const GROUP_POLICIES: ReadonlyMap<string, SystemGroupPolicy> = new Map([
  [SystemGroups.devtools, { strategy: stoppingStrategy, internal: true }],
]);

/**
 * Policy for the guardian at `groupPath`.
 *
 * Takes a plain string, not a {@link SystemGroup}: a nested group creates
 * intermediate guardians on the way down (`cluster` for `cluster/sharding`),
 * and those paths are not themselves spawn targets.
 */
export function systemGroupPolicy(groupPath: string): SystemGroupPolicy {
  return GROUP_POLICIES.get(groupPath) ?? DEFAULT_POLICY;
}

/* ------------------------- well-known actor names ------------------------ */

/**
 * Names of the framework actors that are addressed by name rather than by a
 * ref — either because a remote node has to reach them without ever having
 * been handed one, or because an extension looks its own actor back up.
 *
 * The names are bare: `mediator`, not `pubsub-mediator`.  The prefixes only
 * existed to keep a dozen unrelated actors from colliding as flat children of
 * `/user`, and inside a group they say the same thing twice.
 */
export const SystemActorNames = {
  devtoolsHub: 'hub',
  receptionist: 'receptionist',
  pubSubMediator: 'mediator',
  distributedData: 'data',
} as const;

/** Shard region for `typeName`, under {@link SystemGroups.clusterSharding}. */
export const shardRegionName = (typeName: string): string => `region-${typeName}`;

/** Shard coordinator for `typeName`, under {@link SystemGroups.clusterSharding}. */
export const shardCoordinatorName = (typeName: string): string => `coordinator-${typeName}`;

/** Singleton manager for `typeName`, under {@link SystemGroups.clusterSingleton}. */
export const singletonManagerName = (typeName: string): string => `manager-${typeName}`;

/**
 * Singleton proxy for `typeName`.  Synthetic — no actor is ever spawned here;
 * `ClusterSingletonProxy` is a bare `ActorRef` that needs a plausible path to
 * report in logs and dead letters.
 */
export const singletonProxyName = (typeName: string): string => `proxy-${typeName}`;

/** Absolute path of a group guardian — the parent of that group's actors. */
export function systemGroupPath(systemName: string, group: SystemGroup): string {
  return `actor-ts://${systemName}/system/${group}`;
}

/**
 * Absolute path of a framework actor, in the form that goes on the wire.
 *
 * The one place a `/system` path is rendered, so a group or name change moves
 * the spawn location and every remote address for it together.
 */
export function systemActorPath(
  systemName: string,
  group: SystemGroup,
  actorName: string,
): string {
  return `${systemGroupPath(systemName, group)}/${actorName}`;
}

/**
 * Assert that a framework actor really landed where its well-known path
 * helper claims.
 *
 * Worth a runtime check because the failure is silent *and* misleading. Every
 * site spawns the actor and registers its envelope handler as two separate
 * calls, keyed on the helper's output; if the two disagree,
 * `Cluster.dispatchEnvelope` misses the per-path handler, falls through to
 * resolving the path itself, and `tell`s the raw envelope body. So a
 * singleton manager receives an unwrapped payload where it expected a
 * `singleton-deliver`, and a coordinator a shape its matcher never handles —
 * no exception, no dropped-message warning, just wrong behaviour later.
 */
export function assertSpawnedAt(expectedPath: string, ref: ActorRef): void {
  const actualPath = ref.path.toString();
  if (actualPath === expectedPath) return;
  throw new Error(
    `Framework actor path mismatch: spawned at '${actualPath}', but the `
    + `well-known path helper says '${expectedPath}'. Remote nodes address it `
    + `by the latter, and a mismatch mis-delivers silently.`,
  );
}
