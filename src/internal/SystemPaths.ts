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
   * Mark the whole subtree as tooling — see `PropsConfig.internal`.  Set on
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
