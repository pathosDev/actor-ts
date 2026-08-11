// The base queue every variant extends, and the record it holds.  Re-exported
// from `src/internal/` rather than moved: the class is load-bearing for the
// cell, and relocating it would churn every importer for no behavioural gain.
// Public because a custom mailbox is unwritable without both — `extends
// Mailbox` needs the class, and every method it overrides takes an
// `Envelope<T>` — and because `MailboxFactory` has always been exported while
// the type it returns was not (#661, #1002).
export { Mailbox } from '../internal/Mailbox.js';
export type { Envelope } from '../internal/Mailbox.js';
export { BoundedMailbox, MailboxFullError } from './BoundedMailbox.js';
export { BoundedMailboxOptions, BoundedMailboxOptionsBuilder, BoundedMailboxOptionsValidator } from './BoundedMailboxOptions.js';
export type { BoundedMailboxOptionsType, BoundedMailboxOverflow } from './BoundedMailboxOptions.js';
export { PriorityMailbox } from './PriorityMailbox.js';
export { PriorityMailboxOptions, PriorityMailboxOptionsBuilder } from './PriorityMailboxOptions.js';
export type { PriorityMailboxOptionsType } from './PriorityMailboxOptions.js';
export type { PriorityFunction } from './PriorityMailbox.js';
