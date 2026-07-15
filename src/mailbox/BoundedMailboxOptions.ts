import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import type { BoundedMailboxOverflow } from './BoundedMailbox.js';

/** Plain options-object shape accepted by a {@link BoundedMailbox}. */
export interface BoundedMailboxOptionsType {
  readonly capacity: number;
  readonly overflow?: BoundedMailboxOverflow;
  /**
   * Optional hook fired each time a message is dropped by the overflow
   * policy.  Receives the policy that triggered the drop so the consumer
   * can label metrics.  Never fires for `reject` — that throws instead.
   */
  readonly onDrop?: (reason: 'drop-head' | 'drop-new') => void;
}

/**
 * Fluent builder for {@link BoundedMailboxOptionsType}:
 *
 *     new BoundedMailbox(BoundedMailboxOptions.create()
 *       .withCapacity(1000)
 *       .withOverflow('drop-head'));
 */
export class BoundedMailboxOptionsBuilder extends OptionsBuilder<BoundedMailboxOptionsType> {
  /** Start a fresh builder. */
  static create(): BoundedMailboxOptionsBuilder {
    return new BoundedMailboxOptionsBuilder();
  }

  /** Maximum queued user messages.  Must be >= 1. */
  withCapacity(capacity: number): this {
    return this.set('capacity', capacity);
  }

  /** What to do when a message arrives on a full mailbox.  Default `reject`. */
  withOverflow(overflow: BoundedMailboxOverflow): this {
    return this.set('overflow', overflow);
  }

  /** Hook fired on each overflow drop (for metrics). */
  withOnDrop(onDrop: (reason: 'drop-head' | 'drop-new') => void): this {
    return this.set('onDrop', onDrop);
  }
}

/**
 * Validates resolved {@link BoundedMailboxOptionsType} settings.  `capacity`
 * is required at runtime too — without it the "bounded" mailbox would
 * silently be unbounded.
 */
export class BoundedMailboxOptionsValidator extends OptionsValidator<BoundedMailboxOptionsType> {
  constructor() {
    super('BoundedMailboxOptions');
  }
  protected rules(s: Partial<BoundedMailboxOptionsType>): void {
    if (s.capacity === undefined) this.fail('capacity', 'is required');
    this.positiveInt('capacity');
    this.oneOf('overflow', ['drop-head', 'drop-new', 'reject']);
  }
}

/**
 * Accepted input for a {@link BoundedMailbox}: the fluent
 * {@link BoundedMailboxOptionsBuilder} OR a plain
 * {@link BoundedMailboxOptionsType} object.
 */
export type BoundedMailboxOptions = BoundedMailboxOptionsBuilder | Partial<BoundedMailboxOptionsType>;
/** Value alias so `BoundedMailboxOptions.create()` / `new BoundedMailboxOptions()` resolve to the builder. */
export const BoundedMailboxOptions = BoundedMailboxOptionsBuilder;
