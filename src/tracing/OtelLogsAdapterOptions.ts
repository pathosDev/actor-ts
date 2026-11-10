import type { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
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

/**
 * The slice of the logger's settings HOCON can supply.  `api` and `logger` are
 * missing on purpose: both are live objects — the `@opentelemetry/api-logs`
 * namespace the application imports and a logger an SDK built — which a config
 * file cannot hold.  `level` is missing too, for another reason: it is the
 * system's own, `actor-ts.logger.level`, which the system layers in itself, so
 * a second level key here would be a second answer to one question.
 */
export type OtelLogsAdapterConfigDefaults = Pick<OtelLogsAdapterOptionsType, 'loggerName' | 'loggerVersion'>;

/**
 * Read `actor-ts.tracing.logger-name` and `logger-version`: the name and
 * version `getLogger` is asked for.
 *
 * The `Config` is a **required argument**, and nothing here calls
 * `Config.load()`.  The one consumer is the `ActorSystem` constructor, which
 * passes `system.config` when it builds the logger of the `otelLogs` slot;
 * `otelLogger` itself stays the pure code path and never reads a file, so a
 * logger built with it behaves exactly as its options say.
 *
 * An absent leaf stays absent rather than being filled with
 * {@link DEFAULT_OTEL_LOGGER_NAME}, so `mergeOptions` layers the slot's
 * options over this answer per field.  That matters most for
 * `logger-version`, which `reference.conf` ships only as a comment: absent is
 * what passes no version to `getLogger`, and an own `undefined` would read as
 * configured.
 */
export function readOtelLogsAdapterOptionsFromConfig(config: Config): OtelLogsAdapterConfigDefaults {
  const keys = ConfigKeys.tracing;
  const out: { -readonly [K in keyof OtelLogsAdapterConfigDefaults]: OtelLogsAdapterConfigDefaults[K] } = {};
  if (config.hasPath(keys.loggerName)) out.loggerName = config.getString(keys.loggerName);
  if (config.hasPath(keys.loggerVersion)) out.loggerVersion = config.getString(keys.loggerVersion);
  return out;
}
