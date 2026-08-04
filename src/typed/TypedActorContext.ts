import type { ActorRef } from '../ActorRef.js';
import type { ActorPath } from '../ActorPath.js';
import type { ActorSystem } from '../ActorSystem.js';
import type { Logger } from '../Logger.js';
import type { TimerScheduler } from '../ActorContext.js';
import type { Behavior } from './Behavior.js';

/**
 * Typed variant of ActorContext — the runtime API exposed to Behaviors.
 * Differs from the untyped ActorContext in two ways:
 *   - `spawn` takes a Behavior instead of Props
 *   - there is no `become`/`unbecome` — behavior changes happen by returning
 *     a new Behavior from the message handler.
 */
export interface TypedActorContext<T> {
  readonly self: ActorRef<T>;
  readonly path: ActorPath;
  readonly system: ActorSystem;
  readonly log: Logger;

  /**
   * Name this actor in log lines and in the DevTools tree (#891).  Every
   * Behavior runs inside the same `TypedActor` class, so there is no
   * subclass to override `Actor.displayName()` on — this is the way in:
   *
   *     Behaviors.setup<Command>((context) => {
   *       context.setDisplayName(`User(${userId})`);
   *       return Behaviors.receive(...);
   *     });
   *
   * Takes effect on the next record.  Purely cosmetic — the path stays
   * the identity everywhere that routes or correlates.
   */
  setDisplayName(name: string): void;

  /** Spawn a typed child actor with the given Behavior. */
  spawn<U>(behavior: Behavior<U>, name?: string): ActorRef<U>;

  /** Stop a watched child or self. */
  stop(ref: ActorRef): void;

  /** Death-watch another actor — you'll receive a Signal when it terminates. */
  watch(ref: ActorRef): void;
  unwatch(ref: ActorRef): void;

  /** Per-actor timers. */
  readonly timers: TimerScheduler<T>;
}
