/**
 * How an {@link EventStream} channel is named.
 *
 * Two vocabularies meet here.  A channel used to be a class and nothing else,
 * matched with `instanceof` — which left the message style this project
 * actually prescribes unable to subscribe at all: a `kind`-discriminated plain
 * type has no constructor to hand over.  These declarations are the second
 * vocabulary, and they sit in their own module beside the stream for the same
 * reason `ServiceKey`, `ShardKey` and `SingletonKey` do: naming a thing and
 * being the thing that dispatches on the name are separate concerns.
 */

/**
 * A class used as a channel.  Its instances are the events.
 *
 * `abstract` is deliberate: matching is by `instanceof`, so an abstract base is
 * a perfectly good channel — and the most useful one, since subscribing to it
 * takes a whole family of events (every `ActorLifecycleEvent`, say) with a
 * single call.  It stays a `type` rather than the `interface` a construct
 * signature would normally ask for, because an interface cannot declare an
 * *abstract* one, and dropping `abstract` to satisfy the rule would drop the
 * families with it.
 */
export type EventClass<TEvent = unknown> = abstract new (...args: any[]) => TEvent;

/**
 * The `kind` of an event type — or plain `string` when the type carries none,
 * which is what a class channel and an unparameterised call both land on.
 *
 * Its job is to make the kind *checkable* against the event type rather than
 * merely typed as a string, so that `EventKey.of<UserLoggedInEvent>('user-loged-in')`
 * is a compile error rather than a subscription that quietly never matches.
 */
export type KindOf<TEvent> = TEvent extends { kind: infer TKind extends string }
  ? TKind
  : string;

/**
 * Named, type-tagged identity for a `kind`-discriminated event — the
 * {@link EventStream} counterpart to `ServiceKey`.  Two keys are equal iff
 * their `kind` matches; the type parameter is a compile-time marker that lets
 * a subscription's predicate see the event's real shape without the caller
 * restating it.
 *
 * The field is `kind`, not `id`: it is compared against the event's own `kind`,
 * the project-wide discriminant, and a second name for the same string would
 * be drift waiting to happen.
 *
 * A type and a `const` of the same name give a plain event the call shape a
 * class channel gets for free:
 *
 * ```ts
 * export type UserLoggedInEvent = { readonly kind: 'user-logged-in'; readonly userId: string };
 * export const UserLoggedInEvent = EventKey.of<UserLoggedInEvent>('user-logged-in');
 *
 * eventStream.subscribe(self, UserLoggedInEvent, (event) => event.userId !== 'system');
 * eventStream.publish({ kind: 'user-logged-in', userId: 'user-42' });
 * ```
 *
 * The explicit type argument is load-bearing.  `EventKey.of('user-logged-in')`
 * infers `EventKey<{ kind: string }>` from the constraint, and every predicate
 * written against that key sees `{ kind: string }` instead of the event.
 */
export class EventKey<TEvent = unknown> {
  /** Phantom field — retains TEvent so inference round-trips through the key. */
  readonly _event!: TEvent;

  constructor(public readonly kind: string) {}

  /**
   * The parameter is `KindOf<TEvent>` rather than the free-form `string` that
   * `ServiceKey.of` takes, because unlike a service id the kind is a *field of
   * the event type* — so the relationship is checkable, and a mistyped kind
   * fails here instead of at run time by never matching anything.  The
   * constructor keeps `string` as the raw door for a kind computed at run time.
   */
  static of<TEvent extends { kind: string }>(kind: KindOf<TEvent>): EventKey<TEvent> {
    return new EventKey<TEvent>(kind);
  }

  equals(other: EventKey): boolean { return this.kind === other.kind; }
  toString(): string { return `EventKey(${this.kind})`; }
}

/**
 * Anything that names an {@link EventStream} channel: a class whose instances
 * are the events, a key naming their `kind`, or the bare `kind` string.
 *
 * It is `EventChannel`, not the `XReference` the other key modules use, because
 * "channel" is already the word the stream's API and its JSDoc use for this
 * parameter — and because there is no `eventKeyOf` to write: a class channel
 * names no `kind`, so the three forms do not all reduce to a key the way every
 * `ShardReference` reduces to a `ShardKey`.
 *
 * The bare string is the shorthand, and it costs the type.  `TEvent` has
 * nothing to be inferred from and falls back to `unknown`, so a predicate
 * written against it sees `unknown` — unless the caller supplies the argument
 * (`subscribe<UserLoggedInEvent>(ref, 'user-logged-in')`), which is also what
 * makes the string itself checkable.  Prefer the key.
 */
export type EventChannel<TEvent = unknown> =
  | EventClass<TEvent>
  | EventKey<TEvent>
  | KindOf<TEvent>;
