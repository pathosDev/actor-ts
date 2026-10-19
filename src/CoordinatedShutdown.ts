import type { ActorSystem } from './ActorSystem.js';
import { ConfigKeys } from './config/ConfigKeys.js';
import { Config, ConfigError, isPlainObject } from './config/Config.js';
import { extensionId, type Extension, type ExtensionId } from './Extension.js';
import { DEFAULT_PHASE_TIMEOUT_MS, DEFAULT_SHUTDOWN_EXIT_CODE, MAX_PROCESS_EXIT_CODE } from './Constants.js';
import { getProcessSignals } from './runtime/signals/index.js';
import { armChainedTimeout, unreferencedHostTimers, type Cancellable } from './Scheduler.js';
import type { ProcessSignal } from './util/ProcessSignal.js';

/**
 * Structured reason passed to every shutdown task so that they can behave
 * differently depending on who triggered the shutdown (SIGTERM vs. cluster
 * leave vs. hot-reload vs. …).
 */
export abstract class Reason {
  abstract readonly name: string;
  toString(): string { return this.name; }
}

export class UnknownReason extends Reason {
  readonly name = 'UnknownReason';
  static readonly instance = new UnknownReason();
}
export class ActorSystemTerminateReason extends Reason {
  readonly name = 'ActorSystemTerminateReason';
  static readonly instance = new ActorSystemTerminateReason();
}
export class ClusterLeavingReason extends Reason {
  readonly name = 'ClusterLeavingReason';
  static readonly instance = new ClusterLeavingReason();
}
export class ClusterDowningReason extends Reason {
  readonly name = 'ClusterDowningReason';
  static readonly instance = new ClusterDowningReason();
}
/**
 * The node gave up joining the cluster (#1500): it never became a member, and
 * this run is how it stops.  Passed by both deadlines a join has —
 * `actor-ts.cluster.shutdown-after-unsuccessful-join` passing with nothing
 * able to promote the node, and a `Cluster.bootstrap` readiness wait
 * expiring — so a task tells "could not join" by one reason whichever fired.
 *
 * Its own reason rather than {@link ClusterLeavingReason}, which keeps meaning
 * that a member is leaving: a task that hands work over before a node leaves
 * has nothing to hand over from a node that never joined, and one that pages
 * someone about a failed start should not page about a rolling restart.
 */
export class ClusterJoinUnsuccessfulReason extends Reason {
  readonly name = 'ClusterJoinUnsuccessfulReason';
  static readonly instance = new ClusterJoinUnsuccessfulReason();
}
/** Received SIGTERM / SIGINT from the process. */
export class ProcessTerminateReason extends Reason {
  constructor(public readonly signal: ProcessSignal) { super(); }
  readonly name = 'ProcessTerminateReason';
  override toString(): string { return `ProcessTerminateReason(${this.signal})`; }
}

/** A single task.  Returning a Promise makes the task async. */
export type ShutdownTask = (reason: Reason) => Promise<void> | void;

export type PhaseDefinition = {
  readonly name: string;
  readonly timeoutMs: number;
  /** Names of phases that must run before this one. */
  readonly dependsOn: ReadonlyArray<string>;
  /** If true, task failures are swallowed and the phase continues; if false, a failure halts the pipeline.  Required — no default. */
  readonly recover: boolean;
};

type RegisteredTask = {
  readonly name: string;
  readonly task: ShutdownTask;
};

/**
 * One child of `actor-ts.coordinated-shutdown.phases` or of
 * `actor-ts.coordinated-startup.phases`, already type-checked — both blocks
 * are parsed by {@link readPhaseOverrides}.
 *
 * Every field is optional and `undefined` means "the config said nothing" —
 * the same rule `mergeOptions` uses everywhere else, and the reason a phase
 * that only sets `timeout` keeps the `recover` and `dependsOn` it was seeded
 * with instead of having them blanked to a default.
 */
export type PhaseOverride = {
  readonly name: string;
  readonly timeoutMs: number | undefined;
  readonly recover: boolean | undefined;
  readonly dependsOn: ReadonlyArray<string> | undefined;
};

