/**
 * The half of `smallest-mailbox` cluster routing that runs on a routee node.
 *
 * It answers exactly one question — "how deep is the mailbox of the actor at
 * this path?" — and holds nothing: no timer, no history, no connection.  One
 * entry in the cluster's envelope-handler map, and a path walk per query.
 */
import { LocalActorRef } from '../../internal/LocalActorRef.js';
import { parsePathSegments } from '../../ActorPath.js';
import type { Cluster } from '../Cluster.js';
import type { NodeAddress } from '../NodeAddress.js';
import {
  MAILBOX_DEPTH_AGENT_PATH,
  isMailboxDepthQuery,
  routeeFullPath,
  type MailboxDepthReportMessage,
} from './MailboxDepthProtocol.js';

/** What {@link agentsByCluster} tracks per cluster. */
type ServedAgent = {
  readonly agent: ClusterMailboxDepthAgent;
  holders: number;
};

/**
 * One agent per cluster, shared by every holder.
 *
 * `Cluster._registerEnvelopeHandler` keys handlers by path, so a second
 * registration on the same path silently replaces the first — and the first
 * holder's release would then delete the *second* holder's entry, leaving the
 * node mute while both believe it is being served.  Reference counting around
 * a single registration is what makes "two routers on one node" and "a router
 * on a node that also serves explicitly" both work.
 *
 * Keyed weakly: a `Cluster` that is garbage collected takes its entry with it.
 */
const agentsByCluster = new WeakMap<Cluster, ServedAgent>();

export class ClusterMailboxDepthAgent {
  private release: (() => void) | null = null;

  private constructor(private readonly cluster: Cluster) {}

  /**
   * Serve mailbox depths on `cluster` until the returned release is called.
   *
   * A `smallest-mailbox` `ClusterRouter` calls this on its own node, which
   * covers the two common shapes for free — a single node, and the homogeneous
   * deployment where every node runs both the router and the routees.  Call it
   * yourself on nodes that host routees but no router:
   *
   * ```ts
   * const stopServing = ClusterMailboxDepthAgent.serve(cluster);
   * ```
   *
   * A node that does not serve simply never reports a depth, and the routers
   * asking it fall back to round-robin order for it — degraded, never broken.
   * Releases are idempotent; releasing twice does not decrement twice.
   */
  static serve(cluster: Cluster): () => void {
    let entry = agentsByCluster.get(cluster);
    if (entry === undefined) {
      entry = { agent: new ClusterMailboxDepthAgent(cluster), holders: 0 };
      entry.agent.start();
      agentsByCluster.set(cluster, entry);
    }
    entry.holders++;
    const held = entry;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held.holders--;
      if (held.holders > 0) return;
      held.agent.stop();
      agentsByCluster.delete(cluster);
    };
  }

  /** @internal Whether `cluster` currently has a live agent — for tests. */
  static _isServing(cluster: Cluster): boolean {
    return agentsByCluster.has(cluster);
  }

  private start(): void {
    if (this.release !== null) return;
    this.release = this.cluster._registerEnvelopeHandler(
      MAILBOX_DEPTH_AGENT_PATH,
      (envelope, from) => this.onEnvelope(envelope.body, from),
    );
  }

  private stop(): void {
    this.release?.();
    this.release = null;
  }

  private onEnvelope(body: unknown, from: NodeAddress): void {
    // The body arrives off the network.  Anything that is not a well-formed
    // query is dropped rather than answered — guessing at malformed input is
    // how a diagnostic lane turns into a reflector.
    if (!isMailboxDepthQuery(body)) return;
    const depth = this.depthAt(body.routeePath);
    // No routee at that path here: stay silent rather than report a zero.  A
    // zero reads as "idle, send me everything", which would pull the whole
    // load onto a node that has nothing to receive it and straight into dead
    // letters.  Silence leaves the node uncached, which the router reads as
    // "no reading" and skips.
    if (depth === null) return;
    const report: MailboxDepthReportMessage = {
      kind: 'mailbox-depth-report',
      node: this.cluster.selfAddress.toString(),
      routeePath: body.routeePath,
      depth,
    };
    // Answer the address the transport authenticated, never one the body
    // claimed — the rule `Cluster.onLeave` was hardened to (#564).  It also
    // means `replyTo` can only ever address an actor on the asker's own node.
    this.cluster._sendEnvelope(from, {
      kind: 'envelope',
      to: body.replyTo,
      from: MAILBOX_DEPTH_AGENT_PATH,
      body: report,
    });
  }

  /**
   * Queued user messages at `routeePath` on this node, or `null` when nothing
   * local lives there.
   *
   * Resolved through `_resolvePath` — the same walk the cluster's own envelope
   * dispatcher does for a `RemoteActorRef` — rather than by scanning
   * `_inspectTree()`.  The tree walk would allocate a `CellInspection` for
   * every actor in the system on every refresh tick, which is a lot of garbage
   * for one number.
   */
  private depthAt(routeePath: string): number | null {
    const full = routeeFullPath(this.cluster.selfAddress.systemName, routeePath);
    const segments = parsePathSegments(full);
    if (segments.length === 0) return null;
    const routee = this.cluster.system._resolvePath(segments).toNullable();
    // Depth lives on the cell and not on `ActorRef`, deliberately — see
    // `ActorCell.mailboxSize`.  Only framework code may look, and this is it.
    return routee instanceof LocalActorRef ? routee.getCell().mailboxSize : null;
  }
}
