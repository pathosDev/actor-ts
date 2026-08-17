import { ActorRef } from '../ActorRef.js';
import { ActorPath } from '../ActorPath.js';
import { DeadLetter } from '../SystemMessages.js';
import type { EventStream } from '../EventStream.js';

/**
 * Receives a dead letter and does something durable with it before anyone
 * else sees it — see {@link DeadLetterRef._setSink}.
 */
export type DeadLetterSink = (deadLetter: DeadLetter) => void;

/**
 * Wraps every incoming message in a DeadLetter and publishes it on the
 * system event stream.  This lets applications subscribe to undeliverable
 * messages for debugging and monitoring.
 */
export class DeadLetterRef extends ActorRef<unknown> {
  readonly path: ActorPath;

  private sink: DeadLetterSink | null = null;

  constructor(
    systemName: string,
    private readonly eventStream: EventStream,
  ) {
    super();
    this.path = new ActorPath('deadLetters', null, systemName);
  }

  /**
   * @internal Install the capturing sink, or clear it with `null`.
   *
   * One slot, not a list: this is the seam a *durable* record hangs on, and
   * two of those would each hold half the letters.  Anything that merely
   * wants to observe subscribes to the event stream, which is what the
   * stream is for.
   */
  _setSink(sink: DeadLetterSink | null): void {
    this.sink = sink;
  }

  tell(message: unknown, sender: ActorRef | null = null): void {
    // A DeadLetter wrapping another DeadLetter is the signature of a
    // delivery loop: publishing a dead letter reached a subscriber that
    // has terminated without unsubscribing, whose cell then wrapped it
    // again and sent it back here.  Re-publishing would hand it to the
    // same dead subscriber forever, so the nested one is dropped —
    // there is nowhere further to send an undeliverable dead letter.
    // (A single wrap is the NORMAL path: cells wrap before calling.)
    if (message instanceof DeadLetter && message.message instanceof DeadLetter) return;

    const deadLetter = message instanceof DeadLetter
      ? message
      : new DeadLetter(message, sender, this);
    // Capture first, publish second, and deliberately in that order.  The
    // sink is the durable record; publication is an observation with no
    // guaranteed audience.  Anything that later wants to rate-limit, sample
    // or suppress the dead-letter stream (#1179) belongs on the publish
    // side of this line — a gate in front of the sink would silently turn
    // a complete record into a lossy one.
    this.sink?.(deadLetter);
    this.eventStream.publish(deadLetter);
  }
}