/** Canonical phase names, run in order from top to bottom. */
export const Phases = {
  BeforeServiceUnbind: 'before-service-unbind',
  ServiceUnbind: 'service-unbind',
  ServiceRequestsDone: 'service-requests-done',
  ServiceStop: 'service-stop',
  BeforeClusterShutdown: 'before-cluster-shutdown',
  ClusterShardingShutdownRegion: 'cluster-sharding-shutdown-region',
  ClusterLeave: 'cluster-leave',
  ClusterExiting: 'cluster-exiting',
  ClusterExitingDone: 'cluster-exiting-done',
  ClusterShutdown: 'cluster-shutdown',
  BeforeActorSystemTerminate: 'before-actor-system-terminate',
  ActorSystemTerminate: 'actor-system-terminate',
} as const;

type DefaultPhase = typeof Phases[keyof typeof Phases];

/**
 * Lifecycle coordinator that runs registered tasks in well-known phases.
 * Ordinary application code calls `addTask(phase, name, task)`; the runtime
 * guarantees task order across phases and bounded parallelism within a
 * phase.  Task failures are logged and do NOT by default abort the rest of
 * the pipeline.
 */
export class CoordinatedShutdown implements Extension {
  private readonly phases = new Map<string, PhaseDefinition>();
  private readonly tasks = new Map<string, RegisteredTask[]>();
  private _running = false;
  private _completed = false;
  /** The run has ended, completed or halted — what `_running`, set for good, cannot say. */
  private _settled = false;
  private _runPromise: Promise<void> | null = null;
  /** Something failed and the pipeline is how the system goes — see {@link _runForFailure}. */
  private _failed = false;
  private _processHooksInstalled = false;
  /**
   * The handlers this instance installed, paired with their signal.
   *
   * Only the signal *names* were recorded before, which left no way to
   * remove the right listener — so `removeProcessHooks` fell back to
   * `removeAllListeners`, tearing out the application's own SIGTERM
   * handling along with every other library's and any second
   * `ActorSystem`'s (#644).
   */
  private _processHooks: { signal: ProcessSignal; handler: () => void }[] = [];

  /**
   * Default per-phase timeout in ms.  Can be changed globally or per-phase
   * via `setPhaseTimeout`, or from `actor-ts.coordinated-shutdown.
   * default-phase-timeout`.  5 seconds is a reasonable balance between
   * letting slow tasks finish and not blocking shutdown indefinitely.
   *
   * Assigning it later only affects phases registered after the fact — the
   * 12 canonical phases copy it when they are seeded below, which is why
   * the config read has to happen first.
   */
  defaultPhaseTimeoutMs = DEFAULT_PHASE_TIMEOUT_MS;

  /** Call `process.exit(exitCode)` once the pipeline completes.  Off by default. */
  private readonly exitProcess: boolean;

  /**
   * Status that exit carries.  Only read when {@link exitProcess} is on.
   */
  private readonly exitCode: number;

  /**
   * Whether the built-in terminator sits in the last phase — whether this
   * pipeline takes the system down at all.  Kept past the constructor for the
   * signal path, which stands in for the terminator after a run that halted
   * short of it, and must not where there is none to stand in for.
   */
  private readonly terminateActorSystem: boolean;

  /**
   * Whether framework components register their own teardown — see
   * {@link addFrameworkTask}.
   */
  readonly autoRegisterTasks: boolean;

  /**
   * Whether the framework's two *defaulting* signal call sites —
   * `ActorSystem.runUntilTerminated()` and the cluster bootstrap — arm
   * SIGTERM/SIGINT on the caller's behalf.
   *
   * Deliberately not consulted by {@link installProcessHooks}, which keeps
   * meaning "do it".  The key ships as a leaf, so `reference.conf` always
   * supplies a value and a gate inside the installer would let HOCON beat a
   * caller who named the signals explicitly — the exact inversion of
   * *explicit options > HOCON > defaults*.  Reading it where the default is
   * chosen keeps that order intact.
   */
  readonly runByProcessSignals: boolean;

