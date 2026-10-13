import type { PhaseDefinition } from './CoordinatedShutdown.js';
import { OptionsBuilder } from './util/OptionsBuilder.js';
import { OptionsValidator } from './util/OptionsValidator.js';

/**
 * The budget each startup phase starts with: 30 seconds.
 *
 * It is what bounds a task that has no deadline of its own.  Opening a
 * connection waits as long as the driver lets it, several drivers leave that
 * unset, and a host that drops packets rather than refusing them never
 * answers at all — so without a phase budget a mistyped address would hold
 * `whenReady()` pending and the readiness check false for as long as the
 * process lives, with nothing in the log.  Thirty seconds outlasts a cold
 * connection pool on a slow network and still fails a deployment that will
 * never come up while somebody is watching it roll out.
 */
export const DEFAULT_STARTUP_PHASE_TIMEOUT_MS = 30_000;

/**
 * The startup phases every system has, run in this order.
 *
 * Declared here rather than beside `CoordinatedStartup`, which re-exports it:
 * the validator below refuses a task naming any other phase, and an options
 * file may not import the extension it configures.
 */
export const StartupPhases = {
  /** Open what persistence needs — the journal, the snapshot store, the durable-state store. */
  PersistenceStart: 'persistence-start',
  /** Everything else that has to hold before the system is ready: a migration, a warmed cache. */
  BeforeSystemReady: 'before-system-ready',
} as const;

/**
 * One unit of startup work.
 *
 * The signal aborts when the task's phase runs out of budget, when another
 * task of a phase that does not recover fails, and when the system is
 * terminated while startup is still running — so a task that hands it to
 * whatever it waits on (`fetch`, a driver that takes one) stops instead of
 * finishing for nobody.  A task that ignores it is abandoned all the same:
 * its phase does not wait for it.
 */
export type StartupTask = (signal: AbortSignal) => Promise<void> | void;

/** A task, the phase it runs in, and its name — unique within the phase. */
export type StartupTaskRegistration = {
  readonly phase: string;
  readonly name: string;
  readonly task: StartupTask;
};

/** Plain options-object shape of the startup graph. */
export type CoordinatedStartupOptionsType = {
  /** Budget of every phase that does not name its own, in milliseconds. */
  readonly defaultPhaseTimeoutMs?: number;
  /**
   * Phases to retime or to add.  An entry named after a phase of
   * {@link StartupPhases} merges into it: its `timeoutMs` and `recover`
   * replace the seeded ones and its `dependsOn` is added to the seeded edge,
   * never a replacement — so the two canonical phases cannot be re-ordered.
   * Any other name declares a new phase, which must say what it runs after.
   */
  readonly phases?: ReadonlyArray<PhaseDefinition>;
  /** The tasks the graph runs. */
  readonly tasks?: ReadonlyArray<StartupTaskRegistration>;
};

/** Fluent builder for {@link CoordinatedStartupOptionsType}. */
export class CoordinatedStartupOptionsBuilder extends OptionsBuilder<CoordinatedStartupOptionsType> {
  /** Start a fresh builder. */
  static create(): CoordinatedStartupOptionsBuilder {
    return new CoordinatedStartupOptionsBuilder();
  }

  /** Budget of every phase that does not name its own, in milliseconds. */
  withDefaultPhaseTimeoutMs(defaultPhaseTimeoutMs: number): this {
    return this.set('defaultPhaseTimeoutMs', defaultPhaseTimeoutMs);
  }

  /** Phases to retime or to add — see {@link CoordinatedStartupOptionsType.phases}. */
  withPhases(phases: ReadonlyArray<PhaseDefinition>): this {
    return this.set('phases', phases);
  }

  /** The tasks the graph runs. */
  withTasks(tasks: ReadonlyArray<StartupTaskRegistration>): this {
    return this.set('tasks', tasks);
  }
}

/**
 * Accepted input for `ActorSystemOptions.withCoordinatedStartup`: the fluent
 * {@link CoordinatedStartupOptionsBuilder} OR a plain
 * {@link CoordinatedStartupOptionsType} object.
 */
