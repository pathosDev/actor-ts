import { ActorPath } from './ActorPath.js';
import { AskTimeoutError, PoisonPill, Kill } from './SystemMessages.js';

/**
 * Drop `replyTo: ActorRef<...>` from any variant of a message union
 * that declares one.  Distributes across unions: variants without
 * `replyTo` pass through untouched; variants with `replyTo` lose just
 * that field.  Used by `ActorRef.ask()` so callers never have to
 * supply the `replyTo` field — the framework synthesises and injects
 * one on every call.
 */
export type OmitReplyTo<TMsg> = TMsg extends { replyTo: ActorRef<unknown> }
  ? Omit<TMsg, 'replyTo'>
  : TMsg;

let askCounter = 0;

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
  ask<TRes = unknown>(message: OmitReplyTo<TMsg>, timeoutMs: number = 5_000): Promise<TRes> {
    const name = `askResp-${++askCounter}`;
    const systemName = this.path.systemName;
    const ref = new AskResponseRef<TRes>(systemName, name, timeoutMs, this.path.toString());
    // Inject `replyTo: ref` into the message so recipients that read
    // `msg.replyTo` work without the caller supplying it.  Recipients
    // that read `this.sender` see the same ref (passed via `tell`'s
    // second arg).
    const enriched =
      typeof message === 'object' && message !== null
        ? ({ ...(message as object), replyTo: ref } as unknown as TMsg)
        : (message as unknown as TMsg);
    this.tell(enriched, ref as unknown as ActorRef);
    return ref.promise;
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
 * Short-lived ref synthesised by {@link ActorRef.ask} to capture the
 * recipient's reply.  Accepts the first message (success or `Error`-shaped
 * failure) and either resolves or rejects its promise; further messages
 * are dropped.  If `timeoutMs` elapses before a reply, rejects with
 * {@link AskTimeoutError}.
 *
 * Lives in `ActorRef.ts` (not a separate file) so the abstract `ActorRef`
 * class has a concrete reply-ref to instantiate without any module-cycle
 * gymnastics — `AskResponseRef extends ActorRef`, both in the same file.
 */
class AskResponseRef<T> extends ActorRef<unknown> {
  readonly path: ActorPath;
  readonly promise: Promise<T>;
  private resolveFn!: (value: T) => void;
  private rejectFn!: (err: Error) => void;
  private settled = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(systemName: string, name: string, timeoutMs: number, targetLabel: string) {
    super();
    this.path = new ActorPath(name, null, systemName);
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
    if (timeoutMs > 0) {
      this.timer = setTimeout(() => {
        if (!this.settled) {
          this.settled = true;
          this.rejectFn(new AskTimeoutError(
            `Ask timed out after ${timeoutMs}ms waiting for reply from ${targetLabel}`,
          ));
        }
      }, timeoutMs);
    }
  }

  tell(message: unknown): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (message instanceof Error) this.rejectFn(message);
    else this.resolveFn(message as T);
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
