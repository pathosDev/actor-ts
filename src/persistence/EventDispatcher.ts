/**
 * Typed event dispatcher helper (#239) — gives the user a builder that
 * the compiler refuses to finish until every variant of the event
 * discriminator union has a handler.
 *
 * Today's `PersistentActor.onEvent` is user-defined.  A common pattern
 * is an if-chain or switch over `event.kind`; both are easy to forget
 * to update when a new event type is added — the new variant silently
 * falls through to the default branch (or throws at runtime).
 *
 * `eventDispatcher` materialises an `onEvent` from a sequence of
 * `.on(kind, fn)` calls.  TypeScript prevents `.build()` from being
 * called until every variant of `Event['kind']` is handled — adding a
 * new variant to the union surfaces as a compile error on this site.
 *
 * Usage:
 *
 *   type State = { count: number };
 *   type Event =
 *     | { kind: 'incremented'; by: number }
 *     | { kind: 'decremented'; by: number }
 *     | { kind: 'reset' };
 *
 *   const onEvent = eventDispatcher<State, Event>()
 *     .on('incremented', (s, e) => ({ count: s.count + e.by }))
 *     .on('decremented', (s, e) => ({ count: s.count - e.by }))
 *     .on('reset',       () => ({ count: 0 }))
 *     .build();
 *
 *   class CounterActor extends PersistentActor<Command, Event, State> {
 *     override onEvent = onEvent;
 *     // ... rest of the actor ...
 *   }
 *
 * Adding a fourth variant to `Event` without an `.on(...)` arm makes
 * `.build()` a type error.
 */

/**
 * Phantom marker type returned by `.build()` when the builder is
 * NOT exhaustive.  Has no call signature — using the result as a
 * function produces a clear TS error like
 * `"This expression is not callable. Type
 * 'EventDispatcherIncomplete<\"c\">' has no call signatures."`
 * The `unhandled` field-name surfaces which kind is missing.
 */
export interface EventDispatcherIncomplete<Unhandled extends string> {
  readonly __unhandled: Unhandled;
}

/**
 * Builder state, parameterised by the kinds that have already been
 * handled.  Each `.on()` call narrows `Handled`; once `Handled`
 * covers every kind in the union, `.build()`'s return type becomes a
 * callable `(state, event) => state` function.  Until then it returns
 * an `EventDispatcherIncomplete<missing>` that isn't callable, so the
 * user sees a type error at the call site.
 */
export interface EventDispatcherBuilder<
  S,
  E extends { readonly kind: string },
  Handled extends E['kind'],
> {
  /**
   * Register a handler for `kind`.  Returns a new builder type with
   * `K` added to the handled set.  Re-registering the same kind is a
   * compile error (the type-level `Exclude` forbids it).
   */
  on<K extends Exclude<E['kind'], Handled>>(
    kind: K,
    fn: (state: S, event: Extract<E, { readonly kind: K }>) => S,
  ): EventDispatcherBuilder<S, E, Handled | K>;

  /**
   * Materialise the dispatcher as a single function.  Return type is
   * the callable dispatcher when every variant of `E['kind']` is
   * registered, otherwise `EventDispatcherIncomplete<missing>`.
   *
   * When a variant is missing, calling the result like
   * `dispatcher(state, event)` produces a TS error naming the missing
   * `kind` literal in the type.
   */
  build(): [Exclude<E['kind'], Handled>] extends [never]
    ? (state: S, event: E) => S
    : EventDispatcherIncomplete<Exclude<E['kind'], Handled>>;
}

class EventDispatcherBuilderImplementation<
  S,
  E extends { readonly kind: string },
  Handled extends E['kind'],
> implements EventDispatcherBuilder<S, E, Handled> {
  constructor(
    private readonly handlers: ReadonlyMap<
      string,
      (state: S, event: E) => S
    >,
  ) {}

  on<K extends Exclude<E['kind'], Handled>>(
    kind: K,
    fn: (state: S, event: Extract<E, { readonly kind: K }>) => S,
  ): EventDispatcherBuilder<S, E, Handled | K> {
    if (this.handlers.has(kind)) {
      throw new Error(
        `eventDispatcher: kind '${kind}' was registered twice — ` +
        `each kind must have exactly one handler.`,
      );
    }
    const next = new Map<string, (state: S, event: E) => S>(this.handlers);
    next.set(kind, fn as unknown as (state: S, event: E) => S);
    return new EventDispatcherBuilderImplementation<S, E, Handled | K>(next);
  }

  build(): [Exclude<E['kind'], Handled>] extends [never]
    ? (state: S, event: E) => S
    : EventDispatcherIncomplete<Exclude<E['kind'], Handled>> {
    // Snapshot handlers into a plain Map so the returned closure
    // doesn't keep the builder instance alive.
    const handlers = new Map(this.handlers);
    const fn = (state: S, event: E): S => {
      const handler = handlers.get(event.kind);
      if (!handler) {
        // This branch is unreachable if the user types everything
        // correctly — `.build()`'s return type is non-callable until
        // all variants are registered.  Kept as a defensive throw in
        // case the user forces a cast or the event union shifts at
        // runtime (e.g. legacy persisted events from before a kind
        // was renamed).
        throw new Error(
          `eventDispatcher: no handler registered for event.kind='${event.kind}'.`,
        );
      }
      return handler(state, event);
    };
    return fn as unknown as [Exclude<E['kind'], Handled>] extends [never]
      ? (state: S, event: E) => S
      : EventDispatcherIncomplete<Exclude<E['kind'], Handled>>;
  }
}

/**
 * Start a new event-dispatcher builder.  See the module header for
 * usage.  The two generic parameters `S` (state) and `E` (event
 * discriminated union) MUST be supplied explicitly — TypeScript can't
 * infer the union from the first `.on()` call alone.
 */
export function eventDispatcher<
  S,
  E extends { readonly kind: string },
>(): EventDispatcherBuilder<S, E, never> {
  return new EventDispatcherBuilderImplementation<S, E, never>(new Map());
}
