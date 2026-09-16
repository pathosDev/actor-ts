/**
 * The actor module of the actor-ts arm's `parallel-workload` rows (#1565):
 * the one class the worker threads spawn by export name.  A separate file
 * because the arm's own entry runs `main()` — a worker importing it would
 * start a second benchmark — and because that is what an application does
 * too: its actor module is the file next to its entry, not the entry.
 */
import { Actor } from '../../../src/index.js';
import type { ActorRef } from '../../../src/index.js';
import { workRounds } from './workload.js';

export type WorkMessage = {
  readonly kind: 'work';
  readonly seed: number;
  readonly rounds: number;
  readonly replyTo: ActorRef<number>;
};

/** Burns the workload's rounds from the seed it is handed and replies with the result. */
export class ParallelWorker extends Actor<WorkMessage> {
  override onReceive(message: WorkMessage): void {
    message.replyTo.tell(workRounds(message.seed, message.rounds));
  }
}
