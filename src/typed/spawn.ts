import type { ActorContext } from '../ActorContext.js';
import type { ActorRef } from '../ActorRef.js';
import type { ActorSystem } from '../ActorSystem.js';
import { Props } from '../Props.js';
import type { Behavior } from './Behavior.js';
import { TypedActor } from './TypedActor.js';

/**
 * Build a `Props` that, when used with `system.spawnAnonymous(...)`, hosts the given
 * Behavior.  Useful when you want to keep using the OO spawn APIs but hand
 * over a typed Behavior as the implementation.
 */
export function typedProps<T>(behavior: Behavior<T>): Props<T> {
  return Props.create(() => new TypedActor<T>(behavior));
}

/** Spawn a top-level typed actor under `/user`. */
export function spawnTyped<T>(system: ActorSystem, behavior: Behavior<T>, name?: string): ActorRef<T> {
  const props = typedProps(behavior);
  return name !== undefined ? system.spawn(props, name) : system.spawnAnonymous(props);
}

/** Spawn a typed child from inside an OO actor's context. */
export function spawnTypedChild<T>(ctx: ActorContext, behavior: Behavior<T>, name?: string): ActorRef<T> {
  const props = typedProps(behavior);
  return name !== undefined ? ctx.spawn(props, name) : ctx.spawnAnonymous(props);
}
