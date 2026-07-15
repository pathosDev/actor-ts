/**
 * Named, type-tagged lookup handle for the Receptionist.  Two ServiceKeys
 * compare equal iff their `id` strings match — the type parameter is a
 * compile-time marker used to tighten inferred ActorRef types on lookup.
 */
export class ServiceKey<TMessage = unknown> {
  /** Phantom field — retains T so inference can round-trip through the key. */
  readonly _msg!: TMessage;

  constructor(public readonly id: string) {}

  static of<T>(id: string): ServiceKey<T> { return new ServiceKey<T>(id); }

  equals(other: ServiceKey): boolean { return this.id === other.id; }
  toString(): string { return `ServiceKey(${this.id})`; }
}
