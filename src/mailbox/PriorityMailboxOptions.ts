import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { PriorityFunction } from './PriorityMailbox.js';

/** Plain options-object shape accepted by a {@link PriorityMailbox}. */
export interface PriorityMailboxOptionsType<T> {
  readonly priorityFor: PriorityFunction<T>;
}

/**
 * Fluent builder for {@link PriorityMailboxOptionsType}:
 *
 *     new PriorityMailbox(PriorityMailboxOptions.create<Command>()
 *       .withPriorityFor((m) => m.urgent ? 0 : 10));
 */
export class PriorityMailboxOptionsBuilder<T> extends OptionsBuilder<PriorityMailboxOptionsType<T>> {
  /** Start a fresh builder.  Equivalent to `new PriorityMailboxOptionsBuilder<T>()`. */
  static create<T>(): PriorityMailboxOptionsBuilder<T> {
    return new PriorityMailboxOptionsBuilder<T>();
  }

  /** Priority function: lower numbers are dequeued first (0 = highest).  Required. */
  withPriorityFor(priorityFor: PriorityFunction<T>): this {
    return this.set('priorityFor', priorityFor);
  }
}

/**
 * Accepted input for a {@link PriorityMailbox}: the fluent
 * {@link PriorityMailboxOptionsBuilder} OR a plain
 * {@link PriorityMailboxOptionsType} object.
 */
export type PriorityMailboxOptions<T> =
  | PriorityMailboxOptionsBuilder<T>
  | Partial<PriorityMailboxOptionsType<T>>;
/** Value alias so `PriorityMailboxOptions.create()` / `new PriorityMailboxOptions()` resolve to the builder. */
export const PriorityMailboxOptions = PriorityMailboxOptionsBuilder;
