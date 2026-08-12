import type { LogContextData } from '../LogContext.js';
import type { LogLevel } from '../Logger.js';

/**
 * One log event, frozen at the moment it was emitted — the unit every
 * {@link LogSink} receives.
 *
 * **Why a record type at all.**  The single-destination loggers
 * (`ConsoleLogger`, `JsonLogger`) render straight from their arguments, so
 * every one of them re-does the same work: read the MDC, merge it over the
 * static fields, normalise the arguments.  With more than one destination
 * that work has to happen exactly once — not least because it is not
 * repeatable.  {@link fields} is captured **synchronously at emit time**;
 * a sink that batches and flushes a second later runs in a different async
 * context, where `LogContext.get()` no longer returns the caller's MDC.
 *
 * Records are treated as immutable.  Sinks share one instance, so mutating
 * a record would be visible to every other sink — and to a batch that has
 * not been written yet.
 */
export type LogRecord = {
  /** Emit time in epoch milliseconds — `Date.now()` at the call site. */
  readonly timestampMs: number;
  /** Never `LogLevel.Off`: a record only exists once the level gate passed. */
  readonly level: LogLevel;
  /** Bound source, typically an actor path.  Absent on an unbound logger. */
  readonly source?: string;
  readonly message: string;
  /**
   * Static fields (from `withFields`) merged under the dynamic MDC (from
   * `LogContext.run`), dynamic winning on collision — the "innermost scope
   * wins" rule the single-destination loggers already follow.  Key order is
   * static-then-dynamic, which is what keeps the JSON formatter's output
   * byte-identical to `JsonLogger`.
   */
  readonly fields: LogContextData;
  /**
   * The actor's human-readable name, lifted from the **static** fields
   * only (see `DISPLAY_NAME_FIELD`).  A dynamic one arrives over the
   * cluster wire from a remote peer (#573) and has no business naming a
   * local actor, so it stays an ordinary field.
   *
   * It is *also* still present in {@link fields} — the two views are
   * deliberate: `fields` is the wire/JSON view (every key queryable),
   * `displayName` is the human view the text formatter puts in the line
   * head instead of the field suffix.
   */
  readonly displayName?: string;
  /**
   * Extra positional arguments, already through `normaliseArg` so an
   * `Error` is a plain `{ name, message, stack }` object rather than the
   * `{}` a bare `JSON.stringify` would produce.  Absent when none were
   * passed, so a sink can skip the key entirely.
   */
  readonly args?: readonly unknown[];
};

/**
 * A hook that rewrites or drops a record on its way through the pipeline —
 * returning `null` discards it.
 *
 * This is the redaction seam: a token or a connection URL that reached the
 * MDC can be masked here, once, rather than in every sink (#590, #592,
 * #741).  It runs before fan-out, so every sink sees the same redacted
 * record and there is no ordering question about which destination gets the
 * raw value.
 *
 * It must be cheap and total: it runs on the caller's thread for every
 * record that passes the level gate, and a throw would surface in
 * application code.  A transform that throws is treated as "keep the record
 * unchanged".
 */
export type LogRecordTransform = (record: LogRecord) => LogRecord | null;
