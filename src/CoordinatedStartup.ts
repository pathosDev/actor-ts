import type { ActorSystem } from './ActorSystem.js';
import { ConfigError } from './config/Config.js';
import { ConfigKeys } from './config/ConfigKeys.js';
import { Reason, type PhaseDefinition } from './CoordinatedShutdown.js';
import {
  CoordinatedStartupOptionsValidator,
  DEFAULT_STARTUP_PHASE_TIMEOUT_MS,
  readCoordinatedStartupOptionsFromConfig,
  StartupPhases,
  type CoordinatedStartupOptions,
  type CoordinatedStartupOptionsType,
  type StartupPhaseConfiguration,
  type StartupTask,
} from './CoordinatedStartupOptions.js';
import { extensionId, type Extension, type ExtensionId } from './Extension.js';
import { armChainedTimeout, unreferencedHostTimers, type Cancellable } from './Scheduler.js';
import { mergeOptions } from './util/OptionsMerge.js';
import { OptionsError } from './util/OptionsValidator.js';

export { StartupPhases } from './CoordinatedStartupOptions.js';
export type { StartupTask } from './CoordinatedStartupOptions.js';

/**
 * The reason a coordinated-shutdown run carries when the system goes down
 * because its startup failed.
 *
 * A shutdown task can tell it apart from a signal or a `terminate()` and read
 * what failed — one that would flush a cache startup never filled, or report
 * the failure somewhere the log does not reach, has a use for both.
 */
export class StartupFailedReason extends Reason {
  readonly name = 'StartupFailedReason';

  constructor(
    /** The phase whose task failed. */
    readonly phase: string,
    /** The task that failed. */
    readonly task: string,
    /** What the task threw or rejected with, or the error its phase's budget ran out with. */
    readonly cause: unknown,
  ) {
    super();
  }

  override toString(): string { return `StartupFailedReason(${this.phase}/${this.task})`; }
}

type RegisteredStartupTask = {
  readonly name: string;
  readonly task: StartupTask;
};

/** A task in flight: what aborts it and what bounds it. */
type StartupFlight = {
  readonly controller: AbortController;
  readonly budget: Cancellable;
};

/** A launched task and how it ended — `null` when it finished. */
type LaunchedStartupTask = {
  readonly flight: StartupFlight;
  readonly outcome: Promise<StartupTaskFailure | null>;
};

type StartupTaskFailure = {
  readonly task: string;
  readonly cause: unknown;
};

/**
 * The system's startup, run as a graph of phases — the counterpart of
 * {@link CoordinatedShutdown} at the other end of a system's life (#1473).
 *
 * **The framework runs it, so no `main` has to remember to.**  The tasks come
 * in through `ActorSystemOptions.withCoordinatedStartup`, and the system starts
 * the graph as the last step of `ActorSystem.create`: tasks of one phase run
 * concurrently, phases in dependency order, and {@link whenReady} — also on
 * the system — settles once the last phase has.  A step that has to happen
 * after a plugin is registered and before the node takes traffic is a task in
 * a phase, not a call every application has to place correctly.
 *
 * Two phases are seeded, `persistence-start` and then `before-system-ready`,
 * and neither recovers: a task that fails, or outlives its phase's budget,
 * stops the run, rejects `whenReady()` with an error naming the phase and the
 * task, and takes the system down through the coordinated-shutdown pipeline
 * with a {@link StartupFailedReason}.  `runUntilTerminated()` then ends with
 * that error, so a process whose startup failed exits by itself, non-zero.
 * A declared phase with `recover: true` logs a failure and carries on instead.
 * While the graph runs, the `startup` readiness check of
 * `healthChecksOf(system)` keeps `/ready` false.
 *
 * **The budgets are the deployment's to tune.**  `actor-ts.coordinated-startup`
 * carries the default phase budget and a `phases` block of the shutdown
 * block's shape, both under what the options set in code: a phase an option
 * entry names is that entry's, the block's children retime or declare the
 * rest, and a task may run in a phase only the block declares.
 *
 * **The graph is sealed when `create` returns.**  A task added afterwards
 * would never run — the phases it belongs to may be over — so {@link addTask}
 * and {@link addPhase} refuse from then on, naming the option that works.
 */
export class CoordinatedStartup implements Extension {
  private readonly phases = new Map<string, PhaseDefinition>();
  private readonly tasks = new Map<string, RegisteredStartupTask[]>();
  /** What {@link _abandon} has to reach: every task still running. */
  private readonly inFlight = new Set<StartupFlight>();
  private readonly readiness: Promise<void>;
  private resolveReadiness: () => void = () => {};
  private rejectReadiness: (error: Error) => void = () => {};
  private sealed = false;
  private running = false;
  private completed = false;
  private currentPhase: string | undefined = undefined;
  private failureError: Error | undefined = undefined;
  private abandonment: Error | undefined = undefined;

