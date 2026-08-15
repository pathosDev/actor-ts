import { ActorPath } from '../ActorPath.js';
import { ActorRef } from '../ActorRef.js';
import { Terminated } from '../SystemMessages.js';
import { LocalActorRef } from '../internal/LocalActorRef.js';
import { randomId } from '../util/RandomString.js';

/**
 * Path segment the throwaway watcher below is parked under.
 *
 * The same segment `ask` uses for its reply refs, and for the same reason:
 * these are not actors in the tree — nothing spawns them, `_resolvePath`
 * never finds them — so they must not look like `/user` or `/system`.
 */
const TEMP_SEGMENT = 'temp';

/**
 * Stop `ref` after it has worked through its mailbox, and wait for it.
 *
 * `ActorRef.stop()` already means stop-after-drain — it sends a `PoisonPill`,
 * an ordinary user message that is therefore ordered behind everything already
 * queued — but it is fire-and-forget, and outside an actor there is no `watch`
 * to learn when the stop actually happened (#663).  This is that missing half:
 *
 *     const stopped = await gracefulStop(worker, 5_000);
 *
 * Resolves `true` once the actor is confirmed terminated.  If `timeoutMs`
 * elapses first it resolves `false` — and escalates, enqueueing the system
 * `terminate` that jumps the user queue, so a caller who has run out of
 * patience is not also left with a live actor.  What was still queued goes to
 * dead letters, exactly as any other hard stop.
 *
 * **Why `false` and not a rejection.**  A stop that timed out is an outcome,
 * not an error: the caller asked for a bounded stop and got one, and the two
 * answers differ only in whether the mailbox was finished. Rejecting would
 * make the ordinary "shut this down within five seconds, whatever it takes"
 * call site need a `try`/`catch` to express what a boolean says.
 *
 * The budget is a required argument.  A graceful stop's whole content is the
 * bound, and a default one would be the number that silently truncated
 * somebody's shutdown.
 *
 * Only a locally-hosted actor can be observed this way — the confirmation
 * comes from its cell's watcher set.  For any other ref (a cluster ref, a
 * router's remote routee) the stop is still delivered, but there is nothing
 * local to confirm it with, so this resolves `false` when the budget runs out.
 * Watch it from inside an actor with `context.watch(ref)` instead.
 */
export function gracefulStop(ref: ActorRef, timeoutMs: number): Promise<boolean> {
  ref.stop();
  if (!(ref instanceof LocalActorRef)) {
    return new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), timeoutMs); });
  }

  const cell = ref.getCell();
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const watcher = new TerminationWatcher(ref.path.systemName, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
    // Registered after the watcher exists, because `_addWatcher` answers a
    // target that is already gone on the spot rather than through the
    // mailbox — the callback has to be in place before the call, not after.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cell._removeWatcher(watcher);
      // Escalate: a system command is not queued behind the user messages
      // the PoisonPill is still waiting on.
      cell.enqueueSystem({ kind: 'terminate' });
      resolve(false);
    }, timeoutMs);
    cell._addWatcher(watcher);
  });
}

/**
 * A ref that exists only to receive one `Terminated`.
 *
 * `_addWatcher` takes an `ActorRef` and nothing else, so observing a stop from
 * outside the actor tree means handing it something ref-shaped.  Kept private
 * to this module: it has no mailbox, no cell and no path anyone can resolve,
 * which is fine for a watcher slot and would be misleading anywhere else.
 */
class TerminationWatcher extends ActorRef<unknown> {
  readonly path: ActorPath;

  constructor(systemName: string, private readonly onTerminated: () => void) {
    super();
    this.path = new ActorPath('', null, systemName)
      .child(TEMP_SEGMENT)
      .child(`gracefulStop-${randomId(12)}`);
  }

  tell(message: unknown): void {
    if (message instanceof Terminated) this.onTerminated();
  }
}
