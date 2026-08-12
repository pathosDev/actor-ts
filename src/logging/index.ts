/**
 * Multi-sink logging: one record, many destinations.
 *
 * `MultiSinkLogger` is a `Logger` like any other — pass it to
 * `ActorSystemOptions.withLogger`, or list the sinks with `withLogSinks`
 * and let the system build it — and every actor's `this.log` fans out to
 * the console, a rotating file and a log platform at once, each with its
 * own minimum level.
 */

export { ConsoleSink } from './ConsoleSink.js';
export {
  ConsoleSinkOptions,
  ConsoleSinkOptionsBuilder,
  ConsoleSinkOptionsValidator,
  DEFAULT_CONSOLE_SINK_FORMAT,
  DEFAULT_CONSOLE_SINK_MIN_LEVEL,
  DEFAULT_CONSOLE_SINK_STREAM,
  isConsoleSinkEnabled,
  readConsoleSinkOptionsFromConfig,
} from './ConsoleSinkOptions.js';
export type {
  ConsoleSinkFormat,
  ConsoleSinkOptionsType,
  ConsoleSinkStream,
} from './ConsoleSinkOptions.js';
export { jsonSafeReplacer, normaliseArg } from './JsonSafe.js';
export { formatJsonLine, formatTextLine } from './LogFormat.js';
export { LOG_LEVEL_NAMES, logLevelName, parseLogLevel } from './LogLevelName.js';
export type { LogLevelName } from './LogLevelName.js';
export { buildLoggerFromConfig, readLoggerLevelFromConfig } from './LoggerFromConfig.js';
export type { LogRecord, LogRecordTransform } from './LogRecord.js';
export type { LogSink, LogSinkContext } from './LogSink.js';
export { MultiSinkLogger } from './MultiSinkLogger.js';
export {
  DEFAULT_SINK_CLOSE_TIMEOUT_MS,
  MultiSinkLoggerOptions,
  MultiSinkLoggerOptionsBuilder,
  MultiSinkLoggerOptionsValidator,
} from './MultiSinkLoggerOptions.js';
export type { MultiSinkLoggerOptionsType } from './MultiSinkLoggerOptions.js';
export { isSinkEnabled, readSinkMinLevel, sinkLeaf } from './SinkConfig.js';
export { SinkReporter } from './SinkReporter.js';
