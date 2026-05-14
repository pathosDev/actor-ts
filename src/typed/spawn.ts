import { Props } from '../Props.js';
import type { Behavior } from './Behavior.js';
import { TypedActor } from './TypedActor.js';

/**
 * Wrap a `Behavior<T>` in `Props<T>` so it can be passed to any
 * OO spawn API (e.g. `ClusterSharding.start`, `ClusterSingleton.start`,
 * `Props.create` consumers).
 *
 * For the common case of spawning a top-level or child typed actor,
 * prefer `system.spawnTyped(behavior, name)` /
 * `system.spawnTypedAnonymous(behavior)` (or the same pair on
 * `ActorContext`) — they call this helper internally.
 */
export function typedProps<T>(behavior: Behavior<T>): Props<T> {
  return Props.create(() => new TypedActor<T>(behavior));
}
