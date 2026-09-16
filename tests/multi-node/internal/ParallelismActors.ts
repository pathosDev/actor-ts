import { Actor } from '../../../src/Actor.js';
import type { ActorRef } from '../../../src/ActorRef.js';

/**
 * The actor module of the real-thread parallelism test (#1563): imported by
 * the main thread for the export names, and by every worker thread by URL.
 */

export type WhereCommand = { readonly kind: 'where'; readonly replyTo: ActorRef<string> };

/** Answers with the address of the node it runs on — which must not be the main thread's. */
export class Where extends Actor<WhereCommand> {
  override onReceive(command: WhereCommand): void {
    command.replyTo.tell(this.cluster.selfAddress.toString());
  }
}

export type SumCommand =
  | { readonly kind: 'add'; readonly value: number }
  | { readonly kind: 'sum'; readonly replyTo: ActorRef<number> };

export class Sum extends Actor<SumCommand> {
  private total = 0;
  override onReceive(command: SumCommand): void {
    if (command.kind === 'add') this.total += command.value;
    else command.replyTo.tell(this.total);
  }
}
