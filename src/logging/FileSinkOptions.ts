import type { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { LogLevel } from '../Logger.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import {
  readDeliveryOptionsFromConfig,
  validateDeliveryOptions,
  type DeliveryOptionsType,
} from './DeliveryOptions.js';
import { isLogLevel, LOG_LEVEL_REASON } from './LogLevelName.js';
import { isSinkEnabled, readSinkMinLevel, sinkLeaf } from './SinkConfig.js';

/** How often a {@link FileSink} starts a new file on a clock boundary. */
export type FileRotateInterval = 'off' | 'hourly' | 'daily';

/** How a {@link FileSink} renders each record. */
export type FileSinkFormat = 'text' | 'json';

/** Built-in default for {@link FileSinkOptionsType.minLevel}. */
export const DEFAULT_FILE_SINK_MIN_LEVEL = LogLevel.Info;
/** Built-in default for {@link FileSinkOptionsType.directory}. */
export const DEFAULT_FILE_SINK_DIRECTORY = 'logs';
/** Built-in default for {@link FileSinkOptionsType.prefix}. */
export const DEFAULT_FILE_SINK_PREFIX = 'log';
/** Built-in default for {@link FileSinkOptionsType.extension}. */
export const DEFAULT_FILE_SINK_EXTENSION = 'txt';
/** Built-in default for {@link FileSinkOptionsType.format}. */
export const DEFAULT_FILE_SINK_FORMAT: FileSinkFormat = 'text';
/**
 * Built-in default for {@link FileSinkOptionsType.maxFileBytes} — 64 MiB.
 * Large enough that an ordinary service rolls once a day at most on size
 * alone, small enough to stay openable in an editor and quick to compress.
 */
export const DEFAULT_FILE_SINK_MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Built-in default for {@link FileSinkOptionsType.rotateInterval}. */
export const DEFAULT_FILE_SINK_ROTATE_INTERVAL: FileRotateInterval = 'daily';
/** Built-in default for {@link FileSinkOptionsType.maxFiles}. */
export const DEFAULT_FILE_SINK_MAX_FILES = 14;
/** Built-in default for {@link FileSinkOptionsType.maxAgeMs} — 14 days. */
export const DEFAULT_FILE_SINK_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;

/** Plain options-object shape accepted by {@link FileSink}. */
export type FileSinkOptionsType = {
  /** Records below this level are not written.  Default `info`. */
  readonly minLevel?: LogLevel;
  /** `text` for humans, `json` for one NDJSON object per line. */
  readonly format?: FileSinkFormat;
  /** Directory to write into, created if missing.  Default `logs`. */
  readonly directory?: string;
  /**
   * Filename prefix.  Default `log`, giving `log-2026-08-12-09-41-02.txt`.
   *
   * Retention only ever deletes files matching this prefix and extension,
   * so two sinks writing the same directory under different prefixes do
   * not clean up after each other — and nothing else in the directory is
   * ever touched.
   */
  readonly prefix?: string;
  /** Filename extension, without the dot.  Default `txt`. */
  readonly extension?: string;
  /** Roll over once the active file passes this size.  `0` disables. */
  readonly maxFileBytes?: number;
  /** Roll over on a clock boundary.  Default `daily`. */
  readonly rotateInterval?: FileRotateInterval;
  /** Keep at most this many rotated files.  `0` keeps all of them. */
  readonly maxFiles?: number;
  /** Delete rotated files older than this.  `0` disables age-based cleanup. */
  readonly maxAgeMs?: number;
  /** gzip each rotated file, leaving `<name>.gz`.  Default `false`. */
  readonly compressRotated?: boolean;
  /** Queue, batching and retry settings — see `DeliveryOptionsType`. */
  readonly delivery?: DeliveryOptionsType;
};

/** Fluent builder for {@link FileSinkOptionsType}. */
export class FileSinkOptionsBuilder extends OptionsBuilder<FileSinkOptionsType> {
  /** Start a fresh builder.  Equivalent to `new FileSinkOptionsBuilder()`. */
  static create(): FileSinkOptionsBuilder {
    return new FileSinkOptionsBuilder();
  }

  /** Lowest level this sink writes. */
  withMinLevel(minLevel: LogLevel): this {
    return this.set('minLevel', minLevel);
  }

  /** `text` (human-readable) or `json` (one NDJSON object per line). */
  withFormat(format: FileSinkFormat): this {
    return this.set('format', format);
  }

  /** Directory to write into; created if it does not exist. */
  withDirectory(directory: string): this {
    return this.set('directory', directory);
  }

  /** Filename prefix — also the key retention matches on. */
  withPrefix(prefix: string): this {
    return this.set('prefix', prefix);
  }

  /** Filename extension, without the dot. */
  withExtension(extension: string): this {
    return this.set('extension', extension);
  }

