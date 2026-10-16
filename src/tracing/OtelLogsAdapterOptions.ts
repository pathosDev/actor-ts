import type { LogLevel } from '../Logger.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { OtelLoggerLike, OtelLogsApiLike } from './OtelLogsAdapter.js';

/**
 * Built-in logger name {@link otelLogger} asks `getLogger` for.  OpenTelemetry
 * files every log record under the name of the logger that emitted it — the
 * instrumentation scope, which names the library a record came from — so the
 * default is this library's name, the scope its spans arrive under too
 * (`DEFAULT_OTEL_TRACER_NAME`).
 */
export const DEFAULT_OTEL_LOGGER_NAME = 'actor-ts';

/** Plain options-object shape accepted by {@link otelLogger}. */
export type OtelLogsAdapterOptionsType = {
  /** The `@opentelemetry/api-logs` namespace (`import * as logsApi from '@opentelemetry/api-logs'`). */
  readonly api: OtelLogsApiLike;
  /**
   * Optional pre-built OTel logger; defaults to
   * `api.logs.getLoggerProvider().getLogger(loggerName, loggerVersion)`.
   * Override when you've already created a named logger you want
   * actor-ts records to flow into — it is used as it is, so neither
   * `loggerName` nor `loggerVersion` reaches it.
   */
  readonly logger?: OtelLoggerLike;
  /** Logger name passed to `getLogger`.  Default {@link DEFAULT_OTEL_LOGGER_NAME}. */
  readonly loggerName?: string;
  /** Logger version passed to `getLogger`.  Default: none. */
  readonly loggerVersion?: string;
  /**
   * Initial level filter.  Records below this level skip the OTel
   * round-trip entirely.  Default: `LogLevel.Info`.
   */
  readonly level?: LogLevel;
};

/**
 * Fluent builder for {@link OtelLogsAdapterOptionsType}:
 *
 *     const otelLogsOptions = OtelLogsAdapterOptions.create().withApi(logsApi);
 *     const log = otelLogger(otelLogsOptions);
 *
 * `withApi` is mandatory — the adapter has nothing to emit through without
 * the `@opentelemetry/api-logs` namespace.
 */
export class OtelLogsAdapterOptionsBuilder extends OptionsBuilder<OtelLogsAdapterOptionsType> {
  /** Start a fresh builder.  Equivalent to `new OtelLogsAdapterOptionsBuilder()`. */
  static create(): OtelLogsAdapterOptionsBuilder {
    return new OtelLogsAdapterOptionsBuilder();
  }

  /** The `@opentelemetry/api-logs` namespace (`import * as logsApi from '@opentelemetry/api-logs'`). */
  withApi(api: OtelLogsApiLike): this {
    return this.set('api', api);
  }

  /** Optional pre-built OTel logger, used as it is; defaults to `getLogger(loggerName, loggerVersion)`. */
  withLogger(logger: OtelLoggerLike): this {
    return this.set('logger', logger);
  }

  /** Logger name passed to `getLogger`.  Default {@link DEFAULT_OTEL_LOGGER_NAME}. */
  withLoggerName(loggerName: string): this {
    return this.set('loggerName', loggerName);
  }

  /** Logger version passed to `getLogger`. */
  withLoggerVersion(loggerVersion: string): this {
    return this.set('loggerVersion', loggerVersion);
  }

  /** Initial level filter; records below it never reach the OTel logger. */
  withLevel(level: LogLevel): this {
    return this.set('level', level);
  }
}

/**
 * Accepted input for {@link otelLogger}: the fluent
 * {@link OtelLogsAdapterOptionsBuilder} OR a plain
 * {@link OtelLogsAdapterOptionsType} object.  The whole shape rather than a
 * `Partial` of it, so a literal that leaves out the `api` namespace is a
 * compile error instead of a `TypeError` at the first log call.
 */
export type OtelLogsAdapterOptions = OtelLogsAdapterOptionsBuilder | OtelLogsAdapterOptionsType;
/** Value alias so `OtelLogsAdapterOptions.create()` / `new OtelLogsAdapterOptions()` resolve to the builder. */
export const OtelLogsAdapterOptions = OtelLogsAdapterOptionsBuilder;
