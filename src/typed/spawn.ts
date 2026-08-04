import type { ActorFactory } from '../Actor.js';
import type { Behavior } from './Behavior.js';
import { TypedActor } from './TypedActor.js';

/**
 * Wrap a `Behavior<T>` in an actor factory, so it can be passed to any
 * spawn API that takes one — `ClusterSharding.start`,
 * `ClusterSingleton.start`, `Router.roundRobin`, `system.spawn`.
 *
 * For the common case of spawning a top-level or child typed actor,
 * prefer `system.spawnTyped(behavior, name)` /
 * `system.spawnTypedAnonymous(behavior)` (or the same pair on
 * `ActorContext`) — they call this helper internally.
 */
export function typedActor<T>(behavior: Behavior<T>): ActorFactory<T> {
  return () => new TypedActor<T>(behavior);
}
