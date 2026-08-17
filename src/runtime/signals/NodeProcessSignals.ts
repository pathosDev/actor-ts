import type { ProcessSignal } from '../../util/ProcessSignal.js';
import { UNCATCHABLE_SIGNALS, type ProcessSignals } from './ProcessSignals.js';

/**
 * The slice of Node's `process` this backend uses, typed structurally so the
 * module compiles with or without `@types/node` — the same reason
 * {@link ProcessSignal} exists at all (#1006).
 */
interface SignalCapableProcess {
  on(signal: string, handler: () => void): unknown;
  off(signal: string, handler: () => void): unknown;
}

/**
 * `process`-based signal delivery — Node.js's `process.on(signal, …)`.
 *
 * Windows is not special-cased here even though it has no POSIX signals.
 * Node accepts a registration for `SIGTERM` on Windows and simply never
 * fires it, so declaring the signal unsupported would trade a handler that
 * is never called for a startup path that has to branch — no behavioural
 * difference, one more thing to get wrong.  Deno is the runtime where the
 * distinction is load-bearing, because there the registration *throws*.
 */
export class NodeProcessSignals implements ProcessSignals {
  readonly runtime: ProcessSignals['runtime'] = 'Node.js';

  /**
   * `false` when there is no `process` to listen on at all — a bundled
   * browser build, a Worker, a `--jitless` embedding.  Callers treat that
   * as "this program cannot be signalled", which is exactly right.
   */
  supports(signal: ProcessSignal): boolean {
    if (UNCATCHABLE_SIGNALS.has(signal)) return false;
    return this.process !== null;
  }

  add(signal: ProcessSignal, handler: () => void): void {
    this.process?.on(signal, handler);
  }

  remove(signal: ProcessSignal, handler: () => void): void {
    this.process?.off(signal, handler);
  }

  private get process(): SignalCapableProcess | null {
    const candidate = (globalThis as { process?: Partial<SignalCapableProcess> }).process;
    if (!candidate) return null;
    if (typeof candidate.on !== 'function' || typeof candidate.off !== 'function') return null;
    return candidate as SignalCapableProcess;
  }
}
