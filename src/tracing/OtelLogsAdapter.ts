/**
 * Bridge from the framework's {@link Logger} to OpenTelemetry Logs
 * (#311).
 *
 * `JsonLogger` is the right shape when log records ship to a
 * stdout-attached log pipeline (Loki, Fluent-Bit, the Docker driver,
 * Datadog Agent in tail mode).  For OTLP-Logs pipelines —
 * `@opentelemetry/sdk-logs` with an OTLPLogExporter wiring up to a
 * collector — the records have to flow through the OTel
 * `LogRecord` API instead.  This file ships that bridge.
 *
 * The adapter delegates every `info`/`warn`/`error`/`debug` call to
 * an OTel `LoggerProvider`-issued `Logger.emit({...})`.  Severity
 * is mapped to OTel's standard severity-number range; the active
 * span's `traceId` + `spanId` are attached automatically when
 * tracing is enabled in the same process; the framework's static
 * `withFields` + dynamic `LogContext.get()` MDC flow through as
 * record attributes.
 *
 * **Optional peer dep**: `@opentelemetry/api-logs` is not a hard
 * dep.  Users pass their existing import
 * (`import * as logsApi from '@opentelemetry/api-logs'`) as the
 * `{ api }` config — same passthrough pattern as `otelTracer`
 * (#63) and the prom-client metrics adapter (#64).  Structural
 * typing on the OTel surface means we never `import` the package
 * ourselves.
 */

import {
  type Logger as FrameworkLogger,
  LogLevel,
} from '../Logger.js';
import { LogContext, type LogContextData } from '../LogContext.js';

/* ----------------------- OpenTelemetry API surface ----------------------- */
/* Structural — keep in sync with @opentelemetry/api-logs v0.x.  We use only */
/* the surface needed to emit log records with severity + attributes.        */

/**
 * Standard OTel severity numbers.  See
 * https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-severitynumber
 * — we never call these constants directly; the namespace exposes them
 * via `api.SeverityNumber.INFO` etc.
 */
export interface OtelSeverityNumber {
  readonly TRACE: number;
  readonly DEBUG: number;
  readonly INFO: number;
  readonly WARN: number;
  readonly ERROR: number;
  readonly FATAL: number;
}

export interface OtelLogRecord {
  readonly timestamp?: number;          // unix nanos OR ms (SDK normalises)
  readonly observedTimestamp?: number;
  readonly severityNumber?: number;
  readonly severityText?: string;
  readonly body?: unknown;              // typically the log message string
  readonly attributes?: Record<string, unknown>;
  readonly context?: unknown;           // OTel Context (optional — SDK extracts active span)
}

export interface OtelLoggerLike {
  emit(record: OtelLogRecord): void;
}

export interface OtelLoggerProviderLike {
  getLogger(name: string, version?: string): OtelLoggerLike;
}

export interface OtelLogsApiLike {
  /** Top-level severity-number constants (`api.SeverityNumber.INFO` etc.). */
  readonly SeverityNumber: OtelSeverityNumber;
  /** Returns the globally-registered LoggerProvider — what the SDK setup calls. */
  logs: { getLoggerProvider(): OtelLoggerProviderLike };
}

/* ------------------------------ public API ------------------------------ */

export interface OtelLoggerAdapterOptions {
  /** The `@opentelemetry/api-logs` namespace
   *  (`import * as logsApi from '@opentelemetry/api-logs'`). */
  readonly api: OtelLogsApiLike;
  /**
   * Optional pre-built OTel logger; defaults to
   * `api.logs.getLoggerProvider().getLogger(loggerName, loggerVersion)`.
   * Override when you've already created a named logger you want
   * actor-ts records to flow into.
   */
  readonly logger?: OtelLoggerLike;
  /** Logger name passed to `getLogger`.  Default: `'actor-ts'`. */
  readonly loggerName?: string;
  /** Logger version passed to `getLogger`. */
  readonly loggerVersion?: string;
  /**
   * Initial level filter.  Records below this level skip the OTel
   * round-trip entirely.  Default: `LogLevel.Info`.
   */
  readonly level?: LogLevel;
}