  constructor(
    private readonly system: ActorSystem,
    options: CoordinatedStartupOptions = {},
  ) {
    const configured = readCoordinatedStartupOptionsFromConfig(system.config);
    const settings = mergeOptions<CoordinatedStartupOptionsType>(
      { defaultPhaseTimeoutMs: DEFAULT_STARTUP_PHASE_TIMEOUT_MS },
      { defaultPhaseTimeoutMs: configured.defaultPhaseTimeoutMs },
      options as Partial<CoordinatedStartupOptionsType>,
    );
    const configuredPhases = configured.phases ?? [];
    new CoordinatedStartupOptionsValidator(configuredPhases.map((phase) => phase.name)).validate(settings);
    const defaultPhaseTimeoutMs = settings.defaultPhaseTimeoutMs ?? DEFAULT_STARTUP_PHASE_TIMEOUT_MS;
    this.seedPhases(defaultPhaseTimeoutMs);
    const seeded: ReadonlyMap<string, PhaseDefinition> = new Map(this.phases);
    this.applyConfiguredPhases(configuredPhases, defaultPhaseTimeoutMs);
    this.applyPhaseEntries(settings.phases ?? [], seeded);
    for (const registration of settings.tasks ?? []) {
      this.register(registration.phase, registration.name, registration.task);
    }
    this.refuseCycles();
    this.readiness = new Promise<void>((resolve, reject) => {
      this.resolveReadiness = resolve;
      this.rejectReadiness = reject;
    });
    // Handled here, once: a failed or abandoned startup that nobody awaited is
    // not an unhandled rejection.  The failure has its own log line and its
    // own shutdown, and an abandonment is what the caller asked for.
    this.readiness.catch(() => {});
  }

  /* ----------------------------- Public API ----------------------------- */

  /**
   * Register a task — refused once the system is constructed, which is always
   * the case by the time application code holds the extension.  Pass startup
   * work through `ActorSystemOptions.withCoordinatedStartup` instead.
   */
  addTask(phase: string, name: string, task: StartupTask): void {
    this.refuseOnceSealed('addTask');
    this.register(phase, name, task);
  }

  /** Add a phase — refused once the system is constructed, like {@link addTask}. */
  addPhase(definition: PhaseDefinition): void {
    this.refuseOnceSealed('addPhase');
    if (this.phases.has(definition.name)) {
      throw new Error(`CoordinatedStartup: phase "${definition.name}" already exists`);
    }
    if (definition.dependsOn.length === 0) {
      throw new Error(
        `CoordinatedStartup: phase "${definition.name}" must name the phase it runs after — one with no `
        + `dependencies would sort to the front and run before "${StartupPhases.PersistenceStart}"`,
      );
    }
    for (const dependency of definition.dependsOn) {
      if (!this.phases.has(dependency)) {
        throw new Error(`CoordinatedStartup: phase "${definition.name}" depends on unknown "${dependency}"`);
      }
    }
    this.phases.set(definition.name, { ...definition, dependsOn: [...definition.dependsOn] });
  }

  /** The resolved definition of a phase — after the options retimed or added it — or `undefined`. */
  phaseDefinition(phase: string): PhaseDefinition | undefined {
    return this.phases.get(phase);
  }

  /** Whether any phase has a task.  A graph without one is complete the moment it starts. */
  get hasTasks(): boolean {
    for (const list of this.tasks.values()) if (list.length > 0) return true;
    return false;
  }

  /** True while the graph runs: from the end of `create` until its last phase, a failure or an abandonment. */
  get isRunning(): boolean { return this.running; }

  /** True once every phase has run without a failure that stopped the run. */
  get isComplete(): boolean { return this.completed; }

  /** The phase running now, or `undefined` when none is. */
  get runningPhase(): string | undefined { return this.running ? this.currentPhase : undefined; }

  /**
   * The error {@link whenReady} rejected with because a task failed, or
   * `undefined` — also after an abandonment, which is not a failure.
   */
  get failure(): Error | undefined { return this.failureError; }

  /**
   * Resolves once every phase has run; rejects with the error that stopped the
   * run, or with an abandonment error when the system was terminated first.
   * The same promise every call, and already resolved for a graph without
   * tasks — no timer is armed for one.
   */
  whenReady(): Promise<void> {
    return this.readiness;
  }

  /* ------------------------------ Internal ------------------------------ */

