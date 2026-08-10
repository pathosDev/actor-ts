/**
 * The router-side half of `smallest-mailbox` cluster routing: a cache of how
 * deep each routee node's mailbox was when it last said, refreshed on a
 * scheduler tick in the background.
 *
 * **Why a cache and not a question.**  The obvious design — ask every routee
 * how deep it is, then route — cannot be built here.  `ClusterRouterActor`
 * routes synchronously inside `onReceive`, so awaiting a cross-node round-trip
 * per message would park the router's whole mailbox behind the network and
 * reorder everything behind it.  The depth is therefore always read from a
 * possibly slightly stale local map, and the routing decision stays as
 * synchronous as round-robin's modulo.
 *
 * That makes this a **push-shaped lane wearing a pull-shaped protocol**: the
 * refresh tick is the interval at which load information propagates, and the
 * cache is what routing reads.  #884 ("load-metrics gossip and adaptive
 * routing") occupies the same design space with a broader remit — several
 * signals, gossiped rather than polled.  This is kept deliberately small and
 * self-contained so that work can absorb or replace it wholesale: nothing
 * outside this file and {@link MailboxDepthAgent} knows how a depth was
 * obtained.
 *
 * **What staleness costs.**  A reading up to one refresh interval old can send
 * a message to a routee that has since filled up.  That is a worse decision
 * than the local `smallestMailboxStrategy` makes, never a wrong one: the
 * message is still delivered, and the next tick corrects the view.  The
 * failure mode round-robin has — handing a routee its next turn while it is
 * still behind — is what this removes even at one interval of lag.
 */
import type { Cancellable } from '../../Scheduler.js';
import type { Cluster } from '../Cluster.js';
import type { NodeAddress } from '../NodeAddress.js';
import {
  MAILBOX_DEPTH_AGENT_PATH,
  type MailboxDepthQueryMessage,
  type MailboxDepthReportMessage,
} from './MailboxDepthProtocol.js';
import { ClusterMailboxDepthAgent } from './MailboxDepthAgent.js';

/** What one node last reported. */
type CachedDepth = {
  readonly depth: number;
  readonly receivedAtMs: number;
};

/** Anything the probe can choose between — a `RemoteActorRef`, in practice. */
type NodeScopedRoutee = {
  readonly targetNode: NodeAddress;
};

export class MailboxDepthProbe {
  private readonly depths = new Map<string, CachedDepth>();
  private timer: Cancellable | null = null;
  private releaseAgent: (() => void) | null = null;
  private nodes: () => ReadonlyArray<NodeAddress> = () => [];

  constructor(
    private readonly cluster: Cluster,
    /** Full actor path of the owning router — where reports are delivered. */
    private readonly replyToPath: string,
    /** The routee path this probe asks about, e.g. `/user/worker`. */
    private readonly routeePath: string,
    /** Age at which a cached reading stops counting; `0` disables the expiry. */
    private readonly staleAfterMs: number,
  ) {}

  /**
   * Begin refreshing every `refreshMs`, over whatever `nodes` reports at each
   * tick — the routee set is rebuilt on membership changes, so it is read
   * afresh rather than captured.
   *
   * The first refresh runs immediately instead of after one interval, so a
   * router that starts into an already-formed cluster is warm within one
   * round-trip rather than one interval plus one round-trip.
   */
  start(refreshMs: number, nodes: () => ReadonlyArray<NodeAddress>): void {
    if (this.timer !== null) return;
    this.nodes = nodes;
    // The local node is a routee like any other, so this node has to answer
    // too — and in the homogeneous deployment (a router on every node) this
    // one call is the whole of the routee-side setup.
    this.releaseAgent = ClusterMailboxDepthAgent.serve(this.cluster);
    this.refreshNow();
    this.timer = this.cluster.system.scheduler.scheduleAtFixedRateFunction(
      refreshMs,
      refreshMs,
      () => this.refreshNow(),
    );
  }

  /** Stop refreshing and drop the cache. */
  stop(): void {
    this.timer?.cancel();
    this.timer = null;
    this.releaseAgent?.();
    this.releaseAgent = null;
    this.nodes = () => [];
    this.depths.clear();
  }

