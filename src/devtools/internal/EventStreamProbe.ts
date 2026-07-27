/**
 * A one-line way for a tap to listen on the {@link EventStream}.
 *
 * The stream only delivers to an `ActorRef`, so every listening tap
 * would otherwise need its own actor class, spawn call and teardown.
 * This wraps all three.
 *
 * Probes are ordinary `/user` actors — DevTools has no privileged place
 * to hide them — so they DO show up in the actor tree they help render.
 * That is honest (they really are running) and the `devtools-` name
 * prefix, shared with the hub, lets the panel offer to filter them out.
 */
import { Actor } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import type { ActorSystem } from '../../ActorSystem.js';
import { Props } from '../../Props.js';

/**
 * Class-channel token accepted by `EventStream.subscribe`.  Abstract
 * bases are allowed on purpose — subscribing to `ActorLifecycleEvent`
 * takes the whole family in one call.
 */
type EventChannel<T> = abstract new (...args: any[]) => T;

/** A live subscription; call {@link EventStreamProbe.stop} to end it. */
export interface EventStreamProbe {
  stop(): void;
}

/**
 * Subscribe `handle` to `channel` on the system event stream.
 *
 * Handler exceptions are swallowed on purpose: a tap is an observer,
 * and a bug in a diagnostic must never take down the actor whose event
 * it was watching.
 */
export function subscribeToEventStream<T extends object>(
  system: ActorSystem,
  channel: EventChannel<T>,
  handle: (event: T) => void,
  name: string,
): EventStreamProbe {
  class ProbeActor extends Actor<T> {
    override onReceive(event: T): void {
      try {
        handle(event);
      } catch (error) {
        this.log.warn(`devtools tap failed to handle an event: ${(error as Error).message}`);
      }
    }
  }

  const ref: ActorRef<T> = system.spawn(Props.create(() => new ProbeActor()), name);
  system.eventStream.subscribe(ref as ActorRef, channel);

  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      system.eventStream.unsubscribe(ref as ActorRef);
      system.stop(ref as ActorRef);
    },
  };
}
