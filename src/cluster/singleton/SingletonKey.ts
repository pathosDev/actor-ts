import type { Actor } from '../../Actor.js';

/**
 * Named, type-tagged identity for a cluster singleton — the singleton
 * counterpart to {@link ServiceKey}.  Two keys are equal iff their `typeName`
 * matches; the type parameter is a compile-time marker that lets `start()` and
 * `ref()` hand back a correctly-typed `ActorRef` without the caller repeating
 * the message type at every site.
 *
 * The field is `typeName`, not `id`, because it is the same string that feeds
 * `singletonManagerName` and the wire-visible manager path — a second name for
 * it would be drift waiting to happen.
 *
 * ```ts
 * class JobSchedulerActor extends Actor<SchedulerCommand> {
 *   static readonly singleton = SingletonKey.of<SchedulerCommand>('job-scheduler');
 * }
 *
 * // Restricted to nodes carrying a role — declared once, read by every node.
 * class IngressActor extends Actor<IngressCommand> {
 *   static readonly singleton = SingletonKey.of<IngressCommand>('http-ingress', 'edge');
 * }
 * ```
 *
 * The explicit type argument is load-bearing: `SingletonKey.of('job-scheduler')`
 * infers `SingletonKey<unknown>`, which degrades every `start()` / `ref()` that
 * uses it to `ActorRef<unknown>`.
 */
export class SingletonKey<TCommand = unknown> {
  /** Phantom field — retains TCommand so inference round-trips through the key. */
  readonly _command!: TCommand;

  constructor(
    public readonly typeName: string,
    /**
     * Restrict hosting to nodes carrying this role.
     *
     * It rides along on the key — like {@link ShardKey}'s `extractEntityId` —
     * so the declaring class is the single source of truth, and it is NOT part
     * of the identity: {@link equals} ignores it.  A `role` in
     * `StartSingletonOptions` wins over this one.
     *
     * The key is where it has to live for a *proxy* to be right.  Both the
     * hosting node and a node that only calls `ref()` have to resolve the same
     * host, and a `ref()`-only node has no options object to read it from — it
     * has the key, and nothing else.  Declared here, both sides agree by
     * construction.
     */
    public readonly role?: string,
  ) {}

  static of<TCommand>(typeName: string, role?: string): SingletonKey<TCommand> {
    return new SingletonKey<TCommand>(typeName, role);
  }

  equals(other: SingletonKey): boolean { return this.typeName === other.typeName; }
  toString(): string { return `SingletonKey(${this.typeName})`; }
}

/**
 * A class that declares its own singleton identity as a static.
 *
 * TypeScript's `implements` clause constrains only the instance side of a
 * class — there is no `static implements`, and `abstract static` is an error —
 * so a `SingletonActor` marker interface could not carry this and would check
 * nothing.  A static field can, and it composes with any base class, which
 * matters because a singleton is frequently also a `PersistentActor` and
 * TypeScript has single inheritance.  Enforcement happens where it counts: at
 * the `start()` call site, which infers `TCommand` from this key and from the
 * `ActorClassOrFactory<TCommand>` position simultaneously and reports a mismatch between
 * them.
 */
export type SingletonKeyedClass<TCommand> = {
  readonly singleton: SingletonKey<TCommand>;
};

/**
 * …and constructs with no arguments, so passing the class alone is enough.
 *
 * A class with a dependency-injecting constructor satisfies
 * {@link SingletonKeyedClass} but not this — which is exactly what routes it to
 * the `start(TheClass, factory)` overload instead of producing an error.
 */
export interface SingletonActorClass<TCommand> extends SingletonKeyedClass<TCommand> {
  new (): Actor<TCommand>;
}

/**
 * Anything that names a singleton: its key, the class that declares the key, or
 * the bare `typeName` for singletons started from a plain options object with
 * no class to hang a static on.
 */
export type SingletonReference<TCommand = unknown> =
  | SingletonKey<TCommand>
  | SingletonKeyedClass<TCommand>
  | string;

/** Narrow any {@link SingletonReference} to the key it names. */
export function singletonKeyOf<TCommand>(
  reference: SingletonReference<TCommand>,
): SingletonKey<TCommand> {
  if (typeof reference === 'string') return SingletonKey.of<TCommand>(reference);
  if (reference instanceof SingletonKey) return reference;
  return reference.singleton;
}
