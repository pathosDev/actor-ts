/**
 * The `stats` stream — the figures behind the dashboard.
 *
 * Counters are **cumulative since attach**, never per-tick deltas.  The
 * UI keeps a ring of samples and differentiates, so a client that
 * reconnects, throttles, or misses a tick still computes correct rates,
 * and the same series drives both the "per second" tile and the
 * spike-revealing chart underneath it.
 */
import type { ActorSystem } from '../../ActorSystem.js';
import type { Cluster } from '../../cluster/Cluster.js';
import type { Cancellable } from '../../Scheduler.js';
import { detectRuntime } from '../../runtime/detect.js';
import { MetricsExtensionId } from '../../metrics/MetricsExtension.js';
import { ActorLifecycleEvent, ActorRestarted, ActorStarted, ActorStopped, DeadLetter } from '../../SystemMessages.js';
import { match, P } from 'ts-pattern';
import {
  statsSamplePayload,
  type ClusterStatsSummary,
  type DevToolsStreamId,
  type DevToolsStreamPayload,
  type MailboxDepthEntry,
} from '../protocol/index.js';
import type { DevToolsTap } from '../DevToolsServer.js';
import { subscribeToEventStream, type EventStreamProbe } from '../internal/EventStreamProbe.js';
import { counterTotal, handlerLatency } from '../internal/MetricsDigest.js';

/** How many hot mailboxes the dashboard tile shows. */
const TOP_MAILBOX_COUNT = 5;

/** Framework counters the dashboard reads back. */
const MESSAGES_DELIVERED = 'actor_messages_delivered_total';
const MAILBOX_DROPPED = 'actor_mailbox_dropped_total';
const HANDLER_SECONDS = 'actor_message_handler_seconds';

export class StatsTap implements DevToolsTap {
  readonly stream: DevToolsStreamId = 'stats';

  private emit: ((payload: DevToolsStreamPayload) => void) | null = null;
  private ticker: Cancellable | null = null;
  private lifecycleProbe: EventStreamProbe | null = null;
  private deadLetterProbe: EventStreamProbe | null = null;
  /** Did *we* switch metrics on?  Only then may we switch them off. */
  private enabledMetrics = false;

  private actorsStarted = 0;
  private actorsStopped = 0;
  private actorsRestarted = 0;
  private deadLetters = 0;

  constructor(
    private readonly system: ActorSystem,
    private readonly cluster: Cluster | null,
    private readonly intervalMs: number,
  ) {}

  install(emit: (payload: DevToolsStreamPayload) => void): void {
    this.emit = emit;
    // Message throughput, mailbox drops and handler latency are already
    // instrumented in the framework — against a noop registry, so every
    // reading is 0 until somebody switches metrics on.  Take that over
    // the way SpanTap takes over the tracer, and hand it back on detach
    // so a system that had metrics off gets them off again.
    const metrics = this.system.extension(MetricsExtensionId);
    if (!metrics.isEnabled()) {
      metrics.enable();
      this.enabledMetrics = true;
    }
    // Counting starts at attach, not at first subscribe: the dashboard
    // should be able to say "312 actors started since you attached",
    // which is impossible if counting begins when a panel opens.
    this.lifecycleProbe = subscribeToEventStream(
      this.system,
      ActorLifecycleEvent,
      (event) => this.onLifecycleEvent(event),
      'devtools-stats',
    );
    this.deadLetterProbe = subscribeToEventStream(
      this.system,
      DeadLetter,
      () => this.onDeadLetter(),
      'devtools-stats-dead-letters',
    );
  }

  uninstall(): void {
    this.stopTicking();
    this.lifecycleProbe?.stop();
    this.deadLetterProbe?.stop();
    this.lifecycleProbe = null;
    this.deadLetterProbe = null;
    if (this.enabledMetrics) {
      this.system.extension(MetricsExtensionId).disable();
      this.enabledMetrics = false;
    }
    this.emit = null;
  }

  snapshot(): ReadonlyArray<DevToolsStreamPayload> {
    return [this.sample()];
  }

  subscribersChanged(count: number): void {
    if (count > 0) this.startTicking();
    else this.stopTicking();
  }

  private onLifecycleEvent(event: ActorLifecycleEvent): void {
    match(event)
      .with(P.instanceOf(ActorStarted), () => this.onActorStarted())
      .with(P.instanceOf(ActorStopped), () => this.onActorStopped())
      .with(P.instanceOf(ActorRestarted), () => this.onActorRestarted())
      .otherwise(() => this.onUnknownEvent());
  }

  private onActorStarted(): void { this.actorsStarted++; }
  private onActorStopped(): void { this.actorsStopped++; }
  private onActorRestarted(): void { this.actorsRestarted++; }
  private onDeadLetter(): void { this.deadLetters++; }
  /** A lifecycle variant added after this build — ignore it. */
  private onUnknownEvent(): void {}

  private startTicking(): void {
    if (this.ticker !== null) return;
    this.ticker = this.system.scheduler.scheduleAtFixedRateFunction(
      this.intervalMs,
      this.intervalMs,
      () => this.emit?.(this.sample()),
    );
  }

  private stopTicking(): void {
    this.ticker?.cancel();
    this.ticker = null;
  }

  private sample(): DevToolsStreamPayload {
    const tree = this.system._inspectTree();
    let mailboxBacklog = 0;
    let stashedTotal = 0;
    let suspendedActors = 0;
    const busiest: MailboxDepthEntry[] = [];
    for (const cell of tree) {
      mailboxBacklog += cell.mailboxSize;
      stashedTotal += cell.stashSize;
      if (cell.suspended) suspendedActors++;
      if (cell.mailboxSize > 0) {
        busiest.push({
          path: cell.path,
          size: cell.mailboxSize,
          stashSize: cell.stashSize,
          suspended: cell.suspended,
        });
      }
    }
    busiest.sort((a, b) => b.size - a.size);

    const metrics = this.system.extension(MetricsExtensionId).get().collect();
    const latency = handlerLatency(metrics, HANDLER_SECONDS);
    const now = Date.now();
    const cluster = this.clusterSummary();
    return statsSamplePayload({
      atMs: now,
      uptimeMs: now - this.system.startedAtMs,
      runtime: detectRuntime(),
      actorCount: tree.length,
      actorsStarted: this.actorsStarted,
      actorsStopped: this.actorsStopped,
      actorsRestarted: this.actorsRestarted,
      deadLetters: this.deadLetters,
      messagesProcessed: counterTotal(metrics, MESSAGES_DELIVERED),
      mailboxDrops: counterTotal(metrics, MAILBOX_DROPPED),
      mailboxBacklog,
      stashedTotal,
      suspendedActors,
      ...(latency === null ? {} : { handlerLatency: latency }),
      topMailboxes: busiest.slice(0, TOP_MAILBOX_COUNT),
      ...(cluster === null ? {} : { cluster }),
    });
  }

  private clusterSummary(): ClusterStatsSummary | null {
    const cluster = this.cluster;
    if (cluster === null) return null;
    const members = cluster.getMembers();
    return {
      members: members.length,
      up: members.filter((member) => member.status === 'up').length,
      unreachable: members.filter((member) => member.status === 'unreachable').length,
      leader: cluster.leader().fold(() => null as string | null, (m) => m.address.toString()),
      selfAddress: cluster.selfAddress.toString(),
    };
  }
}
