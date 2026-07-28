/**
 * Picking names for DevTools' own actors.
 *
 * Stopping an actor is asynchronous: `ActorSystem.stop` enqueues a
 * system message and returns, and the child keeps its slot in the
 * parent's name table until that termination settles.  Re-attaching
 * DevTools straight after detaching therefore raced its own teardown
 * and failed with "Child name 'devtools-hub' is not unique" — a
 * confusing way to report a port conflict, which is what the caller was
 * usually working around.
 */
import type { ActorSystem } from '../../ActorSystem.js';

/** Enough suffixes that exhausting them means something else is wrong. */
const MAXIMUM_ATTEMPTS = 1_000;

/**
 * A free `/user` child name, preferring `base`.
 *
 * The plain name is used whenever it is available, which is every case
 * except re-attaching before the previous attachment has finished going
 * away — so the actor tree normally reads `devtools-hub`, not
 * `devtools-hub-2`.
 */
export function freeActorName(system: ActorSystem, base: string): string {
  const taken = new Set(
    system._inspectTree()
      .filter((cell) => cell.parentPath !== null && cell.parentPath.endsWith('/user'))
      .map((cell) => cell.name),
  );
  if (!taken.has(base)) return base;
  for (let attempt = 2; attempt <= MAXIMUM_ATTEMPTS; attempt++) {
    const candidate = `${base}-${attempt}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`DevTools could not find a free actor name for '${base}'`);
}
