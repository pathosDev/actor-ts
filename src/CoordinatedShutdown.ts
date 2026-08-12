import type { ActorSystem } from './ActorSystem.js';
import { ConfigKeys } from './config/ConfigKeys.js';
import { extensionId, type Extension, type ExtensionId } from './Extension.js';
import { DEFAULT_PHASE_TIMEOUT_MS } from './Constants.js';

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
/** Received SIGTERM / SIGINT from the process. */
export class ProcessTerminateReason extends Reason {
  constructor(public readonly signal: NodeJS.Signals) { super(); }
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
  private _runPromise: Promise<void> | null = null;
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
  private _processHooks: { signal: NodeJS.Signals; handler: () => void }[] = [];

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

  /** Call `process.exit(0)` once the pipeline completes.  Off by default. */
  private readonly exitProcess: boolean;

  constructor(private readonly system: ActorSystem) {
    const config = system.config;
    const keys = ConfigKeys.coordinatedShutdown;
    if (config.hasPath(keys.defaultPhaseTimeout)) {
      this.defaultPhaseTimeoutMs = config.getDuration(keys.defaultPhaseTimeout);
    }
    this.exitProcess = config.hasPath(keys.exitProcess)
      ? config.getBoolean(keys.exitProcess)
      : false;
    const terminateActorSystem = config.hasPath(keys.terminateActorSystem)
      ? config.getBoolean(keys.terminateActorSystem)
      : true;

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
    // Built-in terminator in the final phase.  Opting out leaves the phase
    // in place — user tasks registered there still run — and hands the
    // system's lifetime back to the embedder, which is the point: a host
    // process that owns the system does not want a signal handler killing it.
    if (terminateActorSystem) {
      this.addTask(Phases.ActorSystemTerminate, 'terminate-actor-system', async () => {
        if (!this.system.isTerminated) await this.system.terminate();
      });
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
   * Run the pipeline.  Safe to call from multiple sites — subsequent calls
   * return the same in-flight promise.
   */
  run(reason: Reason = UnknownReason.instance): Promise<void> {
    if (this._runPromise) return this._runPromise;
    this._runPromise = this._run(reason);
    return this._runPromise;
  }

  /**
   * Install SIGTERM / SIGINT handlers that call `run(ProcessTerminateReason)`.
   * Calling twice is harmless.  Uninstall via `removeProcessHooks`.
   */
  installProcessHooks(signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT']): void {
    if (this._processHooksInstalled) return;
    if (typeof process === 'undefined' || typeof process.on !== 'function') return;
    for (const sig of signals) {
      const handler = (): void => {
        void this.run(new ProcessTerminateReason(sig));
      };
      process.on(sig, handler);
      this._processHooks.push({ signal: sig, handler });
    }
    this._processHooksInstalled = true;
  }

  removeProcessHooks(): void {
    if (!this._processHooksInstalled) return;
    if (typeof process === 'undefined') return;
    // Remove exactly what was installed.  A shutdown hook has no business
    // deciding that nobody else may listen for SIGTERM.
    for (const { signal, handler } of this._processHooks) {
      process.off(signal, handler);
    }
    this._processHooksInstalled = false;
    this._processHooks = [];
  }

  /* ------------------------------- Internal ------------------------------ */

  private async _run(reason: Reason): Promise<void> {
    this._running = true;
    const order = this.topologicalOrder();
    for (const phase of order) {
      await this.runPhase(phase, reason);
    }
    this._completed = true;
    // Last thing, and only when asked: a lingering handle (an open socket, a
    // pooled DB connection a driver never released) otherwise keeps the
    // process alive long after the pipeline is done, and the operator has no
    // way to tell "shutting down" from "hung".  `_completed` is already set,
    // so anything awaiting `run()` observes success even though this call
    // does not return.
    if (this.exitProcess && typeof process !== 'undefined' && typeof process.exit === 'function') {
      process.exit(0);
    }
  }

  private async runPhase(phase: string, reason: Reason): Promise<void> {
    const def = this.phases.get(phase)!;
    const tasks = this.tasks.get(phase) ?? [];
    if (tasks.length === 0) return;

    const promises = tasks.map(t => this.runOneTask(t, def, reason));
    if (def.recover) {
      await Promise.all(promises.map(p => p.catch(() => {})));
    } else {
      await Promise.all(promises);
    }
  }

  private async runOneTask(t: RegisteredTask, def: PhaseDefinition, reason: Reason): Promise<void> {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(
        new Error(`Shutdown task "${t.name}" in phase "${def.name}" timed out after ${def.timeoutMs}ms`),
      ), def.timeoutMs);
      (timeoutHandle as { unref?: () => void }).unref?.();
    });
    try {
      await Promise.race([Promise.resolve(t.task(reason)), timeout]);
    } catch (e) {
      this.system.log.warn(
        `[shutdown] task "${t.name}" in phase "${def.name}" failed: ${(e as Error).message}`,
      );
      if (!def.recover) throw e;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
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

/** ExtensionId — use via `system.extension(CoordinatedShutdownId)`. */
export const CoordinatedShutdownId: ExtensionId<CoordinatedShutdown> = extensionId(
  'CoordinatedShutdown',
  (system) => new CoordinatedShutdown(system),
);
