import { LogContext, type LogContextData } from '../LogContext.js';
import { displayNameOf, LogLevel, type Logger } from '../Logger.js';
import { formatTextLine } from './LogFormat.js';
import type { LogRecord, LogRecordTransform } from './LogRecord.js';
import type { LogSink, LogSinkContext } from './LogSink.js';
import {
  DEFAULT_SINK_CLOSE_TIMEOUT_MS,
  MultiSinkLoggerOptionsValidator,
  type MultiSinkLoggerOptions,
  type MultiSinkLoggerOptionsType,
} from './MultiSinkLoggerOptions.js';
import { SinkReporter } from './SinkReporter.js';

/** One sink plus the reporter that speaks for it when it misbehaves. */
type SinkTarget = {
  readonly sink: LogSink;
  readonly reporter: SinkReporter;
};

/**
 * The shared state behind every logger view: the sinks, the level gate, the
 * transform, and the close lifecycle.  One pipeline serves the root logger
 * and every `withSource` / `withFields` derivative of it.
 */
class LogPipeline {
  readonly level: LogLevel;
  private readonly targets: readonly SinkTarget[];
  private readonly transform: LogRecordTransform | undefined;
  private readonly closeTimeoutMs: number;
  private readonly pipelineReporter = new SinkReporter('pipeline');
  private closed = false;
  private closing: Promise<void> | undefined;
  private dropped = 0;

  constructor(options: MultiSinkLoggerOptions) {
    const settings = { ...(options as Partial<MultiSinkLoggerOptionsType>) };
    new MultiSinkLoggerOptionsValidator().validate(settings);
    const sinks = settings.sinks ?? [];
    this.targets = sinks.map((sink) => ({ sink, reporter: new SinkReporter(sink.name) }));
    this.transform = settings.transform;
    this.closeTimeoutMs = settings.closeTimeoutMs ?? DEFAULT_SINK_CLOSE_TIMEOUT_MS;
    // The gate is the stricter of the configured floor and the least
    // demanding sink: without a floor there is no reason to build a record
    // no sink would accept, and with one the operator's intent wins.
    const lowestSinkLevel = sinks.reduce<LogLevel>(
      (lowest, sink) => (sink.minLevel < lowest ? sink.minLevel : lowest),
      LogLevel.Off,
    );
    this.level = settings.level !== undefined && settings.level > lowestSinkLevel
      ? settings.level
      : lowestSinkLevel;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  /**
   * Build the record and fan it out.  Runs on the caller's stack, so every
   * step here is either cheap or wrapped: the only thing an application
   * should ever pay for a suppressed log call is the comparison on the
   * first line.
   */
  emit(
    level: LogLevel,
    source: string,
    staticFields: LogContextData,
    message: string,
    args: unknown[],
  ): void {
    if (level < this.level) return;

    // Read the MDC here, synchronously: it is bound to this async context
    // and a batching sink flushes in a different one.
    const dynamic = LogContext.get();
    const displayName = displayNameOf(staticFields);
    const built: LogRecord = {
      timestampMs: Date.now(),
      level,
      ...(source ? { source } : {}),
      message,
      fields: { ...staticFields, ...dynamic },
      ...(displayName !== '' ? { displayName } : {}),
      ...(args.length > 0 ? { args } : {}),
    };

    const record = this.applyTransform(built);
    if (record === null) return;

    if (this.closed) {
      this.fallback(record);
      return;
    }

    for (const target of this.targets) {
      if (record.level < target.sink.minLevel) continue;
      try {
        target.sink.write(record);
      } catch (error) {
        this.dropped += 1;
        target.reporter.report('write threw', error);
      }
    }
  }

  attach(context: LogSinkContext): void {
    for (const target of this.targets) {
      try {
        target.sink.attach?.(context);
      } catch (error) {
        target.reporter.report('attach threw', error);
      }
    }
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.targets.map((target) => this.bounded(target, 'flush')));
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    // Stop handing records to sinks *before* draining: a sink that is
    // shutting down should not be given a record it may never get to
    // write, and the fallback keeps those records visible.
    this.closed = true;
    this.closing = (async () => {
      await Promise.allSettled(this.targets.map((target) => this.bounded(target, 'close')));
    })();
    return this.closing;
  }

  private applyTransform(record: LogRecord): LogRecord | null {
    if (this.transform === undefined) return record;
    try {
      return this.transform(record);
    } catch (error) {
      // A broken redaction hook must not silently discard the log stream,
      // and it must not throw into application code either.  Keeping the
      // record is the honest failure: the operator sees the report and the
      // unredacted line, rather than a hole where their logs used to be.
      this.pipelineReporter.report('transform threw', error);
      return record;
    }
  }

