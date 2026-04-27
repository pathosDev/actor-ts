import { match } from 'ts-pattern';
import { ActorRef } from './ActorRef.js';
import { ActorSelection, parseSelectionPath } from './ActorSelection.js';
import { Config } from './config/Config.js';
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
import { ActorCell } from './internal/ActorCell.js';
import { DeadLetterRef } from './internal/DeadLetterRef.js';
import { Guardian, systemGuardianStrategy, userGuardianStrategy } from './internal/Guardian.js';
import { LocalActorRef } from './internal/LocalActorRef.js';

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
    this.deadLetters = new DeadLetterRef(name, this.eventStream);
    this.extensions = new Extensions(this);

    // Construct the supervisor chain: /  ->  /user, /system.
    this.rootCell = new ActorCell<unknown>(
      this,
      Props.create(() => new Guardian()),
      null,
      '',
    );

    const userRef = this.rootCell.actorOf(
      Props.create(() => new Guardian(userGuardianStrategy)),
      'user',
    );
    this.userGuardianCell = (userRef as LocalActorRef<unknown>).getCell();

    const systemRef = this.rootCell.actorOf(
      Props.create(() => new Guardian(systemGuardianStrategy)),
      'system',
    );
    this.systemGuardianCell = (systemRef as LocalActorRef<unknown>).getCell();
  }

  /** Create a new actor system. */
  static create(name: string = 'default', settings: ActorSystemSettings = {}): ActorSystem {
    return new ActorSystem(name, settings);
  }

  /**
   * Convenience shortcut for `system.extensions.get(id)` — the one-liner
   * used throughout the codebase to resolve an extension by its id.
   */
  extension<T extends Extension>(id: ExtensionId<T>): T {
    return this.extensions.get(id);
  }

  /** Spawn a top-level user actor under /user. */
  actorOf<T>(props: Props<T>, name?: string): ActorRef<T> {
    if (this._terminating || this._terminated) {
      throw new Error(`Cannot create actors on a terminated ActorSystem '${this.name}'`);
    }
    return this.userGuardianCell.actorOf(props, name);
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
  if (!config.hasPath('actor-ts.logger.level')) return LogLevel.Info;
  const raw = config.getString('actor-ts.logger.level').toLowerCase();
  return match(raw)
    .with('debug', () => LogLevel.Debug)
    .with('info',  () => LogLevel.Info)
    .with('warn',  () => LogLevel.Warn)
    .with('error', () => LogLevel.Error)
    .with('off',   () => LogLevel.Off)
    .otherwise(() => LogLevel.Info);
}

function dispatcherFromConfig(config: Config): Dispatcher {
  const kind = config.hasPath('actor-ts.dispatcher.default')
    ? config.getString('actor-ts.dispatcher.default').toLowerCase()
    : 'immediate';
  return match(kind)
    .with('microtask',  () => new MicrotaskDispatcher() as Dispatcher)
    .with('throughput', () => {
      const n = config.hasPath('actor-ts.dispatcher.throughput')
        ? config.getInt('actor-ts.dispatcher.throughput')
        : 16;
      return new ThroughputDispatcher(n) as Dispatcher;
    })
    .otherwise(() => new ImmediateDispatcher() as Dispatcher);
}
