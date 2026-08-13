/**
 * The serving node's view of every other node.
 *
 * Peers are polled rather than made to push: the serving node already
 * has a sampling tick, and a peer that has stopped answering is then
 * simply a reading that stopped getting newer — which is exactly how it
 * should read on the overview.  Nothing waits for a slow node.
 *
 * Everything in the cache arrived off the cluster wire, so what may land
 * there is bounded on three axes: only a node the cluster currently holds
 * as a member may open a row, the row is keyed on the address the
 * transport supplied rather than the one the report claims for itself,
 * and both the number of rows and one report's actor tree are capped
 * (#593).  A peer that lies now lies only about its own row.
 */
import {
  MAXIMUM_PEER_ACTORS,
  MAXIMUM_PEER_REPORTS,
  STALE_AFTER_MS,
  TOP_MAILBOX_COUNT,
} from '../Constants.js';
import type { Cluster } from '../../cluster/Cluster.js';
import type { NodeAddress } from '../../cluster/NodeAddress.js';
import {
  CLUSTER_MEMBER_RETENTION_MS,
  type ActorNode,
  type NodeFigures,
  type NodeSample,
} from '../protocol/index.js';
import {
  DEVTOOLS_AGENT_PATH,
  DEVTOOLS_COLLECTOR_PATH,
  isNodeReport,
  type NodeQueryMessage,
} from './NodeProtocol.js';

/** What one peer last told us. */
type CachedReport = {
  readonly figures: NodeFigures;
  readonly actors: ReadonlyArray<ActorNode> | null;
  readonly receivedAtMs: number;
};

export class DevToolsFederation {
  private unregister: (() => void) | null = null;
  /** Keyed on the sending peer's authenticated address — see `onEnvelope`. */
  private readonly reports = new Map<string, CachedReport>();
  private round = 0;
  /** Whether the last round asked for actor trees — they are not small. */
  private wantActors = false;

  constructor(private readonly cluster: Cluster) {}

  start(): void {
    if (this.unregister !== null) return;
    this.unregister = this.cluster._registerEnvelopeHandler(
      DEVTOOLS_COLLECTOR_PATH,
      (envelope, from) => this.onEnvelope(envelope.body, from),
    );
  }

  stop(): void {
    this.unregister?.();
    this.unregister = null;
    this.reports.clear();
  }

  /** Include actor trees in subsequent rounds, or stop doing so. */
  requestActors(wanted: boolean): void {
    this.wantActors = wanted;
  }

  /**
   * Ask every peer for a fresh reading.
   *
   * Fire-and-forget by design: answers land in the cache whenever they
   * arrive, and the caller reads whatever is there.  Blocking a
   * dashboard tick on the slowest node in the cluster would make one
   * struggling node look like an outage.
   */
  poll(): void {
    const self = this.cluster.selfAddress.toString();
    const query: NodeQueryMessage = {
      kind: 'devtools-node-query',
      round: ++this.round,
      wantActors: this.wantActors,
    };
    for (const member of this.cluster.getMembers()) {
      const address = member.address.toString();
      if (address === self) continue;
      this.cluster._sendEnvelope(member.address, {
        kind: 'envelope',
        to: DEVTOOLS_AGENT_PATH,
        from: DEVTOOLS_COLLECTOR_PATH,
        body: query,
      });
    }
    this.forgetLongGoneNodes();
  }

  /**
   * Peers as last heard, self excluded — the caller adds its own.
   *
   * A node that has gone quiet keeps its last figures, marked stale.
   * Dropping the row would make a failing node indistinguishable from
   * one that was never there.
   */
  peers(nowMs = Date.now()): ReadonlyArray<NodeSample> {
    const out: NodeSample[] = [];
    for (const cached of this.reports.values()) {
      out.push({
        figures: cached.figures,
        receivedAtMs: cached.receivedAtMs,
        stale: nowMs - cached.receivedAtMs > STALE_AFTER_MS,
        isSelf: false,
      });
    }
    return out;
  }

  /** The actor tree a peer last reported, if it sent one. */
  actorsOf(address: string): ReadonlyArray<ActorNode> | null {
    return this.reports.get(address)?.actors ?? null;
  }

