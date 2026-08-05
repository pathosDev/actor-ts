import type { Actor, ActorClassOrFactory, ActorFactory } from '../Actor.js';
import { ActorOptionsValidator, type ActorOptions, type ActorOptionsType } from '../ActorOptions.js';

/**
 * Everything an {@link ActorCell} needs for its whole life, in one frozen
 * record: how to build the actor, and how it was configured.
 *
 * One value rather than two constructor parameters, because both halves
 * outlive the actor instance and are read at times the spawn call is long
 * gone — the factory on every restart, and `supervisorStrategy` by the
 * *parent* when the child fails.  Splitting them gives two things that must
 * never drift apart.
 *
 * @internal — the public door is `spawn(actor, name, options)`.
 */
export type ActorBlueprint<TMessage> = ActorOptionsType<TMessage> & {
  readonly factory: ActorFactory<TMessage>;
};

/**
 * Normalize a spawn call — class-or-factory plus optional options — into the
 * blueprint the cell keeps.
 *
 * The options are **snapshotted**: a builder mutated after the spawn does not
 * retroactively reconfigure a running actor.
 */
export function actorBlueprintOf<TMessage>(
  actor: ActorClassOrFactory<TMessage>,
  options?: ActorOptions<TMessage>,
): ActorBlueprint<TMessage> {
  const settings = { ...(options as Partial<ActorOptionsType<TMessage>> | undefined) };
  new ActorOptionsValidator<TMessage>().validate(settings);
  return { ...settings, factory: actorFactoryOf(actor) };
}

/**
 * Narrow a class-or-factory shorthand to the plain factory the blueprint wants.
 *
 * Classes have a `.prototype` whose `constructor` is the class itself.  Arrow
 * functions have no `prototype`; regular non-class functions do (with
 * `.prototype.constructor === fn`), so anything `new`-able is treated the same
 * way a class is, and the closure form (`() => new X(deps)`) falls into the
 * factory branch.  There is no reliable way to tell a `class` from a
 * `function` at runtime beyond this, and none is needed — both are
 * constructible, and a constructor that returns an object wins over `this`, so
 * `new makeWorker()` yields the same worker `makeWorker()` would.
 */
export function actorFactoryOf<TMessage>(
  actor: ActorClassOrFactory<TMessage>,
): ActorFactory<TMessage> {
  const constructible = actor as { prototype?: { constructor?: unknown } };
  const isClass =
    typeof actor === 'function' &&
    typeof constructible.prototype === 'object' &&
    constructible.prototype?.constructor === actor;
  if (!isClass) return actor as ActorFactory<TMessage>;

  // A class whose constructor takes arguments cannot be spawned by name:
  // `new X()` would silently construct with `undefined` dependencies and fail
  // far from the call site.  TypeScript already rejects this — the guard is
  // for JavaScript callers and for anyone who cast their way past it.
  // `Function.length` counts parameters before the first default or rest, so
  // `constructor(a, b = 1)` is rejected and `constructor(a = 1)` is not.
  const arity = (actor as (...args: never[]) => unknown).length;
  if (arity > 0) {
    const name = (actor as { name?: string }).name ?? 'The actor class';
    throw new Error(
      `${name} needs ${arity} constructor argument${arity === 1 ? '' : 's'}, so the class `
      + 'alone is not enough to build it — pass a factory that supplies them: '
      + `() => new ${name}(...).`,
    );
  }
  return () => new (actor as new () => Actor<TMessage>)();
}
