/**
 * A one-line way for a tap to listen on the {@link EventStream}.
 *
 * The stream only delivers to an `ActorRef`, so every listening tap
 * would otherwise need its own actor class, spawn call and teardown.
 * This wraps all three.
 *
 * Probes live under `/system/devtools`, beside the hub, with the bare name
 * the caller passes (`stats`, `actor-tree`): the group already says whose
 * they are, so no `devtools-` prefix repeats it, and `freeActorName` adds a
 * suffix only while a sibling still holds the name — in practice a
 * re-attach racing the previous attachment's teardown.  They DO show up in
 * the actor tree they help render.  That is honest (they really are
 * running), and the tooling mark they inherit from the group is what the
 * panel hides them by, as it does by default, and what keeps whole-system
 * tracing off them.
 */
import { Actor } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import type { ActorSystem } from '../../ActorSystem.js';
import type { EventChannel } from '../../EventKey.js';
import { SystemGroups } from '../../internal/SystemPaths.js';
import { freeActorName } from './ActorNames.js';

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
export function subscribeToEventStream<TEvent extends object>(
  system: ActorSystem,
  channel: EventChannel<TEvent>,
  handle: (event: TEvent) => void,
  name: string,
): EventStreamProbe {
  class ProbeActor extends Actor<TEvent> {
    override onReceive(event: TEvent): void {
      try {
        handle(event);
      } catch (error) {
        this.log.warn(`devtools tap failed to handle an event: ${(error as Error).message}`);
      }
    }
  }

  // The `/system/devtools` group is marked tooling and `ActorCell` inherits
  // the mark, so the probe needs no `withInternal()` of its own.
  const ref: ActorRef<TEvent> = system._spawnSystemActor(
    ProbeActor,
    SystemGroups.devtools,
    freeActorName(system, SystemGroups.devtools, name),
  );
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