  private onEnvelope(body: unknown, from: NodeAddress): void {
    if (!isNodeReport(body)) return;
    // The address the transport handed us, never the one the body claimed.
    const address = from.toString();
    if (!this.isMember(address)) return;
    this.makeRoomFor(address);
    // A report from a round we have moved past is still the newest thing
    // that node has said, so it is kept — only its age is what matters.
    this.reports.set(address, {
      figures: this.attributedFigures(address, body.figures),
      actors: this.cappedActors(address, body.actors),
      receivedAtMs: Date.now(),
    });
  }

  /**
   * A peer's figures, filed under the address that actually sent them.
   *
   * `peers()` hands `figures` straight to the overview and `ActorTreeTap`
   * looks a peer's tree back up by `figures.address`, so this string is a
   * row key in two panels.  Taken from the body it was the *sender's*
   * choice of key: a peer could file its readings under another node's
   * name, or under a name no node in the cluster has, and the dashboard
   * would show the result as a real node with a real actor tree (#593).
   * Replacing it here means the authenticated address is the only one
   * that ever leaves the collector, which also keeps `actorsOf` resolving.
   */
  private attributedFigures(address: string, reported: NodeFigures): NodeFigures {
    return {
      ...reported,
      address,
      // An honest node sends its busiest `TOP_MAILBOX_COUNT` and no more;
      // beyond that is padding the serving node would re-sort every tick.
      topMailboxes: reported.topMailboxes.slice(0, TOP_MAILBOX_COUNT),
    };
  }

  /**
   * The tree to cache: this round's, capped — or the last one, kept.
   *
   * A round that did not ask for actors carries none, and forgetting the
   * cached tree then would blank the panel between the rounds that do ask.
   */
  private cappedActors(
    address: string,
    reported: ReadonlyArray<ActorNode> | undefined,
  ): ReadonlyArray<ActorNode> | null {
    if (reported === undefined) return this.reports.get(address)?.actors ?? null;
    return reported.length <= MAXIMUM_PEER_ACTORS
      ? reported
      : reported.slice(0, MAXIMUM_PEER_ACTORS);
  }

  /**
   * Whether the cluster currently holds `address` as a member.
   *
   * `poll()` asks members and nobody else, so a report from anywhere else
   * was never solicited.  Gating what may *enter* the cache rather than
   * what stays in it leaves `forgetLongGoneNodes`' hour untouched:
   * `getMembers()` still returns `leaving`, `down` and `unreachable`
   * nodes, so a node on its way out still lands the last reading — the
   * one an operator actually wants afterwards.
   */
  private isMember(address: string): boolean {
    return this.cluster.getMembers().some((member) => member.address.toString() === address);
  }

  /**
   * Evict oldest-first until a new row fits.
   *
   * A backstop: the membership gate above already bounds this map by the
   * cluster's own `maxMembers`.  It is here because those two caps live in
   * different subsystems, and "they will stay in agreement" is not a
   * property anything checks.
   */
  private makeRoomFor(address: string): void {
    if (this.reports.has(address)) return;
    while (this.reports.size >= MAXIMUM_PEER_REPORTS) {
      const oldest = this.oldestReport();
      if (oldest === null) return;
      this.reports.delete(oldest);
    }
  }

  /** The address whose last reading is furthest back, if there is one. */
  private oldestReport(): string | null {
    let oldest: string | null = null;
    let oldestAtMs = Number.POSITIVE_INFINITY;
    for (const [address, cached] of this.reports) {
      if (cached.receivedAtMs >= oldestAtMs) continue;
      oldest = address;
      oldestAtMs = cached.receivedAtMs;
    }
    return oldest;
  }

  /**
   * Forget a departed node only once its last reading is an hour old.
   *
   * Dropping it the moment the cluster does would make it vanish from
   * the overview at the instant it became the interesting one — the same
   * mistake the cluster panel used to make, and the reason both now
   * retain for the same hour.
   */
  private forgetLongGoneNodes(nowMs = Date.now()): void {
    const known = new Set(this.cluster.getMembers().map((member) => member.address.toString()));
    for (const [address, cached] of this.reports) {
      if (known.has(address)) continue;
      if (nowMs - cached.receivedAtMs < CLUSTER_MEMBER_RETENTION_MS) continue;
      this.reports.delete(address);
    }
  }
}
