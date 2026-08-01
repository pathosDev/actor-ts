import type { Actor } from '../Actor.js';
import type { ActorFactory } from '../Props.js';

/**
 * The shorthand an API accepts in place of a full {@link Props}: either the
 * actor class itself (constructed with no arguments) or a factory closure
 * that builds one — the latter is how dependencies get injected.
 */
export type ActorClassOrFactory<TMessage> =
  | (new () => Actor<TMessage>)
  | (() => Actor<TMessage>);

/**
 * Normalize a class-or-factory shorthand into the plain factory `Props.create`
 * wants.
 *
 * Classes have a `.prototype` whose `constructor` is the class itself.  Arrow
 * functions have no `prototype`; regular non-class functions do (with
 * `.prototype.constructor === fn`), so anything `new`-able is treated the same
 * way a class is, and the closure form (`() => new X(deps)`) falls into the
 * factory branch.  There is no reliable way to tell a `class` from a `function`
 * at runtime beyond this, and none is needed: both are constructible.
 */
export function actorFactoryOf<TMessage>(
  entity: ActorClassOrFactory<TMessage>,
): ActorFactory<TMessage> {
  const constructible = entity as { prototype?: { constructor?: unknown } };
  const isClass =
    typeof entity === 'function' &&
    typeof constructible.prototype === 'object' &&
    constructible.prototype?.constructor === entity;
  return isClass
    ? () => new (entity as new () => Actor<TMessage>)()
    : (entity as ActorFactory<TMessage>);
}
