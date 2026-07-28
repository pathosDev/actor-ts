/**
 * Payload of the `stats` stream — the numbers behind the DevTools
 * dashboard (the landing page every panel is reached from).
 *
 * **Counters are cumulative since attach, never deltas.**  The UI keeps
 * a ring of the last samples and derives rates itself, which means a
 * client that reconnects, throttles, or misses a tick still computes
 * correct rates, and the same series drives both the "per second" tile
 * and the spike-revealing time-series chart.
 */
import type { MailboxDepthEntry } from './ActorStreamFrames.js';

/** Host runtime, mirrored from `RuntimeKind`. */
export type StatsRuntime = 'bun' | 'node' | 'deno';

/**
 * Cluster figures folded into the dashboard; absent when no cluster
 * runs.  Sharding is deliberately not summarised here — the framework
 * never registers sharded types centrally, so a count would either be
 * a guess or a lie.  The cluster panel reports shard maps as the
 * coordinator republishes them.
 */
export interface ClusterStatsSummary {
  readonly members: number;
  readonly up: number;
  readonly unreachable: number;
  readonly leader: string | null;
  readonly selfAddress: string;
}

/**
 * Handler-latency percentiles, interpolated from the framework's
 * `actor_message_handler_seconds` histogram.  Bucket-derived, so they
 * are approximations bounded by the bucket edges — good enough to spot
 * a regression, not a substitute for a real latency profile.  Absent
 * until the histogram has an observation.
 */
export interface HandlerLatencySummary {
  readonly p50Ms: number;
  readonly p99Ms: number;
  readonly count: number;
}

/**
 * One node's figures.
 *
 * The same shape whether the node is the one serving DevTools or a peer
 * reporting over the cluster, so the overview can total them without
 * caring which is which.
 */
export interface NodeFigures {
  /** Cluster address, or `'local'` on a system with no cluster. */
  readonly address: string;
  readonly systemName: string;
  /** Milliseconds since that node's `ActorSystem` was created. */
  readonly uptimeMs: number;
  readonly actorCount: number;
  readonly actorsStarted: number;
  readonly actorsStopped: number;
  readonly actorsRestarted: number;
  readonly deadLetters: number;
  readonly messagesProcessed: number;
  readonly mailboxDrops: number;
  readonly mailboxBacklog: number;
  readonly stashedTotal: number;
  readonly suspendedActors: number;
  readonly handlerLatency?: HandlerLatencySummary;
  readonly topMailboxes: ReadonlyArray<MailboxDepthEntry>;
}

/** A node's figures as the serving node last heard them. */
export interface NodeSample {
  readonly figures: NodeFigures;
  /**
   * When this reached the serving node.  A peer that has stopped
   * answering keeps its last figures with an ageing timestamp, which is
   * more use than a row that disappears.
   */
  readonly receivedAtMs: number;
  /** The node has not answered within the staleness window. */
  readonly stale: boolean;
  /** True for the node serving these DevTools. */
  readonly isSelf: boolean;
}

/** One dashboard sample, emitted on the sampler interval. */
export interface StatsSamplePayload {
  readonly kind: 'stats-sample';
  readonly atMs: number;
  /**
   * Milliseconds since the `ActorSystem` was created — **not** since
   * DevTools attached.  A tool that connects late, or a browser that
   * reloads, must not make the system look younger than it is.
   */
  readonly uptimeMs: number;
  readonly runtime: StatsRuntime;
  /** Live actors, including the guardians. */
  readonly actorCount: number;
  /** Cumulative lifecycle counters since attach. */
  readonly actorsStarted: number;
  readonly actorsStopped: number;
  readonly actorsRestarted: number;
  /** Cumulative dead letters observed on the event stream since attach. */
  readonly deadLetters: number;
  /**
   * Cumulative user messages delivered to `onReceive`, read from the
   * framework's own counter.  Counts from whenever metrics were switched
   * on — which DevTools does at attach if nobody else had.
   */
  readonly messagesProcessed: number;
  /** Cumulative messages a bounded mailbox threw away on overflow. */
  readonly mailboxDrops: number;
  /** Sum of all mailbox depths at sample time — the system-wide backlog. */
  readonly mailboxBacklog: number;
  /** Sum of all stashes at sample time. */
  readonly stashedTotal: number;
  /** Actors currently suspended — the supervision-trouble signal. */
  readonly suspendedActors: number;
  readonly handlerLatency?: HandlerLatencySummary;
  /** Deepest mailboxes, for the dashboard's hot-actor tile. */
  readonly topMailboxes: ReadonlyArray<MailboxDepthEntry>;
  readonly cluster?: ClusterStatsSummary;
  /**
   * Per-node breakdown, newest reading each.
   *
   * Always at least the serving node, so the overview can render "total
   * and per node" the same way whether or not a cluster is involved.
   * The figures above are the sum of these.
   */
  readonly nodes: ReadonlyArray<NodeSample>;
}

/** Payloads carried by the `stats` stream. */
export type StatsStreamPayload = StatsSamplePayload;

/** @internal */
export function statsSamplePayload(sample: Omit<StatsSamplePayload, 'kind'>): StatsSamplePayload {
  return { kind: 'stats-sample', ...sample };
}
