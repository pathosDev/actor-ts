import type { Config } from '../config/Config.js';
import type { LogLevel } from '../Logger.js';
import { parseLogLevel } from './LogLevelName.js';

/**
 * The two leaves every sink block carries, read the same way everywhere.
 *
 * Each sink owns a *block* under `actor-ts.logger.sinks.<name>` rather than
 * a flat list of keys, so `ConfigKeys` needs one entry per sink instead of
 * one per option — the same shape the cache and persistence plugin roots
 * use.  These helpers turn a block root into the individual leaf paths.
 */

/** Build the full path of a leaf inside a sink block. */
export function sinkLeaf(blockRoot: string, leaf: string): string {
  return `${blockRoot}.${leaf}`;
}

/**
 * Whether a sink block asks to be built.  Absent means no — a sink that
 * appears in `reference.conf` but was never switched on must stay off.
 */
export function isSinkEnabled(config: Config, blockRoot: string): boolean {
  const path = sinkLeaf(blockRoot, 'enabled');
  return config.hasPath(path) && config.getBoolean(path);
}

/**
 * Read a sink's `min-level`.
 *
 * An unrecognised name is passed through **unparsed** rather than being
 * silently replaced by a default: the sink's own options validator then
 * rejects it as an `OptionsError` naming the field, which is a far better
 * diagnosis than logs quietly appearing at the wrong level.  (The same
 * reasoning `resolveWebsocketPolicy` follows for its HOCON enums.)
 */
export function readSinkMinLevel(config: Config, blockRoot: string): LogLevel | undefined {
  const path = sinkLeaf(blockRoot, 'min-level');
  if (!config.hasPath(path)) return undefined;
  const raw = config.getString(path);
  return (parseLogLevel(raw) ?? raw) as LogLevel;
}
