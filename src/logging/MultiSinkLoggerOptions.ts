import { LogLevel } from '../Logger.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import type { LogRecordTransform } from './LogRecord.js';
import type { LogSink } from './LogSink.js';

/**
 * How long {@link MultiSinkLogger.close} waits for **one** sink to drain
 * before moving on without it.
 *
 * Per sink rather than for the whole set, so one unreachable endpoint
 * cannot eat the budget a healthy file sink needs to finish its last
 * write.  Three seconds is enough for a queued batch to reach a local
 * disk or a nearby collector, and short enough that a process shutting
 * down behind a dead endpoint still exits promptly.
 */
export const DEFAULT_SINK_CLOSE_TIMEOUT_MS = 3_000;

/** Plain options-object shape accepted by {@link MultiSinkLogger}. */
export type MultiSinkLoggerOptionsType = {
  /**
   * The destinations, in the order they receive each record.  An empty
   * list is legal and means "discard everything" — it makes the logger's
   * `level` report `Off`, so a caller that filtered its sinks by
   * environment can tell the difference from a misconfiguration.
   */
  readonly sinks: readonly LogSink[];
  /**
   * Global floor.  The effective gate is the **stricter** of this and the
   * lowest `minLevel` among the sinks, so leaving it unset never
   * accidentally suppresses a debug-level sink, and setting it always
   * wins over one.
   */
  readonly level?: LogLevel;
  /** Redaction / rewriting hook applied once, before fan-out. */
  readonly transform?: LogRecordTransform;
  /** Per-sink drain budget on close.  Default {@link DEFAULT_SINK_CLOSE_TIMEOUT_MS}. */
  readonly closeTimeoutMs?: number;
};

/** Fluent builder for {@link MultiSinkLoggerOptionsType}. */
export class MultiSinkLoggerOptionsBuilder extends OptionsBuilder<MultiSinkLoggerOptionsType> {
  /** Start a fresh builder.  Equivalent to `new MultiSinkLoggerOptionsBuilder()`. */
  static create(): MultiSinkLoggerOptionsBuilder {
    return new MultiSinkLoggerOptionsBuilder();
  }

  /** The destinations each record is fanned out to. */
  withSinks(sinks: readonly LogSink[]): this {
    return this.set('sinks', sinks);
  }

  /** Global floor, applied on top of the per-sink minimum levels. */
  withLevel(level: LogLevel): this {
    return this.set('level', level);
  }

  /** Rewrite or drop each record before it is fanned out. */
  withTransform(transform: LogRecordTransform): this {
    return this.set('transform', transform);
  }

  /** Per-sink drain budget on close, in milliseconds. */
  withCloseTimeoutMs(closeTimeoutMs: number): this {
    return this.set('closeTimeoutMs', closeTimeoutMs);
  }
}

/** Validates resolved {@link MultiSinkLoggerOptionsType} settings. */
export class MultiSinkLoggerOptionsValidator extends OptionsValidator<MultiSinkLoggerOptionsType> {
  constructor() {
    super('MultiSinkLoggerOptions');
  }

  protected rules(s: Partial<MultiSinkLoggerOptionsType>): void {
    this.oneOf('level', [LogLevel.Debug, LogLevel.Info, LogLevel.Warn, LogLevel.Error, LogLevel.Off]);
    this.positiveInt('closeTimeoutMs');
    if (s.sinks !== undefined && !Array.isArray(s.sinks)) {
      this.fail('sinks', 'must be an array of LogSink', s.sinks);
    }
    for (const sink of s.sinks ?? []) {
      // A sink is a structural contract, so a typo in a hand-written object
      // literal would otherwise surface as "write is not a function" on the
      // first record — long after construction, and inside a catch.
      if (typeof sink?.write !== 'function' || typeof sink?.name !== 'string') {
        this.fail('sinks', 'must each be a LogSink with a name and a write method', sink);
      }
    }
  }
}

/**
 * Accepted input for the {@link MultiSinkLogger} constructor: the fluent
 * {@link MultiSinkLoggerOptionsBuilder} OR a plain
 * {@link MultiSinkLoggerOptionsType} object.
 */
export type MultiSinkLoggerOptions = MultiSinkLoggerOptionsBuilder | MultiSinkLoggerOptionsType;
/** Value alias so `MultiSinkLoggerOptions.create()` resolves to the builder. */
export const MultiSinkLoggerOptions = MultiSinkLoggerOptionsBuilder;
