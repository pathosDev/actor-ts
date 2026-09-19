import type { Scheduler } from '../Scheduler.js';
import { ActorPath, canonicalActorPathString, parsePathSegments } from '../ActorPath.js';
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
 *
 * `targetPath` may be given as the bare `/user/name` form or as the full
 * `actor-ts://<system>/user/name` URI; the bare form resolves against the
 * **target node's** system name, and the field holds the full form whichever
 * was passed (#1568).  That field — not `.path` — is the load-bearing one: it
 * goes on the wire as the envelope's `to`, on the death-watch `watch` frame,
 * and into a `WireActorRef` when this ref travels inside a message body, and
 * the far side's `parsePathSegments` reads only the full form.  Normalising
 * `.path` alone would have fixed the label and left delivery and death watch
 * broken.  The reader stays strict for a reason, stated on
 * {@link canonicalActorPathString}; the wire never sees a bare path from here.
 * Any spelling is accepted; any *segment* that `assertValidName` refuses —
 * `.`, `..`, a backslash, a control character — throws from the constructor,
 * bare or full alike, as it does at every other path entry point.
 */
export class RemoteActorRef<TMessage = unknown> extends ActorRef<TMessage> {
  readonly path: ActorPath;
  /** Always the full `actor-ts://…` form, whatever the constructor was handed. */
  readonly targetPath: string;

  constructor(
    public readonly targetNode: NodeAddress,
    targetPath: string,
    private readonly cluster: Cluster,
  ) {
    super();
    this.targetPath = canonicalActorPathString(targetNode.systemName, targetPath);
    this.path = remoteActorPath(this.targetPath, targetNode.systemName);
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

  /**
   * @internal The *sending* node's `actor-ts.actor.ask-timeout` (#863).
   *
   * Deliberately this node's and not the target's: the deadline is the
   * caller's patience, and it arms a timer here.  A cross-node ask between
   * members configured differently therefore behaves the way a local one
   * does — the side that waits decides how long.
   */
  override _defaultAskTimeoutMs(): number {
    return this.cluster.system._defaultAskTimeoutMs;
  }

  override _virtualScheduler(): Scheduler | null { return this.cluster.system._virtualScheduler; }

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
 *
 * Accepts the same two forms the constructor does — bare `/user/x` or full
 * `actor-ts://…` — through {@link canonicalActorPathString}, so every caller
 * gets one semantics; handed the bare form it used to yield the root, the
 * #515 defect back for bare input (#1568).  A full URI's authority is ignored
 * as before: the path is rendered under `systemName`, the node's own.
 */
export function remoteActorPath(targetPath: string, systemName: string): ActorPath {
  const root = new ActorPath('', null, systemName);
  return parsePathSegments(canonicalActorPathString(systemName, targetPath))
    .reduce<ActorPath>((path, segment) => path.child(segment), root);
}
