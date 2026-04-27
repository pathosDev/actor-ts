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
    const dl = message instanceof DeadLetter
      ? message
      : new DeadLetter(message, sender, this);
    this.eventStream.publish(dl);
  }
}
