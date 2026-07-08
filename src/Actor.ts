import type { ActorContext } from './ActorContext.js';
import type { ActorRef } from './ActorRef.js';
import type { ActorSystem } from './ActorSystem.js';
import type { Logger } from './Logger.js';
import { defaultStrategy, SupervisorStrategy } from './Supervision.js';
import type { Option } from './util/Option.js';

/**
 * Base class for user actors.  Subclasses must override `onReceive`.
 * Lifecycle hooks (preStart, postStop, preRestart, postRestart) have sensible
 * defaults but can be overridden.
 *
 * Actors are single-threaded by construction: the runtime guarantees that
 * onReceive is never invoked concurrently for the same actor.  If onReceive
 * returns a Promise, the runtime awaits it before starting the next message.
 */
export abstract class Actor<TMessage = unknown> {
  /** @internal — injected by ActorCell at construction time. */
  private _context!: ActorContext<TMessage>;

  /** @internal */
  _attach(context: ActorContext<TMessage>): void {
    this._context = context;
  }

  /** Runtime context. Only valid after the actor has been started. */
  protected get context(): ActorContext<TMessage> { return this._context; }

  protected get self(): ActorRef<TMessage> { return this._context.self; }
  protected get sender(): Option<ActorRef> { return this._context.sender; }
  protected get system(): ActorSystem { return this._context.system; }
  protected get log(): Logger { return this._context.log; }

  /**
   * Main message handler.  Receives each envelope dequeued from the mailbox.
   * A thrown error (sync or async) is caught by the supervisor.
   */
  abstract onReceive(message: TMessage): void | Promise<void>;

  /** Called after construction and before the first message is processed. */
  preStart(): void | Promise<void> {}

  /** Called after the actor has been terminated. Children are already stopped. */
  postStop(): void | Promise<void> {}

  /**
   * Called before a restart, on the instance about to be thrown away.
   * The default stops children and then calls postStop().
   */
  preRestart(_reason: Error, _message?: TMessage): void | Promise<void> {
    return this.postStop();
  }

  /** Called on the fresh instance after a restart.  Default: call preStart(). */
  postRestart(_reason: Error): void | Promise<void> {
    return this.preStart();
  }

  /**
   * Supervisor strategy for this actor's children.  Defaults to restart,
   * up to 10 times per minute, then stop.
   */
  supervisorStrategy(): SupervisorStrategy { return defaultStrategy; }
}
