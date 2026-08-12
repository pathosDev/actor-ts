import type { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { LogLevel } from '../Logger.js';
import { ConsoleSink } from './ConsoleSink.js';
import { isConsoleSinkEnabled, readConsoleSinkOptionsFromConfig } from './ConsoleSinkOptions.js';
import { FileSink } from './FileSink.js';
import { isFileSinkEnabled, readFileSinkOptionsFromConfig } from './FileSinkOptions.js';
import { OtlpHttpSink } from './OtlpHttpSink.js';
import { isOtlpSinkEnabled, readOtlpSinkOptionsFromConfig } from './OtlpHttpSinkOptions.js';
import { parseLogLevel } from './LogLevelName.js';
import type { LogSink } from './LogSink.js';
import { MultiSinkLogger } from './MultiSinkLogger.js';

/**
 * `actor-ts.logger.level`, or `info` when unset or unrecognised.
 *
 * An unknown name falls back rather than throwing: this is the level of
 * the logger itself, and refusing to start a system because someone typed
 * `"warning"` would trade a cosmetic mistake for an outage.  Sink-level
 * names are stricter — there the validator rejects them — because a
 * misconfigured sink is worth surfacing before it silently ships the wrong
 * records to a remote service.
 */
export function readLoggerLevelFromConfig(config: Config): LogLevel {
  if (!config.hasPath(ConfigKeys.logger.level)) return LogLevel.Info;
  return parseLogLevel(config.getString(ConfigKeys.logger.level)) ?? LogLevel.Info;
}

/**
 * Build a {@link MultiSinkLogger} from `actor-ts.logger.sinks.*`, or
 * `undefined` when no sink is enabled — in which case the caller keeps
 * whatever default it had.  That "no sinks, no logger" answer is what lets
 * a system with an untouched config behave exactly as it did before the
 * pipeline existed.
 *
 * `overrides.level` is the floor from `actor-ts.logger.level` (or an
 * explicit code override).  It gates *before* the per-sink levels, so a
 * sink asking for `debug` while the system level is `info` receives nothing
 * — one knob decides how much is produced at all, and the per-sink levels
 * only narrow it further.
 *
 * `overrides.closeTimeoutMs` is the same budget the system gives the whole
 * logger on `terminate()`.  Passing it down keeps the two from disagreeing:
 * with independent deadlines the outer one can expire, let the process
 * carry on, and leave the inner one to report a timeout into a program that
 * has already moved on.
 */
export function buildLoggerFromConfig(
  config: Config,
  overrides: { level?: LogLevel; closeTimeoutMs?: number } = {},
): MultiSinkLogger | undefined {
  const sinks: LogSink[] = [];
  if (isConsoleSinkEnabled(config)) {
    sinks.push(new ConsoleSink(readConsoleSinkOptionsFromConfig(config)));
  }
  if (isFileSinkEnabled(config)) {
    sinks.push(new FileSink(readFileSinkOptionsFromConfig(config)));
  }
  if (isOtlpSinkEnabled(config)) {
    sinks.push(new OtlpHttpSink(readOtlpSinkOptionsFromConfig(config)));
  }
  if (sinks.length === 0) return undefined;
  return new MultiSinkLogger({
    sinks,
    level: overrides.level ?? readLoggerLevelFromConfig(config),
    ...(overrides.closeTimeoutMs !== undefined ? { closeTimeoutMs: overrides.closeTimeoutMs } : {}),
  });
}