  /**
   * @internal Seal the graph and run it — the `ActorSystem` constructor's last
   * step.  Once only: a second call does nothing.
   *
   * Sealed synchronously, so nothing registered after `create` returns is ever
   * part of the run; but not one task runs inside `create`.  The first phase
   * starts a microtask later, after the statement that called `create` has
   * finished — a task that refers to the system through the very `const` its
   * registration sits in would otherwise meet that binding before it exists.
   */
  _start(onFailed: (reason: StartupFailedReason, error: Error) => void): void {
    if (this.sealed) return;
    this.sealed = true;
    if (!this.hasTasks) {
      this.completed = true;
      this.resolveReadiness();
      return;
    }
    this.running = true;
    void this.run(this.topologicalOrder(), onFailed).catch((error: unknown) => {
      this.endWithFailure(this.currentPhase ?? '(none)', { task: '(startup runner)', cause: error }, onFailed);
    });
  }

  /**
   * @internal Give up on a startup the system no longer wants: it is being
   * terminated while the graph still runs.
   *
   * Every running task's signal aborts, its budget is cleared on the spot, no
   * further phase starts, and {@link whenReady} rejects.  Not a failure — the
   * caller asked for the system to go — so it is logged at debug and starts no
   * shutdown of its own.  A no-op when the graph is not running.
   */
  _abandon(): void {
    if (!this.running) return;
    const phase = this.currentPhase;
    const error = new Error(
      phase === undefined
        ? 'Startup was abandoned: the system was terminated before its first phase began'
        : `Startup was abandoned: the system was terminated while phase "${phase}" was running`,
    );
    this.abandonment = error;
    this.running = false;
    for (const flight of [...this.inFlight]) this.abort(flight, error);
    this.system.log.debug(`[startup] ${error.message}`);
    this.rejectReadiness(error);
  }

  private async run(
    order: ReadonlyArray<string>,
    onFailed: (reason: StartupFailedReason, error: Error) => void,
  ): Promise<void> {
    await Promise.resolve();
    for (const phase of order) {
      if (this.abandonment !== undefined) return;
      this.currentPhase = phase;
      const failure = await this.runPhase(this.phases.get(phase)!);
      if (this.abandonment !== undefined) return;
      if (failure !== null) {
        this.endWithFailure(phase, failure, onFailed);
        return;
      }
    }
    this.running = false;
    this.currentPhase = undefined;
    this.completed = true;
    this.resolveReadiness();
  }

  private endWithFailure(
    phase: string,
    failure: StartupTaskFailure,
    onFailed: (reason: StartupFailedReason, error: Error) => void,
  ): void {
    if (!this.running) return;
    const error = new Error(
      `Startup task "${failure.task}" in phase "${phase}" failed: ${messageOf(failure.cause)}`,
      { cause: failure.cause },
    );
    this.running = false;
    this.failureError = error;
    this.rejectReadiness(error);
    onFailed(new StartupFailedReason(phase, failure.task, failure.cause), error);
  }

  /**
   * Run one phase's tasks together and answer with the failure that stops the
   * run, if any.
   *
   * In a phase that does not recover the first failure also aborts the other
   * tasks of the phase: the system is about to go down, and their work is for
   * nobody now.  The phase still waits for them, which costs nothing — a
   * task's outcome settles the moment its signal aborts, whether or not the
   * task itself listens — and leaves no budget armed behind the run.
   */
  private async runPhase(definition: PhaseDefinition): Promise<StartupTaskFailure | null> {
    const registered = [...(this.tasks.get(definition.name) ?? [])];
    if (registered.length === 0) return null;
    const launched = registered.map((entry) => this.launch(entry, definition));
    const result: { failure: StartupTaskFailure | null } = { failure: null };
    await Promise.all(launched.map(async ({ flight, outcome }) => {
      const failure = await outcome;
      if (failure === null || this.abandonment !== undefined) return;
      if (definition.recover) {
        this.system.log.warn(
          `[startup] task "${failure.task}" in phase "${definition.name}" failed and the phase recovers, `
          + `so startup goes on: ${messageOf(failure.cause)}`,
        );
        return;
      }
      if (result.failure !== null) return;
      result.failure = failure;
      const siblingFailed = new Error(
        `abandoned because task "${failure.task}" of phase "${definition.name}" failed`,
      );
      for (const other of launched) {
        if (other.flight !== flight) this.abort(other.flight, siblingFailed);
      }
    }));
    return result.failure;
  }

