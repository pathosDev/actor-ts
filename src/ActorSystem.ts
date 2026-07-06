import { match } from 'ts-pattern';
import { ActorRef } from './ActorRef.js';
import { ActorSelection, parseSelectionPath } from './ActorSelection.js';
import { Config } from './config/Config.js';
import { ConfigKeys } from './config/ConfigKeys.js';
import { none, some, type Option } from './util/Option.js';
import type { ConfigObject } from './config/HoconParser.js';
import { Extensions, type Extension, type ExtensionId } from './Extension.js';
import {
  Dispatcher,
  ImmediateDispatcher,
  MicrotaskDispatcher,
  ThroughputDispatcher,
} from './Dispatcher.js';
import { EventStream } from './EventStream.js';
import { ConsoleLogger, Logger, LogLevel } from './Logger.js';
import { Props } from './Props.js';
import { Scheduler } from './Scheduler.js';
import { OptionsBuilder } from './util/OptionsBuilder.js';
import { ActorCell } from './internal/ActorCell.js';
import { DeadLetterRef } from './internal/DeadLetterRef.js';
import { Guardian, systemGuardianStrategy, userGuardianStrategy } from './internal/Guardian.js';
import { LocalActorRef } from './internal/LocalActorRef.js';
import type { Journal } from './persistence/Journal.js';
import type { SnapshotStore } from './persistence/SnapshotStore.js';
import { PersistenceExtensionId } from './persistence/PersistenceExtension.js';
import type { HttpServerBackend } from './http/backend/HttpServerBackend.js';
import { HttpExtensionId, type ServerBuilder } from './http/HttpExtension.js';
import type { Behavior } from './typed/Behavior.js';
import { typedProps } from './typed/spawn.js';

export interface ActorSystemSettings {
  readonly logger?: Logger;
  readonly logLevel?: LogLevel;
  readonly dispatcher?: Dispatcher;
  /** Inject a custom scheduler — typically a ManualScheduler in tests. */
  readonly scheduler?: Scheduler;
  /**
   * Application config.  Accepts:
   *   - a prebuilt `Config` (highest precedence layered on top of reference);
   *   - a plain JS object of overrides (converted via Config.fromObject);
   *   - omitted — reference defaults + `application.conf` in CWD are used.
   * Constructor settings (`logger`, `logLevel`, `dispatcher`) still win
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
}

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

/**
 * The ActorSystem is the top-level container for actors.  It owns the root
 * guardians, the event stream, the scheduler, and the default dispatcher.
 * Create one per logical application.
 */
export class ActorSystem {
  readonly name: string;
  readonly dispatcher: Dispatcher;
  readonly scheduler: Scheduler;
  readonly eventStream: EventStream;
  readonly log: Logger;
  readonly deadLetters: ActorRef;
  /** Full merged configuration in effect for this system. */
  readonly config: Config;
  /** Per-system extension registry (serialization, sharding, pubsub, …). */
  readonly extensions: Extensions;

  private readonly rootCell: ActorCell<unknown>;
  private readonly userGuardianCell: ActorCell<unknown>;
  private readonly systemGuardianCell: ActorCell<unknown>;

  private _terminating = false;
  private _terminated = false;
  private _terminationResolvers: Array<() => void> = [];

