import { OptionsBuilder } from '../util/OptionsBuilder.js';

/** Plain options-object shape accepted by a {@link ConsumerController}. */
export interface ConsumerControllerOptionsType<T> {
  /**
   * Invoked for every successfully delivered (un-duplicated) message.  The
   * controller Acks AFTER the handler returns — if the handler returns a
   * Promise, the Ack is delayed until it settles.
   */
  readonly handler: (body: T) => void | Promise<void>;
}

/**
 * Fluent builder for {@link ConsumerControllerOptionsType}.  The `handler`
 * is required — pass it via {@link withHandler} before `build()`.
 *
 *     ConsumerControllerOptions.create<Cmd>()
 *       .withHandler(async (body) => { … });
 */
export class ConsumerControllerOptionsBuilder<T> extends OptionsBuilder<ConsumerControllerOptionsType<T>> {
  /** Start a fresh builder.  Equivalent to `new ConsumerControllerOptionsBuilder<T>()`. */
  static create<T>(): ConsumerControllerOptionsBuilder<T> {
    return new ConsumerControllerOptionsBuilder<T>();
  }

  /** Handler invoked for every delivered (un-duplicated) message.  Required. */
  withHandler(handler: (body: T) => void | Promise<void>): this {
    return this.set('handler', handler);
  }
}

/**
 * Accepted input for a {@link ConsumerController}: the fluent
 * {@link ConsumerControllerOptionsBuilder} OR a plain
 * {@link ConsumerControllerOptionsType} object.
 */
export type ConsumerControllerOptions<T> =
  | ConsumerControllerOptionsBuilder<T>
  | Partial<ConsumerControllerOptionsType<T>>;
/** Value alias so `ConsumerControllerOptions.create()` / `new ConsumerControllerOptions()` resolve to the builder. */
export const ConsumerControllerOptions = ConsumerControllerOptionsBuilder;
