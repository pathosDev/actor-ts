/**
 * The `stats` stream — the figures behind the overview.
 *
 * Counters are **cumulative**, never per-tick deltas.  The UI keeps a
 * ring of samples and differentiates, so a client that reconnects,
 * throttles, or misses a tick still computes correct rates, and the same
 * series drives both the "per second" tile and the spike-revealing chart
 * underneath it.
 *
 * In a cluster the sample carries both: the total across every node, and
 * each node on its own.  The total is a plain sum of the per-node
 * figures rather than a separately gathered number — two ways of
 * counting the same thing eventually disagree, and then nobody knows
 * which to believe.
 */
import type { ActorSystem } from '../../ActorSystem.js';
import type { Cluster } from '../../cluster/Cluster.js';
import type { Cancellable } from '../../Scheduler.js';
import { detectRuntime } from '../../runtime/detect.js';
import {
  statsSamplePayload,
  type ClusterStatsSummary,
  type DevToolsStreamId,
  type DevToolsStreamPayload,
  type HandlerLatencySummary,
  type MailboxDepthEntry,
  type NodeFigures,
  type NodeSample,
  type StatsHistoryParameters,
  type StatsHistoryResult,
  type StatsSamplePayload,
} from '../protocol/index.js';
import type { DevToolsServer, DevToolsTap } from '../DevToolsServer.js';
import { HISTORY_MAXIMUM_SPAN_MS, StatsHistoryStore } from '../internal/StatsHistoryStore.js';
import { NodeSampler } from '../internal/NodeSampler.js';
import type { DevToolsFederation } from '../cluster/Federation.js';
import type { ClusterMembership } from '../internal/ClusterMembership.js';

/** How many hot mailboxes the overview shows, across all nodes. */
const TOP_MAILBOX_COUNT = 5;

/** Address used for the single node of a system with no cluster. */
const LOCAL_ADDRESS = 'local';

export class StatsTap implements DevToolsTap {
  readonly stream: DevToolsStreamId = 'stats';

  private emit: ((payload: DevToolsStreamPayload) => void) | null = null;
  private ticker: Cancellable | null = null;
  private readonly sampler: NodeSampler;
  /**
   * Kept whether or not anybody is watching.
   *
   * The point of a history is to answer a question asked *after* the
   * interesting thing happened, so recording it only while a panel is
   * open would defeat it.
   */
  private readonly history = new StatsHistoryStore();
  /** Frames are pushed only while somebody is subscribed; the series is not. */
  private subscribed = false;


  constructor(
    private readonly system: ActorSystem,
    private readonly cluster: Cluster | null,
    private readonly intervalMs: number,
    /**
     * Shared with the node agent when there is one: two samplers on one
     * system would install two sets of probes and count everything
     * twice.
     */
    sampler: NodeSampler,
    private readonly federation: DevToolsFederation | null = null,
    private readonly membership: ClusterMembership | null = null,
  ) {
    this.sampler = sampler;
  }

  install(emit: (payload: DevToolsStreamPayload) => void): void {
    this.emit = emit;
    // One ticker, running from attach.  Sampling has to continue with no
    // panel open — a history that only exists while somebody is watching
    // answers no question worth asking — and sampling twice when one is
    // would walk the actor tree twice a second for nothing.
    this.startTicking();
  }

  /** Register the history query on `server`. */
  installMethods(server: DevToolsServer): void {
    server.registerMethod('stats.history', async (p) => this.onHistory(p));
  }

  uninstall(): void {
    this.stopTicking();
    this.emit = null;
  }

  snapshot(): ReadonlyArray<DevToolsStreamPayload> {
    return [this.sample()];
  }

  subscribersChanged(count: number): void {
    this.subscribed = count > 0;
  }

  private startTicking(): void {
    if (this.ticker !== null) return;
    this.ticker = this.system.scheduler.scheduleAtFixedRateFunction(
      this.intervalMs,
      this.intervalMs,
      () => this.tick(),
    );
  }

  private stopTicking(): void {
    this.ticker?.cancel();
    this.ticker = null;
  }

  private tick(): void {
    // Ask first, sample second: this round's peers answer into the next
    // sample.  One interval of lag beats a dashboard that stalls
    // whenever a node does.
    this.federation?.poll();
    const sample = this.sample() as StatsSamplePayload;
    this.history.record(sample);
    if (this.subscribed) this.emit?.(sample);
  }

