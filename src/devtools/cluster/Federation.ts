/**
 * The serving node's view of every other node.
 *
 * Peers are polled rather than made to push: the serving node already
 * has a sampling tick, and a peer that has stopped answering is then
 * simply a reading that stopped getting newer — which is exactly how it
 * should read on the overview.  Nothing waits for a slow node.
 */
import { STALE_AFTER_MS } from '../Constants.js';
import type { Cluster } from '../../cluster/Cluster.js';
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
  private readonly reports = new Map<string, CachedReport>();
  private round = 0;
  /** Whether the last round asked for actor trees — they are not small. */
  private wantActors = false;

  constructor(private readonly cluster: Cluster) {}

  start(): void {
    if (this.unregister !== null) return;
    this.unregister = this.cluster._registerEnvelopeHandler(
      DEVTOOLS_COLLECTOR_PATH,
      (envelope) => this.onEnvelope(envelope.body),
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
      from: self,
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

  private onEnvelope(body: unknown): void {
    if (!isNodeReport(body)) return;
    const address = body.figures.address;
    if (typeof address !== 'string' || address.length === 0) return;
    // A report from a round we have moved past is still the newest thing
    // that node has said, so it is kept — only its age is what matters.
    this.reports.set(address, {
      figures: body.figures,
      actors: body.actors ?? this.reports.get(address)?.actors ?? null,
      receivedAtMs: Date.now(),
    });
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
