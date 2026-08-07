import type { ActorRef } from '../../ActorRef.js';
import type { ActorSystem } from '../../ActorSystem.js';
import { SystemActorNames, SystemGroups, assertSpawnedAt } from '../../internal/SystemPaths.js';
import { extensionId, type Extension, type ExtensionId } from '../../Extension.js';
import type { Cluster } from '../Cluster.js';
import type { EnvelopeMessage } from '../Protocol.js';
import { mergeOptions } from '../../util/OptionsMerge.js';
import {
  DistributedPubSubMediator,
  mediatorPath,
  type MediatorMessage,
} from './DistributedPubSubMediator.js';
import {
  DistributedPubSubOptions,
  readDistributedPubSubOptionsFromConfig,
  type DistributedPubSubOptionsType,
} from './DistributedPubSubOptions.js';

/**
 * System-wide access to the DistributedPubSubMediator for a given Cluster.
 * Call `DistributedPubSub.get(system, cluster).mediator` to grab a ref
 * and send Subscribe / Publish / … messages to it.
 */
export class DistributedPubSub implements Extension {
  private _mediator: ActorRef<MediatorMessage> | null = null;
  private _cluster: Cluster | null = null;

  constructor(private readonly system: ActorSystem) {}

  /**
   * Bind the mediator to a specific Cluster.  Idempotent per Cluster —
   * re-binding to the same cluster is a no-op; re-binding to a different
   * cluster throws.
   */
  start(cluster: Cluster, options: DistributedPubSubOptions = DistributedPubSubOptions.create()): ActorRef<MediatorMessage> {
    if (this._mediator && this._cluster === cluster) return this._mediator;
    if (this._mediator) throw new Error('DistributedPubSub is already bound to a different cluster');
    this._cluster = cluster;

    // Cluster comes from the positional arg and is authoritative — inject it
    // into the options (builder or plain object) before constructing the
    // mediator.  The tunables layer in the documented order: explicit options
    // beat `actor-ts.cluster.pub-sub.*`, which beats the mediator's built-ins.
    const resolvedOptions: DistributedPubSubOptionsType = {
      ...mergeOptions<DistributedPubSubOptionsType>(
        {},
        readDistributedPubSubOptionsFromConfig(this.system.config),
        options as Partial<DistributedPubSubOptionsType>,
      ),
      cluster,
    };
    const mediator = this.system._spawnSystemActor(
      () => new DistributedPubSubMediator(resolvedOptions),
      SystemGroups.clusterPubSub,
      SystemActorNames.pubSubMediator,
    );
    this._mediator = mediator as ActorRef<MediatorMessage>;

    // Route inbound publishes (remote → local) to the mediator's mailbox.
    // The handler key is the well-known path, so it has to be the path the
    // mediator actually occupies — see `assertSpawnedAt`.
    const wellKnownPath = mediatorPath(cluster.system.name);
    assertSpawnedAt(wellKnownPath, mediator);
    cluster._registerEnvelopeHandler(
      wellKnownPath,
      (env: EnvelopeMessage) => mediator.tell(env.body as never),
    );

    return this._mediator;
  }

  /** The ref of the mediator — throws if `start()` hasn't been called. */
  get mediator(): ActorRef<MediatorMessage> {
    if (!this._mediator) throw new Error('DistributedPubSub.start(cluster) must be called first');
    return this._mediator;
  }

  isStarted(): boolean { return this._mediator !== null; }
}

export const DistributedPubSubId: ExtensionId<DistributedPubSub> = extensionId(
  'DistributedPubSub',
  (system) => new DistributedPubSub(system),
);
