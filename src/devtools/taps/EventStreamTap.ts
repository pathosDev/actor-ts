/**
 * The `events` stream (#553) — a live tail of the system event bus.
 *
 * Events are buffered and flushed on a tick rather than sent one by one:
 * the bus publishes on every actor start, stop, restart and dead letter,
 * so a system doing ordinary work publishes far faster than a table can
 * be read.
 *
 * **Unlike the span tap, this one records only while someone is
 * watching.** Spans are opt-in already, so recording them from attach
 * costs nothing on a system that never enabled tracing; the event bus is
 * always live, so an observer installed at attach would run on every
 * lifecycle event for a panel nobody opened.  The trade is that an
 * opening panel starts empty — which is the honest shape for a tail, and
 * what the panel says while it waits.
 */
import type { ActorRef } from '../../ActorRef.js';
import { AskResponseRef } from '../../ActorRef.js';
import type { ActorSystem } from '../../ActorSystem.js';
import { DistributedPubSubId } from '../../cluster/pubsub/DistributedPubSubExtension.js';
import { CurrentTopics, GetTopics } from '../../cluster/pubsub/Messages.js';
import { PUBSUB_TOPICS_TIMEOUT_MS } from '../Constants.js';
import type { Cancellable } from '../../Scheduler.js';
import { toWireValue } from '../internal/WireSerializer.js';
import {
  busEventBatchPayload,
  type BusEvent,
  type DevToolsStreamId,
  type DevToolsStreamPayload,
  type PubSubTopicsResult,
} from '../protocol/index.js';
import type { DevToolsServer, DevToolsTap } from '../DevToolsServer.js';

export class EventStreamTap implements DevToolsTap {
  readonly stream: DevToolsStreamId = 'events';

  private emit: ((payload: DevToolsStreamPayload) => void) | null = null;
  private ticker: Cancellable | null = null;
  private installed = false;
  private observing = false;

  /** Events awaiting the next flush, oldest first. */
  private pending: BusEvent[] = [];
  /** Events dropped since the last flush, so the panel can say so. */
  private dropped = 0;
  /** Monotonic across the session, so the panel can see a gap. */
  private sequenceNumber = 0;
  /** Names the one-shot reply refs apart. */
  private topicRequests = 0;

  constructor(
    private readonly system: ActorSystem,
    private readonly bufferCapacity: number,
    private readonly flushIntervalMs: number,
  ) {}

  install(emit: (payload: DevToolsStreamPayload) => void): void {
    this.emit = emit;
    this.installed = true;
  }

  /** Register the PubSub topic query on `server`. */
  installMethods(server: DevToolsServer): void {
    server.registerMethod('pubsub.topics', async () => this.onTopics());
  }

  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    this.stopObserving();
    this.stopTicking();
    this.emit = null;
  }

  /**
   * Nothing — a tail has no past.
   *
   * The observer is not installed until a panel subscribes, so there is
   * genuinely nothing recorded to hand over.  Returning an empty batch
   * instead would claim the bus was quiet, which is a different answer.
   */
  snapshot(): ReadonlyArray<DevToolsStreamPayload> {
    return [];
  }

  subscribersChanged(count: number): void {
    if (count > 0) {
      this.startObserving();
      this.startTicking();
      return;
    }
    this.stopObserving();
    this.stopTicking();
  }

  /* ------------------------------ observing ---------------------------- */

  private startObserving(): void {
    if (this.observing) return;
    this.observing = true;
    this.system.eventStream._observe((event) => this.onEvent(event));
  }

  private stopObserving(): void {
    if (!this.observing) return;
    this.observing = false;
    // Leave the bus exactly as it was found: an observer left behind
    // because a browser tab closed would run for the life of the system.
    this.system.eventStream._observe(null);
  }

  private onEvent(event: object): void {
    const wire = toWireValue(event);
    this.sequenceNumber++;
    if (this.pending.length >= this.bufferCapacity) {
      // Drop the oldest: when a tail falls behind, the recent past is
      // what the reader is looking at.
      this.pending.shift();
      this.dropped++;
    }
    this.pending.push({
      sequenceNumber: this.sequenceNumber,
      atMs: Date.now(),
      eventType: eventTypeOf(event),
      payload: wire.value,
      truncated: wire.truncated,
    });
  }

  /* ------------------------------- pubsub ------------------------------ */

  /**
   * The cluster PubSub topics this node knows about.
   *
   * Asked with a hand-built reply ref rather than `mediator.ask(...)`,
   * which cannot carry this message: `ask` spreads its argument to inject
   * `replyTo`, and a spread of a class instance is a plain object — so
   * the mediator's `P.instanceOf(GetTopics)` arm would not match it and
   * the request would time out rather than fail.
   *
   * On demand, not on the tail's tick: this costs a mailbox round trip
   * and topics change far more slowly than events arrive.
   */
  private async onTopics(): Promise<PubSubTopicsResult> {
    const pubsub = this.system.extension(DistributedPubSubId);
    if (!pubsub.isStarted()) return { started: false, topics: [] };

    this.topicRequests++;
    const reply = new AskResponseRef<CurrentTopics>(
      this.system.name,
      `devtools-pubsub-topics-${this.topicRequests}`,
      PUBSUB_TOPICS_TIMEOUT_MS,
      'devtools',
    );
    pubsub.mediator.tell(
      new GetTopics(reply as unknown as ActorRef) as never,
      reply as unknown as ActorRef,
    );
    const current = await reply.promise;
    return { started: true, topics: [...current.topics] };
  }

  /* -------------------------------- ticks ------------------------------ */

  private startTicking(): void {
    if (this.ticker !== null) return;
    this.ticker = this.system.scheduler.scheduleAtFixedRateFunction(
      this.flushIntervalMs,
      this.flushIntervalMs,
      () => this.flush(),
    );
  }

  private stopTicking(): void {
    this.ticker?.cancel();
    this.ticker = null;
    // Stop buffering for nobody; the next subscriber starts clean.
    this.pending = [];
    this.dropped = 0;
  }

  private flush(): void {
    if (this.pending.length === 0 && this.dropped === 0) return;
    const batch = this.pending;
    const dropped = this.dropped;
    this.pending = [];
    this.dropped = 0;
    this.emit?.(busEventBatchPayload(Date.now(), batch, dropped));
  }
}

/** Name the event by its constructor, falling back to `typeof`. */
function eventTypeOf(event: unknown): string {
  if (event === null) return 'null';
  if (typeof event !== 'object') return typeof event;
  const name = (event as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === 'string' && name.length > 0 ? name : 'Object';
}
