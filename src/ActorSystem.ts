import { match } from 'ts-pattern';
import { ActorRef } from './ActorRef.js';
import { ActorSelection, parseSelectionPath } from './ActorSelection.js';
import { DEFAULT_DISPATCHER_THROUGHPUT } from './Constants.js';
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
import { ConsoleLogger, Logger } from './Logger.js';
import { buildLoggerFromConfig, readLoggerLevelFromConfig } from './logging/LoggerFromConfig.js';
import { MultiSinkLogger } from './logging/MultiSinkLogger.js';
import { DEFAULT_SINK_CLOSE_TIMEOUT_MS } from './logging/MultiSinkLoggerOptions.js';
import type { ActorClassOrFactory } from './Actor.js';
import type { ActorOptions } from './ActorOptions.js';
import { Scheduler } from './Scheduler.js';
import type { ActorSystemOptions, ActorSystemOptionsType } from './ActorSystemOptions.js';
import { ActorCell } from './internal/ActorCell.js';
import type { CellInspection, DispatchObserver } from './internal/Instrumentation.js';
import { DeadLetterRef } from './internal/DeadLetterRef.js';
import {
  GUARDIAN_SHUTDOWN_ORDER,
  Guardian,
  SYSTEM_GUARDIAN_NAME,
  USER_GUARDIAN_NAME,
  systemGuardianStrategy,
  userGuardianStrategy,
} from './internal/Guardian.js';
import { LocalActorRef } from './internal/LocalActorRef.js';
import { systemGroupPolicy, type SystemGroup } from './internal/SystemPaths.js';
import type { Cluster } from './cluster/Cluster.js';
import { ClusterExtensionId } from './cluster/ClusterExtension.js';
import { PersistenceExtensionId } from './persistence/PersistenceExtension.js';
import type { HttpServerBackend } from './http/backend/HttpServerBackend.js';
import { HttpExtensionId, type ServerBuilder } from './http/HttpExtension.js';
import type { Behavior } from './typed/Behavior.js';
import { typedActor } from './typed/spawn.js';

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
  /** How long `terminate()` waits for the logger to flush and close. */
  private readonly loggerCloseTimeoutMs: number;
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

  private constructor(name: string | undefined, options: ActorSystemOptionsType) {
    this.startedAtMs = Date.now();
    // Config first: the name may come out of it, and nothing in the build
    // depends on the name.
    this.config = buildConfig(options);
    this.name = name ?? systemNameFromConfig(this.config);
    this.dispatcher = options.dispatcher ?? dispatcherFromConfig(this.config);
    this.scheduler = options.scheduler ?? new Scheduler();
    this.eventStream = new EventStream();
    this.loggerCloseTimeoutMs = loggerCloseTimeoutFromConfig(this.config);
    this.log = resolveLogger(options, this.config, this.loggerCloseTimeoutMs);
    // Sinks are built before any system exists, so anything system-shaped —
    // the scheduler a batching sink ticks on, the name a remote sink sends
    // as its service identity — has to reach them here.  Structural, so a
    // third-party logger that grew an `attach` benefits too.
    attachLogger(this.log, { scheduler: this.scheduler, systemName: this.name });
    // Wire the system logger into the bus so a throwing subscriber
    // predicate (#85) gets surfaced rather than silently dropped.
    this.eventStream.log = this.log;
    this.deadLetters = new DeadLetterRef(this.name, this.eventStream);
    this.extensions = new Extensions(this);

    // Construct the supervisor chain: /  ->  /user, /system.
    this.rootCell = new ActorCell<unknown>(
      this,
      { factory: () => new Guardian() },
      null,
      '',
    );

    const userRef = this.rootCell.spawn(
      () => new Guardian(userGuardianStrategy),
      USER_GUARDIAN_NAME,
    );
    this.userGuardianCell = (userRef as LocalActorRef<unknown>).getCell();

    const systemRef = this.rootCell.spawn(
      () => new Guardian(systemGuardianStrategy),
      SYSTEM_GUARDIAN_NAME,
    );
    this.systemGuardianCell = (systemRef as LocalActorRef<unknown>).getCell();

    // The root stops its two children in sequence, not together — see
    // GUARDIAN_SHUTDOWN_ORDER for why `/user` has to drain first.
    this.rootCell._terminationOrder = GUARDIAN_SHUTDOWN_ORDER;

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

  /**
   * Create a new actor system.  Omitting `name` falls back to
   * `actor-ts.system.name` and, failing that, to `"default"` — so a
   * deployment can name its system from config without a rebuild.
   */
  static create(
    name?: string,
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
   * The `Cluster` this system joined, or `None` if it never did (#833).
   *
   * Filled in by `Cluster.join`, so a local-only system stays local — the
   * getter never starts a cluster.  Inside an actor prefer
   * `this.context.cluster` (same `Option`) or `this.cluster` (unwrapped,
   * for code that already knows it is clustered).
   *
   * The `Cluster` type is imported type-only and the value import is just
   * the extension id, which is why core can hand out a cluster without
   * depending on the cluster layer at runtime — the same split
   * `EntityContext` uses.
   */
  get cluster(): Option<Cluster> {
    return this.extensions.get(ClusterExtensionId).get();
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
   *
   *     system.spawn(Greeter, 'greeter');                  // zero-arg class
   *     system.spawn(() => new Worker(database), 'worker'); // dependencies
   */
  spawn<T>(actor: ActorClassOrFactory<T>, name: string, options?: ActorOptions<T>): ActorRef<T> {
    if (this._terminating || this._terminated) {
      throw new Error(`Cannot create actors on a terminated ActorSystem '${this.name}'`);
    }
    return this.userGuardianCell.spawn(actor, name, options);
  }

  /**
   * Spawn a top-level user actor under /user with an auto-generated
   * name.  Use when the caller doesn't care about the path — e.g.
   * one-shot async work, throwaway helpers.  For a deterministic
   * name, see {@link spawn}.
   */
  spawnAnonymous<T>(actor: ActorClassOrFactory<T>, options?: ActorOptions<T>): ActorRef<T> {
    if (this._terminating || this._terminated) {
      throw new Error(`Cannot create actors on a terminated ActorSystem '${this.name}'`);
    }
    return this.userGuardianCell.spawnAnonymous(actor, options);
  }

  /**
   * Spawn a typed Behavior under `/user` with a deterministic name —
   * the Behavior-DSL counterpart to {@link spawn}.  Wraps the Behavior
   * in `typedActor(behavior)` so callers don't have to thread a factory
   * through the typed API.
   *
   *     const ref = system.spawnTyped(counter(0), 'counter');
   */
  spawnTyped<T>(behavior: Behavior<T>, name: string): ActorRef<T> {
    return this.spawn(typedActor<T>(behavior), name);
  }

  /**
   * Anonymous variant of {@link spawnTyped} — the Behavior-DSL
   * counterpart to {@link spawnAnonymous}.  Pick this when the caller
   * doesn't need a stable path.
   */
  spawnTypedAnonymous<T>(behavior: Behavior<T>): ActorRef<T> {
    return this.spawnAnonymous(typedActor<T>(behavior));
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
  _spawnSystemActor<T>(
    actor: ActorClassOrFactory<T>,
    group: SystemGroup,
    name: string,
    options?: ActorOptions<T>,
  ): ActorRef<T> {
    if (this._terminating || this._terminated) {
      throw new Error(`Cannot create actors on a terminated ActorSystem '${this.name}'`);
    }
    return this._systemGroupCell(group).spawn(actor, name, options);
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
      const groupRef = parent.spawn(
        () => new Guardian(policy.strategy),
        segment,
        policy.internal ? { internal: true } : undefined,
      );
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

  /**
   * Shut down: stops `/user` (children first), then `/system`, and resolves
   * once everything is drained.  The two guardians go in sequence so a user
   * actor's `postStop` can still reach the framework actors it depends on —
   * see `GUARDIAN_SHUTDOWN_ORDER`.
   */
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
    const finish = (): void => { for (const resolve of resolvers) resolve(); };

    // Flush the log sinks before anyone learns the system is down.  This is
    // the only seam that catches both shutdown paths: `CoordinatedShutdown`
    // ends by calling `terminate()`, so a task registered in a phase would
    // miss every program that terminates directly.  It also runs *after*
    // every `postStop`, so a last message from a stopping actor is still in
    // the queue being drained.  Structural, so any logger with a `close()`
    // is flushed — not just the framework's own.
    const closeLogger = closeOf(this.log);
    if (closeLogger === undefined) {
      finish();
      return;
    }
    void withinBudget(closeLogger, this.loggerCloseTimeoutMs).then(finish, finish);
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

/** `actor-ts.system.name`, or the historical `"default"` when unset. */
function systemNameFromConfig(config: Config): string {
  return config.hasPath(ConfigKeys.system.name)
    ? config.getString(ConfigKeys.system.name)
    : 'default';
}

/* ----------------------------- Logger helpers ----------------------------- */

/**
 * Pick the system logger.  Precedence is **atomic**: an explicit `logger`
 * wins outright, then an explicit `logSinks` list, then the sinks enabled
 * in HOCON, then the historical single `ConsoleLogger`.  Code and config
 * never merge into one sink set — a half-configured destination is worse
 * than either whole answer, and merging would mean validating options
 * somewhere other than the constructor that owns them.
 */
function resolveLogger(
  options: ActorSystemOptionsType,
  config: Config,
  closeTimeoutMs: number,
): Logger {
  if (options.logger !== undefined) return options.logger;
  const level = options.logLevel ?? readLoggerLevelFromConfig(config);
  if (options.logSinks !== undefined) {
    return new MultiSinkLogger({ sinks: options.logSinks, level, closeTimeoutMs });
  }
  return buildLoggerFromConfig(config, { level, closeTimeoutMs }) ?? new ConsoleLogger(level);
}

function loggerCloseTimeoutFromConfig(config: Config): number {
  return config.hasPath(ConfigKeys.logger.closeTimeout)
    ? config.getDuration(ConfigKeys.logger.closeTimeout)
    : DEFAULT_SINK_CLOSE_TIMEOUT_MS;
}

/** A logger's `attach`, if it has one — a structural, not nominal, check. */
function attachLogger(log: Logger, context: { scheduler: Scheduler; systemName: string }): void {
  const attach = (log as Partial<MultiSinkLogger>).attach;
  if (typeof attach !== 'function') return;
  try {
    attach.call(log, context);
  } catch (error) {
    // Attaching is a courtesy, not a precondition: a sink that refuses it
    // still logs, just without a scheduler.  Reported the way everything
    // underneath logging reports — the logger itself is the thing at fault.
    console.error('[actor-ts] log sink attach failed:', error);
  }
}

/** A logger's `close`, bound, if it has one. */
function closeOf(log: Logger): (() => Promise<void>) | undefined {
  const close = (log as Partial<MultiSinkLogger>).close;
  return typeof close === 'function' ? () => close.call(log) : undefined;
}

/**
 * Run `operation` with a hard deadline.  A raw `setTimeout` because the
 * scheduler is already shut down by the time this runs, and deliberately
 * not `unref`'d: the loop is empty at that point, and an unreferenced timer
 * in an empty loop is not guaranteed to fire — the timeout that exists to
 * break a hang would hang.  It is cleared in the `finally`.
 */
async function withinBudget(operation: () => Promise<void>, budgetMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(operation()),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          console.error(`[actor-ts] logger close timed out after ${budgetMs} ms; some records may be lost`);
          resolve();
        }, budgetMs);
      }),
    ]);
  } catch (error) {
    console.error('[actor-ts] logger close failed:', error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
        : DEFAULT_DISPATCHER_THROUGHPUT;
      return new ThroughputDispatcher(throughput) as Dispatcher;
    })
    .otherwise(() => new ImmediateDispatcher() as Dispatcher);
}
