/**
 * What the framework says about itself — `actor-ts.diagnostics.*` (#1000,
 * #867).
 *
 * The block is the home for anything that decides how loudly the runtime
 * reports its own behaviour, as opposed to what that behaviour is.  Two
 * families live in it, split by level.  The `log-*` keys are `info` and
 * `warn`: dead-letter logging and its throttle, and the boot config dump.
 * The `debug.*` keys are `debug`, and therefore need
 * `actor-ts.logger.level = debug` as well — declined messages, actor
 * lifecycle transitions, event-stream subscription churn.
 * `ConfigKeys.deadLetters` carries the argument for why the dead-letter knobs
 * are not in `actor-ts.dead-letters.*` — the split is by reader, retention
 * there, announcement here.
 *
 * There is no runtime object to reach: the settings are resolved once in the
 * `ActorSystem` constructor and handed to the sites that emit — the
 * dead-letter ref, the cell, the bus, the declined-message recorder.  What
 * this barrel carries is the options family an application configures them
 * with, so `ActorSystemOptions.withDiagnostics(…)` has a type to name, and
 * the dump renderer, so an application can ask for the same text at a moment
 * of its own choosing.
 */
export { configDumpLines } from './ConfigDump.js';
export {
  DEFAULT_DEBUG_EVENT_STREAM,
  DEFAULT_DEBUG_LIFECYCLE,
  DEFAULT_DEBUG_UNHANDLED,
  DEFAULT_LOG_CONFIG_ON_START,
  DEFAULT_LOG_DEAD_LETTERS,
  DEFAULT_LOG_DEAD_LETTERS_DURING_SHUTDOWN,
  DEFAULT_LOG_DEAD_LETTERS_SUSPEND_DURATION_MS,
  DiagnosticsOptions,
  DiagnosticsOptionsBuilder,
  DiagnosticsOptionsValidator,
  readDiagnosticsOptionsFromConfig,
} from './DiagnosticsOptions.js';
export type { DiagnosticsOptionsType, ResolvedDiagnostics } from './DiagnosticsOptions.js';
