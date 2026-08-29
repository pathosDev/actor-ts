import { ActorPath, parsePathSegments } from '../ActorPath.js';
import { ActorRef } from '../ActorRef.js';
import { LogContext } from '../LogContext.js';
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
    this.path = remoteActorPath(targetPath, targetNode.systemName);
  }

  tell(message: TMessage, sender: ActorRef | null = null): void {
    // Snapshot caller's MDC + W3C trace context at tell-time so the
    // receiving node can re-install both before delivering to the
    // local actor (#53, #10).  Empty values are omitted so the wire
    // envelope stays unchanged on the no-instrumentation hot path.
    const context = LogContext.get();
    const tracer = this.cluster.system._tracer;
    const trace = tracer === null ? null : tracer.injectContext();
    const envelope: EnvelopeMessage = {
      kind: 'envelope',
      to: this.targetPath,
      from: sender ? sender.path.toString() : null,
      body: message as unknown,
      tag: (message as { constructor?: { name?: string } })?.constructor?.name,
    };
    // Conditional assignment rather than a conditional spread.  `...(cond ? {x}
    // : {})` allocates the empty object on the *false* branch too, so the two
    // fields cost two throwaway objects on every send that carries neither —
    // which is every send on an uninstrumented system (#411).
    if (!LogContext.isEmpty(context)) envelope.context = context;
    if (trace) envelope.trace = trace;
    this.cluster._sendEnvelope(this.targetNode, envelope);
  }

  override toString(): string {
    return `${this.targetNode}${this.targetPath}`;
  }
}

/**
 * Rebuild the target's path as a real hierarchy instead of a single root node.
 *
 * The obvious shortcut — `new ActorPath(lastSegment, null, systemName)` — produces
 * a *root* path, and `ActorPath` renders a root as `actor-ts://<system>/` without
 * its name.  Every remote ref therefore stringified to the same address-less
 * value, which made `.path` useless for logging and, because `ActorRef.equals`
 * compares `path.toString()`, made any two remote refs compare equal (#515).
 * Callers that key a map on `ref.path.toString()` — the receptionist and the
 * pub-sub mediator both do — collapsed every remote entry onto one slot.
 *
 * Building it segment by segment (the shape `ClusterSingletonProxy` already uses)
 * keeps the empty-named root that `render` skips and hangs the real segments off
 * it, so the rendering round-trips back to `targetPath`.
 *
 * **`equals` still cannot separate two nodes.**  `ActorPath` carries only a
 * system name, not the host and port, and in practice every member of a cluster
 * shares one system name — so refs to the same path on different members remain
 * equal.  Distinguishing those needs an authority on `ActorPath` itself; until
 * then `toString()` (which prefixes `targetNode`) is the node-aware rendering.
 *
 * Exported because a ref does not always deliver to the path it *is*: a
 * sharding shard ref keeps the shard's path as its identity while sending
 * through the owning region, and has to build that identity the same way.
 */
export function remoteActorPath(targetPath: string, systemName: string): ActorPath {
  const root = new ActorPath('', null, systemName);
  return parsePathSegments(targetPath).reduce<ActorPath>((path, segment) => path.child(segment), root);
}
