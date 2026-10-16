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
import type { CoordinatedStartupOptions } from './CoordinatedStartupOptions.js';
import type { DeadLetterQueueOptions } from './deadletters/DeadLetterQueueOptions.js';
import type { DiagnosticsOptions } from './diagnostics/DiagnosticsOptions.js';
import type { MessageBoundaryOptions } from './diagnostics/MessageBoundaryOptions.js';
import type { ParallelismOptions } from './parallelism/ParallelismOptions.js';
import type { Dispatcher } from './Dispatcher.js';
import type { Logger, LogLevel } from './Logger.js';
import type { LogSink } from './logging/LogSink.js';
import type { Scheduler } from './Scheduler.js';
import type { DurableStateStore } from './persistence/DurableStateStore.js';
import type { Journal } from './persistence/Journal.js';
import type { PersistenceBehaviorOptions } from './persistence/PersistenceBehaviorOptions.js';
import type { PersistencePlugin } from './persistence/PersistenceExtension.js';
import type { SnapshotStore } from './persistence/SnapshotStore.js';
import type { OtelLogsAdapterOptions } from './tracing/OtelLogsAdapterOptions.js';
import { OptionsBuilder } from './util/OptionsBuilder.js';

/**
 * Plain options-object shape accepted by {@link ActorSystem.create}.
 *
 * Four fields decide the system logger, and the first one set wins whole:
 * `logger` > `otelLogs` > `logSinks` > the sinks `actor-ts.logger.sinks.*`
 * enables > a `ConsoleLogger`.  Nothing is merged across them, and setting
 * two is not an error — the lower one is simply not built.
 */
