import { match } from 'ts-pattern';
import { ActorRef } from './ActorRef.js';
import { ActorSelection, parseSelectionPath } from './ActorSelection.js';
import {
  DEFAULT_ACTOR_THROUGHPUT,
  DEFAULT_DISPATCHER_THROUGHPUT,
  DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
  EVENT_LOOP_KEEPALIVE_INTERVAL_MS,
  QUIESCENCE_POLL_INTERVAL_MS,
  QUIESCENCE_POLL_MAX_INTERVAL_MS,
} from './Constants.js';
import { DEFAULT_ASK_TIMEOUT_MS } from './util/Constants.js';
import { SETTLE_MAX_TURNS } from './Constants.js';
import { DEFAULT_SCATTER_GATHER_TIMEOUT_MS, MINIMUM_ASK_TIMEOUT_FOR_SCATTER_GATHER_MS } from './ScatterGatherOptions.js';
import { OptionsError } from './util/OptionsValidator.js';
import { Config } from './config/Config.js';
import { ConfigKeys } from './config/ConfigKeys.js';
import { CoordinatedShutdownId, Phases } from './CoordinatedShutdown.js';
import type { ProcessSignal } from './util/ProcessSignal.js';
import { none, some, type Option } from './util/Option.js';
import { mergeOptions } from './util/OptionsMerge.js';
import { Extensions, type Extension, type ExtensionId } from './Extension.js';
import {
  Dispatcher,
  DispatcherErrorSink,
  HybridDispatcher,
  ImmediateDispatcher,
  MicrotaskDispatcher,
  ThroughputDispatcher,
} from './Dispatcher.js';
import { EventStream } from './EventStream.js';
import { ConsoleLogger, Logger } from './Logger.js';
import { DispatcherError, SchedulerError } from './SystemMessages.js';
import { buildLoggerFromConfig, readLoggerLevelFromConfig } from './logging/LoggerFromConfig.js';
import { MultiSinkLogger } from './logging/MultiSinkLogger.js';
import { DEFAULT_SINK_CLOSE_TIMEOUT_MS } from './logging/MultiSinkLoggerOptions.js';
import type { ActorClassOrFactory } from './Actor.js';
import type { ActorOptions, DefaultMailboxConfiguration } from './ActorOptions.js';
import { readDefaultMailboxFromConfig } from './ActorOptions.js';
import type { Clock } from './Clock.js';
import { Scheduler, type SchedulerErrorSink } from './Scheduler.js';
import type { ActorSystemOptions, ActorSystemOptionsType } from './ActorSystemOptions.js';
import { ActorCell } from './internal/ActorCell.js';
import type { CellInspection, DispatchObserver } from './internal/Instrumentation.js';
import type { MetricsRegistry } from './metrics/Metrics.js';
import type { Tracer } from './tracing/Tracer.js';
import { DeadLetterRef } from './internal/DeadLetterRef.js';
import { DeadLetterQueue } from './deadletters/DeadLetterQueue.js';
import {
  readDeadLetterQueueOptionsFromConfig,
  type DeadLetterQueueOptionsType,
} from './deadletters/DeadLetterQueueOptions.js';
import { configDumpLines } from './diagnostics/ConfigDump.js';
import {
  DEFAULT_DEBUG_EVENT_STREAM,
  DEFAULT_DEBUG_LIFECYCLE,
  DEFAULT_DEBUG_UNHANDLED,
  DEFAULT_LOG_CONFIG_ON_START,
  DEFAULT_LOG_DEAD_LETTERS,
  DEFAULT_LOG_DEAD_LETTERS_DURING_SHUTDOWN,
  DEFAULT_LOG_DEAD_LETTERS_SUSPEND_DURATION_MS,
  DiagnosticsOptionsValidator,
  readDiagnosticsOptionsFromConfig,
  type DiagnosticsOptionsType,
  type ResolvedDiagnostics,
} from './diagnostics/DiagnosticsOptions.js';
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
import { ParallelismExtension, ParallelismExtensionId } from './parallelism/ParallelismExtension.js';
import type { ParallelismOptionsType } from './parallelism/ParallelismOptions.js';
import { PersistenceExtensionId } from './persistence/PersistenceExtension.js';
import type { HttpServerBackend } from './http/backend/HttpServerBackend.js';
import { DEFAULT_HTTP_BIND_HOST } from './http/Constants.js';
import { HttpExtensionId, type ServerBuilder } from './http/HttpExtension.js';
import type { Behavior } from './typed/Behavior.js';
import { typedActor } from './typed/Spawn.js';

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

  /**
   * What time it is, according to this system.
   *
   * The same object as {@link scheduler}, narrowed to the one method, and the
   * narrowing is the point: a component that only reads the time should take
   * `system.clock` rather than the whole scheduler, so its dependency says
   * what it actually needs and a test can supply a clock without also
   * granting it the power to arm timers.
   *
   * Under a `ManualScheduler` this is virtual time, which is the whole point:
   * a component reading it advances with `advance()` instead of with the wall
   * clock, and a test can say "a minute passed" in a millisecond.
   */
  get clock(): Clock { return this.scheduler; }

  /**
   * @internal This system's scheduler when its time is virtual, `null` when it
   * is the wall clock.
   *
   * A field resolved once at construction rather than a check per use, because
   * the caller is `ActorRef.ask` and the answer cannot change: a system's
   * scheduler is fixed for its lifetime.
   *
   * The narrowing is what keeps the deadline seam free in production. Arming
   * every ask through the scheduler costs ~13% of `ask-throughput`; arming only
   * the ones a test can actually advance past costs nothing, because the branch
   * that reads this is already there.
   */
  readonly _virtualScheduler: Scheduler | null;
  readonly eventStream: EventStream;
  readonly log: Logger;
  /** How long `terminate()` waits for the logger to flush and close. */
  private readonly loggerCloseTimeoutMs: number;
  /**
   * How long `terminate()` lets `/user` finish its queued work before the
   * stop cascade starts.  0 skips the drain — see {@link terminate}.
   */
  private readonly shutdownDrainTimeoutMs: number;
  /**
   * @internal The same budget, for the parallelism extension: a worker's
   * system terminates with the identical `shutdown-drain-timeout`, so that is
   * how long the main thread waits for it before stopping the thread.
   */
  get _shutdownDrainTimeoutMs(): number { return this.shutdownDrainTimeoutMs; }
  /**
   * @internal What `ActorSystemOptions.withParallelism` carried, kept for the
   * extension's factory — the one extension the system constructs itself.
   */
  readonly _explicitParallelismOptions: ParallelismOptionsType | undefined;
  /**
   * The parallelism extension when `actor-ts.parallelism.workers` is above
   * zero, and `null` otherwise — which is what keeps `workers = 0` the code
   * path it always was: `spawn` pays one null check and takes the local path.
   */
  private readonly _parallelism: ParallelismExtension | null;
  /**
   * Work that has to finish *before* the actors are stopped — the parallelism
   * extension terminating the workers' systems, so an offloaded actor gets
   * its `postStop` while the main thread's cluster node is still up to hear
   * back.  Empty on a system that offloads nothing, and then `terminate()` is
   * the code it always was.
   */
  private readonly _terminationPreludes: Array<() => Promise<void>> = [];
  /**
   * @internal Default batch budget for every cell that does not set its own
   * `ActorOptions.throughput` (#409).
   *
   * Resolved here and not in `ActorCell` because a cell reads no config at
   * all — it has never needed to, and giving the framework's most-created
   * object a `Config` lookup per construction to answer one integer would be
   * the expensive way round.  Public-but-`@internal` for the same reason
   * {@link _dispatchObserver} is: the cell is the only reader, and it is not
   * in this file.
   */
  readonly _actorThroughput: number;
  /**
   * @internal Deadline `ActorRef.ask` arms when the caller names no
   * `timeoutMs` — `actor-ts.actor.ask-timeout` (#863).
   *
   * Resolved here rather than at the ask site for the reason above and one
   * more: a ref is not a config reader either, and there are fourteen of them.
   * Reached through `ActorRef._defaultAskTimeoutMs()`, which each ref that
   * can see a system overrides; the ones that cannot — dead letters, `Nobody`,
   * an unresolved path, the reply ref itself — keep the built-in constant, and
   * the reference comment says so rather than implying uniform coverage.
   */
  readonly _defaultAskTimeoutMs: number;
  /**
   * @internal What `actor-ts.mailbox.default.*` says, for every cell that
   * does not name its own mailbox (#862).
   *
   * Resolved here for the same reason `_actorThroughput` above is: a cell
   * reads no config, and this is the framework's most-created object.  Empty
   * unless an operator asked for a bound, so the shipped answer stays the
   * unbounded mailbox #1148 restored.
   */
  readonly _defaultMailbox: DefaultMailboxConfiguration;
  /**
   * @internal The resolved `actor-ts.diagnostics.*` settings, for the sites
   * that emit a gated record (#867).
   *
   * Here for the third time and for the third instance of one reason: a cell
   * reads no config, and neither does the per-message path in
   * `recordUnhandled`.  Every field is decided, so a read site is a plain
   * boolean test — a `?? DEFAULT_…` at the read site would be a second place
   * the default lives, free to disagree with the merge that produced this.
   */
  readonly _diagnostics: ResolvedDiagnostics;
  readonly deadLetters: ActorRef;
  /**
   * Bounded record of the messages this system could not deliver.
   *
   * Always present, and capturing nothing unless `actor-ts.dead-letters.store`
   * says otherwise — so `list()` on a default system answers "nothing kept",
   * which is the truth, rather than throwing or being `undefined`.
   */
  readonly deadLetterQueue: DeadLetterQueue;
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
   * @internal The live metrics registry, or `null` while metrics are off.
   *
   * Owned by `MetricsExtension`, which is the only writer.  A field rather
   * than a `metricsOf(system)` call because the receive path reads it once per
   * message, and `metricsOf` is a `Map.get` plus two calls through the
   * extension chain (#411).
   *
   * **`null` rather than the noop registry**, which is the half that matters:
   * a caller that has to null-check anyway will skip building the label and
   * help objects for a call that would discard them, and those literals were
   * the bulk of what the uninstrumented path allocated per message.  Handing
   * back a noop instead makes the call site look free and quietly is not.
   *
   * Read fresh every message, never cached per cell, because both extensions
   * swap their backing object at runtime with live cells draining — DevTools
   * does it whenever a panel opens or closes.
   */
  _metricsRegistry: MetricsRegistry | null = null;

  /**
   * @internal The installed tracer, or `null` while tracing is off.
   *
   * Owned by `TracingExtension`; same reasoning as {@link _metricsRegistry},
   * except that a reader must fall back to `NOOP_TRACER` rather than skip the
   * work: an envelope can carry a trace context from a remote peer that traces
   * while this node does not, and the noop tracer's span is what keeps that
   * message's explain entry shaped the way it has always been.
   */
  _tracer: Tracer | null = null;

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

  /**
   * The sink this system installed on {@link dispatcher}, kept so
   * termination can tell it apart from one the owner installed.
   */
  private readonly dispatcherErrorSink: DispatcherErrorSink;

  /**
   * The sink this system installed on {@link scheduler}, kept so termination
   * can tell it apart from one the owner installed.
   */
  private readonly schedulerErrorSink: SchedulerErrorSink;

  /**
   * Did this system construct {@link scheduler} itself?
   *
   * Decides whether `terminate()` may shut it down.  A scheduler handed in
   * through `ActorSystemOptions` belongs to whoever handed it over, exactly as
   * the dispatcher does — and unlike the dispatcher it used to be shut down
   * anyway, which is only invisible while one system holds it.  Share a
   * `ManualScheduler` across two systems and the first `terminate()` disarms
   * every handle the second one still owns (#1424).
   */
  private readonly ownsScheduler: boolean;

  private constructor(name: string | undefined, options: ActorSystemOptionsType) {
    this.startedAtMs = Date.now();
    // Config first: the name may come out of it, and nothing in the build
    // depends on the name.
    this.config = buildConfig(options);
    this.name = name ?? systemNameFromConfig(this.config);
    this.dispatcher = options.dispatcher ?? dispatcherFromConfig(this.config);
    // Whether this system built its own scheduler, which is the same question
    // as "may this system shut it down" — see `_rootTerminated`.
    this.ownsScheduler = options.scheduler === undefined;
    this.scheduler = options.scheduler ?? new Scheduler();
    this._virtualScheduler = this.scheduler.isVirtual ? this.scheduler : null;
    this.eventStream = new EventStream();
    this.loggerCloseTimeoutMs = loggerCloseTimeoutFromConfig(this.config);
    this.shutdownDrainTimeoutMs = shutdownDrainTimeoutFromConfig(this.config);
    this._actorThroughput = actorThroughputFromConfig(this.config);
    // Throws on a value no ask could arm, and does so here rather than at the
    // first ask: the mistake is in the config file, so the failure belongs at
    // the moment the config file is read (#863).
    this._defaultAskTimeoutMs = askTimeoutFromConfig(this.config);
    // Before the guardian cells are built below: the first cell constructed
    // reads this, so a later assignment would leave the root and the two
    // guardians looking at `undefined`.
    this._defaultMailbox = readDefaultMailboxFromConfig(this.config);
    this.log = resolveLogger(options, this.config, this.loggerCloseTimeoutMs);
    // Sinks are built before any system exists, so anything system-shaped —
    // the scheduler a batching sink ticks on, the name a remote sink sends
    // as its service identity — has to reach them here.  Structural, so a
    // third-party logger that grew an `attach` benefits too.
    attachLogger(this.log, { scheduler: this.scheduler, systemName: this.name });
    // Needs a logger, so it cannot ride along with the read above.
    warnIfAskTimeoutUndercutsScatterGather(this.log, this._defaultAskTimeoutMs);
    // Wire the system logger into the bus so a throwing subscriber
    // predicate (#85) gets surfaced rather than silently dropped.
    this.eventStream.log = this.log;
    // Same idea one layer down: a work unit that threw used to reach only
    // `console.error`, which no sink, no MDC and no test can see (#410).
    // `??=` and not `=`: `ActorSystemOptions.withDispatcher` hands in an
    // instance the caller owns, and a sink they set on it is a decision,
    // not a slot to claim.  It also settles the shared-dispatcher case in
    // the only stable direction — first system wins, rather than whichever
    // system happened to be constructed last.
    this.dispatcherErrorSink = (error, dispatcherId) =>
      this._reportDispatcherError(error, dispatcherId, null);
    this.dispatcher.onError ??= this.dispatcherErrorSink;
    // And the same again for the scheduler, which had the identical hole:
    // a throwing `scheduleOnceFunction` task reached only `console.error`
    // (#678).  `??=` for the same lent-instance reason — `withScheduler` is
    // documented as "typically a ManualScheduler in tests", so the instance
    // is even more often the caller's than the dispatcher is.
    this.schedulerErrorSink = (error) => this._reportSchedulerError(error);
    this.scheduler.onError ??= this.schedulerErrorSink;
    // Diagnostics are resolved before the ref that reads them, and the
    // built-in layer is a real one here rather than the empty layer the
    // queue merge below uses: there is no `Diagnostics` object downstream
    // to apply defaults of its own, so this merge is where every published
    // default in the block actually takes effect.
    const diagnostics = mergeOptions<ResolvedDiagnostics>(
      {
        logDeadLetters: DEFAULT_LOG_DEAD_LETTERS,
        logDeadLettersDuringShutdown: DEFAULT_LOG_DEAD_LETTERS_DURING_SHUTDOWN,
        logDeadLettersSuspendDurationMs: DEFAULT_LOG_DEAD_LETTERS_SUSPEND_DURATION_MS,
        logConfigOnStart: DEFAULT_LOG_CONFIG_ON_START,
        debugUnhandled: DEFAULT_DEBUG_UNHANDLED,
        debugLifecycle: DEFAULT_DEBUG_LIFECYCLE,
        debugEventStream: DEFAULT_DEBUG_EVENT_STREAM,
      },
      readDiagnosticsOptionsFromConfig(this.config),
      { ...(options.diagnostics as Partial<DiagnosticsOptionsType> | undefined) },
    );
    new DiagnosticsOptionsValidator().validate(diagnostics);
    // Before the guardian cells are built below, for the same reason
    // `_defaultMailbox` is: the first cell constructed reads this, so a later
    // assignment would leave the root and the two guardians looking at
    // `undefined`.
    this._diagnostics = diagnostics;
    this.eventStream.traceSubscriptions = diagnostics.debugEventStream;
    // After `attachLogger` above, so the dump reaches the configured sinks
    // rather than only whatever the logger writes to before it is wired; and
    // before the guardians, so a system that fails to finish starting has
    // still said what it was configured with — which is when the answer is
    // wanted most.  Once by construction: there is one constructor.
    if (diagnostics.logConfigOnStart) this.log.info(configDumpLines(this.config));
    const deadLetterRef = new DeadLetterRef(this.name, this.eventStream, {
      log: this.log,
      logDeadLetters: diagnostics.logDeadLetters,
      logDeadLettersDuringShutdown: diagnostics.logDeadLettersDuringShutdown,
      logDeadLettersSuspendDurationMs: diagnostics.logDeadLettersSuspendDurationMs,
      // A predicate, not `this`: the ref is built before the guardians and
      // must not hold the half-constructed system for the sake of one
      // boolean.  An arrow keeps the binding without a `bind` call.
      isTerminating: () => this._terminating,
    });
    this.deadLetters = deadLetterRef;
    this.extensions = new Extensions(this);
    // Built here, before the guardians exist, because the first dead letter
    // can be produced by the very first `spawn` — a queue installed later
    // would be missing exactly the letters an early failure produced.
    //
    // The built-in-defaults layer is empty on purpose: `DeadLetterQueue`'s
    // constructor applies them itself, because a queue someone builds
    // directly has to get them too.  So all this merge has to settle is
    // explicit-over-HOCON, field by field — `withDeadLetters` naming one
    // knob must not blank the rest of the config block out.
    this.deadLetterQueue = new DeadLetterQueue(
      this,
      mergeOptions<DeadLetterQueueOptionsType>(
        {},
        readDeadLetterQueueOptionsFromConfig(this.config),
        { ...(options.deadLetters as Partial<DeadLetterQueueOptionsType> | undefined) },
      ),
    );
    if (this.deadLetterQueue.store !== 'off') {
      deadLetterRef._setSink((deadLetter) => this.deadLetterQueue._capture(deadLetter));
    }

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

    // Only when the operator asked for a queue.  Off — the default — this
    // would construct `CoordinatedShutdown` for every system in the process
    // to register a task with nothing to do.
    if (this.deadLetterQueue.store !== 'off') {
      this.extensions.get(CoordinatedShutdownId).addFrameworkTask(
        Phases.BeforeActorSystemTerminate,
        'flush-dead-letter-queue',
        () => this.deadLetterQueue.flush(),
      );
    }

    // Last, because a mesh start spawns under `/system` and the extension's
    // constructor validates `actor-ts.parallelism.*` whether or not it is
    // enabled — a bad `offload` pattern is a config mistake and fails here,
    // where every other config mistake fails.  Off, the extension is
    // constructed and never started; the instance is registered so
    // `system.extension(ParallelismExtensionId)` answers either way.
    this._explicitParallelismOptions = options.parallelism as ParallelismOptionsType | undefined;
    const parallelism = new ParallelismExtension(this, this._explicitParallelismOptions);
    this.extensions.put(ParallelismExtensionId, parallelism);
    this._parallelism = parallelism.enabled ? parallelism : null;
    parallelism._start();
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
   *           .newServerAt(host ?? '127.0.0.1', port)
   *           .useBackend(backend ?? new FastifyBackend())
   *
   * **The default host is loopback, and that is a change** (#1408).  It used
   * to be the IPv4 wildcard, which made the shortest and most-copied form of
   * this call the one that published the server on every interface — a
   * decision nothing at the call site recorded and most callers never made.
   * A server that should be reachable from outside the host now says so, by
   * passing the interface it means through `options.host`.
   *
   * The wildcard is deliberately not spelled out here: this comment is a
   * copy-paste surface, and `tests/unit/ci/ExampleBindAddresses.test.ts`
   * flags one baked into a snippet for exactly that reason (#756).
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
    const builder = this.extensions.get(HttpExtensionId)
      .newServerAt(options.host ?? DEFAULT_HTTP_BIND_HOST, port);
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
    if (this._parallelism !== null) {
      const placed = this._parallelism._place(actor, name, options, 'caller');
      if (placed !== null) return placed;
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
    if (this._parallelism !== null) {
      // The name is minted here so the ref's path is settled before the
      // worker has heard of it; a placement that stays local reuses it.
      const name = this.userGuardianCell._nextAnonymousName();
      const placed = this._parallelism._place(actor, name, options, 'generated');
      if (placed !== null) return placed;
      return this.userGuardianCell._spawnWithGeneratedName(actor, name, options);
    }
    return this.userGuardianCell.spawnAnonymous(actor, options);
  }

  /**
   * @internal Spawn under `/user` with a name the framework generated —
   * on another node, for an anonymous actor the parallelism extension placed
   * here.  The reserved `$` prefix is what `spawn` refuses from a caller.
   */
  _spawnWithGeneratedName<T>(actor: ActorClassOrFactory<T>, name: string, options?: ActorOptions<T>): ActorRef<T> {
    if (this._terminating || this._terminated) {
      throw new Error(`Cannot create actors on a terminated ActorSystem '${this.name}'`);
    }
    return this.userGuardianCell._spawnWithGeneratedName(actor, name, options);
  }

  /** @internal Register work `terminate()` runs before the actors are stopped. */
  _beforeTerminate(prelude: () => Promise<void>): void {
    this._terminationPreludes.push(prelude);
  }

  /** @internal Whether `terminate()` has been called. */
  _isTerminating(): boolean { return this._terminating || this._terminated; }

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

  /**
   * Stop an actor once it has worked through its mailbox — fire and forget.
   *
   * The same graceful stop `ActorRef.stop()` performs, and like it this
   * returns nothing: the JSDoc promised a promise for a signature that never
   * had one (#663).  Await the stop with `gracefulStop(ref, timeoutMs)`.
   */
  stop(ref: ActorRef): void {
    ref.stop();
  }

  /**
   * Shut down: drains `/user`, stops it (children first), then `/system`, and
   * resolves once everything is torn down.  The two guardians go in sequence
   * so a user actor's `postStop` can still reach the framework actors it
   * depends on — see `GUARDIAN_SHUTDOWN_ORDER`.
   *
   * The drain in front is what makes `ref.tell(x); await system.terminate()`
   * deliver `x` (#663).  It has to be here rather than inside the cascade
   * because a `terminate` is a *system* command: `ActorCell.run()` re-checks
   * its system queue after every `await`, so a terminate that lands in a
   * running turn's await window is picked up before the user message queued
   * behind it — and the cell that has flipped to `terminating` no longer
   * dequeues user messages at all, so the rest went to dead letters.  Waiting
   * for quiescence *before* the first `terminate` is enqueued is the only
   * ordering that does not fight that, and it leaves the teardown itself
   * exactly as it was.
   *
   * Bounded by `actor-ts.system.shutdown-drain-timeout`; set it to 0 to skip
   * the drain entirely.  See {@link awaitQuiescence} for what "quiet" means
   * and which mailboxes are deliberately not waited on.
   */
  terminate(): Promise<void> {
    if (this._terminated) return Promise.resolve();
    if (this._terminating) return this.whenTerminated();
    this._terminating = true;
    const terminated = this.whenTerminated();
    const startTeardown = (): void => { this.rootCell.enqueueSystem({ kind: 'terminate' }); };
    if (this.shutdownDrainTimeoutMs <= 0) {
      if (this._terminationPreludes.length === 0) {
        startTeardown();
      } else {
        void this.runTerminationPreludes().then(startTeardown, startTeardown);
      }
      return terminated;
    }
    // Not awaited: `terminate()` stays synchronous up to its first suspension
    // point so `_terminating` is set before any caller can re-enter, and the
    // promise it hands back is `whenTerminated()` either way.
    //
    // Same handler on both settlements on purpose.  Nothing in the drain is
    // supposed to throw, and if something ever does, the failure mode must not
    // be a system that never tears down and a `terminate()` that never
    // settles — the drain is an optimisation over the teardown, not a
    // precondition for it.  The preludes come after the drain and before the
    // stop cascade: the drain lets in-flight replies land, the preludes take
    // down what lives outside this tree, and only then do the actors stop.
    const runPreludes = (): Promise<void> => this.runTerminationPreludes();
    void this.awaitQuiescence(this.shutdownDrainTimeoutMs)
      .then(runPreludes, runPreludes)
      .then(startTeardown, startTeardown);
    return terminated;
  }

  /** Every prelude, together; one that throws is logged and does not hold the others up. */
  private async runTerminationPreludes(): Promise<void> {
    const preludes = this._terminationPreludes.splice(0);
    await Promise.all(preludes.map((prelude) =>
      prelude().catch((error: unknown) => {
        this.log.error('a termination prelude failed; shutting the actors down regardless', error);
      }),
    ));
  }

  /**
   * Wait until nothing under `/user` has work left it can dispatch, or until
   * `timeoutMs` elapses.  Resolves `true` if the tree went quiet, `false` if
   * the budget ran out first.
   *
   * "Quiet" is per cell: no turn in flight and no dispatchable message queued.
   * Because a cell is marked busy at `tell` time — synchronously, by the
   * sender's turn — a reply that has been sent but not yet run already counts,
   * which is what carries the wait across a ping-pong, a router fan-out or a
   * supervision restart instead of flushing one mailbox once.
   *
   * Two kinds of mailbox are deliberately *not* waited on, because neither
   * drains at a rate a shutdown could wait for: one parked by
   * `context.throttle(...)`, and one suspended while its actor's supervisor
   * decides. Both are treated as quiet, and whatever is still queued in them
   * is dead-lettered by the ordinary teardown.
   *
   * Only `/user` is inspected.  Framework actors under `/system` — cluster
   * heartbeats, failure detectors, broker reconnect loops — are never quiet by
   * design, so including them would spend the whole budget on every shutdown.
   *
   * Work that is not in a mailbox yet is not waited for either: a scheduled
   * tick, or a `tell` from a promise the handler did not await, can still
   * arrive after this resolves.
   */
  async awaitQuiescence(
    timeoutMs: number = this.shutdownDrainTimeoutMs,
  ): Promise<boolean> {
    if (this._terminated) return true;
    // Probed once before any sleep, so an already-idle system pays nothing at
    // all — which matters because every `terminate()` goes through here.  It
    // is safe to look this early precisely because a cell is marked busy
    // synchronously by the sender: `ref.tell(x)` has already scheduled the
    // receiving cell by the time this runs, so the message queued a line
    // earlier cannot read as quiet.
    if (this.isUserTreeQuiescent()) return true;
    const deadline = Date.now() + timeoutMs;
    let intervalMs = QUIESCENCE_POLL_INTERVAL_MS;
    while (Date.now() < deadline) {
      await sleep(intervalMs);
      if (this.isUserTreeQuiescent()) return true;
      intervalMs = Math.min(intervalMs * 2, QUIESCENCE_POLL_MAX_INTERVAL_MS);
    }
    return this.isUserTreeQuiescent();
  }

  /**
   * @internal Let every actor turn that is already armed run, and every turn
   * those arm, until the `/user` tree is quiet.
   *
   * **The primitive the TestKit's `advance` needed and did not have.**
   * `ManualScheduler.advance` fires a timer *synchronously*, but the `tell` the
   * timer performs is delivered by the dispatcher on a later turn — so
   * `scheduler.advance(100); expect(probe.received).toHaveLength(1)` reads an
   * empty probe, and the two flagship determinism samples in the documentation
   * did not work as written (#1025).  Virtual time makes *when* a timer fires
   * deterministic; it says nothing about when its effects have landed.
   *
   * Distinct from {@link awaitQuiescence}, which this deliberately does not
   * reuse. That one is a **drain with a deadline**: it backs off from 1 ms to
   * 25 ms because it runs on every `terminate()` and may be waiting on a real
   * system doing real work. This one is a **settle with a turn budget**: it
   * never sleeps, because there is nothing to wait *for* — the work is already
   * armed and only needs the event loop to reach it. Sleeping here would put a
   * fixed delay into the one place the test suite is trying to remove them
   * from.
   *
   * The yield is a macrotask, not a microtask, and that is load-bearing: the
   * default dispatcher spends a microtask budget before yielding, so a
   * microtask-only loop can spin against it forever without the runner's own
   * timeout ever firing (#1360).
   *
   * Only `/user` is inspected, for the reason {@link awaitQuiescence} gives:
   * the framework actors under `/system` are never quiet by design.
   *
   * @returns whether the tree actually became quiet. A `false` means the budget
   *   ran out, which is a finding rather than a timing accident.
   */
  async _settle(maxTurns: number = SETTLE_MAX_TURNS): Promise<boolean> {
    if (this._terminated) return true;
    for (let turn = 0; turn < maxTurns; turn++) {
      // Probed before the first yield, so an already-quiet system pays nothing.
      if (this.isUserTreeQuiescent()) return true;
      await sleep(0);
    }
    return this.isUserTreeQuiescent();
  }

  /** Is every cell under `/user` — the guardian included — out of work? */
  private isUserTreeQuiescent(): boolean {
    const busy = (cell: ActorCell<unknown>): boolean => {
      if (!cell._isQuiescent()) return true;
      let childBusy = false;
      cell._eachChildCell((child) => { childBusy ||= busy(child); });
      return childBusy;
    };
    return !busy(this.userGuardianCell);
  }

  /** Promise that resolves when the system has finished shutting down. */
  whenTerminated(): Promise<void> {
    if (this._terminated) return Promise.resolve();
    return new Promise((resolve) => {
      this._terminationResolvers.push(resolve);
    });
  }

  get isTerminated(): boolean { return this._terminated; }

  /**
   * Run until the process is asked to stop, then shut down gracefully —
   * the whole of a service's `main` after the actors are wired:
   *
   * ```ts
   * const system = ActorSystem.create('orders');
   * await system.http.bind(routes);
   * await system.runUntilTerminated();
   * ```
   *
   * Installs SIGTERM/SIGINT handlers that start
   * {@link CoordinatedShutdown}, resolves once the system is fully down,
   * and detaches the handlers on the way out.  That last step is why this
   * exists as a method rather than a documented three-liner: the handlers
   * have to come off in a `finally`, or a Deno program that shuts down for
   * any *other* reason — a `terminate()` from inside, an operator command —
   * never exits, because a `Deno.addSignalListener` listener holds the event
   * loop open and has no `unref`.
   *
   * What replaces the hand-rolled `process.on('SIGTERM', () => { … })` is
   * not just the signal plumbing but the **ordering**.  A handler that
   * calls `terminate()` stops the actors first and only then, if ever,
   * releases the port and leaves the cluster; the pipeline unbinds in
   * `service-unbind`, closes brokers in `service-stop` and leaves the
   * cluster in `cluster-leave`, all before `actor-system-terminate` — so a
   * rolling deploy takes the node out of rotation while its actors can
   * still finish what they are holding.
   *
   * Resolves when the pipeline is finished, not merely when the system is
   * down: a task registered alongside the built-in terminator in the final
   * phase runs in parallel with it, and returning while one of those is
   * still going would hand back a "shutdown complete" that is not.
   *
   * **The process stays alive for as long as this promise is pending**, and
   * that is a guarantee this method makes rather than one it inherits.  A
   * signal handler is not a reason for a runtime to keep running: Node's
   * signal handles are unref'd, so a system with nothing else on the event
   * loop — no bound port, no open socket, every timer unref'd — used to
   * drain its loop the moment it started waiting and exit instead of ever
   * receiving the SIGTERM it had just armed itself for.  Bun refs its
   * handles and Deno's `Deno.addSignalListener` cannot be unref'd at all, so
   * the same program waited correctly on two runtimes out of three (#549).
   * A keep-alive timer, released in the same `finally` as the handlers,
   * makes the three agree.
   *
   * @param signals Which signals to listen for.  Defaults to SIGTERM and
   *   SIGINT.  One the runtime cannot deliver is skipped — Windows has no
   *   SIGTERM under any runtime — so this never fails to start over a
   *   platform difference.  Note that skipping them *all* does not turn this
   *   into a no-op: the promise still waits, and the process still stays
   *   alive, until something shuts the system down from inside.
   *
   *   Naming any signal here is an explicit request and always installs.
   *   Leaving it unset takes the default from
   *   `actor-ts.coordinated-shutdown.run-by-process-signals`, which a host
   *   process that owns SIGTERM itself can turn off — the wait and the
   *   keep-alive are unaffected, only the handlers go.
   */
  async runUntilTerminated(
    signals?: ReadonlyArray<ProcessSignal>,
  ): Promise<void> {
    const coordinatedShutdown = this.extension(CoordinatedShutdownId);
    // `signals !== undefined` is an explicit request and outranks the config
    // key, which only decides the default.  Gating inside
    // `installProcessHooks` would invert that: the key ships as a leaf, so
    // reference.conf always answers it and HOCON would beat the caller.
    if (signals !== undefined || coordinatedShutdown.runByProcessSignals) {
      coordinatedShutdown.installProcessHooks(signals);
    }
    const releaseEventLoop = holdEventLoopOpen();
    try {
      await this.whenTerminated();
      // Only when one is already in flight: `run()` on an idle pipeline
      // would *start* it, which would be a second shutdown of a system that
      // has just finished its first.
      if (coordinatedShutdown.isRunning) await coordinatedShutdown.run();
    } finally {
      coordinatedShutdown.removeProcessHooks();
      releaseEventLoop();
    }
  }

  /**
   * @internal Surface a work unit that threw on a dispatcher — through the
   * system logger, and on the {@link EventStream} as a
   * {@link DispatcherError}.
   *
   * Called from two places, and the difference is `actor`.  `ActorCell`
   * catches its own turn and passes `self`, which is what makes the report
   * attributable and covers per-actor and third-party dispatchers the
   * system never sees.  The sink installed on `this.dispatcher` passes
   * `null`, for work handed straight to `dispatcher.execute` by something
   * that is not a cell.
   *
   * **Why this does not need a rate limit.**  Publishing tells the
   * subscribers, and a `tell` schedules on the very dispatcher that just
   * failed — so the shape of a feedback loop is there.  It cannot close,
   * though: a throw out of `onReceive` goes to supervision and never
   * reaches this path, so a subscriber would have to fail in its cell
   * *machinery* to produce a second report, which is a second bug of the
   * same rare class rather than a consequence of the first.  With no
   * subscriber at all — the common case — reports and failures are one for
   * one, exactly as the `console.error` this replaced.
   *
   * The guard is for the loop that *can* close: this method runs inside
   * the dispatcher's own catch, so a logger or a subscriber that throws
   * here would be reported as a dispatcher error, from inside the report
   * of one.  Catching it ends that in one hop and still prints both
   * failures — the original one is the one nobody else is holding.
   */
  _reportDispatcherError(error: unknown, dispatcherId: string, actor: ActorRef | null): void {
    const cause = error instanceof Error ? error : new Error(String(error));
    try {
      const scope = actor === null ? '' : ` while running ${actor.path}`;
      this.log.error(`Unhandled dispatcher error on '${dispatcherId}'${scope}`, cause);
      this.eventStream.publish(new DispatcherError(dispatcherId, cause, actor));
    } catch (reportFailure) {
      console.error('[actor-ts] unhandled dispatcher error:', cause);
      console.error('[actor-ts] reporting that dispatcher error failed:', reportFailure);
    }
  }

  /**
   * @internal Surface a scheduled task that threw — through the system
   * logger, and on the {@link EventStream} as a {@link SchedulerError}.
   *
   * The scheduler twin of {@link _reportDispatcherError}, with one channel
   * fewer: there is no `actor` to attribute a bare closure to, and no
   * scheduler id to name because a system has exactly one.
   *
   * **Why this does not need a rate limit, and why it does not feed back into
   * the logger.**  The logging subsystem's own flush ticker is armed through
   * `scheduleAtFixedRateFunction` (`BatchingSink`), so the framework's log
   * flush ticks on the very scheduler whose failures now go to the log — the
   * shape `logging/SinkReporter.ts` warns about.  It does not close, for two
   * independent reasons.  The ticker body is a length check that `void`s an
   * async `flush()`, so a *delivery* failure is not a throw on this path at
   * all; `BatchingSink` reports those through its own `SinkReporter`, which
   * writes to the console deliberately and rate-limits itself.  And a ticker
   * body that did throw would produce one report per tick — one for one with
   * the failures, exactly as the `console.error` this replaces, not an
   * amplification.  The `catch` is for the loop that *can* close: this runs
   * inside the scheduler's own guard, so a logger or a subscriber that throws
   * here would otherwise be reported as a scheduler error from inside the
   * report of one.  Catching ends that in one hop and still prints both.
   */
  _reportSchedulerError(error: unknown): void {
    const cause = error instanceof Error ? error : new Error(String(error));
    try {
      this.log.error('Unhandled scheduler error', cause);
      this.eventStream.publish(new SchedulerError(cause));
    } catch (reportFailure) {
      console.error('[actor-ts] unhandled scheduler error:', cause);
      console.error('[actor-ts] reporting that scheduler error failed:', reportFailure);
    }
  }

  /** @internal — called by the root cell once it has finished terminating. */
  _rootTerminated(_cell: ActorCell<any>): void {
    this._terminated = true;
    // Only a scheduler this system built.  One passed in belongs to the caller,
    // the same rule the dispatcher below has always followed — and the reason
    // it matters is that a shared one is still in use: the second of two
    // systems on one `ManualScheduler` would find every handle disarmed by the
    // first one's teardown (#1424).
    if (this.ownsScheduler) this.scheduler.shutdown();
    // Stop reporting into a logger that is about to be closed.  Only our
    // own sink is removed: a dispatcher passed in through
    // `ActorSystemOptions` outlives this system, and one the owner wired
    // themselves is theirs to keep.
    if (this.dispatcher.onError === this.dispatcherErrorSink) this.dispatcher.onError = undefined;
    // Same for the scheduler, and for a borrowed one this is the whole of the
    // cleanup: it stays armed and advancing for whoever still holds it, so its
    // ticks must not report into a logger that is about to be closed.
    if (this.scheduler.onError === this.schedulerErrorSink) this.scheduler.onError = undefined;
    const resolvers = this._terminationResolvers;
    this._terminationResolvers = [];
    const finish = (): void => { for (const resolve of resolvers) resolve(); };

    // Settle the dead-letter queue's writes, then flush the log sinks,
    // before anyone learns the system is down.  This is the only seam that
    // catches both shutdown paths: `CoordinatedShutdown` ends by calling
    // `terminate()`, so a task registered in a phase would miss every
    // program that terminates directly.  It also runs *after* every
    // `postStop`, so a last message from a stopping actor is still in the
    // queue being drained.  Structural, so any logger with a `close()` is
    // flushed — not just the framework's own.
    //
    // Ordering matters for the queue and not only for tidiness: the bulk of
    // a shutdown's dead letters — stashes discarded, mailboxes emptied past
    // their cell — are produced by this very teardown, which is *after* the
    // last shutdown phase ran.  The phase task settles what a running system
    // produced; this settles what stopping it produced.  Both are needed.
    // The queue goes first so a failure it reports still reaches a sink.
    //
    // The queue borrows the logger's close budget rather than owning one.
    // Both answer the same question — how long may a flush hold the
    // shutdown open — and inventing a second knob for the second flush
    // would ask an operator to tune a number they have no separate
    // information about.
    const closeLogger = closeOf(this.log);
    const closeSinks = (): Promise<void> => closeLogger === undefined
      ? Promise.resolve()
      : withinBudget(closeLogger, this.loggerCloseTimeoutMs, 'logger close');

    if (this.deadLetterQueue.store === 'off') {
      // The overwhelmingly common path, and deliberately kept free of the
      // extra timer `withinBudget` would arm for a flush with nothing to do.
      if (closeLogger === undefined) { finish(); return; }
      void closeSinks().then(finish, finish);
      return;
    }
    void withinBudget(
      () => this.deadLetterQueue.flush(),
      this.loggerCloseTimeoutMs,
      'dead-letter flush',
    )
      .then(() => {
        // After the flush, so a letter produced by the teardown itself is
        // still captured; before the sinks close, so nothing starts a write
        // nobody will await.
        this.deadLetterQueue._close();
        return closeSinks();
      })
      .then(finish, finish);
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

/** `actor-ts.system.shutdown-drain-timeout` — the `terminate()` drain budget. */
function shutdownDrainTimeoutFromConfig(config: Config): number {
  return config.hasPath(ConfigKeys.system.shutdownDrainTimeout)
    ? config.getDuration(ConfigKeys.system.shutdownDrainTimeout)
    : DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS;
}

/**
 * Gap between two quiescence probes.
 *
 * A bare `setTimeout` rather than the system {@link Scheduler}: this runs on
 * the shutdown path, where the scheduler is about to be — and on a second
 * `terminate()` already has been — shut down, and a drain that silently
 * stopped ticking would hand back "quiet" for a system that is merely
 * unscheduled.  Referenced, not `unref`'d, for the same reason `withinBudget`
 * below is: the wait exists to be waited out, and an unreferenced timer in an
 * otherwise empty loop is not guaranteed to fire at all.
 */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Keep the process running until the returned release is called.
 *
 * The one thing every runtime agrees on is that a referenced timer holds the
 * event loop open; almost nothing else about idle-process lifetime is
 * portable.  Signal handlers in particular are not: Node unrefs its signal
 * handles, so `process.on('SIGTERM', …)` buys a Node process no lifetime at
 * all, while Bun refs its and Deno offers no way to unref a
 * `Deno.addSignalListener` listener even if you wanted one.
 * {@link ActorSystem.runUntilTerminated} needs the strongest of those three
 * behaviours on all three, so it takes a hold of its own rather than relying
 * on the handlers it installed (#549).
 *
 * The callback is empty on purpose — the *reference* is the whole mechanism,
 * and the tick is only how a timer expresses one.  Deliberately not the
 * system {@link Scheduler}: this has to outlive the scheduler's own shutdown,
 * which happens inside the pipeline this is waiting for.
 */
function holdEventLoopOpen(): () => void {
  const keepAlive = setInterval(() => {}, EVENT_LOOP_KEEPALIVE_INTERVAL_MS);
  return () => { clearInterval(keepAlive); };
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
 *
 * `what` names the operation in the two failure lines.  Both go to
 * `console` rather than to `this.log`, because the one caller that is not
 * about the logger runs beside the one that is — and a message about a
 * flush that timed out must not depend on the sink being flushed.
 */
async function withinBudget(
  operation: () => Promise<void>,
  budgetMs: number,
  what: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(operation()),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          console.error(`[actor-ts] ${what} timed out after ${budgetMs} ms; some records may be lost`);
          resolve();
        }, budgetMs);
      }),
    ]);
  } catch (error) {
    console.error(`[actor-ts] ${what} failed:`, error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Resolve the system-wide per-actor batch budget (#409).
 *
 * A non-positive value is clamped rather than rejected: `0` would leave every
 * actor accepting mail and never reading it, and a config file is exactly the
 * place that mistake is made far from the code that suffers it.  Clamping to
 * `1` reproduces the pre-#409 message-at-a-time loop, which is the honest
 * reading of "as little batching as possible".
 */
function actorThroughputFromConfig(config: Config): number {
  if (!config.hasPath(ConfigKeys.actor.throughput)) return DEFAULT_ACTOR_THROUGHPUT;
  return Math.max(1, config.getInt(ConfigKeys.actor.throughput));
}

/**
 * Resolve the system-wide default ask deadline (#863).
 *
 * **Rejected, not clamped — deliberately unlike its neighbour above.**
 * `throughput = 0` has a nearest honest reading ("as little batching as
 * possible" is 1) so clamping loses nothing.  `ask-timeout = 0` has none: an
 * ask that arms no deadline can never settle, because the reply ref is neither
 * returned to the caller nor exported, which is why {@link ActorRef.ask}
 * refuses the same value as a positional argument (#765).  Clamping to 1 ms
 * would honour the letter of that rule while producing asks that reject before
 * anything can answer them — a working deadline that is never the one anybody
 * asked for.
 *
 * Throwing here rather than leaving it to `assertAskTimeout` moves the failure
 * from every ask site in the application to the one line that caused it, and
 * names the key in the message.
 */
function askTimeoutFromConfig(config: Config): number {
  if (!config.hasPath(ConfigKeys.actor.askTimeout)) return DEFAULT_ASK_TIMEOUT_MS;
  const timeoutMs = config.getDuration(ConfigKeys.actor.askTimeout);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new OptionsError(
      `${ConfigKeys.actor.askTimeout} must be a positive finite duration `
      + `(got ${String(timeoutMs)}) — an ask that arms no deadline can never settle`,
      'actor-ts.actor',
      'ask-timeout',
      timeoutMs,
    );
  }
  return timeoutMs;
}

/**
 * Say so when the configured ask deadline has made the default scatter-gather
 * router unable to report (#863, #1088).
 *
 * {@link DEFAULT_SCATTER_GATHER_TIMEOUT_MS} exists only to sit under the ask
 * default, so that a bare `pool.ask(message)` sees the router's
 * `AggregateError` naming the failing routees rather than its own
 * `AskTimeoutError`.  Lowering `ask-timeout` past it silently restores exactly
 * the defect #1088 fixed, and nothing downstream can notice: the scatter
 * default is resolved in `scatterGatherRouterFactory`, at a call site with no
 * system in scope.
 *
 * A WARN and not a rejection, and not a derived scatter default either.  The
 * combination is legal — a router that names its own `timeoutMs` is unaffected,
 * and so is an application with no scatter-gather router at all — so refusing
 * to start would punish a configuration that may be entirely correct.  Deriving
 * `min(4_500, resolved - 500)` inside the router would fix it without a word,
 * but it moves validation away from the factory that its JSDoc argues should
 * own it, and it makes one knob quietly retune another.  One line at startup
 * naming both knobs is what the operator needs to decide which of the two they
 * actually meant.
 */
function warnIfAskTimeoutUndercutsScatterGather(log: Logger, askTimeoutMs: number): void {
  if (askTimeoutMs >= MINIMUM_ASK_TIMEOUT_FOR_SCATTER_GATHER_MS) return;
  log.warn(
    `${ConfigKeys.actor.askTimeout} = ${askTimeoutMs}ms is below `
    + `${MINIMUM_ASK_TIMEOUT_FOR_SCATTER_GATHER_MS}ms, the least a scatter-gather router left `
    + `on its ${DEFAULT_SCATTER_GATHER_TIMEOUT_MS}ms default needs to report before the caller `
    + 'gives up — so `pool.ask(message)` will raise AskTimeoutError instead of the '
    + 'AggregateError naming the failing routees (#1088).  Raise the ask timeout, or give the '
    + 'router its own ScatterGatherOptions.withTimeoutMs().',
  );
}

/**
 * The absent-key case and the unrecognised-value case both land on the default
 * rather than on a named kind, so "what runs when nobody chose?" has exactly
 * one answer — including for a typo, which is the case most likely to reach
 * someone wondering why their tuning did nothing.
 */
function dispatcherFromConfig(config: Config): Dispatcher {
  const kind = config.hasPath(ConfigKeys.dispatcher.default)
    ? config.getString(ConfigKeys.dispatcher.default).toLowerCase()
    : 'hybrid';
  return match(kind)
    .with('immediate',  () => new ImmediateDispatcher() as Dispatcher)
    .with('microtask',  () => new MicrotaskDispatcher() as Dispatcher)
    .with('throughput', () => {
      const throughput = config.hasPath(ConfigKeys.dispatcher.throughput)
        ? config.getInt(ConfigKeys.dispatcher.throughput)
        : DEFAULT_DISPATCHER_THROUGHPUT;
      return new ThroughputDispatcher(throughput) as Dispatcher;
    })
    .otherwise(() => new HybridDispatcher() as Dispatcher);
}
