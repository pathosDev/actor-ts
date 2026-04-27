import type { ActorRef } from '../ActorRef.js';
import { Failure, Success } from './Status.js';

export interface PipeToOptions {
  /** ActorRef attributed as the sender on the tell; optional. */
  readonly sender?: ActorRef | null;
  /**
   * When true (default), wraps the value in `Success` and the error in
   * `Failure` before telling.  Set to false to forward the raw value on
   * success and drop errors.
   */
  readonly wrap?: boolean;
}

/**
 * Route the eventual result of `promise` into an actor's mailbox.  On
 * fulfilment the value (or `Success<T>`) lands as a message.  On rejection
 * `Failure(error)` is delivered so the actor can react.
 *
 * Returns the same promise so callers can chain further logic if needed.
 */
export function pipeTo<T>(
  promise: Promise<T>,
  recipient: ActorRef,
  options: PipeToOptions = {},
): Promise<T> {
  const wrap = options.wrap ?? true;
  const sender = options.sender ?? null;
  promise.then(
    (v) => {
      recipient.tell(wrap ? new Success(v) : (v as never), sender);
    },
    (err: unknown) => {
      if (wrap) {
        recipient.tell(new Failure(err instanceof Error ? err : new Error(String(err))) as never, sender);
      }
      // When !wrap, rejections are silently dropped — the caller opted out.
    },
  );
  return promise;
}