  private constructor(name: string, settings: ActorSystemSettings) {
    this.name = name;
    this.config = buildConfig(settings);
    this.dispatcher = settings.dispatcher ?? dispatcherFromConfig(this.config);
    this.scheduler = settings.scheduler ?? new Scheduler();
    this.eventStream = new EventStream();
    this.log = settings.logger
      ?? new ConsoleLogger(settings.logLevel ?? logLevelFromConfig(this.config));
    // Wire the system logger into the bus so a throwing subscriber
    // predicate (#85) gets surfaced rather than silently dropped.
    this.eventStream.log = this.log;
    this.deadLetters = new DeadLetterRef(name, this.eventStream);
    this.extensions = new Extensions(this);

    // Construct the supervisor chain: /  ->  /user, /system.
    this.rootCell = new ActorCell<unknown>(
      this,
      Props.create(() => new Guardian()),
      null,
      '',
    );

    const userRef = this.rootCell.spawn(
      Props.create(() => new Guardian(userGuardianStrategy)),
      'user',
    );
    this.userGuardianCell = (userRef as LocalActorRef<unknown>).getCell();

    const systemRef = this.rootCell.spawn(
      Props.create(() => new Guardian(systemGuardianStrategy)),
      'system',
    );
    this.systemGuardianCell = (systemRef as LocalActorRef<unknown>).getCell();

    // Apply persistence overrides AFTER the guardians are wired up so the
    // extension registry exists.  Either field is independent — omitted
    // slots keep the auto-default in-memory plugin
    // (see PersistenceExtension.journal / snapshotStore getters).
    if (settings.persistence) {
      const ext = this.extensions.get(PersistenceExtensionId);
      if (settings.persistence.journal) ext.setJournal(settings.persistence.journal);
      if (settings.persistence.snapshotStore) ext.setSnapshotStore(settings.persistence.snapshotStore);
    }
  }

  /** Create a new actor system. */
  static create(name: string = 'default', options: ActorSystemOptions = ActorSystemOptions.create()): ActorSystem {
    return new ActorSystem(name, options.build());
  }

  /**
   * Convenience shortcut for `system.extensions.get(id)` — the one-liner
   * used throughout the codebase to resolve an extension by its id.
   */
  extension<T extends Extension>(id: ExtensionId<T>): T {
    return this.extensions.get(id);
  }

  /**
   * Shortcut — bind an HTTP server on `port` (and optionally `host`)
   * with the framework's default Fastify backend.  Equivalent to:
   *
   *     system.extension(HttpExtensionId)
   *           .newServerAt(host ?? '0.0.0.0', port)
   *           .useBackend(backend ?? new FastifyBackend())
   *
   * For non-default backends, pass `backend:` — typically
   * `new ExpressBackend(opts)` or `new HonoBackend(opts)`.  Returns
   * the `ServerBuilder` so you can chain `.bind(routes)`:
   *
   *     const binding = await system.http(8080).bind(routes);
   *
   * Note — `FastifyBackend` is a hard dependency of the framework
   * (not a peer-dep), so the default path needs no extra installs.
   */
  http(
    port: number,
    opts: { readonly host?: string; readonly backend?: HttpServerBackend } = {},
  ): ServerBuilder {
    const builder = this.extensions.get(HttpExtensionId).newServerAt(opts.host ?? '0.0.0.0', port);
    return opts.backend ? builder.useBackend(opts.backend) : builder;
  }

  /**
   * Spawn a top-level user actor under /user with a deterministic
   * caller-supplied name.  The name must be unique among siblings
   * (i.e. children of `/user`) — if a child with the same name
   * already exists, the call throws.
   *
   * For an auto-generated name, see {@link spawnAnonymous}.
   */
  spawn<T>(props: Props<T>, name: string): ActorRef<T> {
    if (this._terminating || this._terminated) {
      throw new Error(`Cannot create actors on a terminated ActorSystem '${this.name}'`);
    }
    return this.userGuardianCell.spawn(props, name);
  }

  /**
   * Spawn a top-level user actor under /user with an auto-generated
   * name.  Use when the caller doesn't care about the path — e.g.
   * one-shot async work, throwaway helpers.  For a deterministic
   * name, see {@link spawn}.
   */
  spawnAnonymous<T>(props: Props<T>): ActorRef<T> {
    if (this._terminating || this._terminated) {
      throw new Error(`Cannot create actors on a terminated ActorSystem '${this.name}'`);
    }
    return this.userGuardianCell.spawnAnonymous(props);
  }

  /**
   * Spawn a typed Behavior under `/user` with a deterministic name —
   * the Behavior-DSL counterpart to {@link spawn}.  Wraps the Behavior
   * in `typedProps(behavior)` so callers don't have to thread Props
   * through the typed API.
   *
   *     const ref = system.spawnTyped(counter(0), 'counter');
   */
  spawnTyped<T>(behavior: Behavior<T>, name: string): ActorRef<T> {
    return this.spawn(typedProps<T>(behavior), name);
  }

