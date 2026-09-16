/**
 * The actor module of `config-scaling.ts`: the same two actors run on the
 * main thread under `workers = 0` and on worker threads under anything else,
 * imported by URL on both sides — which is exactly the convention the
 * parallelism extension asks of an application.
 *
 * Ignored by the benchmark discovery harness — filename starts with "_".
 */
import { Actor } from '../../src/Actor.js';
import type { ActorRef } from '../../src/ActorRef.js';
import { crunch } from '../worker/_crunch.js';

export type CrunchCommand = { readonly kind: 'crunch'; readonly rounds: number; readonly replyTo: ActorRef<number> };

/** CPU-bound: burns `rounds` of the shared loop per message and returns the result, so skipped work would show. */
export class Cruncher extends Actor<CrunchCommand> {
  override onReceive(command: CrunchCommand): void {
    command.replyTo.tell(crunch(command.rounds));
  }
}

export type PingCommand = { readonly kind: 'ping'; readonly sequence: number; readonly replyTo: ActorRef<number> };

/** Chatty and idle: answers at once, so a message to it costs only the delivery path. */
export class Ponger extends Actor<PingCommand> {
  override onReceive(command: PingCommand): void {
    command.replyTo.tell(command.sequence);
  }
}
