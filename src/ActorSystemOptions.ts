/**
 * Fluent builder for {@link ActorSystemSettings}, passed to
 * {@link ActorSystem.create}:
 *
 *     const sys = ActorSystem.create('my-app', ActorSystemOptions.create()
 *       .withLogger(new NoopLogger())
 *       .withLogLevel(LogLevel.Off));
 *
 * The system name stays a positional argument to `create`; everything else
 * is set here.  `build()` yields a `Partial<ActorSystemSettings>` that feeds
 * the same resolution as before (explicit code overrides > HOCON >
 * reference defaults).
 */
import type { Config } from './config/Config.js';
import type { ConfigObject } from './config/HoconParser.js';
import type { Dispatcher } from './Dispatcher.js';
import type { Logger, LogLevel } from './Logger.js';
import type { Scheduler } from './Scheduler.js';
import { OptionsBuilder } from './util/OptionsBuilder.js';
import type { ActorSystemSettings } from './ActorSystem.js';

export class ActorSystemOptions<T extends ActorSystemSettings = ActorSystemSettings> extends OptionsBuilder<T> {
  /** Start a fresh builder.  Equivalent to `new ActorSystemOptions()`. */
  static create(): ActorSystemOptions {
    return new ActorSystemOptions();
  }

  /**
   * The `as keyof T` / `as T[keyof T]` casts keep these setters writable once
   * against the generic `T extends ActorSystemSettings`, so a subclass builder
   * (e.g. `TestKitOptions`) inherits them for its own settings type — the same
   * pattern as `BrokerOptions<T>` / `LeaseOptions<T>`.  Concrete callers stay
   * type-safe because each method's argument type is concrete.
   */

  /** System logger.  Overrides the HOCON/console default. */
  withLogger(logger: Logger): this {
    return this.set('logger' as keyof T, logger as T[keyof T]);
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
  withPersistence(persistence: NonNullable<ActorSystemSettings['persistence']>): this {
    return this.set('persistence' as keyof T, persistence as T[keyof T]);
  }
}
