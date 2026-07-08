import type { ActorRef } from '../../ActorRef.js';
import type { ActorSystem } from '../../ActorSystem.js';
import { extensionId, type ExtensionId } from '../../Extension.js';
import { Props } from '../../Props.js';
import type { Cluster } from '../Cluster.js';
import { fromNullable, type Option } from '../../util/Option.js';
import {
  ClusterSingletonManager,
  singletonManagerPath,
  type SingletonDeliver,
} from './ClusterSingletonManager.js';
import { ClusterSingletonManagerOptions } from './ClusterSingletonManagerOptions.js';
import type { StartSingletonOptions, StartSingletonOptionsType } from './StartSingletonOptions.js';
import { ClusterSingletonProxy } from './ClusterSingletonProxy.js';

export interface SingletonHandle<T> {
  /** Location-transparent ActorRef — tell here, the leader's instance receives. */
  readonly proxy: ClusterSingletonProxy<T>;
  /** Local manager — stopping it takes this node out of rotation. */
  readonly manager: ActorRef;
  /** Stop both proxy and local manager. */
  stop(): void;
}

/**
 * Extension registered on the ActorSystem that manages all
 * ClusterSingletons declared in the process.  Use
 * `system.extension(ClusterSingletonId).start(cluster, ...)` to materialize
 * one; subsequent calls with the same typeName return the same handle.
 */
export class ClusterSingleton {
  private handles = new Map<string, SingletonHandle<unknown>>();
  constructor(private readonly system: ActorSystem) {}

  start<T>(
    cluster: Cluster,
    options: StartSingletonOptions<T>,
  ): SingletonHandle<T> {
    const resolvedOptions = options as StartSingletonOptionsType<T>;
    const existing = this.handles.get(resolvedOptions.typeName);
    if (existing) return existing as SingletonHandle<T>;

    // Register the envelope handler *before* spawning the manager actor so
    // remote proxies that fire during the brief spawn window don't drop.
    // The handler enqueues via the not-yet-existing ref — we close over the
    // same variable and assign below.
    let managerRef: ActorRef = null as unknown as ActorRef;
    const envelopeUnsub = cluster._registerEnvelopeHandler(
      singletonManagerPath(this.system.name, resolvedOptions.typeName),
      (env) => {
        // Route inbound envelopes through the manager's own mailbox so the
        // manager processes them on its own dispatcher thread.
        if (managerRef) managerRef.tell({ t: 'singleton-deliver', body: env.body } as SingletonDeliver as never);
      },
    );

    const managerProps = Props.create(() => {
      const managerOptions = ClusterSingletonManagerOptions.create<T>()
        .withCluster(cluster)
        .withTypeName(resolvedOptions.typeName)
        .withSingletonProps(resolvedOptions.props);
      if (resolvedOptions.role !== undefined) managerOptions.withRole(resolvedOptions.role);
      if (resolvedOptions.lease !== undefined) managerOptions.withLease(resolvedOptions.lease);
      if (resolvedOptions.acquireRetryIntervalMs !== undefined) {
        managerOptions.withAcquireRetryIntervalMs(resolvedOptions.acquireRetryIntervalMs);
      }
      const mgr = new ClusterSingletonManager<T>(managerOptions);
      mgr._envelopeUnsub = envelopeUnsub;
      return mgr;
    });
    managerRef = this.system.spawn(managerProps, `singleton-manager-${resolvedOptions.typeName}`);
    const proxy = new ClusterSingletonProxy<T>(cluster, resolvedOptions.typeName, managerRef);
    const handle: SingletonHandle<T> = {
      proxy, manager: managerRef,
      stop(): void {
        proxy.stop();
        managerRef.stop();
      },
    };
    this.handles.set(resolvedOptions.typeName, handle as SingletonHandle<unknown>);
    return handle;
  }

  /** Look up a previously-started singleton by typeName. */
  get<T>(typeName: string): Option<SingletonHandle<T>> {
    return fromNullable(this.handles.get(typeName) as SingletonHandle<T> | undefined);
  }
}

export const ClusterSingletonId: ExtensionId<ClusterSingleton> = extensionId<ClusterSingleton>(
  'actor-ts/cluster/singleton',
  (system) => new ClusterSingleton(system),
);
