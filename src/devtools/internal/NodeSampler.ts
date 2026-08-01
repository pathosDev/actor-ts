/**
 * One node's figures, gathered in one place.
 *
 * Both the DevTools server and the agent that runs on every other
 * cluster node need exactly the same numbers about the system they are
 * in.  Keeping the gathering here means a figure added for the local
 * overview automatically arrives from remote nodes too, rather than
 * appearing on one and quietly missing on the others.
 */
import type { ActorSystem } from '../../ActorSystem.js';
import { MetricsExtensionId } from '../../metrics/MetricsExtension.js';
import { ActorLifecycleEvent, ActorRestarted, ActorStarted, ActorStopped, DeadLetter } from '../../SystemMessages.js';
import { match, P } from 'ts-pattern';
import { counterTotal, handlerLatency } from './MetricsDigest.js';
import { subscribeToEventStream, type EventStreamProbe } from './EventStreamProbe.js';
import type { MailboxDepthEntry, NodeFigures } from '../protocol/index.js';

/** How many hot mailboxes a node reports. */
const TOP_MAILBOX_COUNT = 5;

/** Framework counters the figures read back. */
const MESSAGES_DELIVERED = 'actor_messages_delivered_total';
const MAILBOX_DROPPED = 'actor_mailbox_dropped_total';
const HANDLER_SECONDS = 'actor_message_handler_seconds';

/**
 * Watches one actor system and answers "how is it doing?".
 *
 * Counting starts at {@link start}, not at the first question, so a
 * dashboard can say "312 actors started since you attached" — impossible
 * if counting began when a panel opened.
 */
export class NodeSampler {
  private lifecycleProbe: EventStreamProbe | null = null;
  private deadLetterProbe: EventStreamProbe | null = null;
  /** Did *we* switch metrics on?  Only then may we switch them off. */
  private enabledMetrics = false;

  private actorsStarted = 0;
  private actorsStopped = 0;
  private actorsRestarted = 0;
  private deadLetters = 0;

  constructor(private readonly system: ActorSystem) {}

  start(): void {
    if (this.lifecycleProbe !== null) return;
    // Message throughput, mailbox drops and handler latency are already
    // instrumented in the framework — against a noop registry, so every
    // reading is 0 until somebody switches metrics on.  Take that over
    // the way SpanTap takes over the tracer, and hand it back on stop so
    // a system that had metrics off gets them off again.
    const metrics = this.system.extension(MetricsExtensionId);
    if (!metrics.isEnabled()) {
      metrics.enable();
      this.enabledMetrics = true;
    }
    this.lifecycleProbe = subscribeToEventStream(
      this.system,
      ActorLifecycleEvent,
      (event) => this.onLifecycleEvent(event),
      'stats',
    );
    this.deadLetterProbe = subscribeToEventStream(
      this.system,
      DeadLetter,
      () => this.onDeadLetter(),
      'stats-dead-letters',
    );
  }

  stop(): void {
    this.lifecycleProbe?.stop();
    this.deadLetterProbe?.stop();
    this.lifecycleProbe = null;
    this.deadLetterProbe = null;
    if (this.enabledMetrics) {
      this.system.extension(MetricsExtensionId).disable();
      this.enabledMetrics = false;
    }
  }

  /** This node, right now. */
  figures(address: string): NodeFigures {
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
    return {
      address,
      systemName: this.system.name,
      uptimeMs: Date.now() - this.system.startedAtMs,
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
    };
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
}
