import { ActorRef } from '../ActorRef.js';
import type { ActorPath } from '../ActorPath.js';
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
    this.cell.postUserMessage(message, sender);
  }

  /** @internal */
  getCell(): ActorCell<TMsg> {
    return this.cell;
  }
}