  /** Size at which the active file is closed and a new one started. */
  withMaxFileBytes(maxFileBytes: number): this {
    return this.set('maxFileBytes', maxFileBytes);
  }

  /** Clock boundary at which a new file is started. */
  withRotateInterval(rotateInterval: FileRotateInterval): this {
    return this.set('rotateInterval', rotateInterval);
  }

  /** How many rotated files to keep. */
  withMaxFiles(maxFiles: number): this {
    return this.set('maxFiles', maxFiles);
  }

  /** How long to keep rotated files, in milliseconds. */
  withMaxAgeMs(maxAgeMs: number): this {
    return this.set('maxAgeMs', maxAgeMs);
  }

  /** gzip rotated files. */
  withCompressRotated(compressRotated: boolean): this {
    return this.set('compressRotated', compressRotated);
  }

  /** Queue, batching and retry settings. */
  withDelivery(delivery: DeliveryOptionsType): this {
    return this.set('delivery', delivery);
  }
}

/** Validates resolved {@link FileSinkOptionsType} settings. */
export class FileSinkOptionsValidator extends OptionsValidator<FileSinkOptionsType> {
  constructor() {
    super('FileSinkOptions');
  }

  protected rules(s: Partial<FileSinkOptionsType>): void {
    if (s.minLevel !== undefined && !isLogLevel(s.minLevel)) {
      this.fail('minLevel', LOG_LEVEL_REASON, s.minLevel);
    }
    this.oneOf('format', ['text', 'json']);
    this.nonEmptyString('directory');
    this.nonEmptyString('prefix');
    this.nonEmptyString('extension');
    this.nonNegativeInt('maxFileBytes');
    this.oneOf('rotateInterval', ['off', 'hourly', 'daily']);
    this.nonNegativeInt('maxFiles');
    this.nonNegativeInt('maxAgeMs');
    // A separator in either would break the filename into a path, and the
    // retention pattern along with it — so a stray slash could point
    // deletions at a directory nobody meant to touch.
    if (s.prefix !== undefined && /[\\/.]/.test(s.prefix)) {
      this.fail('prefix', 'must not contain a path separator or a dot', s.prefix);
    }
    if (s.extension !== undefined && /[\\/.]/.test(s.extension)) {
      this.fail('extension', 'must not contain a path separator or a dot', s.extension);
    }
    validateDeliveryOptions('FileSinkOptions', s.delivery);
  }
}

/** Whether `actor-ts.logger.sinks.file.enabled` asks for this sink. */
export function isFileSinkEnabled(config: Config): boolean {
  return isSinkEnabled(config, ConfigKeys.logger.sinks.file);
}

/**
 * Read `actor-ts.logger.sinks.file.*`.  Only keys actually present are
 * returned, so an absent one falls through to the built-in default.
 */
export function readFileSinkOptionsFromConfig(config: Config): Partial<FileSinkOptionsType> {
  const root = ConfigKeys.logger.sinks.file;
  const out: { -readonly [K in keyof FileSinkOptionsType]?: FileSinkOptionsType[K] } = {};
  const path = (leaf: string): string => sinkLeaf(root, leaf);
  const minLevel = readSinkMinLevel(config, root);
  if (minLevel !== undefined) out.minLevel = minLevel;
  // Enum leaves are read as-is; the validator names the field on a typo.
  if (config.hasPath(path('format'))) out.format = config.getString(path('format')) as FileSinkFormat;
  if (config.hasPath(path('directory'))) out.directory = config.getString(path('directory'));
  if (config.hasPath(path('prefix'))) out.prefix = config.getString(path('prefix'));
  if (config.hasPath(path('extension'))) out.extension = config.getString(path('extension'));
  if (config.hasPath(path('max-file-bytes'))) out.maxFileBytes = config.getBytes(path('max-file-bytes'));
  if (config.hasPath(path('rotate-interval'))) {
    out.rotateInterval = config.getString(path('rotate-interval')) as FileRotateInterval;
  }
  if (config.hasPath(path('max-files'))) out.maxFiles = config.getInt(path('max-files'));
  if (config.hasPath(path('max-age'))) out.maxAgeMs = config.getDuration(path('max-age'));
  if (config.hasPath(path('compress-rotated'))) {
    out.compressRotated = config.getBoolean(path('compress-rotated'));
  }
  const delivery = readDeliveryOptionsFromConfig(config, root);
  if (delivery !== undefined) out.delivery = delivery;
  return out;
}

/**
 * Accepted input for the {@link FileSink} constructor: the fluent
 * {@link FileSinkOptionsBuilder} OR a plain {@link FileSinkOptionsType}
 * object.
 */
export type FileSinkOptions = FileSinkOptionsBuilder | FileSinkOptionsType;
/** Value alias so `FileSinkOptions.create()` resolves to the builder. */
export const FileSinkOptions = FileSinkOptionsBuilder;
