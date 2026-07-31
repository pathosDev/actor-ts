import { match } from 'ts-pattern';
import { ActorRef } from './ActorRef.js';
import { ActorSelection, parseSelectionPath } from './ActorSelection.js';
import { Config } from './config/Config.js';
import { ConfigKeys } from './config/ConfigKeys.js';
import { none, some, type Option } from './util/Option.js';
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
import type { ActorSystemOptions, ActorSystemOptionsType } from './ActorSystemOptions.js';
import { ActorCell } from './internal/ActorCell.js';
import type { CellInspection, DispatchObserver } from './internal/Instrumentation.js';
import { DeadLetterRef } from './internal/DeadLetterRef.js';
import { Guardian, systemGuardianStrategy, userGuardianStrategy } from './internal/Guardian.js';
import { LocalActorRef } from './internal/LocalActorRef.js';
import { systemGroupPolicy, type SystemGroup } from './internal/SystemPaths.js';
import { PersistenceExtensionId } from './persistence/PersistenceExtension.js';
import type { HttpServerBackend } from './http/backend/HttpServerBackend.js';
import { HttpExtensionId, type ServerBuilder } from './http/HttpExtension.js';
import type { Behavior } from './typed/Behavior.js';
import { typedProps } from './typed/spawn.js';

/**
 * The ActorSystem is the top-level container for actors.  It owns the root
 * guardians, the event stream, the scheduler, and the default dispatcher.
 * Create one per logical application.
 */
export class ActorSystem {
  readonly name: string;
  /**
   * Wall-clock time this system was created.  Stamped first in the
   * constructor, so `Date.now() - startedAtMs` is the system's uptime —
   * the one clock that survives a monitoring tool attaching, detaching,
   * or reconnecting halfway through the run.
   */
  readonly startedAtMs: number;
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
  /**
   * Group guardians under `/system`, keyed by group path — populated on
   * demand by {@link _systemGroupCell}.  Empty until something actually
   * spawns a framework actor, so a plain system keeps its three-cell tree.
   */
  private readonly systemGroupCells = new Map<string, ActorCell<unknown>>();

  /**
   * @internal Profiling hook, `null` unless a profiler is running.
   *
   * Read once per message on the dispatch path, so it is a field rather
   * than an extension lookup.  Single-owner by design — see
   * {@link DispatchObserver}.
   */
  _dispatchObserver: DispatchObserver | null = null;

  /**
   * @internal Open a span for every message, not only for ones that
   * already belong to a trace.  Owned by `TracingExtension`; see
   * `recordRootSpans`.
   *
   * A field for the same reason as {@link _dispatchObserver}: it is read
   * once per message, and an extension lookup per message is not.
   */
  _traceRootSpans = false;

  /**
   * @internal Attach the serialised message to each `actor.receive`
   * span.  Owned by `TracingExtension`; see `captureMessagePayloads`.
   *
   * Separate from {@link _traceRootSpans} because the costs differ: one
   * decides *whether* to open a span, this one decides whether to
   * `JSON.stringify` a user object while doing so.  Production tracing
   * wants the first without paying for the second.
   */
  _traceMessagePayloads = false;

  private _terminating = false;
  private _terminated = false;
  private _terminationResolvers: Array<() => void> = [];

  private constructor(name: string, options: ActorSystemOptionsType) {
    this.startedAtMs = Date.now();
    this.name = name;
    this.config = buildConfig(options);
    this.dispatcher = options.dispatcher ?? dispatcherFromConfig(this.config);
    this.scheduler = options.scheduler ?? new Scheduler();
    this.eventStream = new EventStream();
    this.log = options.logger
      ?? new ConsoleLogger(options.logLevel ?? logLevelFromConfig(this.config));
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
    if (options.persistence) {
      const ext = this.extensions.get(PersistenceExtensionId);
      if (options.persistence.journal) ext.setJournal(options.persistence.journal);
      if (options.persistence.snapshotStore) ext.setSnapshotStore(options.persistence.snapshotStore);
    }
  }

