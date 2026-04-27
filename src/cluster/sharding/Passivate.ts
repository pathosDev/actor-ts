import type { ActorRef } from '../../ActorRef.js';

/**
 * An entity actor sends `Passivate(stopMessage)` to its parent (the shard
 * region) to request a graceful shutdown.  The region then forwards
 * `stopMessage` to the entity and buffers any further traffic for the
 * entity until it has fully stopped; the next inbound message recreates
 * the entity and flushes the buffer.
 *
 * Two call shapes are accepted:
 *   // Explicit (recommended) — entity attaches its own ref so the region
 *   // can find it regardless of how `tell` was invoked:
 *   this.context.parent?.tell(new Passivate(Stop, this.self));
 *
 *   // Implicit — works when the enclosing `tell` also passed `self` as
 *   // the sender:
 *   this.context.parent?.tell(new Passivate(Stop), this.self);
 */
export class Passivate {
  constructor(
    public readonly stopMessage: unknown,
    public readonly entity?: ActorRef,
  ) {}
}