  /**
   * Ask every current routee node for a reading, out of band.
   *
   * Fire-and-forget: answers land in the cache whenever they arrive and
   * routing reads whatever is there.  Called on the tick, and again whenever
   * the routee set is rebuilt — a node that just came up would otherwise wait
   * up to a full interval before it could be chosen on merit.
   */
  refreshNow(): void {
    const query: MailboxDepthQueryMessage = {
      kind: 'mailbox-depth-query',
      replyTo: this.replyToPath,
      routeePath: this.routeePath,
    };
    const known = new Set<string>();
    for (const node of this.nodes()) {
      known.add(node.toString());
      this.cluster._sendEnvelope(node, {
        kind: 'envelope',
        to: MAILBOX_DEPTH_AGENT_PATH,
        from: this.replyToPath,
        body: query,
      });
    }
    this.forgetDepartedNodes(known);
  }

  /**
   * Take a node's answer into the cache.
   *
   * The path check is not redundant with the addressing: reports are delivered
   * to the asking router's own actor path, so they already cannot reach the
   * wrong router — but a body that arrived some other way should not be able
   * to install the depth of a different actor under this routee's name.
   */
  record(report: MailboxDepthReportMessage, nowMs = Date.now()): void {
    if (report.routeePath !== this.routeePath) return;
    this.depths.set(report.node, { depth: report.depth, receivedAtMs: nowMs });
  }

  /**
   * The shallowest routee, by the same scan the local `smallestMailboxStrategy`
   * runs — a rotation start, a strict `<`, and an early exit on an empty
   * mailbox.
   *
   * Keeping the two identical is the point: a reader who understands the local
   * strategy understands this one, and the tie behaviour that matters (an idle
   * pool, and a uniformly saturated one, both degrade to round-robin instead of
   * pinning routee 1) comes out the same.  The only difference is where a depth
   * comes from — a cached reading that can be absent or too old, where the
   * local one reads a live cell.
   *
   * A routee with no usable reading is skipped rather than assumed idle: a
   * node that has not answered may be the one that is struggling.  If *no*
   * routee has one — a cold cache, or a cluster where nothing serves depths —
   * the rotation fallback makes the whole strategy behave as round-robin,
   * which is the correct degradation and never a dropped message.
   *
   * `routees` must not be empty; the router checks that before routing.
   */
  pickShallowest<TRoutee extends NodeScopedRoutee>(
    routees: ReadonlyArray<TRoutee>,
    messageIndex: number,
    nowMs = Date.now(),
  ): TRoutee {
    const start = messageIndex % routees.length;
    let shallowest: TRoutee | null = null;
    let shallowestDepth = 0;
    for (let offset = 0; offset < routees.length; offset++) {
      const routee = routees[(start + offset) % routees.length]!;
      const depth = this.depthOf(routee.targetNode.toString(), nowMs);
      if (depth === null) continue;
      if (shallowest === null || depth < shallowestDepth) {
        shallowest = routee;
        shallowestDepth = depth;
        // A depth is never negative, so nothing later in the scan wins under
        // the strict `<`.  An optimisation, not a behaviour change.
        if (depth === 0) break;
      }
    }
    return shallowest ?? routees[start]!;
  }

  /** @internal The reading currently cached for a node — for tests. */
  _depthOf(address: string, nowMs = Date.now()): number | null {
    return this.depthOf(address, nowMs);
  }

  /* ----------------------------- internals ------------------------------ */

  private depthOf(address: string, nowMs: number): number | null {
    const cached = this.depths.get(address);
    if (cached === undefined) return null;
    if (this.staleAfterMs > 0 && nowMs - cached.receivedAtMs > this.staleAfterMs) return null;
    return cached.depth;
  }

  /**
   * Drop readings for nodes that are no longer routees.
   *
   * Unlike the DevTools overview, there is nothing to be learned from a
   * departed node's last figure — it cannot be routed to — and keeping it
   * would let a rejoining address be picked on a reading from its previous
   * incarnation.
   */
  private forgetDepartedNodes(known: ReadonlySet<string>): void {
    for (const address of this.depths.keys()) {
      if (!known.has(address)) this.depths.delete(address);
    }
  }
}
