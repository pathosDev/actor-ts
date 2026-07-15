import { ActorPath } from '../ActorPath.js';
import { ActorRef } from '../ActorRef.js';
import { LogContext } from '../LogContext.js';
import { tracerOf } from '../tracing/TracingExtension.js';
import type { Cluster } from './Cluster.js';
import type { NodeAddress } from './NodeAddress.js';
import type { EnvelopeMessage } from './Protocol.js';

/**
 * A ref whose target lives on a different node.  tell() builds an envelope
 * and hands it to the cluster transport.  Messages MUST be JSON-safe;
 * classes are not preserved by default (only the tag string is sent).
 * Any `ActorRef` instances embedded in the message body are rewritten to
 * wire-safe markers inside `Cluster._sendEnvelope` so they can be
 * reconstructed on the receiving node.
 */
export class RemoteActorRef<TMessage = unknown> extends ActorRef<TMessage> {
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

  tell(message: TMessage, sender: ActorRef | null = null): void {
    // Snapshot caller's MDC + W3C trace context at tell-time so the
    // receiving node can re-install both before delivering to the
    // local actor (#53, #10).  Empty values are omitted so the wire
    // envelope stays unchanged on the no-instrumentation hot path.
    const ctx = LogContext.get();
    const trace = tracerOf(this.cluster.system).injectContext();
    const envelope: EnvelopeMessage = {
      t: 'envelope',
      to: this.targetPath,
      from: sender ? sender.path.toString() : null,
      body: message as unknown,
      tag: (message as { constructor?: { name?: string } })?.constructor?.name,
      ...(Object.keys(ctx).length > 0 ? { context: ctx } : {}),
      ...(trace ? { trace } : {}),
    };
    this.cluster._sendEnvelope(this.targetNode, envelope);
  }

  override toString(): string {
    return `${this.targetNode}${this.targetPath}`;
  }
}
