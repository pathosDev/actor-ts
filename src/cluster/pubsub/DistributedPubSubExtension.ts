import type { ActorRef } from '../../ActorRef.js';
import type { ActorSystem } from '../../ActorSystem.js';
import { extensionId, type Extension, type ExtensionId } from '../../Extension.js';
import { Props } from '../../Props.js';
import type { Cluster } from '../Cluster.js';
import type { EnvelopeMsg } from '../Protocol.js';
import {
  DistributedPubSubMediator,
  mediatorPath,
} from './DistributedPubSubMediator.js';
import { DistributedPubSubOptions } from './DistributedPubSubOptions.js';
import type {
  GetTopics,
  Publish,
  Subscribe,
  Unsubscribe,
  UnsubscribeAll,
} from './Messages.js';

type MediatorMessage = Subscribe | Unsubscribe | UnsubscribeAll | Publish | GetTopics;

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
    // into the builder before constructing the (builder-only) mediator.
    const mediator = this.system.spawn(
      Props.create(() => new DistributedPubSubMediator(options.withCluster(cluster))),
      'pubsub-mediator',
    );
    this._mediator = mediator as ActorRef<MediatorMessage>;

    // Route inbound publishes (remote → local) to the mediator's mailbox.
    cluster._registerEnvelopeHandler(
      mediatorPath(cluster.system.name),
      (env: EnvelopeMsg) => mediator.tell(env.body as never),
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
