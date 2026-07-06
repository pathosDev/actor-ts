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
 *   - **`build()` snapshots.** It returns an independent `Partial<T>`;
 *     the accumulated `s` is never handed out by reference, so a built
 *     partial won't mutate if the builder is used further.
 *   - **`build()` feeds the existing resolution.** For brokers it is the
 *     highest-precedence layer of `mergeSettings(defaults, HOCON, ctor)`;
 *     because a builder records ONLY the fields you set, unset fields
 *     fall through to HOCON — the builder never competes with config.
 *
 * A builder instance is a throwaway construction helper: methods mutate
 * in place, so a single instance is not a branch point (two chains off
 * the same instance share state). Call `build()` to freeze.
 */
export abstract class OptionsBuilder<T extends object> {
  /** Accumulated settings.  `-readonly` so `set` can write the (readonly) target fields. */
  protected readonly s: { -readonly [K in keyof T]?: T[K] } = {};

  /** Set one field and return `this` for chaining. */
  protected set<K extends keyof T>(key: K, value: T[K]): this {
    this.s[key] = value;
    return this;
  }

  /** Snapshot the accumulated settings as an independent `Partial<T>`. */
  build(): Partial<T> {
    return { ...this.s };
  }
}
