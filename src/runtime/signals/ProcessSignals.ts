import type { ProcessSignal } from '../../util/ProcessSignal.js';

/**
 * Runtime-neutral process-signal abstraction consumed by
 * {@link CoordinatedShutdown.installProcessHooks}.
 *
 * Bun and Node.js deliver signals through `process.on` / `process.off`; Deno
 * has its own `Deno.addSignalListener` / `Deno.removeSignalListener` and only
 * a partial `process` shim, so a single `process.on` call site cannot serve
 * all three.  Signal handling was the last runtime-specific primitive still
 * written inline against `process` (#549); it now sits beside `src/runtime/
 * tcp/`, `http/`, `sqlite/` and `worker/` like every other one.
 *
 * Unlike those, the backend is chosen **synchronously**: none of the three
 * implementations needs a module import — Bun and Node reach `process` off
 * the global scope, Deno reaches `Deno` — and `installProcessHooks` is a
 * synchronous public API that predates this abstraction.  Making it async to
 * await a backend would have been a breaking change bought for nothing.
 */
export interface ProcessSignals {
  /** Which runtime this backend speaks for — for diagnostics and tests. */
  readonly runtime: 'Bun' | 'Node.js' | 'Deno';

  /**
   * Whether a listener for `signal` can be installed here at all.
   *
   * Never a question of taste: registering an unsupported signal *throws* on
   * Deno (Windows accepts only SIGINT and SIGBREAK), and `SIGKILL` /
   * `SIGSTOP` cannot be caught on any runtime or platform.  Callers skip
   * what this rejects rather than letting a shutdown hook fail to install
   * and take the program's startup with it.
   */
  supports(signal: ProcessSignal): boolean;

  /** Install `handler` for `signal`.  Only ever called for a supported signal. */
  add(signal: ProcessSignal, handler: () => void): void;

  /** Remove exactly the `handler` that {@link add} installed — never all of them. */
  remove(signal: ProcessSignal, handler: () => void): void;
}

/**
 * Signals no runtime lets a process catch.  The kernel handles both itself,
 * and asking to be told about them throws rather than being ignored.
 */
export const UNCATCHABLE_SIGNALS: ReadonlySet<ProcessSignal> = new Set<ProcessSignal>([
  'SIGKILL',
  'SIGSTOP',
]);

/**
 * The only two signals Windows can deliver to a Deno process — the console
 * control events, which is all the platform has.  There is no POSIX signal
 * layer to emulate: `SIGTERM` never arrives on Windows no matter who asks
 * for it, so refusing to register it loses nothing and avoids the throw.
 */
export const WINDOWS_DELIVERABLE_SIGNALS: ReadonlySet<ProcessSignal> = new Set<ProcessSignal>([
  'SIGINT',
  'SIGBREAK',
]);