  private async onHistory(parameters: unknown): Promise<StatsHistoryResult> {
    const request = (parameters ?? {}) as Partial<StatsHistoryParameters>;
    const wanted = request.spanMs;
    if (typeof wanted !== 'number' || !Number.isFinite(wanted) || wanted <= 0) {
      throw new Error('`spanMs` must be a positive number');
    }
    const spanMs = Math.min(wanted, HISTORY_MAXIMUM_SPAN_MS);
    const { resolutionMs, points } = this.history.query(spanMs);
    return { spanMs, resolutionMs, points };
  }

  private sample(): DevToolsStreamPayload {
    const now = Date.now();
    const selfAddress = this.cluster?.selfAddress.toString() ?? LOCAL_ADDRESS;
    const self: NodeSample = {
      figures: this.sampler.figures(selfAddress),
      receivedAtMs: now,
      stale: false,
      isSelf: true,
    };
    const nodes = [self, ...(this.federation?.peers(now) ?? [])];
    const total = totalOf(nodes.map((node) => node.figures));
    const cluster = this.clusterSummary();

    return statsSamplePayload({
      atMs: now,
      uptimeMs: self.figures.uptimeMs,
      runtime: detectRuntime(),
      actorCount: total.actorCount,
      actorsStarted: total.actorsStarted,
      actorsStopped: total.actorsStopped,
      actorsRestarted: total.actorsRestarted,
      deadLetters: total.deadLetters,
      messagesProcessed: total.messagesProcessed,
      mailboxDrops: total.mailboxDrops,
      mailboxBacklog: total.mailboxBacklog,
      stashedTotal: total.stashedTotal,
      suspendedActors: total.suspendedActors,
      ...(total.handlerLatency === undefined ? {} : { handlerLatency: total.handlerLatency }),
      topMailboxes: total.topMailboxes,
      ...(cluster === null ? {} : { cluster }),
      nodes,
    });
  }

  /**
   * The cluster tile, counting the recently departed.
   *
   * A cluster of three that has lost one is "2 / 3 up", not a cluster of
   * two — the missing node is the whole point of looking.
   */
  private clusterSummary(): ClusterStatsSummary | null {
    return this.membership?.summary() ?? null;
  }
}

/** Everything summable, summed; the rest merged sensibly. */
function totalOf(all: ReadonlyArray<NodeFigures>): Omit<NodeFigures, 'address' | 'systemName' | 'uptimeMs'> {
  let actorCount = 0;
  let actorsStarted = 0;
  let actorsStopped = 0;
  let actorsRestarted = 0;
  let deadLetters = 0;
  let messagesProcessed = 0;
  let mailboxDrops = 0;
  let mailboxBacklog = 0;
  let stashedTotal = 0;
  let suspendedActors = 0;
  const mailboxes: MailboxDepthEntry[] = [];

  for (const figures of all) {
    actorCount += figures.actorCount;
    actorsStarted += figures.actorsStarted;
    actorsStopped += figures.actorsStopped;
    actorsRestarted += figures.actorsRestarted;
    deadLetters += figures.deadLetters;
    messagesProcessed += figures.messagesProcessed;
    mailboxDrops += figures.mailboxDrops;
    mailboxBacklog += figures.mailboxBacklog;
    stashedTotal += figures.stashedTotal;
    suspendedActors += figures.suspendedActors;
    mailboxes.push(...figures.topMailboxes);
  }
  mailboxes.sort((a, b) => b.size - a.size);

  return {
    actorCount,
    actorsStarted,
    actorsStopped,
    actorsRestarted,
    deadLetters,
    messagesProcessed,
    mailboxDrops,
    mailboxBacklog,
    stashedTotal,
    suspendedActors,
    ...(latencyOf(all) === null ? {} : { handlerLatency: latencyOf(all)! }),
    topMailboxes: mailboxes.slice(0, TOP_MAILBOX_COUNT),
  };
}

/**
 * Cluster-wide handler latency, weighted by how many messages each node
 * measured.
 *
 * A plain average would let an idle node with one slow message drag the
 * figure as hard as a busy one — the percentile a developer wants is
 * "across all the messages", not "across all the nodes".  Still an
 * approximation of an approximation, and labelled as such in the panel.
 */
function latencyOf(all: ReadonlyArray<NodeFigures>): HandlerLatencySummary | null {
  let count = 0;
  let p50 = 0;
  let p99 = 0;
  for (const figures of all) {
    const latency = figures.handlerLatency;
    if (latency === undefined || latency.count === 0) continue;
    count += latency.count;
    p50 += latency.p50Ms * latency.count;
    p99 += latency.p99Ms * latency.count;
  }
  if (count === 0) return null;
  return { p50Ms: p50 / count, p99Ms: p99 / count, count };
}