  /**
   * Run one sink's `flush` / `close` with a timeout, swallowing whatever it
   * does.  The timer is a raw `setTimeout` on purpose: this runs during
   * `ActorSystem` shutdown, after `scheduler.shutdown()` has already
   * cleared the framework's own timers.
   *
   * It is deliberately **not** `unref`'d.  Shutdown is the moment the
   * event loop empties out, and an unreferenced timer in an idle loop is
   * not guaranteed to fire — so the one timer that exists to break a hang
   * would itself hang.  It cannot leak either way: it is cleared in the
   * `finally` of the very expression awaiting it.
   */
  private async bounded(target: SinkTarget, operation: 'flush' | 'close'): Promise<void> {
    const run = operation === 'flush' ? target.sink.flush : target.sink.close;
    if (run === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve(run.call(target.sink)),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            target.reporter.report(`${operation} timed out after ${this.closeTimeoutMs} ms`);
            resolve();
          }, this.closeTimeoutMs);
        }),
      ]);
    } catch (error) {
      target.reporter.report(`${operation} failed`, error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Where a record goes once the sinks are closed.  Shutdown is precisely
   * when a last message matters, so it goes to the console rather than
   * nowhere.
   */
  private fallback(record: LogRecord): void {
    const line = formatTextLine(record);
    const args = record.args ?? [];
    if (record.level >= LogLevel.Error) console.error(line, ...args);
    else if (record.level >= LogLevel.Warn) console.warn(line, ...args);
    else console.log(line, ...args);
  }
}

/**
 * A bound view onto a {@link LogPipeline} — what `withSource` and
 * `withFields` return.
 *
 * Deliberately not exported: a view must not expose `attach` / `close`,
 * because those belong to whoever owns the pipeline (the `ActorSystem`),
 * not to the thousand per-actor loggers derived from it.
 */
class PipelineLogger implements Logger {
  constructor(
    protected readonly pipeline: LogPipeline,
    private readonly source: string,
    private readonly staticFields: LogContextData,
  ) {}

  get level(): LogLevel {
    return this.pipeline.level;
  }

  debug(message: string, ...args: unknown[]): void {
    this.pipeline.emit(LogLevel.Debug, this.source, this.staticFields, message, args);
  }
  info(message: string, ...args: unknown[]): void {
    this.pipeline.emit(LogLevel.Info, this.source, this.staticFields, message, args);
  }
  warn(message: string, ...args: unknown[]): void {
    this.pipeline.emit(LogLevel.Warn, this.source, this.staticFields, message, args);
  }
  error(message: string, ...args: unknown[]): void {
    this.pipeline.emit(LogLevel.Error, this.source, this.staticFields, message, args);
  }

  withSource(source: string): Logger {
    return new PipelineLogger(this.pipeline, source, this.staticFields);
  }

  withFields(fields: LogContextData): Logger {
    return new PipelineLogger(this.pipeline, this.source, { ...this.staticFields, ...fields });
  }
}

/**
 * A {@link Logger} that fans every record out to several {@link LogSink}s —
 * the console *and* a rotating file *and* a log platform, each with its own
 * minimum level.
 *
 *     const consoleSink = new ConsoleSink();
 *     const fileSink = new FileSink(fileSinkOptions);
 *     const loggerOptions = MultiSinkLoggerOptions.create()
 *       .withSinks([consoleSink, fileSink]);
 *     const systemOptions = ActorSystemOptions.create().withLogger(new MultiSinkLogger(loggerOptions));
 *
 * **Where the work happens.**  The level gate runs at the call site, so a
 * suppressed record costs a comparison and nothing else.  Everything a sink
 * could possibly need is then computed exactly once — the MDC merge, the
 * display-name lift — and handed to every sink as one immutable
 * {@link LogRecord}.  This is not only cheaper than letting each sink
 * render for itself: the MDC is bound to the *current async context*, so a
 * sink that batches and flushes later could not read it at all.
 *
 * **Failure is contained.**  A sink that throws is caught, reported on the
 * console (rate-limited) and skipped — the remaining sinks still get the
 * record, and application code never sees the exception.  A sink is never
 * given a chance to report *through* this logger, because that is the loop
 * that turns a broken destination into a broken process.
 *
 * **`withSource` / `withFields` are cheap.**  They return views that share
 * one pipeline, so a system with a thousand actors — each holding its own
 * `withSource(path)` logger — still has one set of sinks, attached once and
 * closed once.
 */
export class MultiSinkLogger extends PipelineLogger {
  constructor(options: MultiSinkLoggerOptions) {
    super(new LogPipeline(options), '', {});
  }

  /** Hand the sinks the system's scheduler and name.  Called once, by `ActorSystem`. */
  attach(context: LogSinkContext): void {
    this.pipeline.attach(context);
  }

  /** Deliver everything queued in every sink. */
  flush(): Promise<void> {
    return this.pipeline.flush();
  }

  /**
   * Drain and close every sink, each bounded by `closeTimeoutMs`.
   * Idempotent.  Records emitted afterwards fall through to a plain
   * console line rather than disappearing.
   */
  close(): Promise<void> {
    return this.pipeline.close();
  }

  /** Records dropped so far because a sink refused or failed to take them. */
  get droppedCount(): number {
    return this.pipeline.droppedCount;
  }
}
