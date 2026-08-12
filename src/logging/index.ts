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
export {
  DEFAULT_GELF_MAX_CHUNK_BYTES,
  GELF_CHUNK_HEADER_BYTES,
  GELF_CHUNK_MAGIC,
  GELF_MAX_CHUNKS,
  GelfMessageTooLargeError,
  chunkGelfDatagram,
  newGelfMessageId,
} from './GelfChunking.js';
export { additionalFieldName, encodeGelf, gelfPayloadFor } from './GelfPayload.js';
export { GelfSink } from './GelfSink.js';
export {
  DEFAULT_GELF_COMPRESSION,
  DEFAULT_GELF_HOST,
  DEFAULT_GELF_MIN_LEVEL,
  DEFAULT_GELF_PORT,
  DEFAULT_GELF_PROTOCOL,
  DEFAULT_GELF_REQUEST_TIMEOUT_MS,
  GelfSinkOptions,
  GelfSinkOptionsBuilder,
  GelfSinkOptionsValidator,
  isGelfSinkEnabled,
  readGelfSinkOptionsFromConfig,
} from './GelfSinkOptions.js';
export type {
  GelfCompression,
  GelfProtocol,
  GelfSinkOptionsType,
} from './GelfSinkOptions.js';
export { basicAuthorization, postToEndpoint, retryAfterMs } from './HttpDelivery.js';
export type { FetchLike, HttpPostRequest } from './HttpDelivery.js';
export { jsonSafeReplacer, normaliseArg } from './JsonSafe.js';
export { OtlpHttpSink } from './OtlpHttpSink.js';
export {
  DEFAULT_OTLP_MIN_LEVEL,
  DEFAULT_OTLP_REQUEST_TIMEOUT_MS,
  DEFAULT_OTLP_SCOPE_NAME,
  DEFAULT_OTLP_URL,
  OtlpHttpSinkOptions,
  OtlpHttpSinkOptionsBuilder,
  OtlpHttpSinkOptionsValidator,
  isOtlpSinkEnabled,
  readOtlpSinkOptionsFromConfig,
} from './OtlpHttpSinkOptions.js';
export type { OtlpHttpSinkOptionsType } from './OtlpHttpSinkOptions.js';
export { ParseableSink, requestBodiesFor } from './ParseableSink.js';
export {
  DEFAULT_PARSEABLE_MIN_LEVEL,
  DEFAULT_PARSEABLE_REQUEST_TIMEOUT_MS,
  PARSEABLE_MAX_REQUEST_BYTES,
  ParseableSinkOptions,
  ParseableSinkOptionsBuilder,
  ParseableSinkOptionsValidator,
  isParseableSinkEnabled,
  readParseableSinkOptionsFromConfig,
} from './ParseableSinkOptions.js';
export type { ParseableSinkOptionsType } from './ParseableSinkOptions.js';
export {
  DEFAULT_SENTRY_MIN_LEVEL,
  SentrySinkOptions,
  SentrySinkOptionsBuilder,
  SentrySinkOptionsValidator,
  sentrySink,
} from './SentrySink.js';
export type { SentrySdkLike, SentrySinkOptionsType } from './SentrySink.js';
export { SeqSink, clefDocumentFor } from './SeqSink.js';
export {
  DEFAULT_SEQ_MIN_LEVEL,
  DEFAULT_SEQ_REQUEST_TIMEOUT_MS,
  SEQ_CLEF_CONTENT_TYPE,
  SeqSinkOptions,
  SeqSinkOptionsBuilder,
  SeqSinkOptionsValidator,
  isSeqSinkEnabled,
  readSeqSinkOptionsFromConfig,
} from './SeqSinkOptions.js';
export type { SeqSinkOptionsType } from './SeqSinkOptions.js';
export { SplunkSink } from './SplunkSink.js';
export {
  DEFAULT_SPLUNK_MIN_LEVEL,
  DEFAULT_SPLUNK_REQUEST_TIMEOUT_MS,
  DEFAULT_SPLUNK_SOURCE,
  DEFAULT_SPLUNK_SOURCETYPE,
  SplunkSinkOptions,
  SplunkSinkOptionsBuilder,
  SplunkSinkOptionsValidator,
  isSplunkSinkEnabled,
  readSplunkSinkOptionsFromConfig,
} from './SplunkSinkOptions.js';
export type { SplunkSinkOptionsType } from './SplunkSinkOptions.js';
export { formatJsonLine, formatTextLine } from './LogFormat.js';
export { LOG_LEVEL_NAMES, logLevelName, parseLogLevel } from './LogLevelName.js';
export type { LogLevelName } from './LogLevelName.js';
export { buildLoggerFromConfig, readLoggerLevelFromConfig } from './LoggerFromConfig.js';
export { LokiSink } from './LokiSink.js';
export {
  DEFAULT_LOKI_MIN_LEVEL,
  DEFAULT_LOKI_REQUEST_TIMEOUT_MS,
  LOKI_LABEL_PATTERN,
  LokiSinkOptions,
  LokiSinkOptionsBuilder,
  LokiSinkOptionsValidator,
  isLokiSinkEnabled,
  readLokiSinkOptionsFromConfig,
} from './LokiSinkOptions.js';
export type { LokiLineFormat, LokiSinkOptionsType } from './LokiSinkOptions.js';
export { nanosecondsOf } from './Timestamps.js';
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
