import type { ActorSystem } from '../ActorSystem.js';
import { extensionId, type Extension, type ExtensionId } from '../Extension.js';
import { fromNullable, type Option } from '../util/Option.js';
import type { Cluster } from './Cluster.js';

/**
 * Holds the {@link Cluster} this `ActorSystem` joined, so that anything
 * holding the system can reach it — `system.cluster`,
 * `context.cluster`, `this.cluster` — instead of having it threaded in
 * by hand.
 *
 * `Cluster.join` is the only writer.  That keeps the invariant simple:
 * the slot is filled exactly when a cluster exists, and nothing else
 * has to remember to register.
 *
 * It stays `Option` rather than being created on demand because a
 * cluster is not free — it binds a transport and starts gossip,
 * heartbeat and failure-detection timers.  A local-only system must
 * never grow one just because someone asked.
 */
export class ClusterExtension implements Extension {
  private cluster: Cluster | null = null;
  private readonly registrationListeners: Array<(cluster: Cluster) => void> = [];

  /** The joined cluster, or `None` on a system that never joined one. */
  get(): Option<Cluster> {
    return fromNullable(this.cluster);
  }

  /**
   * @internal Called from `Cluster.join`.
   *
   * Last-join-wins: a system that `leave()`s and joins again gets a
   * brand-new `Cluster` instance, and callers must see that one rather
   * than the dead predecessor.  Leaving deliberately does *not* clear
   * the slot — a left cluster still answers `selfAddress` and its final
   * member view, which is what shutdown paths read.
   */
  _register(cluster: Cluster): void {
    this.cluster = cluster;
    for (const listener of [...this.registrationListeners]) listener(cluster);
  }

  /**
   * @internal Observe every future registration — including the rollback
   * re-register of a failed join and the fresh instance of a rejoin.  The
   * storage advisory (#1356) uses this because a `PersistentActor` may
   * resolve its stores before any cluster exists, and `_register` runs
   * *before* `_start` reads the seed list, so a listener must evaluate the
   * cluster lazily rather than snapshot it here.  Listeners run inside
   * `Cluster.join` and must not throw.
   */
  _onRegister(listener: (cluster: Cluster) => void): void {
    this.registrationListeners.push(listener);
  }

  /**
   * @internal Undo a registration whose `Cluster.join` then failed to
   * start.  Only that rollback path uses it — `leave()` does not.
   */
  _unregister(): void {
    this.cluster = null;
  }
}

export const ClusterExtensionId: ExtensionId<ClusterExtension> =
  extensionId<ClusterExtension>(
    'actor-ts/cluster',
    () => new ClusterExtension(),
  );

/**
 * Convenience accessor mirroring `metricsOf` / `tracerOf` —
 * `clusterOf(system)` is the joined cluster, or `None`.
 *
 * Equivalent to `system.cluster`, which is the form to prefer in
 * application code; this exists for call sites that already work in
 * terms of a system and want the lookup without the property.
 */
export function clusterOf(system: ActorSystem): Option<Cluster> {
  return system.extension(ClusterExtensionId).get();
}