  constructor(private readonly system: ActorSystem) {
    const config = system.config;
    const configured = readCoordinatedShutdownOptionsFromConfig(config);
    if (configured.defaultPhaseTimeoutMs !== undefined) {
      this.defaultPhaseTimeoutMs = configured.defaultPhaseTimeoutMs;
    }
    this.exitProcess = configured.exitProcess ?? false;
    this.exitCode = configured.exitCode ?? DEFAULT_SHUTDOWN_EXIT_CODE;
    this.terminateActorSystem = configured.terminateActorSystem ?? true;
    this.autoRegisterTasks = configured.autoRegisterTasks ?? true;
    this.runByProcessSignals = configured.runByProcessSignals ?? true;

    // Seed the 12 canonical phases linearly — each depends on the previous.
    const order: DefaultPhase[] = [
      Phases.BeforeServiceUnbind,
      Phases.ServiceUnbind,
      Phases.ServiceRequestsDone,
      Phases.ServiceStop,
      Phases.BeforeClusterShutdown,
      Phases.ClusterShardingShutdownRegion,
      Phases.ClusterLeave,
      Phases.ClusterExiting,
      Phases.ClusterExitingDone,
      Phases.ClusterShutdown,
      Phases.BeforeActorSystemTerminate,
      Phases.ActorSystemTerminate,
    ];
    for (let i = 0; i < order.length; i++) {
      this.phases.set(order[i]!, {
        name: order[i]!,
        timeoutMs: this.defaultPhaseTimeoutMs,
        dependsOn: i === 0 ? [] : [order[i - 1]!],
        recover: true,
      });
    }
    this.applyPhaseOverrides(config);
    // Built-in terminator in the final phase.  Opting out leaves the phase
    // in place — user tasks registered there still run — and hands the
    // system's lifetime back to the embedder, which is the point: a host
    // process that owns the system does not want a signal handler killing it.
    //
    // It calls the teardown, never the public `terminate()`.  That method may
    // be what started this run, and while a run is in flight it deliberately
    // starts nothing: called from here it would only queue the teardown
    // behind the very run that is waiting for it, and `run()` would resolve
    // on a system that is still up (#1455).
    if (this.terminateActorSystem) {
      this.addTask(Phases.ActorSystemTerminate, 'terminate-actor-system', () => this.system._teardown());
    }
  }

  /* ----------------------------- Public API ----------------------------- */

  /** Register a task to run during the given phase.  Task names must be unique within a phase. */
  addTask(phase: string, name: string, task: ShutdownTask): void {
    if (!this.phases.has(phase)) {
      throw new Error(`CoordinatedShutdown: unknown phase "${phase}"`);
    }
    const list = this.tasks.get(phase) ?? [];
    if (list.some(t => t.name === name)) {
      throw new Error(`CoordinatedShutdown: task "${name}" already registered in phase "${phase}"`);
    }
    list.push({ name, task });
    this.tasks.set(phase, list);
  }

  /**
   * Register a task the *framework* owns — an HTTP unbind, a broker
   * teardown, the cluster leave, the DevTools detach — and report whether it
   * was taken.
   *
   * Identical to {@link addTask} except that it is a no-op when
   * `actor-ts.coordinated-shutdown.auto-register-tasks` is `false`.  That
   * flag is the opt-out for an embedder who wants the pipeline's phases but
   * not its opinions about when its own resources go: a host process that
   * hands the same HTTP server to two subsystems, a test harness that binds
   * and unbinds inside one system, or anyone who would rather order the
   * teardown by hand.  It is deliberately one switch rather than one per
   * subsystem — the reason to reach for it is never "unbind the HTTP server
   * but leave the brokers to me", it is "I own the lifecycle".
   *
   * The boolean return exists so a caller can skip the matching
   * {@link removeTask} bookkeeping instead of guessing.
   */
  addFrameworkTask(phase: string, name: string, task: ShutdownTask): boolean {
    if (!this.autoRegisterTasks) return false;
    this.addTask(phase, name, task);
    return true;
  }

  /**
   * Unregister a task, returning whether one was there.
   *
   * A task registered for a resource that has since been released must
   * be able to go with it.  Without this, a component that registers on
   * acquire — the HTTP layer's `http-unbind-<host>:<port>`, say — could
   * never re-acquire the same resource in one process: the second
   * registration collides with a task whose binding no longer exists.
   */
  removeTask(phase: string, name: string): boolean {
    const list = this.tasks.get(phase);
    if (list === undefined) return false;
    const index = list.findIndex((t) => t.name === name);
    if (index < 0) return false;
    list.splice(index, 1);
    return true;
  }

  /** Add a custom phase.  `dependsOn` tells the coordinator where in the order it sits. */
  addPhase(def: PhaseDefinition): void {
    if (this.phases.has(def.name)) {
      throw new Error(`CoordinatedShutdown: phase "${def.name}" already exists`);
    }
    for (const dep of def.dependsOn) {
      if (!this.phases.has(dep)) {
        throw new Error(`CoordinatedShutdown: phase "${def.name}" depends on unknown "${dep}"`);
      }
    }
    this.phases.set(def.name, def);
  }

