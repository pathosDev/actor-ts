import type { ActorClassOrFactory } from '../Actor.js';
import type { ActorOptions } from '../ActorOptions.js';
import { Props } from '../Props.js';
import { actorBlueprintOf, type ActorBlueprint } from './ActorBlueprint.js';

/**
 * Accept either calling convention at a spawn site while the call sites
 * migrate off `Props`.
 *
 * `Props` is an object and never a function, so the two are disjoint at
 * runtime; `PropsConfig` is already an {@link ActorBlueprint}, so the legacy
 * branch is a field read rather than a conversion.
 *
 * @internal — temporary scaffolding, removed together with `Props` (#547).
 *   Nothing outside `src/` should reach for it, and nothing in `src/` should
 *   grow a new caller.
 */
export function blueprintOf<TMessage>(
  actor: ActorClassOrFactory<TMessage> | Props<TMessage>,
  options?: ActorOptions<TMessage>,
): ActorBlueprint<TMessage> {
  return actor instanceof Props ? actor.config : actorBlueprintOf(actor, options);
}
