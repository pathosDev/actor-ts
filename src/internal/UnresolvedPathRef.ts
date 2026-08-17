import { ActorPath } from '../ActorPath.js';
import { ActorRef } from '../ActorRef.js';

/**
 * Stand-in ref for a path that named no actor.
 *
 * Every other dead-letter site has a ref for the recipient — a cell's
 * `self`, a proxy that *is* a ref — and can therefore say which actor the
 * message failed to reach.  {@link ActorSelection} is the one that cannot:
 * it holds a path that resolved to nothing, so there is no ref to name.
 * Without one, its dead letters were attributed to `/deadLetters` itself,
 * which is the one address that tells a reader nothing — the *whole*
 * stream has that recipient.
 *
 * Drops anything sent to it, exactly like `Nobody`.  The difference is the
 * path: `Nobody` renders as `actor-ts://<nobody>/nobody` and is shared by
 * every caller, while this one carries the path that was actually looked
 * up, so a `DeadLetter` built with it reads `.../user/ghost` and a
 * per-recipient counter or a `list({ recipient })` filter has something to
 * key on.
 *
 * Internal: it exists to label a dead letter, not to be handed out.  A
 * caller who obtained one and `tell`ed it would silently lose the message
 * — the same trap `Nobody` carries, and the reason neither is returned
 * from a public lookup.
 */
export class UnresolvedPathRef extends ActorRef<unknown> {
  readonly path: ActorPath;

  constructor(systemName: string, segments: ReadonlyArray<string>) {
    super();
    let path = new ActorPath('', null, systemName);
    for (const segment of segments) path = path.child(segment);
    this.path = path;
  }

  tell(): void { /* nothing lives here — the ref is a label, not a target */ }
}
