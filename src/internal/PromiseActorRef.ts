import { ActorRef } from '../ActorRef.js';
import { ActorPath } from '../ActorPath.js';
import { AskTimeoutError } from '../SystemMessages.js';

/**
 * A short-lived actor-like ref used by the ask pattern.  It accepts the
 * first reply and either resolves or rejects its promise.  If `timeoutMs`
 * elapses first the promise rejects with AskTimeoutError.
 */
export class PromiseActorRef<T> extends ActorRef<unknown> {
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
          this.rejectFn(new AskTimeoutError(`Ask timed out after ${timeoutMs}ms waiting for reply from ${targetLabel}`));
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
