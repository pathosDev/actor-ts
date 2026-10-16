import type { Config } from './config/Config.js';
import { ConfigKeys } from './config/ConfigKeys.js';
import { readPhaseOverrides, type PhaseDefinition, type PhaseOverride } from './CoordinatedShutdown.js';
import { OptionsBuilder } from './util/OptionsBuilder.js';
import { OptionsValidator } from './util/OptionsValidator.js';

/**
 * The budget each startup phase starts with: 30 seconds, published as
 * `actor-ts.coordinated-startup.default-phase-timeout`.
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

/**
 * Plain options-object shape of the startup graph.
 *
 * Layered over `actor-ts.coordinated-startup` — see
 * {@link readCoordinatedStartupOptionsFromConfig} — and over the built-in
 * defaults, field by field.
 */
export type CoordinatedStartupOptionsType = {
  /** Budget of every phase that does not name its own, in milliseconds. */
  readonly defaultPhaseTimeoutMs?: number;
  /**
   * Phases to retime or to add.  An entry named after a phase of
   * {@link StartupPhases} merges into it: its `timeoutMs` and `recover`
   * replace the seeded ones and its `dependsOn` is added to the seeded edge,
   * never a replacement — so the two canonical phases cannot be re-ordered.
   * Any other name declares a new phase, which must say what it runs after.
   *
   * An entry is complete, so it wins over the configuration's child for the
   * same phase as a whole; the children for the phases it does not name
   * still apply.
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
  /**
   * @param configuredPhases the phases `actor-ts.coordinated-startup.phases`
   *   names.  A task and an entry's `dependsOn` may name one of them too: a
   *   phase the configuration declares is only worth declaring if a task can
   *   run in it.
   */
  constructor(private readonly configuredPhases: ReadonlyArray<string> = []) {
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
    const known: ReadonlySet<string> = new Set([...canonical, ...named, ...this.configuredPhases]);
    phases.forEach((phase, index) => {
      for (const dependency of phase.dependsOn) {
        if (!known.has(dependency)) {
          this.fail(
            `phases[${index}].dependsOn`,
            `names "${dependency}", which is neither a startup phase nor one declared here or in `
            + ConfigKeys.coordinatedStartup.phases,
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

/**
 * One child of `actor-ts.coordinated-startup.phases`, each setting absent
 * when the child leaves it out — so a child that only retimes a phase keeps
 * the `recover` and `dependsOn` the phase already has instead of having them
 * blanked.
 */
export type StartupPhaseConfiguration = {
  readonly name: string;
  /** `timeout`: the phase's budget. */
  readonly timeoutMs?: number;
  /** `recover`: whether a failing task is logged and stepped over rather than failing the startup. */
  readonly recover?: boolean;
  /** `depends-on`: the phases that run first. */
  readonly dependsOn?: ReadonlyArray<string>;
};

/**
 * What `actor-ts.coordinated-startup` says, each part absent when unset.
 *
 * Not the options type itself, because a configured phase is a partial one:
 * a {@link PhaseDefinition} carries every setting, while a config child
 * carries only the ones it changes, and the rest come from the phase it
 * merges into — which only the graph knows.
 */
export type CoordinatedStartupConfiguration = {
  /** `default-phase-timeout`: the budget of every phase that names none of its own. */
  readonly defaultPhaseTimeoutMs?: number;
  /** `phases`: the phases to retime or to add, in the order the block lists them. */
  readonly phases?: ReadonlyArray<StartupPhaseConfiguration>;
};

/**
 * Read `actor-ts.coordinated-startup`, leaving an unset part absent rather
 * than defaulting it in; `CoordinatedStartup` layers the result under the
 * options set in code and over the built-in defaults.
 *
 * The `phases` children go through the shutdown block's own reader, so the
 * two blocks refuse the same mistakes — a setting other than `timeout`,
 * `recover` or `depends-on`, a child that is a bare value — with a
 * `ConfigError` naming the path.  Which children declare a phase, and whether
 * the result ties itself in a knot, is the graph's to judge: it is the one
 * that knows the phases already there.
 */
export function readCoordinatedStartupOptionsFromConfig(config: Config): CoordinatedStartupConfiguration {
  const keys = ConfigKeys.coordinatedStartup;
  const out: {
    -readonly [K in keyof CoordinatedStartupConfiguration]?: CoordinatedStartupConfiguration[K]
  } = {};
  if (config.hasPath(keys.defaultPhaseTimeout)) {
    out.defaultPhaseTimeoutMs = config.getDuration(keys.defaultPhaseTimeout);
  }
  if (config.hasPath(keys.phases)) {
    out.phases = readPhaseOverrides(config, keys.phases).map(phaseConfigurationOf);
  }
  return out;
}

/** A shutdown-shaped override, with the settings it leaves unset omitted rather than `undefined`. */
function phaseConfigurationOf(override: PhaseOverride): StartupPhaseConfiguration {
  return {
    name: override.name,
    ...(override.timeoutMs === undefined ? {} : { timeoutMs: override.timeoutMs }),
    ...(override.recover === undefined ? {} : { recover: override.recover }),
    ...(override.dependsOn === undefined ? {} : { dependsOn: override.dependsOn }),
  };
}
