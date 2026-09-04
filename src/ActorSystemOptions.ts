/**
 * Fluent builder for {@link ActorSystemOptionsType}, passed to
 * {@link ActorSystem.create}:
 *
 *     const sys = ActorSystem.create('my-app', ActorSystemOptions.create()
 *       .withLogger(new NoopLogger())
 *       .withLogLevel(LogLevel.Off));
 *
 * The system name stays a positional argument to `create`; everything else
 * is set here.  `build()` yields a `Partial<ActorSystemOptionsType>` that feeds
 * the same resolution as before (explicit code overrides > HOCON >
 * reference defaults).
 */
import type { Config } from './config/Config.js';
import type { ConfigObject } from './config/HoconParser.js';
import type { DeadLetterQueueOptions } from './deadletters/DeadLetterQueueOptions.js';
import type { DiagnosticsOptions } from './diagnostics/DiagnosticsOptions.js';
import type { Dispatcher } from './Dispatcher.js';
import type { Logger, LogLevel } from './Logger.js';
import type { LogSink } from './logging/LogSink.js';
import type { Scheduler } from './Scheduler.js';
import type { Journal } from './persistence/Journal.js';
import type { SnapshotStore } from './persistence/SnapshotStore.js';
import { OptionsBuilder } from './util/OptionsBuilder.js';

/** Plain options-object shape accepted by {@link ActorSystem.create}. */
export type ActorSystemOptionsType = {
  readonly logger?: Logger;
  /**
   * Log destinations — the system wraps them in a `MultiSinkLogger`,
   * attaches them to its scheduler, and flushes them on `terminate()`.
   *
   * The shorthand for the common case; `logger` still wins when both are
   * given.  Setting either one replaces the `actor-ts.logger.sinks.*`
   * block wholesale rather than merging with it: a sink is configured in
   * code or in HOCON, never half in each.
   */
  readonly logSinks?: readonly LogSink[];
  readonly logLevel?: LogLevel;
  readonly dispatcher?: Dispatcher;
  /** Inject a custom scheduler — typically a ManualScheduler in tests. */
  readonly scheduler?: Scheduler;
  /**
   * Application config.  Accepts:
   *   - a prebuilt `Config` (highest precedence layered on top of reference);
   *   - a plain JS object of overrides (converted via Config.fromObject);
   *   - omitted — reference defaults + `application.conf` in CWD are used.
   * Constructor options (`logger`, `logLevel`, `dispatcher`) still win
   * over anything in config — they are explicit code overrides.
   */
  readonly config?: Config | ConfigObject;
  /** Explicit path to `application.conf`; overrides `ACTOR_TS_CONFIG` + CWD lookup. */
  readonly configFile?: string;
  /**
   * Persistence overrides — wire a real journal / snapshot store at
   * system creation time instead of reaching into the extension after
   * the fact.  Either field is independent; omit one to keep the
   * in-memory default for that slot.
   *
   * Equivalent to:
   *   const sys = ActorSystem.create(name);
   *   sys.extension(PersistenceExtensionId).setJournal(journal);
   *   sys.extension(PersistenceExtensionId).setSnapshotStore(snapshotStore);
   */
  readonly persistence?: {
    readonly journal?: Journal;
    readonly snapshotStore?: SnapshotStore;
  };
  /**
   * Dead-letter queue settings — the explicit layer over
   * `actor-ts.dead-letters.*`.
   *
   * Needed because `system.deadLetterQueue` is built by the constructor and
   * is `readonly`: without a slot here the publicly exported
   * `DeadLetterQueueOptions` family had no reachable consumer at all.  A
   * queue you construct yourself is never installed as the capture sink, so
   * it is a correctly-configured object that receives nothing — which made
   * HOCON the only way to configure the real queue, against the project's
   * *explicit options > HOCON > built-in defaults* rule.
   *
   * Field-by-field, so setting one knob here does not blank the others out
   * of the config file.
   */
  readonly deadLetters?: DeadLetterQueueOptions;
  /**
   * Diagnostics settings — the explicit layer over `actor-ts.diagnostics.*`,
   * which today is dead-letter logging and its throttle (#1000).
   *
   * Here for the same reason `deadLetters` is: the settings are consumed by
   * the constructor and handed straight to `DeadLetterRef`, so without a
   * slot here the published `DiagnosticsOptions` family would have no
   * reachable consumer and HOCON would be the only way to configure a
   * default-ON log line — against the project's *explicit options > HOCON >
   * built-in defaults* rule.
   *
   * Field-by-field, so setting one knob here does not blank the others out
   * of the config file.
   */
  readonly diagnostics?: DiagnosticsOptions;
};

