import type { ProcessSignal } from '../../util/ProcessSignal.js';
import {
  UNCATCHABLE_SIGNALS,
  WINDOWS_DELIVERABLE_SIGNALS,
  type ProcessSignals,
} from './ProcessSignals.js';

/** The slice of the `Deno` global this backend uses, typed structurally. */
interface SignalCapableDeno {
  addSignalListener(signal: string, handler: () => void): void;
  removeSignalListener(signal: string, handler: () => void): void;
  readonly build?: { readonly os?: string };
}

/**
 * Signal names in {@link ProcessSignal} that `Deno.Signal` does not have.
 *
 * All four are Linux aliases or long-dead numbers that Node's type kept for
 * compatibility — `SIGIOT` is `SIGABRT`, `SIGPOLL` is `SIGIO`, `SIGUNUSED`
 * is `SIGSYS`, and `SIGLOST` has not existed since Linux 2.0.  Deno rejects
 * an unknown name by throwing, so they are filtered rather than forwarded;
 * anyone who genuinely wants one asks for the name Deno knows it by.
 */
const DENO_UNKNOWN_SIGNALS: ReadonlySet<ProcessSignal> = new Set<ProcessSignal>([
  'SIGIOT',
  'SIGLOST',
  'SIGPOLL',
  'SIGUNUSED',
]);

/**
 * Deno's signal delivery — `Deno.addSignalListener` / `removeSignalListener`.
 *
 * Deno's `process` shim does not carry signal events, so the `process.on`
 * path the other two runtimes share silently registers nothing there.  This
 * is the backend that made the abstraction necessary rather than tidy.
 *
 * Two Deno-specific hazards this class exists to contain:
 *
 * - **Registration throws** for a signal the platform cannot deliver, unlike
 *   Node's accept-and-never-fire.  On Windows that is everything except
 *   SIGINT and SIGBREAK, so {@link supports} gates on `Deno.build.os` and a
 *   `bun run smoke` on a maintainer's Windows box degrades to the console
 *   control events instead of failing to start.
 * - **A listener keeps the event loop alive.**  Deno has no `unref` for one,
 *   so a program that installs a handler and never removes it does not exit
 *   on its own — which is why `removeProcessHooks()` is not optional
 *   housekeeping here, and why `runUntilTerminated()` calls it in a
 *   `finally`.
 *
 * Requires `--allow-run`?  No — signal *handling* needs no permission flag.
 * Only a test that spawns a child to signal does, which is why
 * `smoke:deno` grants it.
 */
export class DenoProcessSignals implements ProcessSignals {
  readonly runtime: ProcessSignals['runtime'] = 'Deno';

  supports(signal: ProcessSignal): boolean {
    if (UNCATCHABLE_SIGNALS.has(signal)) return false;
    if (DENO_UNKNOWN_SIGNALS.has(signal)) return false;
    const deno = this.deno;
    if (deno === null) return false;
    if (deno.build?.os === 'windows') return WINDOWS_DELIVERABLE_SIGNALS.has(signal);
    return true;
  }

  add(signal: ProcessSignal, handler: () => void): void {
    this.deno?.addSignalListener(signal, handler);
  }

  remove(signal: ProcessSignal, handler: () => void): void {
    this.deno?.removeSignalListener(signal, handler);
  }

  private get deno(): SignalCapableDeno | null {
    const candidate = (globalThis as { Deno?: Partial<SignalCapableDeno> }).Deno;
    if (!candidate) return null;
    if (typeof candidate.addSignalListener !== 'function') return null;
    if (typeof candidate.removeSignalListener !== 'function') return null;
    return candidate as SignalCapableDeno;
  }
}
