import { ActorPath } from '../ActorPath.js';
import { ActorRef } from '../ActorRef.js';
import { LogContext } from '../LogContext.js';
import type { Cluster } from './Cluster.js';
import type { NodeAddress } from './NodeAddress.js';
import type { EnvelopeMsg } from './Protocol.js';

/**
 * A ref whose target lives on a different node.  tell() builds an envelope
 * and hands it to the cluster transport.  Messages MUST be JSON-safe;
 * classes are not preserved by default (only the tag string is sent).
 * Any `ActorRef` instances embedded in the message body are rewritten to
 * wire-safe markers inside `Cluster._sendEnvelope` so they can be
 * reconstructed on the receiving node.
 */
export class RemoteActorRef<TMsg = unknown> extends ActorRef<TMsg> {
  readonly path: ActorPath;

  constructor(
    public readonly targetNode: NodeAddress,
    public readonly targetPath: string,
    private readonly cluster: Cluster,
  ) {
    super();
    // Remote path doesn't have a local parent hierarchy; rebuild minimally.
    this.path = new ActorPath(
      targetPath.split('/').pop() ?? 'remote',
      null,
      targetNode.systemName,
    );
  }

  tell(message: TMsg, sender: ActorRef | null = null): void {
    // Snapshot the caller's MDC at tell-time and embed it in the wire
    // envelope so the receiving node can re-install it before
    // delivering to the local actor (#53).  Empty contexts are
    // omitted to keep envelope size unchanged on the no-MDC path.
    const ctx = LogContext.get();
    const envelope: EnvelopeMsg = {
      t: 'envelope',
      to: this.targetPath,
      from: sender ? sender.path.toString() : null,
      body: message as unknown,
      tag: (message as { constructor?: { name?: string } })?.constructor?.name,
      ...(Object.keys(ctx).length > 0 ? { context: ctx } : {}),
    };
    this.cluster._sendEnvelope(this.targetNode, envelope);
  }

  override toString(): string {
    return `${this.targetNode}${this.targetPath}`;
  }
}