export class ActorSystemOptionsBuilder<T extends ActorSystemOptionsType = ActorSystemOptionsType> extends OptionsBuilder<T> {
  /** Start a fresh builder.  Equivalent to `new ActorSystemOptionsBuilder()`. */
  static create(): ActorSystemOptionsBuilder {
    return new ActorSystemOptionsBuilder();
  }

  /**
   * The `as keyof T` / `as T[keyof T]` casts keep these setters writable once
   * against the generic `T extends ActorSystemOptionsType`, so a subclass builder
   * (e.g. `TestKitOptionsBuilder`) inherits them for its own options type — the same
   * pattern as `BrokerOptionsBuilder<T>` / `LeaseOptions<T>`.  Concrete callers stay
   * type-safe because each method's argument type is concrete.
   */

  /** System logger.  Overrides the HOCON/console default. */
  withLogger(logger: Logger): this {
    return this.set('logger' as keyof T, logger as T[keyof T]);
  }

  /**
   * Log destinations, wrapped in a `MultiSinkLogger` by the system.
   * Ignored if `withLogger` is set.
   */
  withLogSinks(logSinks: readonly LogSink[]): this {
    return this.set('logSinks' as keyof T, logSinks as T[keyof T]);
  }

  /** Minimum log level for the default console logger (ignored if `withLogger` is set). */
  withLogLevel(logLevel: LogLevel): this {
    return this.set('logLevel' as keyof T, logLevel as T[keyof T]);
  }

  /** Custom dispatcher for the system's default mailbox scheduling. */
  withDispatcher(dispatcher: Dispatcher): this {
    return this.set('dispatcher' as keyof T, dispatcher as T[keyof T]);
  }

  /** Custom scheduler — typically a ManualScheduler in tests. */
  withScheduler(scheduler: Scheduler): this {
    return this.set('scheduler' as keyof T, scheduler as T[keyof T]);
  }

  /** Application config — a prebuilt `Config` or a plain object of overrides. */
  withConfig(config: Config | ConfigObject): this {
    return this.set('config' as keyof T, config as T[keyof T]);
  }

  /** Explicit path to `application.conf` (overrides `ACTOR_TS_CONFIG` + CWD lookup). */
  withConfigFile(configFile: string): this {
    return this.set('configFile' as keyof T, configFile as T[keyof T]);
  }

  /** Wire a real journal / snapshot store at system creation time. */
  withPersistence(persistence: NonNullable<ActorSystemOptionsType['persistence']>): this {
    return this.set('persistence' as keyof T, persistence as T[keyof T]);
  }

  /**
   * Dead-letter queue settings, layered over `actor-ts.dead-letters.*`.
   * Fields you leave unset still fall through to HOCON.
   */
  withDeadLetters(deadLetters: NonNullable<ActorSystemOptionsType['deadLetters']>): this {
    return this.set('deadLetters' as keyof T, deadLetters as T[keyof T]);
  }

  /**
   * Diagnostics settings, layered over `actor-ts.diagnostics.*` — how loudly
   * the runtime reports itself.  Fields you leave unset still fall through
   * to HOCON.
   */
  withDiagnostics(diagnostics: NonNullable<ActorSystemOptionsType['diagnostics']>): this {
    return this.set('diagnostics' as keyof T, diagnostics as T[keyof T]);
  }
}

/**
 * Accepted input for {@link ActorSystem.create}: the fluent
 * {@link ActorSystemOptionsBuilder} OR a plain {@link ActorSystemOptionsType}
 * object.  The union is the default (non-generic) instantiation; subclass
 * builders (e.g. `TestKitOptionsBuilder`) still parametrize
 * {@link ActorSystemOptionsBuilder} with their own options type.
 */
export type ActorSystemOptions = ActorSystemOptionsBuilder<ActorSystemOptionsType> | Partial<ActorSystemOptionsType>;
/** Value alias so `ActorSystemOptions.create()` / `new ActorSystemOptions()` resolve to the builder. */
export const ActorSystemOptions = ActorSystemOptionsBuilder;
