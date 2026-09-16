import type { ActorPath } from '../ActorPath.js';
import { ActorRef } from '../ActorRef.js';
import type { ActorSystem } from '../ActorSystem.js';
import type { Scheduler } from '../Scheduler.js';
import { DeadLetter } from '../SystemMessages.js';

/** The extension's bounded account of everything every pending ref holds. */
export interface PendingBufferAccount {
  /** Claim one slot; `false` means the extension-wide cap is reached. */
  reserve(): boolean;
  release(count: number): void;
}

type Buffered<TMessage> = {
  readonly message: TMessage;
  readonly sender: ActorRef | null;
};

/**
 * The ref `system.spawn` hands back for an actor that is being created on a
 * worker (#1563).
 *
 * `spawn` stays synchronous and the worker's acknowledgment does not, so
 * something has to be returned before the actor exists.  Its identity is
 * settled from the first instant — the path is chosen on the main thread, so
 * `path`, `equals` and `toString` are what they will be forever — and only
 * delivery waits: a `tell` before the acknowledgment is queued in order and
 * replayed through the real remote ref the moment it arrives, so a caller
 * that spawns and immediately sends sees exactly the ordering a local spawn
 * gives.  The queue is bounded across the whole extension, with the region
 * buffer's vocabulary for overflow: what does not fit goes to dead letters,
 * never silently away.  A spawn the worker refuses, or one that outlives its
 * deadline, fails the ref the same way — everything queued becomes a dead
 * letter naming this ref as the recipient, and everything after it too.
 */
export class PendingRemoteActorRef<TMessage = unknown> extends ActorRef<TMessage> {
  readonly path: ActorPath;
  private buffer: Buffered<TMessage>[] = [];
  private target: ActorRef<TMessage> | null = null;
  private failed = false;

  constructor(
    path: ActorPath,
    private readonly system: ActorSystem,
    private readonly account: PendingBufferAccount,
  ) {
    super();
    this.path = path;
  }

  tell(message: TMessage, sender: ActorRef | null = null): void {
    if (this.target !== null) {
      this.target.tell(message, sender);
      return;
    }
    if (this.failed || !this.account.reserve()) {
      this.system.deadLetters.tell(new DeadLetter(message, sender, this));
      return;
    }
    this.buffer.push({ message, sender });
  }

  /** Whether delivery has switched to the worker's actor. */
  get isResolved(): boolean { return this.target !== null; }

  /** @internal The worker acknowledged the spawn: replay the queue, in order, then forward everything. */
  _resolve(target: ActorRef<TMessage>): void {
    if (this.target !== null || this.failed) return;
    this.target = target;
    const queued = this.buffer;
    this.buffer = [];
    this.account.release(queued.length);
    for (const { message, sender } of queued) target.tell(message, sender);
  }

  /** @internal The spawn will never complete: everything queued, and everything after, is a dead letter. */
  _fail(): void {
    if (this.target !== null || this.failed) return;
    this.failed = true;
    const queued = this.buffer;
    this.buffer = [];
    this.account.release(queued.length);
    for (const { message, sender } of queued) {
      this.system.deadLetters.tell(new DeadLetter(message, sender, this));
    }
  }

  override _defaultAskTimeoutMs(): number { return this.system._defaultAskTimeoutMs; }

  override _virtualScheduler(): Scheduler | null { return this.system._virtualScheduler; }

  /** The worker's rendering once known — node-prefixed, like any remote ref — and the bare path until then. */
  override toString(): string {
    return this.target === null ? this.path.toString() : this.target.toString();
  }
}