  /**
   * The resolved definition of a phase, or `undefined` if there is none.
   *
   * Read-only on purpose — the map is the pipeline's own state, and the copy
   * handed back is the same frozen-by-convention record `addPhase` took.
   * It exists because the graph stopped being something only code builds:
   * once `actor-ts.coordinated-shutdown.phases` can retime a phase or add
   * one, the operator who wrote that block needs a way to ask what the merge
   * actually produced, and "run a shutdown and watch" is not one.
   */
  phaseDefinition(phase: string): PhaseDefinition | undefined {
    return this.phases.get(phase);
  }

  /** Override the timeout for a phase.  Uses `defaultPhaseTimeoutMs` by default. */
  setPhaseTimeout(phase: string, timeoutMs: number): void {
    const phaseEntry = this.phases.get(phase);
    if (!phaseEntry) throw new Error(`Unknown phase: ${phase}`);
    this.phases.set(phase, { ...phaseEntry, timeoutMs });
  }

  /** True once `run()` has been kicked off. */
  get isRunning(): boolean { return this._running; }
  /** True once `run()` has completed (successful or not). */
  get isComplete(): boolean { return this._completed; }

  /**
   * @internal The run in flight, or `null` when there is none — before the
   * first `run()`, and again once that run has ended, completed or halted.
   *
   * Narrower than {@link isRunning}, which stays true for good, and
   * `ActorSystem.terminate()` needs the narrow answer: while a run is in
   * flight it must start nothing, but after a run that left the system up
   * it is the ordinary teardown again.
   */
  get _runInProgress(): Promise<void> | null {
    return this._settled ? null : this._runPromise;
  }

  /**
   * Run the pipeline.  Safe to call from multiple sites — subsequent calls
   * return the same in-flight promise.
   */
  run(reason: Reason = UnknownReason.instance): Promise<void> {
    if (this._runPromise) return this._runPromise;
    // Stored before `_run` is called rather than taken from what it returns.
    // `_run` is async, but the tasks of the first phase in the order start
    // before its first `await` — inside this call — and one of them may ask
    // whether a run is in flight: `terminate()` does, and so does a second
    // `run()`.  Assigned afterwards, the run was invisible for exactly that
    // phase, so a task there tore the system down mid-pipeline or started a
    // second pipeline inside the first (#1455).
    let resolveRun!: () => void;
    let rejectRun!: (error: unknown) => void;
    this._runPromise = new Promise<void>((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });
    this._run(reason).then(resolveRun, rejectRun);
    return this._runPromise;
  }

  /**
   * @internal {@link run} for a system that is going down because something
   * failed — a startup task, today.  The same pipeline, and the same run when
   * one is already in flight; what differs is the status `exit-process` exits
   * with, which is never `0` after a failure (see {@link exitStatus}).
   *
   * A call rather than a check of the reason: the reason a failed startup
   * passes is declared beside the startup graph, which imports this module, so
   * recognising it here would be an import cycle — and the system, which
   * learns of the failure first, is the one place that knows it was one.
   */
  _runForFailure(reason: Reason): Promise<void> {
    this._failed = true;
    return this.run(reason);
  }

  /**
   * Install SIGTERM / SIGINT handlers that call `run(ProcessTerminateReason)`.
   * Calling twice is harmless.  Uninstall via `removeProcessHooks`.
   *
   * Delivery goes through the `src/runtime/signals/` backend rather than
   * `process.on` directly, because Deno's `process` shim carries no signal
   * events — the old call site registered nothing at all there and reported
   * success (#549).  A signal the runtime cannot deliver is skipped rather
   * than registered: on Deno that would throw, and on Windows there is no
   * SIGTERM to catch under any runtime.
   */
  installProcessHooks(
    signals: ReadonlyArray<ProcessSignal> = ['SIGTERM', 'SIGINT'],
  ): void {
    if (this._processHooksInstalled) return;
    const backend = getProcessSignals();
    for (const signal of signals) {
      if (!backend.supports(signal)) continue;
      const handler = (): void => { this.onProcessSignal(signal); };
      backend.add(signal, handler);
      this._processHooks.push({ signal, handler });
    }
    this._processHooksInstalled = true;
  }

