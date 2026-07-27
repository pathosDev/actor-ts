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

/** One dashboard sample, emitted on the sampler interval. */
export interface StatsSamplePayload {
  readonly kind: 'stats-sample';
  readonly atMs: number;
  /** Milliseconds since `DevTools.attach`. */
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
  /** Sum of all mailbox depths at sample time — the system-wide backlog. */
  readonly mailboxBacklog: number;
  /** Deepest mailboxes, for the dashboard's hot-actor tile. */
  readonly topMailboxes: ReadonlyArray<MailboxDepthEntry>;
  readonly cluster?: ClusterStatsSummary;
}

/** Payloads carried by the `stats` stream. */
export type StatsStreamPayload = StatsSamplePayload;

/** @internal */
export function statsSamplePayload(sample: Omit<StatsSamplePayload, 'kind'>): StatsSamplePayload {
  return { kind: 'stats-sample', ...sample };
}
