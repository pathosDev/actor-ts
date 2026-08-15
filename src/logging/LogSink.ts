import type { LogLevel } from '../Logger.js';
import type { Scheduler } from '../Scheduler.js';
import type { LogRecord } from './LogRecord.js';

/**
 * What a sink learns when it is installed into a running `ActorSystem`.
 *
 * A sink is constructed before any system exists — it is passed *to*
 * `ActorSystem.create` — so anything system-shaped has to arrive later, via
 * {@link LogSink.attach}.  Two things are worth handing over:
 *
 *  - the **scheduler**, so a batching sink's flush ticker is registered
 *    where `scheduler.shutdown()` can clear it (an armed `setInterval`
 *    otherwise keeps the process alive after the system terminates, #641)
 *    and where `ManualScheduler` can drive it deterministically in tests;
 *  - the **system name**, the natural default for the `service.name` /
 *    `app-name` / GELF `host` field a remote sink has to send *something*
 *    for.
 */
export type LogSinkContext = {
  readonly scheduler?: Scheduler;
  readonly systemName?: string;
};

/**
 * One destination for log records — the console, a file, a log platform.
 *
 * **The contract is "never make things worse".**  Logging is a diagnostic
 * side channel: an application that logs must not fail, stall or crash
 * because a destination is unreachable.  Three rules follow, and every
 * shipped sink obeys them:
 *
 *  1. **`write` never throws.**  Failures are the sink's own problem.  The
 *     pipeline wraps sinks defensively too, but a sink that leans on that
 *     wrapper is a sink that loses the rest of its batch.
 *  2. **`write` never blocks.**  It hands the record to a bounded queue and
 *     returns; the I/O happens later.  Only the console sink writes
 *     synchronously, because there is nothing to wait for.
 *  3. **A sink never logs through the framework logger.**  It *is* the
 *     framework logger — reporting a delivery failure that way would feed
 *     the failure straight back into itself.  Sinks report on raw
 *     `console.error`, rate-limited — the convention for errors raised on
 *     paths that logging itself depends on, which `Scheduler` still
 *     follows outright and `Dispatcher` keeps only as its last resort
 *     (#410).
 *
 * `attach`, `flush` and `close` are optional so a minimal sink is a
 * one-method object: `{ name, minLevel, write }` is a complete
 * implementation.
 */
export interface LogSink {
  /**
   * Stable identifier used in drop reports and diagnostics
   * (`'console'`, `'file'`, `'gelf'`, …).  Not required to be unique —
   * two file sinks writing different directories may share a name — it
   * only has to tell an operator which sink is complaining.
   */
  readonly name: string;
  /** Records below this level are never passed to {@link write}. */
  readonly minLevel: LogLevel;
  /** Accept a record.  Must not throw and must not block. */
  write(record: LogRecord): void;
  /** Called once when the logger is installed into an `ActorSystem`. */
  attach?(context: LogSinkContext): void;
  /** Deliver everything queued so far.  Resolves when the queue is drained. */
  flush?(): Promise<void>;
  /**
   * Drain, flush and release transports.  Idempotent — the system's
   * shutdown path and an explicit call may both reach it.  It must resolve
   * even when the destination is unreachable; the caller bounds it with a
   * timeout, but a sink that hangs forever burns that whole budget.
   */
  close?(): Promise<void>;
}