  /** Create a new actor system. */
  static create(
    name: string = 'default',
    options: ActorSystemOptions = {},
  ): ActorSystem {
    return new ActorSystem(name, (options as Partial<ActorSystemOptionsType>));
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
    options: { readonly host?: string; readonly backend?: HttpServerBackend } = {},
  ): ServerBuilder {
    const builder = this.extensions.get(HttpExtensionId).newServerAt(options.host ?? '0.0.0.0', port);
    return options.backend ? builder.useBackend(options.backend) : builder;
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
   * @internal Spawn a framework-owned actor under `/system/<group>`.
   *
   * The framework's own actors — the DevTools hub, shard regions, the pub-sub
   * mediator, projections — do not belong in `/user`, which is the
   * application's namespace.  Keeping them apart is what lets a reader of the
   * actor tree tell the two sides apart, and what gives shutdown a boundary
   * to order against.
   *
   * Deliberately internal: this is not an extension point for applications,
   * and `/user` stays the only place user code can spawn a top-level actor.
   */
  _spawnSystemActor<T>(props: Props<T>, group: SystemGroup, name: string): ActorRef<T> {
    if (this._terminating || this._terminated) {
      throw new Error(`Cannot create actors on a terminated ActorSystem '${this.name}'`);
    }
    return this._systemGroupCell(group).spawn(props, name);
  }

  /**
   * @internal The guardian cell for `groupPath`, creating missing levels.
   *
   * Memoised rather than probe-and-create, because `ActorCell._createChild`
   * throws on a duplicate name and several callers sharing one group is the
   * normal case — the DevTools hub and its three probes, or every sharded
   * type reaching for `cluster/sharding`.  Creation is lazy so that a system
   * which never starts DevTools or clustering pays for no group at all.
   *
   * A cell exists synchronously even though its `create` message is queued,
   * so a group can be spawned into immediately after it is made.
   */
  private _systemGroupCell(groupPath: string): ActorCell<unknown> {
    const cached = this.systemGroupCells.get(groupPath);
    if (cached) return cached;

    let parent = this.systemGuardianCell;
    let walked = '';
    for (const segment of groupPath.split('/')) {
      walked = walked === '' ? segment : `${walked}/${segment}`;
      const existing = this.systemGroupCells.get(walked);
      if (existing) {
        parent = existing;
        continue;
      }
      const policy = systemGroupPolicy(walked);
      const base = Props.create(() => new Guardian(policy.strategy));
      const groupRef = parent.spawn(policy.internal ? base.asInternal() : base, segment);
      const groupCell = (groupRef as LocalActorRef<unknown>).getCell();
      this.systemGroupCells.set(walked, groupCell);
      parent = groupCell;
    }
    return parent;
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

  /**
   * @internal Describe every live actor, root first, parents before
   * children.
   *
   * The whole tree in one pass, for introspection tooling that has no
   * path to start from.  `_resolvePath` answers "what is at this path?";
   * this answers "what is there at all?", which is the question a
   * debugger opens with.  The result is a plain snapshot — no cells
   * escape, so a caller cannot accidentally keep a terminated actor
   * alive.
   */
  _inspectTree(): ReadonlyArray<CellInspection> {
    const out: CellInspection[] = [];
    const visit = (cell: ActorCell<unknown>): void => {
      out.push(cell._inspect());
      cell._eachChildCell(visit);
    };
    visit(this.rootCell);
    return out;
  }

  /**
   * @internal Install (or clear, with `null`) the profiling hook.
   *
   * Replaces any existing observer: two profilers running at once would
   * each see half a picture, so the last caller wins and is expected to
   * put back what it found.
   */
  _setDispatchObserver(observer: DispatchObserver | null): void {
    this._dispatchObserver = observer;
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
    for (const resolve of resolvers) resolve();
  }
}

/* ----------------------------- Config helpers ----------------------------- */

function buildConfig(options: ActorSystemOptionsType): Config {
  const userLayer =
    options.config === undefined
      ? Config.empty()
      : options.config instanceof Config
        ? options.config
        : Config.fromObject(options.config);
  return Config.load({
    appConfPath: options.configFile,
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
      const throughput = config.hasPath(ConfigKeys.dispatcher.throughput)
        ? config.getInt(ConfigKeys.dispatcher.throughput)
        : 16;
      return new ThroughputDispatcher(throughput) as Dispatcher;
    })
    .otherwise(() => new ImmediateDispatcher() as Dispatcher);
}
