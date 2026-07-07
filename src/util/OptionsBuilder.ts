/**
 * Base class for the framework's fluent options builders — the shared
 * mechanics behind `MqttOptions`, `KafkaOptions`, `ActorSystemOptions`,
 * and every other `<X>Options` builder.
 *
 * Design (matches the hand-written `MqttOptions` that seeded this):
 *
 *   - **Mutable, `this`-returning.** Each concrete `withX(...)` calls the
 *     protected {@link set} and returns `this`, so chaining stays typed
 *     as the concrete subclass across inheritance levels (no F-bounded
 *     `Self` generic needed — `this` already IS the subclass).
 *   - **A builder *is* its settings.** {@link set} writes each field as an
 *     own enumerable property of the builder instance, so a builder is
 *     structurally a bag of the fields you set. Consumers accept the
 *     `XOptions` union (`XOptionsBuilder | Partial<XOptionsType>`) and read /
 *     spread the argument directly — no separate "resolve" step. The `withX`
 *     / `build` methods live on the prototype, so they never surface when
 *     the settings are spread (`{ ...options }`), enumerated
 *     (`Object.keys`), or serialized (`JSON.stringify`): only the set
 *     fields do. (The consumer keeps the union in its signature because a
 *     builder — a methods-only type — is not assignable to a bare
 *     `Partial<T>`: TypeScript's weak-type check would reject it. Reading
 *     the settings out of the argument is a plain cast: `options as
 *     XOptionsType` / `{ ...(options as Partial<XOptionsType>) }`.)
 *   - **`build()` snapshots.** It returns an independent `Partial<T>` (a
 *     copy of the own fields) for the rare caller that wants to freeze a
 *     builder it intends to keep mutating; ordinary consumers don't need
 *     it because they already read/spread the argument.
 *   - **Feeds the existing resolution.** For brokers the settings are the
 *     highest-precedence layer of `mergeSettings(defaults, HOCON, ctor)`;
 *     because a builder records ONLY the fields you set, unset fields fall
 *     through to HOCON — the builder never competes with config.
 *
 * A builder instance is a throwaway construction helper: methods mutate in
 * place, so a single instance is not a branch point (two chains off the
 * same instance share state).
 */
export abstract class OptionsBuilder<T extends object> {
  /**
   * Set one field and return `this` for chaining.  The value is written as
   * an own enumerable property of the builder so the instance reads as a
   * plain bag of settings (see the class doc); methods stay on the prototype.
   */
  protected set<K extends keyof T>(key: K, value: T[K]): this {
    (this as unknown as { [P in keyof T]?: T[P] })[key] = value;
    return this;
  }

  /** Snapshot the set fields as an independent `Partial<T>` (own props only). */
  build(): Partial<T> {
    return { ...(this as unknown as Partial<T>) };
  }
}