  /**
   * A signal arrived: run the pipeline, and answer the run if it halts.
   *
   * Nobody awaits a signal, so the promise `run()` hands back is held by
   * nothing but this handler, and a failing phase with `recover = false`
   * would otherwise reject it unhandled — which ends a Node process with the
   * task's stack — after stopping the pipeline short of its terminator, which
   * left the system up and `runUntilTerminated()` waiting on `whenTerminated()`
   * for good (#1455).  A signal that arrives while a run exists — a second
   * SIGINT, or one during a run something else started — joins it and adds
   * nothing: that run's outcome is its starter's to answer.
   */
  private onProcessSignal(signal: ProcessSignal): void {
    if (this._runPromise !== null) return;
    this.run(new ProcessTerminateReason(signal)).catch((error: unknown) => {
      this.onSignalRunHalted(error);
    });
  }

  /**
   * Report a halted signal run, and stand in for the terminator it never
   * reached — the teardown an opted-in `terminate()` performs after a halt
   * too, since the process was asked to stop either way.
   *
   * Only where there is a terminator to stand in for: with
   * `terminate-actor-system` off the pipeline never takes the system down,
   * because a host process that owns it does not want a signal handler doing
   * so, and a halt on the way changes nothing about whose system it is.
   */
  private onSignalRunHalted(error: unknown): void {
    if (!this.terminateActorSystem) {
      this.system.log.error(
        'the coordinated-shutdown pipeline a signal started halted; '
        + `${ConfigKeys.coordinatedShutdown.terminateActorSystem} is off, so the system stays up`,
        error,
      );
      return;
    }
    this.system.log.error(
      'the coordinated-shutdown pipeline a signal started halted; tearing the system down regardless',
      error,
    );
    void this.system._teardown();
  }

  /**
   * Detach the handlers this instance installed.
   *
   * Not optional housekeeping on Deno: a signal listener there holds the
   * event loop open with no `unref` to soften it, so a program that installs
   * one and never removes it stops exiting by itself.
   */
  removeProcessHooks(): void {
    if (!this._processHooksInstalled) return;
    const backend = getProcessSignals();
    // Remove exactly what was installed.  A shutdown hook has no business
    // deciding that nobody else may listen for SIGTERM.
    for (const { signal, handler } of this._processHooks) {
      backend.remove(signal, handler);
    }
    this._processHooksInstalled = false;
    this._processHooks = [];
  }

  /* ------------------------------- Internal ------------------------------ */

  /**
   * Fold `actor-ts.coordinated-shutdown.phases` into the freshly seeded DAG.
   *
   * A child naming one of the twelve canonical phases **merges** into it —
   * neither {@link addPhase} (which throws on a duplicate) nor
   * {@link setPhaseTimeout} (which only replaces the timeout) can express
   * that, so this is a third path rather than a call into either.  Any other
   * name declares a new phase, and there `depends-on` is required: a phase
   * with no edges sorts into the first ready batch and would run *before*
   * `before-service-unbind`, which is never what an operator adding a phase
   * meant.
   *
   * `depends-on` on a canonical phase is **added** to the seeded edge, never
   * a replacement.  The topological sort catches cycles and nothing else, so
   * a replacing form would let a config file re-parent `cluster-leave` ahead
   * of `service-unbind` and produce a pipeline that runs happily in the wrong
   * order — a silent failure exactly where the pipeline exists to prevent one.
   *
   * Everything it can reject, it rejects here rather than at `run()`: a
   * shutdown that throws on a bad phase graph fails at the worst possible
   * moment, whereas failing in the extension's constructor fails at startup.
   */
  private applyPhaseOverrides(config: Config): void {
    const path = ConfigKeys.coordinatedShutdown.phases;
    if (!config.hasPath(path)) return;
    const overrides = readPhaseOverrides(config, path);
    if (overrides.length === 0) return;

    // Resolve every target against existing *and* declared names, so a
    // canonical phase may depend on a config-declared one and vice versa.
    const declared = new Set(overrides.map((entry) => entry.name));
    for (const entry of overrides) {
      for (const dependency of entry.dependsOn ?? []) {
        if (!this.phases.has(dependency) && !declared.has(dependency)) {
          throw new ConfigError(
            `${path}.${entry.name}.depends-on names "${dependency}", which is `
            + 'neither a canonical phase nor another phase declared here',
          );
        }
      }
    }

    const additions = overrides.filter((entry) => !this.phases.has(entry.name));
    const addedNames = new Set(additions.map((entry) => entry.name));
    this.registerDeclaredPhases(additions, path);
    for (const entry of overrides) {
      if (!addedNames.has(entry.name)) this.mergePhaseOverride(entry);
    }
    this.checkPhaseGraph(path);
  }

