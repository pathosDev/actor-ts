import { Actor } from '../../../../src/Actor.js';

/** Defined outside the actor module on purpose: no export name reaches a worker. */
export class Stranger extends Actor<never> {
  override onReceive(): void { /* nothing */ }
}
