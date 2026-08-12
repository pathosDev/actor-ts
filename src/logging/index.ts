/**
 * Multi-sink logging: one record, many destinations.
 *
 * `MultiSinkLogger` is a `Logger` like any other — pass it to
 * `ActorSystemOptions.withLogger`, or list the sinks with `withLogSinks`
 * and let the system build it — and every actor's `this.log` fans out to
 * the console, a rotating file and a log platform at once, each with its
 * own minimum level.
 */

export { BatchingSink, SinkDeliveryError } from './BatchingSink.js';
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
export {
  DEFAULT_DELIVERY_FLUSH_INTERVAL_MS,
  DEFAULT_DELIVERY_MAX_BACKOFF_MS,
  DEFAULT_DELIVERY_MAX_BATCH_SIZE,
  DEFAULT_DELIVERY_MAX_RETRIES,
  DEFAULT_DELIVERY_MIN_BACKOFF_MS,
  DEFAULT_DELIVERY_OVERFLOW,
  DEFAULT_DELIVERY_QUEUE_CAPACITY,
  DEFAULT_DELIVERY_RANDOM_FACTOR,
  readDeliveryOptionsFromConfig,
  resolveDeliveryOptions,
  validateDeliveryOptions,
} from './DeliveryOptions.js';
export type {
  DeliveryOptionsType,
  DeliveryOverflow,
  ResolvedDeliveryOptions,
} from './DeliveryOptions.js';
export { AppendOnlyFile } from './AppendOnlyFile.js';
export { FileSink } from './FileSink.js';
export {
  DEFAULT_FILE_SINK_DIRECTORY,
  DEFAULT_FILE_SINK_EXTENSION,
  DEFAULT_FILE_SINK_FORMAT,
  DEFAULT_FILE_SINK_MAX_AGE_MS,
  DEFAULT_FILE_SINK_MAX_FILES,
  DEFAULT_FILE_SINK_MAX_FILE_BYTES,
  DEFAULT_FILE_SINK_MIN_LEVEL,
  DEFAULT_FILE_SINK_PREFIX,
  DEFAULT_FILE_SINK_ROTATE_INTERVAL,
  FileSinkOptions,
  FileSinkOptionsBuilder,
  FileSinkOptionsValidator,
  isFileSinkEnabled,
  readFileSinkOptionsFromConfig,
} from './FileSinkOptions.js';
export type {
  FileRotateInterval,
  FileSinkFormat,
  FileSinkOptionsType,
} from './FileSinkOptions.js';
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
