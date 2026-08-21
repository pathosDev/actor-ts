/**
 * The `actors.send` action (#553) — the one thing DevTools can do to a
 * running system rather than merely watch it.
 *
 * Everything else in this protocol reads.  This writes, which makes it a
 * different kind of feature and gives it a different default: it is off
 * unless the operator acknowledged it in code, and when it is off the
 * method is not registered at all rather than registered and refusing.
 *
 * Two bounds are worth naming because they are structural rather than
 * enforced:
 *
 * - The message is **JSON**, so it is a plain object.  It cannot be a
 *   `PoisonPill`, a `Kill`, or any other class the system treats
 *   specially — those are instances, and JSON cannot construct one.
 * - The recipient must be under the **user guardian**.  System actors
 *   are internal machinery, and a hand-written message to one is at best
 *   ignored.
 */

/** What `actors.send` accepts. */
export type SendMessageParameters = {
  /** Path of the recipient, e.g. `/user/orders/checkout`. */
  readonly path: string;
  /** The message, as JSON text — parsed and validated server-side. */
  readonly body: string;
};

/** What `actors.send` answers. */
export type SendMessageResult = {
  /** The path the message actually went to, fully qualified. */
  readonly path: string;
  /** Constructor name the recipient will see, for the panel's log. */
  readonly messageType: string;
  readonly atMs: number;
};

/**
 * Largest JSON body accepted, in bytes.
 *
 * Small on purpose: this is a debugging poke, not a data-loading path,
 * and an unbounded field on a write endpoint is a way to push arbitrary
 * amounts of memory into an actor's mailbox from a browser.
 */
export const SEND_MESSAGE_MAX_BYTES = 64 * 1024;
