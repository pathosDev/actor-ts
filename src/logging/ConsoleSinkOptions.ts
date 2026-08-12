import { ConfigKeys } from '../config/ConfigKeys.js';
import type { Config } from '../config/Config.js';
import { LogLevel } from '../Logger.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import { isLogLevel, LOG_LEVEL_REASON } from './LogLevelName.js';
import { isSinkEnabled, readSinkMinLevel, sinkLeaf } from './SinkConfig.js';

/** How a {@link ConsoleSink} renders each record. */
export type ConsoleSinkFormat = 'text' | 'json';

/**
 * Which stream a {@link ConsoleSink} writes to.
 *
 * `'auto'` means "whatever suits the format": text goes through
 * `console.debug/log/warn/error` so the level routing, colouring and object
 * inspection of the host console still apply, while JSON goes to a single
 * stream — splitting NDJSON across stdout and stderr by level would
 * interleave two half-streams in any collector that reads both.
 */
export type ConsoleSinkStream = 'auto' | 'stdout' | 'stderr';

/** Built-in default for {@link ConsoleSinkOptionsType.minLevel}. */
export const DEFAULT_CONSOLE_SINK_MIN_LEVEL = LogLevel.Info;
/** Built-in default for {@link ConsoleSinkOptionsType.format}. */
export const DEFAULT_CONSOLE_SINK_FORMAT: ConsoleSinkFormat = 'text';
/** Built-in default for {@link ConsoleSinkOptionsType.stream}. */
export const DEFAULT_CONSOLE_SINK_STREAM: ConsoleSinkStream = 'auto';

/** Plain options-object shape accepted by {@link ConsoleSink}. */
export type ConsoleSinkOptionsType = {
  /** Records below this level are not written.  Default `info`. */
  readonly minLevel?: LogLevel;
  /** `text` for humans (the `ConsoleLogger` layout), `json` for NDJSON. */
  readonly format?: ConsoleSinkFormat;
  /** Target stream.  Default `auto` — see {@link ConsoleSinkStream}. */
  readonly stream?: ConsoleSinkStream;
};

/** Fluent builder for {@link ConsoleSinkOptionsType}. */
export class ConsoleSinkOptionsBuilder extends OptionsBuilder<ConsoleSinkOptionsType> {
  /** Start a fresh builder.  Equivalent to `new ConsoleSinkOptionsBuilder()`. */
  static create(): ConsoleSinkOptionsBuilder {
    return new ConsoleSinkOptionsBuilder();
  }

  /** Lowest level this sink writes. */
  withMinLevel(minLevel: LogLevel): this {
    return this.set('minLevel', minLevel);
  }

  /** `text` (human-readable) or `json` (one NDJSON object per record). */
  withFormat(format: ConsoleSinkFormat): this {
    return this.set('format', format);
  }

  /** Force a stream instead of letting the format choose. */
  withStream(stream: ConsoleSinkStream): this {
    return this.set('stream', stream);
  }
}

/** Validates resolved {@link ConsoleSinkOptionsType} settings. */
export class ConsoleSinkOptionsValidator extends OptionsValidator<ConsoleSinkOptionsType> {
  constructor() {
    super('ConsoleSinkOptions');
  }

  protected rules(s: Partial<ConsoleSinkOptionsType>): void {
    if (s.minLevel !== undefined && !isLogLevel(s.minLevel)) {
      this.fail('minLevel', LOG_LEVEL_REASON, s.minLevel);
    }
    this.oneOf('format', ['text', 'json']);
    this.oneOf('stream', ['auto', 'stdout', 'stderr']);
  }
}

/** Whether `actor-ts.logger.sinks.console.enabled` asks for this sink. */
export function isConsoleSinkEnabled(config: Config): boolean {
  return isSinkEnabled(config, ConfigKeys.logger.sinks.console);
}

/**
 * Read `actor-ts.logger.sinks.console.*`.  Only keys actually present are
 * returned, so an absent one falls through to the built-in default instead
 * of landing as an explicit `undefined`.
 */
export function readConsoleSinkOptionsFromConfig(config: Config): Partial<ConsoleSinkOptionsType> {
  const root = ConfigKeys.logger.sinks.console;
  const out: { -readonly [K in keyof ConsoleSinkOptionsType]?: ConsoleSinkOptionsType[K] } = {};
  const minLevel = readSinkMinLevel(config, root);
  if (minLevel !== undefined) out.minLevel = minLevel;
  // Enum leaves are read as-is; an unknown value is rejected by the
  // validator, which names the field, rather than silently defaulting.
  if (config.hasPath(sinkLeaf(root, 'format'))) {
    out.format = config.getString(sinkLeaf(root, 'format')) as ConsoleSinkFormat;
  }
  if (config.hasPath(sinkLeaf(root, 'stream'))) {
    out.stream = config.getString(sinkLeaf(root, 'stream')) as ConsoleSinkStream;
  }
  return out;
}

/**
 * Accepted input for the {@link ConsoleSink} constructor: the fluent
 * {@link ConsoleSinkOptionsBuilder} OR a plain
 * {@link ConsoleSinkOptionsType} object.
 */
export type ConsoleSinkOptions = ConsoleSinkOptionsBuilder | ConsoleSinkOptionsType;
/** Value alias so `ConsoleSinkOptions.create()` resolves to the builder. */
export const ConsoleSinkOptions = ConsoleSinkOptionsBuilder;