  /**
   * Register the config-declared phases, dependency-first.
   *
   * {@link addPhase} demands every `dependsOn` target already exist, and two
   * phases declared in one config block may name each other — declaration
   * order in the file says nothing about the order they can be registered in.
   * A round that registers nothing therefore means a cycle among them, since
   * unresolvable targets were rejected before this runs.
   */
  private registerDeclaredPhases(additions: readonly PhaseOverride[], path: string): void {
    let pending = additions.map((entry) => {
      const dependsOn = entry.dependsOn ?? [];
      if (dependsOn.length === 0) {
        throw new ConfigError(
          `${path}.${entry.name} declares a new phase, so it must name depends-on: `
          + 'a phase with no dependencies sorts into the first batch and would run '
          + `before "${Phases.BeforeServiceUnbind}"`,
        );
      }
      return { entry, dependsOn };
    });
    while (pending.length > 0) {
      const ready = pending.filter(({ dependsOn }) => dependsOn.every((d) => this.phases.has(d)));
      if (ready.length === 0) {
        throw new ConfigError(
          `${path}: the phases declared here depend on each other in a cycle: `
          + pending.map(({ entry }) => entry.name).sort().join(', '),
        );
      }
      for (const { entry, dependsOn } of ready) {
        this.addPhase({
          name: entry.name,
          timeoutMs: entry.timeoutMs ?? this.defaultPhaseTimeoutMs,
          dependsOn: [...dependsOn],
          recover: entry.recover ?? true,
        });
      }
      const registered = new Set(ready.map(({ entry }) => entry.name));
      pending = pending.filter(({ entry }) => !registered.has(entry.name));
    }
  }

  /** Merge one config child into the phase of the same name that already exists. */
  private mergePhaseOverride(entry: PhaseOverride): void {
    const seeded = this.phases.get(entry.name)!;
    const added = (entry.dependsOn ?? []).filter((d) => !seeded.dependsOn.includes(d));
    this.phases.set(seeded.name, {
      name: seeded.name,
      timeoutMs: entry.timeoutMs ?? seeded.timeoutMs,
      dependsOn: added.length === 0 ? seeded.dependsOn : [...seeded.dependsOn, ...added],
      recover: entry.recover ?? seeded.recover,
    });
  }

  /** Sort the resulting graph once, so a cycle is a startup error, not a shutdown one. */
  private checkPhaseGraph(path: string): void {
    try {
      this.topologicalOrder();
    } catch (e) {
      throw new ConfigError(`${path} produced an unusable phase graph — ${(e as Error).message}`);
    }
  }

  private async _run(reason: Reason): Promise<void> {
    this._running = true;
    try {
      const order = this.topologicalOrder();
      for (const phase of order) {
        await this.runPhase(phase, reason);
      }
    } finally {
      this._settled = true;
    }
    this._completed = true;
    // Last thing, and only when asked: a lingering handle (an open socket, a
    // pooled DB connection a driver never released) otherwise keeps the
    // process alive long after the pipeline is done, and the operator has no
    // way to tell "shutting down" from "hung".  `_completed` is already set,
    // so anything awaiting `run()` observes success even though this call
    // does not return.
    if (this.exitProcess && typeof process !== 'undefined' && typeof process.exit === 'function') {
      process.exit(this.exitStatus());
    }
  }

  /**
   * The status `exit-process` exits with: `exit-code`, unless something failed
   * and that is `0`.
   *
   * `0` tells a supervisor the process stopped cleanly, and a run for a failed
   * startup is no clean stop, so there the configured code is kept only when it
   * already says "failed" and becomes `1` — the conventional general-failure
   * status — otherwise.  The default `exit-process = false` never gets here:
   * `runUntilTerminated()` rejects with the startup's error, and a `main` that
   * awaits it exits non-zero by itself.
   */
  private exitStatus(): number {
    return this._failed && this.exitCode === 0 ? 1 : this.exitCode;
  }

