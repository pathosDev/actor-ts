import { SINK_REPORT_INTERVAL_MS } from './Constants.js';

/**
 * How a sink tells an operator that it is in trouble.
 *
 * The framework logger is not available to a sink — a sink *is* the
 * framework logger, so reporting a delivery failure through it feeds the
 * failure back into the thing that failed, and a destination that is down
 * would generate an unbounded storm of records about being down.  The
 * codebase already answers this the same way wherever a component sits
 * underneath logging (`Dispatcher`, `Scheduler`): write to `console.error`
 * directly.
 *
 * What this class adds is the rate limit.  Failures come in floods — one
 * per batch while an endpoint is unreachable, one per record while a queue
 * is full — so an unthrottled report turns a broken sink into a broken
 * terminal.  Reports are keyed by *reason* so a connection failure and a
 * queue overflow do not suppress each other, and each key reports at most
 * once per {@link SINK_REPORT_INTERVAL_MS}, carrying the count of what
 * happened in between so nothing is silently swallowed:
 *
 *     [actor-ts] log sink "gelf": queue full — dropped 1240 records (1239 similar suppressed)
 *
 * `now` and `write` are injectable so the throttling is testable without a
 * clock or a patched console.
 */
export class SinkReporter {
  private readonly lastReportMs = new Map<string, number>();
  private readonly suppressed = new Map<string, number>();

  constructor(
    private readonly sinkName: string,
    private readonly intervalMs: number = SINK_REPORT_INTERVAL_MS,
    private readonly now: () => number = Date.now,
    private readonly write: (line: string) => void = (line) => console.error(line),
  ) {}

  /**
   * Report `reason` unless an identical reason was reported within the
   * interval, in which case only a counter moves.  `detail` is appended
   * when it renders to something useful — an error message, a status code.
   */
  report(reason: string, detail?: unknown): void {
    const at = this.now();
    const last = this.lastReportMs.get(reason);
    if (last !== undefined && at - last < this.intervalMs) {
      this.suppressed.set(reason, (this.suppressed.get(reason) ?? 0) + 1);
      return;
    }
    this.lastReportMs.set(reason, at);
    const hidden = this.suppressed.get(reason) ?? 0;
    this.suppressed.delete(reason);
    const suffix = hidden > 0 ? ` (${hidden} similar suppressed)` : '';
    const explanation = describe(detail);
    this.write(`[actor-ts] log sink "${this.sinkName}": ${reason}${explanation}${suffix}`);
  }
}

/**
 * Render whatever a caller passed as `detail` without ever throwing —
 * this runs on the failure path, where a second failure is the last thing
 * anybody needs.
 */
function describe(detail: unknown): string {
  if (detail === undefined) return '';
  if (detail instanceof Error) return ` — ${detail.message}`;
  if (typeof detail === 'string') return ` — ${detail}`;
  try {
    return ` — ${JSON.stringify(detail)}`;
  } catch {
    return '';
  }
}