/**
 * Build a `Logger` whose calls translate to OTel `LogRecord.emit({...})`.
 *
 *     import * as logsApi from '@opentelemetry/api-logs';
 *     const system = ActorSystem.create('my-app',
 *       ActorSystemOptions.create().withLogger(otelLogger({ api: logsApi })));
 *
 * After SDK wire-up (`LoggerProvider` + an OTLP-Logs exporter), every
 * `this.log.info(...)` inside an actor lands as a `LogRecord` with the
 * actor's path on `source`, the merged MDC on `attributes`, and the
 * active span's traceId/spanId automatically linked.
 */
export function otelLogger(options: OtelLoggerAdapterOptions): FrameworkLogger {
  const provider = options.api.logs.getLoggerProvider();
  const otelLog = options.logger
    ?? provider.getLogger(options.loggerName ?? 'actor-ts', options.loggerVersion);
  const level = options.level ?? LogLevel.Info;
  return new OtelLoggerImplementation(otelLog, options.api.SeverityNumber, level, '', {});
}

/* ------------------------------- internals ------------------------------ */

/**
 * Implementation class — kept module-private so the public surface is
 * the factory function only.  `withSource` / `withFields` return a
 * new instance with the same underlying OTel logger but a different
 * source / merged static fields.
 */
class OtelLoggerImplementation implements FrameworkLogger {
  constructor(
    private readonly otel: OtelLoggerLike,
    private readonly severityNumber: OtelSeverityNumber,
    public level: LogLevel,
    private readonly source: string,
    private readonly staticFields: LogContextData,
  ) {}

  private enabled(target: LogLevel): boolean {
    return target >= this.level;
  }

  private severityFor(level: LogLevel): { number: number; text: string } {
    switch (level) {
      case LogLevel.Debug: return { number: this.severityNumber.DEBUG, text: 'DEBUG' };
      case LogLevel.Info:  return { number: this.severityNumber.INFO,  text: 'INFO' };
      case LogLevel.Warn:  return { number: this.severityNumber.WARN,  text: 'WARN' };
      case LogLevel.Error: return { number: this.severityNumber.ERROR, text: 'ERROR' };
      default:             return { number: this.severityNumber.INFO,  text: 'INFO' };
    }
  }

  /** Merge static + dynamic fields, with the actor source as
   *  a reserved attribute and extra positional args under `args.N`. */
  private buildAttributes(args: unknown[]): Record<string, unknown> {
    const attrs: Record<string, unknown> = {
      ...this.staticFields,
      ...LogContext.get(),
    };
    if (this.source) attrs['source'] = this.source;
    // Errors deserve special handling so the stack trace flows
    // through as a real attribute, not a {}-serialised blob.
    args.forEach((a, i) => {
      if (a instanceof Error) {
        attrs[`args.${i}.name`] = a.name;
        attrs[`args.${i}.message`] = a.message;
        if (a.stack) attrs[`args.${i}.stack`] = a.stack;
      } else if (a !== undefined) {
        attrs[`args.${i}`] = a;
      }
    });
    return attrs;
  }

  private emit(level: LogLevel, message: string, args: unknown[]): void {
    if (!this.enabled(level)) return;
    const severity = this.severityFor(level);
    // OTel SDKs accept either ms or nanos for `timestamp`; we pass ms
    // here for parity with the JsonLogger and let the SDK normalise.
    this.otel.emit({
      timestamp: Date.now(),
      severityNumber: severity.number,
      severityText: severity.text,
      body: message,
      attributes: this.buildAttributes(args),
    });
  }

  debug(message: string, ...args: unknown[]): void { this.emit(LogLevel.Debug, message, args); }
  info(message: string, ...args: unknown[]): void { this.emit(LogLevel.Info, message, args); }
  warn(message: string, ...args: unknown[]): void { this.emit(LogLevel.Warn, message, args); }
  error(message: string, ...args: unknown[]): void { this.emit(LogLevel.Error, message, args); }

  withSource(source: string): FrameworkLogger {
    return new OtelLoggerImplementation(this.otel, this.severityNumber, this.level, source, this.staticFields);
  }

  withFields(fields: LogContextData): FrameworkLogger {
    return new OtelLoggerImplementation(
      this.otel, this.severityNumber, this.level, this.source,
      { ...this.staticFields, ...fields },
    );
  }
}