  private async runPhase(phase: string, reason: Reason): Promise<void> {
    const def = this.phases.get(phase)!;
    // Snapshot, because a task is allowed to unregister itself: the HTTP
    // unbind and the cluster leave both drop their task once the resource
    // they name is gone, so re-binding the same address in one process is
    // possible.  Splicing the live array mid-`map` would skip its neighbour.
    const tasks = [...(this.tasks.get(phase) ?? [])];
    if (tasks.length === 0) return;

    const promises = tasks.map(t => this.runOneTask(t, def, reason));
    if (def.recover) {
      await Promise.all(promises.map(p => p.catch(() => {})));
    } else {
      await Promise.all(promises);
    }
  }

  /**
   * Run one task against its phase's budget.
   *
   * The budget is armed through the scheduler's chain rather than as one
   * `setTimeout`, which holds at most ~24.9 days and fires a longer delay after
   * 1 ms on Bun and Node — so a phase timeout the config accepts, `30d` say,
   * timed every task out the moment it started (#1455).  Unreferenced, as the
   * single timer was, so a pending budget never keeps the process alive; and
   * real time, not the system's scheduler, which a `ManualScheduler` would
   * freeze.
   */
  private async runOneTask(t: RegisteredTask, def: PhaseDefinition, reason: Reason): Promise<void> {
    let budget!: Cancellable;
    const timeout = new Promise<never>((_, reject) => {
      budget = armChainedTimeout(
        () => reject(
          new Error(`Shutdown task "${t.name}" in phase "${def.name}" timed out after ${def.timeoutMs}ms`),
        ),
        def.timeoutMs,
        unreferencedHostTimers,
      );
    });
    try {
      await Promise.race([Promise.resolve(t.task(reason)), timeout]);
    } catch (e) {
      this.system.log.warn(
        `[shutdown] task "${t.name}" in phase "${def.name}" failed: ${(e as Error).message}`,
      );
      if (!def.recover) throw e;
    } finally {
      budget.cancel();
    }
  }

  /** Kahn-style topological sort over the phase DAG. */
  private topologicalOrder(): string[] {
    const remaining = new Map<string, string[]>();
    for (const [name, def] of this.phases) {
      remaining.set(name, [...def.dependsOn]);
    }
    const out: string[] = [];
    while (remaining.size > 0) {
      const ready = Array.from(remaining.entries())
        .filter(([, deps]) => deps.length === 0)
        .map(([name]) => name)
        .sort(); // deterministic tiebreaker
      if (ready.length === 0) {
        throw new Error(`CoordinatedShutdown: cycle in phase dependencies: ${Array.from(remaining.keys()).join(', ')}`);
      }
      for (const name of ready) {
        out.push(name);
        remaining.delete(name);
      }
      for (const [, deps] of remaining) {
        for (const done of ready) {
          const index = deps.indexOf(done);
          if (index >= 0) deps.splice(index, 1);
        }
      }
    }
    return out;
  }
}

/**
 * What `actor-ts.coordinated-shutdown` says about the pipeline: its seven
 * leaves, each absent when unset — six the extension applies, and
 * `run-by-actor-system-terminate`, which `ActorSystem` reads through the same
 * reader because a bare `terminate()` must not build the extension to ask
 * (#1455).  The `phases` block is not part of it — its children are named
 * after the operator's own phases, so there is no fixed leaf to read into a
 * field, and {@link CoordinatedShutdown} applies it against the seeded graph
 * instead.
 *
 * Not an options triad: nothing in code hands the extension these settings, so
 * this is only the shape the config layer reads into, as
 * `DefaultMailboxConfiguration` is for the global mailbox bound.
 */
export type CoordinatedShutdownConfiguration = {
  /** `default-phase-timeout`: the budget each seeded phase starts with. */
  readonly defaultPhaseTimeoutMs?: number;
  /** `exit-process`: call `process.exit` once the pipeline completes. */
  readonly exitProcess?: boolean;
  /** `exit-code`: the status that exit carries, already range-checked. */
  readonly exitCode?: number;
  /** `terminate-actor-system`: register the built-in terminator in the last phase. */
  readonly terminateActorSystem?: boolean;
  /** `auto-register-tasks`: let framework components register their own teardown. */
  readonly autoRegisterTasks?: boolean;
  /** `run-by-process-signals`: let the defaulting call sites arm SIGTERM/SIGINT. */
  readonly runByProcessSignals?: boolean;
  /** `run-by-actor-system-terminate`: a `terminate()` that does not choose runs the pipeline first. */
  readonly runByActorSystemTerminate?: boolean;
};