  /**
   * Anonymous variant of {@link spawnTyped} — the Behavior-DSL
   * counterpart to {@link spawnAnonymous}.  Pick this when the caller
   * doesn't need a stable path.
   */
  spawnTypedAnonymous<T>(behavior: Behavior<T>): ActorRef<T> {
    return this.spawnAnonymous(typedProps<T>(behavior));
  }

  /**
   * Build an ActorSelection that resolves a path at lookup time.  Accepts
   *   - a fully-qualified URI ("actor-ts://sys/user/foo/bar")
   *   - an absolute path ("/user/foo/bar" or "user/foo/bar")
   * Wildcards are not supported in v1.
   */
  actorSelection(path: string): ActorSelection {
    const segments = parseSelectionPath(this, path);
    if (segments === null) {
      // Mismatched system name — selection will never resolve.  We stamp
      // an obviously-invalid segment so resolveOne times out rather than
      // silently returning the root cell.
      return new ActorSelection(this, ['<mismatched-system>'], path);
    }
    return new ActorSelection(this, segments, path);
  }

  /** @internal — walk the actor tree and return the ref at `segments`. */
  _resolvePath(segments: ReadonlyArray<string>): Option<ActorRef> {
    if (segments.length === 0) return some(this.rootCell.self);
    let cell: ActorCell<unknown> = this.rootCell;
    for (const seg of segments) {
      const child = cell._findChildCell(seg);
      if (!child) return none;
      cell = child;
    }
    return some(cell.self);
  }

  /** Stop any actor by reference. Returns a promise that resolves once it is fully terminated. */
  stop(ref: ActorRef): void {
    ref.stop();
  }

  /** Shut down: stops /user (children first) and resolves once everything is drained. */
  terminate(): Promise<void> {
    if (this._terminated) return Promise.resolve();
    if (this._terminating) return this.whenTerminated();
    this._terminating = true;
    this.rootCell.enqueueSystem({ kind: 'terminate' });
    return this.whenTerminated();
  }

  /** Promise that resolves when the system has finished shutting down. */
  whenTerminated(): Promise<void> {
    if (this._terminated) return Promise.resolve();
    return new Promise((resolve) => {
      this._terminationResolvers.push(resolve);
    });
  }

  get isTerminated(): boolean { return this._terminated; }

  /** @internal — called by the root cell once it has finished terminating. */
  _rootTerminated(_cell: ActorCell<any>): void {
    this._terminated = true;
    this.scheduler.shutdown();
    const resolvers = this._terminationResolvers;
    this._terminationResolvers = [];
    for (const r of resolvers) r();
  }
}

/* ----------------------------- Config helpers ----------------------------- */

function buildConfig(settings: ActorSystemSettings): Config {
  const userLayer =
    settings.config === undefined
      ? Config.empty()
      : settings.config instanceof Config
        ? settings.config
        : Config.fromObject(settings.config);
  return Config.load({
    appConfPath: settings.configFile,
    overrides: userLayer,
  });
}

function logLevelFromConfig(config: Config): LogLevel {
  if (!config.hasPath(ConfigKeys.logger.level)) return LogLevel.Info;
  const raw = config.getString(ConfigKeys.logger.level).toLowerCase();
  return match(raw)
    .with('debug', () => LogLevel.Debug)
    .with('info',  () => LogLevel.Info)
    .with('warn',  () => LogLevel.Warn)
    .with('error', () => LogLevel.Error)
    .with('off',   () => LogLevel.Off)
    .otherwise(() => LogLevel.Info);
}

function dispatcherFromConfig(config: Config): Dispatcher {
  const kind = config.hasPath(ConfigKeys.dispatcher.default)
    ? config.getString(ConfigKeys.dispatcher.default).toLowerCase()
    : 'immediate';
  return match(kind)
    .with('microtask',  () => new MicrotaskDispatcher() as Dispatcher)
    .with('throughput', () => {
      const n = config.hasPath(ConfigKeys.dispatcher.throughput)
        ? config.getInt(ConfigKeys.dispatcher.throughput)
        : 16;
      return new ThroughputDispatcher(n) as Dispatcher;
    })
    .otherwise(() => new ImmediateDispatcher() as Dispatcher);
}
