import { ActorRef } from '../ActorRef.js';
import type { ActorPath } from '../ActorPath.js';
import { LogContext } from '../LogContext.js';
import type { ActorCell } from './ActorCell.js';

/**
 * Reference to a locally-hosted actor.  Sends go through the cell which owns
 * the mailbox and lifecycle.  The cell is exposed internally via getCell()
 * so that supervision / death-watch can wire things up without public API.
 */
export class LocalActorRef<TMsg = unknown> extends ActorRef<TMsg> {
  readonly path: ActorPath;

  constructor(private readonly cell: ActorCell<TMsg>) {
    super();
    this.path = cell.path;
  }

  tell(message: TMsg, sender: ActorRef | null = null): void {
    // Snapshot the caller's MDC at tell-time so the receiver — and
    // anything it tells onwards — sees the same context (#53).  An
    // empty context is omitted to keep envelopes light when MDC is
    // unused (zero overhead on the common path).
    const ctx = LogContext.get();
    const env = Object.keys(ctx).length === 0
      ? { message, sender }
      : { message, sender, context: ctx };
    this.cell.postUserEnvelope(env);
  }

  /** @internal */
  getCell(): ActorCell<TMsg> {
    return this.cell;
  }
}