/**
 * Read the seven leaves of `actor-ts.coordinated-shutdown`, leaving an unset one
 * absent rather than defaulting it in; the extension's constructor and the
 * system apply the defaults.  Exported so that what is read can be checked
 * without building a system around it (#1425).
 */
export function readCoordinatedShutdownOptionsFromConfig(
  config: Config,
): CoordinatedShutdownConfiguration {
  const keys = ConfigKeys.coordinatedShutdown;
  const out: {
    -readonly [K in keyof CoordinatedShutdownConfiguration]?: CoordinatedShutdownConfiguration[K]
  } = {};
  if (config.hasPath(keys.defaultPhaseTimeout)) {
    out.defaultPhaseTimeoutMs = config.getDuration(keys.defaultPhaseTimeout);
  }
  if (config.hasPath(keys.exitProcess)) out.exitProcess = config.getBoolean(keys.exitProcess);
  if (config.hasPath(keys.exitCode)) out.exitCode = readExitCode(config, keys.exitCode);
  if (config.hasPath(keys.terminateActorSystem)) {
    out.terminateActorSystem = config.getBoolean(keys.terminateActorSystem);
  }
  if (config.hasPath(keys.autoRegisterTasks)) {
    out.autoRegisterTasks = config.getBoolean(keys.autoRegisterTasks);
  }
  if (config.hasPath(keys.runByProcessSignals)) {
    out.runByProcessSignals = config.getBoolean(keys.runByProcessSignals);
  }
  if (config.hasPath(keys.runByActorSystemTerminate)) {
    out.runByActorSystemTerminate = config.getBoolean(keys.runByActorSystemTerminate);
  }
  return out;
}

/**
 * The three keys a `phases.<name>` block may carry.
 *
 * Checked rather than ignored, because the failure this prevents is silent:
 * `timout = 30s` under a phase would leave the phase on its seeded budget and
 * say nothing, which is the same class of defect as a documented key nothing
 * reads.  The list is the whole schema of a phase child, so it lives beside
 * the reader that applies it.
 */
const PHASE_OVERRIDE_KEYS: ReadonlySet<string> = new Set(['timeout', 'recover', 'depends-on']);

/**
 * Type-check one `phases` block into {@link PhaseOverride}s.
 *
 * Each child is re-wrapped in its own `Config` rather than addressed through
 * a dotted path, so a phase whose name contains a dot is read as one key
 * instead of being silently split into a nesting that does not exist.
 */
export function readPhaseOverrides(config: Config, path: string): PhaseOverride[] {
  return Object.entries(config.getObject(path)).map(([name, raw]) => {
    if (!isPlainObject(raw)) {
      throw new ConfigError(
        `${path}.${name} must be a block of timeout / recover / depends-on, not a bare value`,
      );
    }
    for (const key of Object.keys(raw)) {
      if (!PHASE_OVERRIDE_KEYS.has(key)) {
        throw new ConfigError(
          `${path}.${name}.${key} is not a phase setting — expected one of `
          + `${[...PHASE_OVERRIDE_KEYS].join(', ')}`,
        );
      }
    }
    const phase = Config.fromObject(raw);
    return {
      name,
      timeoutMs: phase.hasPath('timeout') ? phase.getDuration('timeout') : undefined,
      recover: phase.hasPath('recover') ? phase.getBoolean('recover') : undefined,
      dependsOn: phase.hasPath('depends-on') ? phase.getStringList('depends-on') : undefined,
    };
  });
}

/**
 * Read `exit-code`, refusing a status the operating system would rewrite.
 *
 * Only eight bits of a wait status carry the code, so `process.exit(256)`
 * surfaces as `0`: a configured failure that the supervisor reads as a clean
 * stop.  Rejecting it at startup is the only point at which anyone is looking.
 */
function readExitCode(config: Config, path: string): number {
  const code = config.getInt(path);
  if (code < 0 || code > MAX_PROCESS_EXIT_CODE) {
    throw new ConfigError(
      `${path} must be between 0 and ${MAX_PROCESS_EXIT_CODE}, got ${code} — `
      + 'a status outside that range is truncated by the operating system, so the '
      + 'exit an operator sees would not be the one configured',
    );
  }
  return code;
}

/** ExtensionId — use via `system.extension(CoordinatedShutdownId)`. */
export const CoordinatedShutdownId: ExtensionId<CoordinatedShutdown> = extensionId(
  'CoordinatedShutdown',
  (system) => new CoordinatedShutdown(system),
);