  /**
   * Start one task under its phase's budget.
   *
   * The budget is an unreferenced host timer, armed through the scheduler's
   * chain so a budget past the ~24.9-day ceiling of one `setTimeout` waits as
   * long as it says instead of firing at once; it is cleared on every way out.
   * Not the system's scheduler: a `ManualScheduler` in a test would freeze
   * every startup budget until somebody advanced it.
   */
  private launch(entry: RegisteredStartupTask, definition: PhaseDefinition): LaunchedStartupTask {
    const controller = new AbortController();
    const flight: StartupFlight = {
      controller,
      budget: armChainedTimeout(
        () => { controller.abort(new Error(`the phase's ${definition.timeoutMs} ms budget ran out`)); },
        definition.timeoutMs,
        unreferencedHostTimers,
      ),
    };
    this.inFlight.add(flight);
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => { reject(controller.signal.reason); }, { once: true });
    });
    const outcome = Promise.race([invoke(entry.task, controller.signal), aborted])
      .then(
        (): StartupTaskFailure | null => null,
        (cause: unknown): StartupTaskFailure | null => ({ task: entry.name, cause }),
      )
      .finally(() => {
        flight.budget.cancel();
        this.inFlight.delete(flight);
      });
    return { flight, outcome };
  }

  private abort(flight: StartupFlight, reason: Error): void {
    flight.budget.cancel();
    flight.controller.abort(reason);
  }

  private refuseOnceSealed(method: string): void {
    if (!this.sealed) return;
    throw new Error(
      `CoordinatedStartup.${method}: the startup graph was sealed when ActorSystem.create returned, so `
      + 'nothing added now would ever run — pass it to ActorSystemOptions.withCoordinatedStartup(...) instead',
    );
  }

  private register(phase: string, name: string, task: StartupTask): void {
    if (!this.phases.has(phase)) {
      throw new Error(`CoordinatedStartup: unknown phase "${phase}"`);
    }
    const list = this.tasks.get(phase) ?? [];
    if (list.some((registered) => registered.name === name)) {
      throw new Error(`CoordinatedStartup: task "${name}" already registered in phase "${phase}"`);
    }
    list.push({ name, task });
    this.tasks.set(phase, list);
  }

  /** The two canonical phases, in order, each depending on the one before; neither recovers. */
  private seedPhases(timeoutMs: number): void {
    const order: ReadonlyArray<string> = [StartupPhases.PersistenceStart, StartupPhases.BeforeSystemReady];
    order.forEach((name, index) => {
      this.phases.set(name, {
        name,
        timeoutMs,
        dependsOn: index === 0 ? [] : [order[index - 1]!],
        recover: false,
      });
    });
  }

  /**
   * Fold `actor-ts.coordinated-startup.phases` into the seeded graph, by the
   * shutdown block's rules — before the options' entries, which then replace
   * whatever this made of a phase they name.
   *
   * A child naming a seeded phase merges into it: what it sets replaces the
   * seeded value, what it leaves out keeps it, and `depends-on` is **added**
   * to the seeded edge.  Any other name declares a phase, which must name
   * `depends-on` — with no edge it would sort to the front — and recovers only
   * when it says so, the polarity of the two seeded phases.  A child may
   * depend on a seeded phase or on another child, never on a phase only the
   * code declares, so the block makes a graph of its own and a cycle in it is
   * the file's mistake, reported as one.
   *
   * Every refusal is a `ConfigError` naming the path, raised while `create`
   * runs rather than by the startup the mistake would break.
   */
  private applyConfiguredPhases(
    entries: ReadonlyArray<StartupPhaseConfiguration>,
    defaultPhaseTimeoutMs: number,
  ): void {
    if (entries.length === 0) return;
    const path = ConfigKeys.coordinatedStartup.phases;
    const named: ReadonlySet<string> = new Set(entries.map((entry) => entry.name));
    for (const entry of entries) this.checkConfiguredPhase(entry, path, named);
    for (const entry of entries) {
      const seeded = this.phases.get(entry.name);
      const added = (entry.dependsOn ?? []).filter((dependency) => !(seeded?.dependsOn.includes(dependency) ?? false));
      this.phases.set(entry.name, {
        name: entry.name,
        timeoutMs: entry.timeoutMs ?? seeded?.timeoutMs ?? defaultPhaseTimeoutMs,
        dependsOn: [...(seeded?.dependsOn ?? []), ...new Set(added)],
        recover: entry.recover ?? seeded?.recover ?? false,
      });
    }
    try {
      this.topologicalOrder();
    } catch (error) {
      throw new ConfigError(`${path}: the phases ${(error as Error).message}`);
    }
  }

  /** What one config child may not do, judged against the seeded phases and the block's other children. */
  private checkConfiguredPhase(entry: StartupPhaseConfiguration, path: string, named: ReadonlySet<string>): void {
    if (entry.timeoutMs !== undefined && !(entry.timeoutMs > 0)) {
      throw new ConfigError(
        `${path}.${entry.name}.timeout must be a positive duration, got ${entry.timeoutMs} ms — `
        + 'a phase with no budget fails every task it runs',
      );
    }
    for (const dependency of entry.dependsOn ?? []) {
      if (!this.phases.has(dependency) && !named.has(dependency)) {
        throw new ConfigError(
          `${path}.${entry.name}.depends-on names "${dependency}", which is neither a startup phase `
          + 'nor another phase declared here',
        );
      }
    }
    if (!this.phases.has(entry.name) && (entry.dependsOn ?? []).length === 0) {
      throw new ConfigError(
        `${path}.${entry.name} declares a new phase, so it must name depends-on: a phase with no `
        + `dependencies sorts to the front and would run before "${StartupPhases.PersistenceStart}"`,
      );
    }
  }

  /**
   * Fold the options' phase entries into the graph, over the seeded phases.
   *
   * An entry for a canonical phase merges: its timeout and `recover` replace
   * the seeded ones and its `dependsOn` is **added** to the seeded edge.  A
   * replacing form would let an options object run `before-system-ready`
   * ahead of `persistence-start`, and the sort below would not object — it
   * catches cycles and nothing else.  The validator has already checked every
   * name an entry depends on, so the declared phases can go in as they come.
   *
   * Merged over the *seed*, not over what the configuration made of the
   * phase: an entry is complete, so the code's definition of a phase wins
   * over the file's as a whole — explicit options above HOCON, the order every
   * setting follows.
   */
  private applyPhaseEntries(
    entries: ReadonlyArray<PhaseDefinition>,
    seeded: ReadonlyMap<string, PhaseDefinition>,
  ): void {
    for (const entry of entries) {
      const base = seeded.get(entry.name);
      const added = entry.dependsOn.filter((dependency) => !(base?.dependsOn.includes(dependency) ?? false));
      this.phases.set(entry.name, {
        name: entry.name,
        timeoutMs: entry.timeoutMs,
        dependsOn: [...(base?.dependsOn ?? []), ...new Set(added)],
        recover: entry.recover,
      });
    }
  }

  /** A graph that ties itself in a knot is an options mistake, so `create` refuses it. */
  private refuseCycles(): void {
    try {
      this.topologicalOrder();
    } catch (error) {
      throw new OptionsError(
        `CoordinatedStartupOptions: phases ${(error as Error).message}`,
        'CoordinatedStartupOptions',
        'phases',
      );
    }
  }

  /**
   * Kahn-style topological sort over the phase graph, ties broken by name so
   * the order never depends on the order phases were declared in — the same
   * rule `CoordinatedShutdown` sorts its pipeline by.
   */
  private topologicalOrder(): string[] {
    const remaining = new Map<string, ReadonlyArray<string>>();
    for (const [name, definition] of this.phases) remaining.set(name, definition.dependsOn);
    const order: string[] = [];
    while (remaining.size > 0) {
      const ready = [...remaining]
        .filter(([, dependencies]) => dependencies.length === 0)
        .map(([name]) => name)
        .sort();
      if (ready.length === 0) {
        throw new Error(`depend on each other in a cycle: ${[...remaining.keys()].sort().join(', ')}`);
      }
      const done = new Set(ready);
      for (const name of ready) {
        order.push(name);
        remaining.delete(name);
      }
      for (const [name, dependencies] of remaining) {
        remaining.set(name, dependencies.filter((dependency) => !done.has(dependency)));
      }
    }
    return order;
  }
}

/** Run a task so that a synchronous throw arrives as a rejection, like every other failure. */
async function invoke(task: StartupTask, signal: AbortSignal): Promise<void> {
  await task(signal);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * ExtensionId — `system.extension(CoordinatedStartupId)` answers the graph the
 * system was built with.
 *
 * The factory refuses rather than builds: the `ActorSystem` constructor puts
 * the instance in place before anything can ask for it, and a graph made on
 * demand would never be started, so a `whenReady()` from it would never
 * settle.
 */
export const CoordinatedStartupId: ExtensionId<CoordinatedStartup> = extensionId<CoordinatedStartup>(
  'CoordinatedStartup',
  () => {
    throw new Error(
      'CoordinatedStartup is built by the ActorSystem constructor from ActorSystemOptions.withCoordinatedStartup '
      + 'and cannot be created on demand',
    );
  },
);
