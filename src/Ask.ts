import type { ActorRef } from './ActorRef.js';
import { PromiseActorRef } from './internal/PromiseActorRef.js';

let askCounter = 0;

/**
 * Request/response pattern.  Sends `message` to `target`, attaching a
 * temporary sender ref.  The returned Promise resolves with the first reply
 * or rejects with AskTimeoutError after `timeoutMs`.
 *
 * Inside the recipient, reply with `context.sender?.tell(response)`.
 *
 * Tip: a recipient can reject an ask by replying with an `Error` instance.
 */
export function ask<TReq, TRes = unknown>(
  target: ActorRef<TReq>,
  message: TReq,
  timeoutMs: number = 5_000,
): Promise<TRes> {
  const name = `askResp-${++askCounter}`;
  // Use the target's system name for the path, falling back to 'ask' if we can't tell.
  const systemName = target.path.systemName;
  const ref = new PromiseActorRef<TRes>(systemName, name, timeoutMs, target.path.toString());
  target.tell(message, ref);
  return ref.promise;
}