export type ActorSystemOptionsType = {
  /** The system logger, used as it is.  Wins over every other logger field. */
  readonly logger?: Logger;
  /**
   * The system logger built by the framework from the OpenTelemetry Logs API:
   * the system passes these options to `otelLogger` at construction and uses
   * the result as `system.log`.  Its level is the options' own `level`, else
   * `logLevel`, else `actor-ts.logger.level`.
   *
   * A slot rather than something the tracing extension installs later,
   * because the logger cannot change once the constructor has run:
   * `system.log` is read-only, and the event stream, the dead-letter
   * reporting and every actor's `this.log` capture it as they are built.
   * `withLogger(otelLogger(...))` stays the pure path — the same factory with
   * your options alone, no config file.
   *
   * `logger` wins over this; this wins over `logSinks` and the HOCON sinks.
   * A mesh worker never receives it — a namespace object does not survive
   * the structured clone into a worker — so a worker's logger follows
   * `actor-ts.logger.sinks.*` as before.
   */
  readonly otelLogs?: OtelLogsAdapterOptions;
  /**
   * Log destinations — the system wraps them in a `MultiSinkLogger`,
   * attaches them to its scheduler, and flushes them on `terminate()`.
   *
   * The shorthand for the common case; `logger` and `otelLogs` still win
   * when either is given.  Setting this, or either of those, replaces the
   * `actor-ts.logger.sinks.*` block wholesale rather than merging with it: a
   * sink is configured in code or in HOCON, never half in each.
   */
  readonly logSinks?: readonly LogSink[];
  /**
   * Minimum level of the logger the system builds — the sinks, the console
   * default, and the `otelLogs` logger unless its options set their own.
   * Wins over `actor-ts.logger.level`; ignored when `logger` is set.
   */
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
   * The config profile — the `profiles.<profile>` block of `application.conf`
   * and of the secrets file, laid over each file's root (#1546).  Overrides
   * `ACTOR_TS_PROFILE`; a name neither file defines is refused at startup.
   *
   * Reaches `system.config` only.  The few components that read the
   * configuration without a system — `ClusterClient`, `InMemoryLease`,
   * `KubernetesLease`, `WorkerCluster`, and the `read…OptionsFromConfig`
   * helpers called without a `Config` — load it themselves and see
   * `ACTOR_TS_PROFILE` alone.
   */
  readonly profile?: string;
  /**
   * Persistence wired where the system is created, instead of by reaching into
   * the extension after `create` (#1473).
   *
   * `plugins` register backends.  Each is handed the system's
   * `PersistenceExtension` and typically makes one `register*Plugins` call —
   * `(persistence) => registerPostgresPlugins(persistence)` — while the
   * configuration's `actor-ts.persistence.<axis>.plugin` still decides which
   * registered plug-in an axis uses.  They run inside `create`, synchronously
   * and in the order given, so a selected plug-in resolves on the line after
   * `create`, before the startup graph starts.  One that throws makes `create`
   * throw; a promise one returns is awaited in the `persistence-start` phase,
   * where a rejection fails the startup.
   *
   * `journal`, `snapshotStore` and `durableStateStore` are instances, each the
   * explicit layer over the plug-in its axis selects: applied after the
   * plug-ins have run, and not replaced by a registration that comes later —
   * as if set with `setJournal` / `setSnapshotStore` / `setDurableStateStore`
   * on `system.extension(PersistenceExtensionId)`.  Every field is
   * independent; an axis with no instance keeps the plug-in it selects.
   *
   * `behavior` is the system-wide persistence behaviour, layered over
   * `actor-ts.persistence` field by field: a field set here wins over the
   * file, and one left unset still falls through to it.  Its `autoStart`,
   * on unless set false here, opens the selected stores as part of the
   * startup: a selection nothing registered, or a store that cannot open,
   * fails `whenReady()` and takes the system down.  Off, the stores open on
   * first use — the one way a plug-in registered after `create` still counts.
   */
  readonly persistence?: {
    readonly plugins?: ReadonlyArray<PersistencePlugin>;
    readonly journal?: Journal;
    readonly snapshotStore?: SnapshotStore;
    readonly durableStateStore?: DurableStateStore;
    readonly behavior?: PersistenceBehaviorOptions;
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
  /**
   * What every local `tell` is held to before delivery, layered over
   * `actor-ts.diagnostics.message-boundary.*` (#1386): the worker hop's
   * structured clone, the cluster wire's serializer round trip.  Off in
   * production; `TestKit` turns the clone check to `fail`.
   */
  readonly messageBoundary?: MessageBoundaryOptions;
  /**
   * Actors on worker threads, layered over `actor-ts.parallelism.*` (#1563).
   * The one thing only code can say here is the actor module — `withModule`
   * — because a config file must not decide which code a worker runs; the
   * worker count and everything else fall through to HOCON.
   */
  readonly parallelism?: ParallelismOptions;
  /**
   * The startup graph (#1473): tasks the system runs in phases as the last
   * step of `create`, before `whenReady()` resolves and before the `startup`
   * readiness check turns true — so a step that has to happen after a plugin
   * is registered and before the node takes traffic needs no call in `main`.
   *
   * A slot here rather than a call on the extension, because the graph is
   * sealed when `create` returns: a task added afterwards could find its phase
   * already over, so `CoordinatedStartup.addTask` refuses and names this.
   */
  readonly coordinatedStartup?: CoordinatedStartupOptions;
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

  /** System logger, used as it is.  Wins over `withOtelLogs`, `withLogSinks` and the HOCON/console default. */
  withLogger(logger: Logger): this {
    return this.set('logger' as keyof T, logger as T[keyof T]);
  }

  /**
   * Build the system logger from the OpenTelemetry Logs API — `otelLogger`
   * with these options.  Ignored if `withLogger` is set; wins over
   * `withLogSinks` and the HOCON sinks.
   */
  withOtelLogs(otelLogs: OtelLogsAdapterOptions): this {
    return this.set('otelLogs' as keyof T, otelLogs as T[keyof T]);
  }

  /**
   * Log destinations, wrapped in a `MultiSinkLogger` by the system.
   * Ignored if `withLogger` or `withOtelLogs` is set.
   */
  withLogSinks(logSinks: readonly LogSink[]): this {
    return this.set('logSinks' as keyof T, logSinks as T[keyof T]);
  }

  /**
   * Minimum log level of the logger the system builds — the sinks, the
   * console default, and the `withOtelLogs` logger unless its options set
   * their own (ignored if `withLogger` is set).
   */
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

  /**
   * Application config — a prebuilt `Config` or a plain object of overrides.
   * A plain object is nested the way the HOCON is, `{ 'actor-ts': { system: { name: 'orders' } } }`:
   * a dotted key such as `'actor-ts.system.name'` is one literal key, which nothing reads.
   */
  withConfig(config: Config | ConfigObject): this {
    return this.set('config' as keyof T, config as T[keyof T]);
  }

  /** Explicit path to `application.conf` (overrides `ACTOR_TS_CONFIG` + CWD lookup). */
  withConfigFile(configFile: string): this {
    return this.set('configFile' as keyof T, configFile as T[keyof T]);
  }

  /**
   * The config profile laid over `application.conf` and the secrets file
   * (overrides `ACTOR_TS_PROFILE`).  An empty name selects none, whatever the
   * environment says.
   */
  withProfile(profile: string): this {
    return this.set('profile' as keyof T, profile as T[keyof T]);
  }

  /**
   * Persistence wired at system creation: plug-ins that register backends
   * before `create` returns, store instances that win over the plug-in
   * their axis selects, and the behaviour layered over `actor-ts.persistence`.
   */
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

  /**
   * Message-boundary checks, layered over
   * `actor-ts.diagnostics.message-boundary.*` — whether a local `tell` is
   * examined the way a worker hop or a cluster wire would examine it.
   */
  withMessageBoundary(messageBoundary: NonNullable<ActorSystemOptionsType['messageBoundary']>): this {
    return this.set('messageBoundary' as keyof T, messageBoundary as T[keyof T]);
  }

  /**
   * Parallelism settings, layered over `actor-ts.parallelism.*` — which
   * actors run on worker threads, and how many threads.  Fields you leave
   * unset still fall through to HOCON.
   */
  withParallelism(parallelism: NonNullable<ActorSystemOptionsType['parallelism']>): this {
    return this.set('parallelism' as keyof T, parallelism as T[keyof T]);
  }

  /**
   * The startup graph — tasks the system runs in phases as the last step of
   * `create`, awaited through `system.whenReady()`.  The only way in: the
   * graph is sealed once `create` returns.
   */
  withCoordinatedStartup(coordinatedStartup: NonNullable<ActorSystemOptionsType['coordinatedStartup']>): this {
    return this.set('coordinatedStartup' as keyof T, coordinatedStartup as T[keyof T]);
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
