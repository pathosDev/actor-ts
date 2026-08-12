/**
 * Picking names for DevTools' own actors.
 *
 * Stopping an actor is asynchronous: `ActorSystem.stop` enqueues a
 * system message and returns, and the child keeps its slot in the
 * parent's name table until that termination settles.  Re-attaching
 * DevTools straight after detaching therefore raced its own teardown
 * and failed with "Child name 'hub' is not unique" — a confusing way
 * to report a port conflict, which is what the caller was usually
 * working around.
 */
import { MAXIMUM_DRAW_ATTEMPTS } from '../../util/Constants.js';
import type { ActorSystem } from '../../ActorSystem.js';
import { systemGroupPath, type SystemGroup } from '../../internal/SystemPaths.js';

/**
 * A free child name within `group`, preferring `base`.
 *
 * The group is passed in rather than assumed: the check is only useful if it
 * looks at the siblings the spawn will actually collide with, and silently
 * scanning the wrong parent would produce an empty "taken" set — always
 * returning `base` and bringing back the very collision this exists to
 * prevent.
 *
 * The plain name is used whenever it is available, which is every case
 * except re-attaching before the previous attachment has finished going
 * away — so the actor tree normally reads `hub`, not `hub-2`.
 */
export function freeActorName(
  system: ActorSystem,
  group: SystemGroup,
  base: string,
): string {
  const parentPath = systemGroupPath(system.name, group);
  const taken = new Set(
    system._inspectTree()
      .filter((cell) => cell.parentPath === parentPath)
      .map((cell) => cell.name),
  );
  if (!taken.has(base)) return base;
  for (let attempt = 2; attempt <= MAXIMUM_DRAW_ATTEMPTS; attempt++) {
    const candidate = `${base}-${attempt}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`DevTools could not find a free actor name for '${base}'`);
}
