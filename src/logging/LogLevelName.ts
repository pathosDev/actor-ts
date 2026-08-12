import { LogLevel } from '../Logger.js';

/**
 * The level ↔ name mapping that HOCON and the log platforms speak.
 *
 * `LogLevel` is a numeric enum, but every configuration surface writes it
 * as a word — `actor-ts.logger.level = "debug"`, a sink's `min-level`, a
 * `severityText` on the wire.  Keeping the parse in one place is what stops
 * `"warn"` from being accepted in one block and `"warning"` in another.
 */

/** Accepted spellings, lowest first — also the order an error message lists. */
export const LOG_LEVEL_NAMES = ['debug', 'info', 'warn', 'error', 'off'] as const;

export type LogLevelName = (typeof LOG_LEVEL_NAMES)[number];

const BY_NAME: Readonly<Record<LogLevelName, LogLevel>> = {
  debug: LogLevel.Debug,
  info: LogLevel.Info,
  warn: LogLevel.Warn,
  error: LogLevel.Error,
  off: LogLevel.Off,
};

const BY_LEVEL: Readonly<Record<LogLevel, LogLevelName>> = {
  [LogLevel.Debug]: 'debug',
  [LogLevel.Info]: 'info',
  [LogLevel.Warn]: 'warn',
  [LogLevel.Error]: 'error',
  [LogLevel.Off]: 'off',
};

/**
 * Parse a configured level name, case-insensitively.  Returns `undefined`
 * for anything unrecognised so the caller decides what an unknown value
 * means — the system logger falls back to `info`, a sink's options
 * validator rejects it, and both are right in their own context.
 */
export function parseLogLevel(raw: string): LogLevel | undefined {
  return BY_NAME[raw.trim().toLowerCase() as LogLevelName];
}

/** The canonical lowercase name of a level. */
export function logLevelName(level: LogLevel): LogLevelName {
  return BY_LEVEL[level] ?? 'info';
}

/** Whether a value is one of the five `LogLevel` members. */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'number' && value in BY_LEVEL;
}

/**
 * The rejection reason an options validator uses for a level field.
 *
 * Levels reach a validator as numbers, so the generic `oneOf` helper would
 * report `must be one of 0, 1, 2, 3, 100` — true, and useless to whoever
 * wrote `min-level = "warning"` in a config file.  Naming the accepted
 * spellings is the whole point of the message.
 */
export const LOG_LEVEL_REASON = `must be one of ${LOG_LEVEL_NAMES.join(', ')}`;
