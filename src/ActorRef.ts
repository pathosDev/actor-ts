import { ActorPath } from './ActorPath.js';
import { PoisonPill, Kill } from './SystemMessages.js';

/**
 * Drop `replyTo: ActorRef<...>` from any variant of a message union
 * that declares one.  Distributes across unions: variants without
 * `replyTo` pass through untouched; variants with `replyTo` lose just
 * that field.  Lives here (not in Ask.ts) so `ActorRef` can reference
 * it without importing the runtime ask implementation — that would
 * create an import cycle through PromiseActorRef.
 */
export type OmitReplyTo<TMsg> = TMsg extends { replyTo: ActorRef<unknown> }
  ? Omit<TMsg, 'replyTo'>
  : TMsg;

/** Set by `Ask.ts` on module init so `ActorRef.ask()` can call into it
 *  without `ActorRef.ts` importing `Ask.ts` (which would cycle through
 *  PromiseActorRef → ActorRef). */
let askImpl: (<TReq, TRes>(
  target: ActorRef<TReq>,
  message: OmitReplyTo<TReq>,
  timeoutMs?: number,
) => Promise<TRes>) | null = null;

/** @internal — Ask.ts calls this once when it loads. */
export function _registerAskImpl(impl: typeof askImpl): void { askImpl = impl; }

/**
 * Handle to an actor.  The only way to interact with an actor — you never
 * hold a direct reference to the Actor instance itself.  tell() is fire-and-
 * forget; ask() provides a request/response Promise.
 */
export abstract class ActorRef<TMsg = unknown> {
  abstract readonly path: ActorPath;

  /** Send a message to this actor. `sender` is surfaced as context.sender in the recipient. */
  abstract tell(message: TMsg, sender?: ActorRef | null): void;

  /** Alias for tell — useful if you want to pipe something. */
  send(message: TMsg): void { this.tell(message, null); }

  /**
   * Request/response — send `message` and await the recipient's reply.
   * The framework synthesises a one-shot reply ref, injects it as both
   * the `sender` slot and as `message.replyTo`, and resolves the returned
   * promise with the first reply (or rejects with `AskTimeoutError`).
   *
   * The caller never specifies `replyTo` on the message — the `OmitReplyTo`
   * type subtracts it from the parameter type if the recipient declares it.
   *
   *     const value = await counter.ask<number>({ kind: 'get' });
   */
  ask<TRes = unknown>(message: OmitReplyTo<TMsg>, timeoutMs?: number): Promise<TRes> {
    if (askImpl === null) {
      throw new Error(
        'ActorRef.ask() called before Ask.ts loaded — make sure the framework entry point ' +
        'is imported (e.g. `import * as ActorTs from "actor-ts"`) at least once before use.',
      );
    }
    return askImpl<TMsg, TRes>(this as ActorRef<TMsg>, message, timeoutMs);
  }

  /** Gracefully stop this actor after it drains its mailbox. */
  stop(): void { this.tell(PoisonPill.instance as unknown as TMsg, null); }

  /** Kill this actor — raises ActorKilledError through the normal supervision path. */
  kill(): void { this.tell(Kill.instance as unknown as TMsg, null); }

  toString(): string { return this.path.toString(); }

  equals(other: ActorRef): boolean {
    return this.path.toString() === other.path.toString();
  }
}

/**
 * The ref that means "no actor here".  Any message tell()'d to Nobody is
 * silently dropped (it does not even go to dead letters).
 */
export class NobodyRef extends ActorRef<unknown> {
  static readonly instance: NobodyRef = new NobodyRef();
  readonly path = new ActorPath('nobody', null, '<nobody>');
  private constructor() { super(); }
  tell(): void { /* drop */ }
}

export const Nobody: ActorRef = NobodyRef.instance;
