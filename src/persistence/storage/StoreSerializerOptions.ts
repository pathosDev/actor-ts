import type { Serializer } from '../../serialization/Serializer.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';

/**
 * The `serializer` option shared by every serialising store (journals,
 * snapshot stores, durable-state stores).
 *
 * Not a HOCON key on purpose: a `Serializer` is an object with functions,
 * which config cannot carry — like `MqttOptions.withCodec`, it exists only
 * on the explicit options layer.  The in-memory stores deliberately do NOT
 * take one: their round-trip always uses the default tagged-JSON codec,
 * which is stricter than a custom serializer can be — the safe direction
 * for a dev/test default.
 */
export type StoreSerializerOptionsBase = {
  /**
   * Custom payload serializer.  When set, the store writes rows in the
   * self-describing `__serialized__` framing (see `PayloadCodec`) instead
   * of the default tagged JSON; rows of both formats can coexist in one
   * stream, but reading a framed row back requires a serializer with the
   * same `id` to be configured.
   */
  readonly serializer?: Serializer;
};

/**
 * Builder half of the shared option — one `withSerializer` for all store
 * builders instead of a copy per backend.  Same generic-cast pattern as
 * `D1OptionsBuilderBase`: `T` merely *extends* the base, so `keyof T` is
 * not known to contain `'serializer'` statically.
 */
export abstract class StoreSerializerOptionsBuilder<
  T extends StoreSerializerOptionsBase,
> extends OptionsBuilder<T> {
  /** Custom payload serializer — stores rows in the `__serialized__` framing. */
  withSerializer(serializer: Serializer): this {
    return this.set('serializer' as keyof T, serializer as T[keyof T]);
  }
}