export type CoordinatedStartupOptions =
  | CoordinatedStartupOptionsBuilder
  | Partial<CoordinatedStartupOptionsType>;
/** Value alias so `CoordinatedStartupOptions.create()` resolves to the builder. */
export const CoordinatedStartupOptions = CoordinatedStartupOptionsBuilder;

/**
 * Everything about the graph that can be judged from the options alone, so a
 * mistake fails `ActorSystem.create` rather than the startup it would break.
 *
 * A phase graph that ties itself in a knot is the one thing left to the
 * extension, which is where the graph is put together.
 */
export class CoordinatedStartupOptionsValidator extends OptionsValidator<CoordinatedStartupOptionsType> {
  constructor() {
    super('CoordinatedStartupOptions');
  }

  protected rules(s: Partial<CoordinatedStartupOptionsType>): void {
    this.positiveNumber('defaultPhaseTimeoutMs');
    const known = this.checkPhases(s.phases ?? []);
    this.checkTasks(s.tasks ?? [], known);
  }

  /** Check the phase entries and answer with every phase name a task may use. */
  private checkPhases(phases: ReadonlyArray<PhaseDefinition>): ReadonlySet<string> {
    const canonical: ReadonlySet<string> = new Set(Object.values(StartupPhases));
    const named = new Set<string>();
    phases.forEach((phase, index) => {
      const field = `phases[${index}]`;
      if (typeof phase.name !== 'string' || phase.name === '') {
        this.fail(`${field}.name`, 'must be a non-empty string', phase.name);
      }
      if (typeof phase.timeoutMs !== 'number' || !Number.isFinite(phase.timeoutMs) || phase.timeoutMs <= 0) {
        this.fail(`${field}.timeoutMs`, 'must be a positive finite number', phase.timeoutMs);
      }
      if (typeof phase.recover !== 'boolean') {
        this.fail(`${field}.recover`, 'must be a boolean', phase.recover);
      }
      if (!Array.isArray(phase.dependsOn)) {
        this.fail(`${field}.dependsOn`, 'must be a list of phase names', phase.dependsOn);
      }
      // Two entries for one phase would leave which of them counts to the order
      // they happen to be listed in.
      if (named.has(phase.name)) {
        this.fail(`${field}.name`, 'names a phase another entry already names', phase.name);
      }
      if (!canonical.has(phase.name) && phase.dependsOn.length === 0) {
        this.fail(
          `${field}.dependsOn`,
          'must name the phase it runs after: an entry with a new name declares a phase, and one '
          + `with no dependencies would sort to the front and run before "${StartupPhases.PersistenceStart}"`,
          phase.dependsOn,
        );
      }
      named.add(phase.name);
    });
    const known: ReadonlySet<string> = new Set([...canonical, ...named]);
    phases.forEach((phase, index) => {
      for (const dependency of phase.dependsOn) {
        if (!known.has(dependency)) {
          this.fail(
            `phases[${index}].dependsOn`,
            `names "${dependency}", which is neither a startup phase nor one declared here`,
            phase.dependsOn,
          );
        }
      }
    });
    return known;
  }

  private checkTasks(tasks: ReadonlyArray<StartupTaskRegistration>, known: ReadonlySet<string>): void {
    const namesByPhase = new Map<string, Set<string>>();
    tasks.forEach((registration, index) => {
      const field = `tasks[${index}]`;
      if (!known.has(registration.phase)) {
        this.fail(
          `${field}.phase`,
          `names an unknown phase — a task runs in one of ${[...known].join(', ')}`,
          registration.phase,
        );
      }
      if (typeof registration.name !== 'string' || registration.name === '') {
        this.fail(`${field}.name`, 'must be a non-empty string', registration.name);
      }
      if (typeof registration.task !== 'function') {
        this.fail(`${field}.task`, 'must be a function', typeof registration.task);
      }
      const names = namesByPhase.get(registration.phase) ?? new Set<string>();
      if (names.has(registration.name)) {
        this.fail(
          `${field}.name`,
          `is already registered in phase "${registration.phase}" — task names are unique within a phase`,
          registration.name,
        );
      }
      names.add(registration.name);
      namesByPhase.set(registration.phase, names);
    });
  }
}
