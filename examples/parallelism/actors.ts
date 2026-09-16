/**
 * The actor module of the parallelism example — found by convention, because
 * it is `actors.ts` next to the entry module `main.ts`.  Only exports: the
 * main thread imports it to learn each class's export name, every worker
 * imports it to spawn the class by that name.
 */
import { Actor } from '../../src/Actor.js';
import type { ActorRef } from '../../src/ActorRef.js';

export type HashCommand = {
  readonly kind: 'hash';
  readonly seed: number;
  readonly rounds: number;
  readonly replyTo: ActorRef<HashResult>;
};

export type HashResult = { readonly kind: 'hashed'; readonly seed: number; readonly value: number; readonly where: string };

/**
 * CPU-bound on purpose: `rounds` of a mixing loop per message, so the work
 * is real and the answer checkable.  `where` names the node it ran on — the
 * only line of the output that differs between `workers = 0` and any other.
 */
export class Hasher extends Actor<HashCommand> {
  override onReceive(command: HashCommand): void {
    let value = command.seed | 0;
    for (let i = 0; i < command.rounds; i++) {
      value = (value + (i * 2654435761)) | 0;
      value = ((value << 5) | (value >>> 27)) ^ i;
    }
    const where = this.system.cluster.map((cluster) => cluster.selfAddress.toString()).getOrElse('main thread');
    command.replyTo.tell({ kind: 'hashed', seed: command.seed, value, where });
  }
}
