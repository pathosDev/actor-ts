import { _registerAskImpl, type ActorRef, type OmitReplyTo } from './ActorRef.js';
import { PromiseActorRef } from './internal/PromiseActorRef.js';

export type { OmitReplyTo };

let askCounter = 0;

/**
 * Request/response pattern.  Sends `message` to `target`, attaching a
 * temporary sender ref AND injecting it as `replyTo` on the message.
 * The returned Promise resolves with the first reply or rejects with
 * AskTimeoutError after `timeoutMs`.
 *
 * Two reply paths work transparently:
 *   - **Implicit sender** — recipient reads `this.sender?.tell(response)`.
 *   - **Explicit replyTo** — recipient reads `msg.replyTo.tell(response)`.
 *
 * Tip: a recipient can reject an ask by replying with an `Error` instance.
 */
export function ask<TReq, TRes = unknown>(
  target: ActorRef<TReq>,
  message: OmitReplyTo<TReq>,
  timeoutMs: number = 5_000,
): Promise<TRes> {
  const name = `askResp-${++askCounter}`;
  // Use the target's system name for the path, falling back to 'ask' if we can't tell.
  const systemName = target.path.systemName;
  const ref = new PromiseActorRef<TRes>(systemName, name, timeoutMs, target.path.toString());
  // Inject `replyTo: ref` into the message so recipients that read it
  // from the message field work without the caller supplying it.
  // Spreading is cheap; primitives that aren't object-like fall back
  // to the bare message (the framework's message contract is "object
  // shape" so this is the standard case).
  const enriched =
    typeof message === 'object' && message !== null
      ? ({ ...(message as object), replyTo: ref } as unknown as TReq)
      : (message as unknown as TReq);
  target.tell(enriched, ref);
  return ref.promise;
}

// Register at module load so `ref.ask()` works without explicit user wiring.
// Safe to call multiple times — last writer wins.
_registerAskImpl(ask as never);
