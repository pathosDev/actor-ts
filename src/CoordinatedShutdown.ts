import type { ActorSystem } from './ActorSystem.js';
import { extensionId, type Extension, type ExtensionId } from './Extension.js';

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

export interface PhaseDefinition {
  readonly name: string;
  readonly timeoutMs: number;
  /** Names of phases that must run before this one. */
  readonly dependsOn: ReadonlyArray<string>;
  /** If true, task failures halt the pipeline.  Defaults to false. */
  readonly recover: boolean;
}

interface RegisteredTask {
  readonly name: string;
  readonly task: ShutdownTask;
}

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
  private _processHookSignals: NodeJS.Signals[] = [];

  /**
   * Default per-phase timeout in ms.  Can be changed globally or per-phase
   * via `setPhaseTimeout`.  5 seconds is a reasonable balance between
   * letting slow tasks finish and not blocking shutdown indefinitely.
   */
  defaultPhaseTimeoutMs = 5_000;

  constructor(private readonly system: ActorSystem) {
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
    // Built-in terminator in the final phase.
    this.addTask(Phases.ActorSystemTerminate, 'terminate-actor-system', async () => {
      if (!this.system.isTerminated) await this.system.terminate();
    });
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
    const p = this.phases.get(phase);
    if (!p) throw new Error(`Unknown phase: ${phase}`);
    this.phases.set(phase, { ...p, timeoutMs });
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
      this._processHookSignals.push(sig);
    }
    this._processHooksInstalled = true;
  }

  removeProcessHooks(): void {
    if (!this._processHooksInstalled) return;
    if (typeof process === 'undefined') return;
    for (const sig of this._processHookSignals) {
      process.removeAllListeners(sig);
    }
    this._processHooksInstalled = false;
    this._processHookSignals = [];
  }

  /* ------------------------------- Internal ------------------------------ */

  private async _run(reason: Reason): Promise<void> {
    this._running = true;
    const order = this.topologicalOrder();
    for (const phase of order) {
      await this.runPhase(phase, reason);
    }
    this._completed = true;
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
          const idx = deps.indexOf(done);
          if (idx >= 0) deps.splice(idx, 1);
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
