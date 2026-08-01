import { ActorRef } from '../ActorRef.js';
import { ActorPath } from '../ActorPath.js';
import { DeadLetter } from '../SystemMessages.js';
import type { EventStream } from '../EventStream.js';

/**
 * Wraps every incoming message in a DeadLetter and publishes it on the
 * system event stream.  This lets applications subscribe to undeliverable
 * messages for debugging and monitoring.
 */
export class DeadLetterRef extends ActorRef<unknown> {
  readonly path: ActorPath;

  constructor(
    systemName: string,
    private readonly eventStream: EventStream,
  ) {
    super();
    this.path = new ActorPath('deadLetters', null, systemName);
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
    this.eventStream.publish(deadLetter);
  }
}
