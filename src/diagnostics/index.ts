/**
 * What the framework says about itself — `actor-ts.diagnostics.*` (#1000).
 *
 * The block is the home for anything that decides how loudly the runtime
 * reports its own behaviour, as opposed to what that behaviour is.  Today
 * that is dead-letter logging: the record `DeadLetterRef` emits when a message
 * could not be delivered, and the throttle that keeps a delivery outage from
 * turning the log into the outage.  `ConfigKeys.deadLetters` carries the
 * argument for why those knobs are not in `actor-ts.dead-letters.*` — the
 * split is by reader, retention there, announcement here.
 *
 * There is no runtime object to reach: the settings are resolved once in the
 * `ActorSystem` constructor and handed to `DeadLetterRef`.  What this barrel
 * carries is the options family an application configures them with, so
 * `ActorSystemOptions.withDiagnostics(…)` has a type to name.
 */
export {
  DEFAULT_LOG_DEAD_LETTERS,
  DEFAULT_LOG_DEAD_LETTERS_DURING_SHUTDOWN,
  DEFAULT_LOG_DEAD_LETTERS_SUSPEND_DURATION_MS,
  DiagnosticsOptions,
  DiagnosticsOptionsBuilder,
  DiagnosticsOptionsValidator,
  readDiagnosticsOptionsFromConfig,
} from './DiagnosticsOptions.js';
export type { DiagnosticsOptionsType } from './DiagnosticsOptions.js';
