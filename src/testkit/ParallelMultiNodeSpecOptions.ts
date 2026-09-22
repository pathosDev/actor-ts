import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import { checkWorkerModuleUrl } from '../worker/WorkerClusterOptions.js';
import type { FailureDetectorOptionsType } from '../cluster/FailureDetectorOptions.js';
import type { LogLevel } from '../Logger.js';
import type { WorkerBackend } from '../runtime/worker/index.js';

type AddressMap = Readonly<Record<string, { host: string; port: number }>>;

/** Plain options-object shape accepted by a {@link ParallelMultiNodeSpec}. */
export type ParallelMultiNodeSpecOptionsType = {
  readonly roles: ReadonlyArray<string>;
  readonly seedRoles?: ReadonlyArray<string>;
  /** URL of the scenario module loaded in each worker.  Optional. */
  readonly scenarioModule?: URL;
  /** Per-role data passed to the scenario module's `setup(context)`. */
  readonly scenarioInitDataFor?: (role: string) => unknown;
  readonly addresses?: AddressMap;
  readonly failureDetector?: Partial<FailureDetectorOptionsType>;
  readonly gossipIntervalMs?: number;
  readonly awaitTimeoutMs?: number;
  readonly logLevel?: LogLevel;
  /** URL of the bootstrap script.  Defaults to the bundled one. */
  readonly bootstrapModule?: URL;
  /** Backend the roles spawn through.  Defaults to the detected one. */
  readonly backend?: WorkerBackend;
};

/** Fluent builder for {@link ParallelMultiNodeSpecOptionsType}. */
export class ParallelMultiNodeSpecOptionsBuilder extends OptionsBuilder<ParallelMultiNodeSpecOptionsType> {
  /** Start a fresh builder. */
  static create(): ParallelMultiNodeSpecOptionsBuilder {
    return new ParallelMultiNodeSpecOptionsBuilder();
  }

  /** Role names; must be unique.  Required. */
  withRoles(roles: ReadonlyArray<string>): this {
    return this.set('roles', roles);
  }

  /** Roles that act as bootstrap seeds. */
  withSeedRoles(seedRoles: ReadonlyArray<string>): this {
    return this.set('seedRoles', seedRoles);
  }

  /** URL of the scenario module loaded in each worker. */
  withScenarioModule(scenarioModule: URL): this {
    return this.set('scenarioModule', scenarioModule);
  }

  /** Per-role data passed to the scenario module's `setup(context)`. */
  withScenarioInitDataFor(scenarioInitDataFor: (role: string) => unknown): this {
    return this.set('scenarioInitDataFor', scenarioInitDataFor);
  }

  /** Per-role address overrides. */
  withAddresses(addresses: AddressMap): this {
    return this.set('addresses', addresses);
  }

  /** Failure-detector overrides. */
  withFailureDetector(failureDetector: Partial<FailureDetectorOptionsType>): this {
    return this.set('failureDetector', failureDetector);
  }

  /** Gossip interval in ms. */
  withGossipIntervalMs(gossipIntervalMs: number): this {
    return this.set('gossipIntervalMs', gossipIntervalMs);
  }

  /** `await*` helper timeout in ms. */
  withAwaitTimeoutMs(awaitTimeoutMs: number): this {
    return this.set('awaitTimeoutMs', awaitTimeoutMs);
  }

  /** Log level. */
  withLogLevel(logLevel: LogLevel): this {
    return this.set('logLevel', logLevel);
  }

  /**
   * URL of the bootstrap script.  Defaults to the bundled one.
   *
   * Held to the allow-list every worker entry in the framework is held to —
   * an absolute, host-less `file:` URL naming a file — because it is the same
   * kind of thing: a module a worker thread will execute.  See
   * {@link ParallelMultiNodeSpecOptionsValidator}.
   */
  withBootstrapModule(bootstrapModule: URL): this {
    return this.set('bootstrapModule', bootstrapModule);
  }

  /**
   * Spawn the roles through this backend instead of the one
   * `getWorkerBackend()` picks for the current runtime — the same seam
   * {@link WorkerClusterOptionsBuilder.withBackend} opens, kept here so
   * a spec can drive fake workers without mocking a module (#520).
   */
  withBackend(backend: WorkerBackend): this {
    return this.set('backend', backend);
  }
}

/**
 * Validates resolved {@link ParallelMultiNodeSpecOptionsType} settings.
 *
 * The harness had none, which is the asymmetry #1508 records: the two sibling
 * fixes of one wave landed unevenly, and this copy of the worker handshake
 * took #775's first-hello latch but not #776's constraint on what a worker may
 * be told to execute.  `bootstrapModule` went straight to `backend.spawn`,
 * so a `data:`, `http:` or `file://a-server/…` specifier that
 * `WorkerClusterOptionsValidator` refuses reached a real worker thread here.
 *
 * A developer-controlled harness is a weaker threat model than an application,
 * and that is the argument for leaving it alone — but it is not an argument
 * for the two spellings differing, and the rule costs one call now that the
 * allow-list is one shared helper instead of four copies (#1515).
 */
export class ParallelMultiNodeSpecOptionsValidator
  extends OptionsValidator<ParallelMultiNodeSpecOptionsType> {
  constructor() {
    super('ParallelMultiNodeSpecOptions');
  }

  protected rules(s: Partial<ParallelMultiNodeSpecOptionsType>): void {
    // Unset is the ordinary case — it keeps the bundled bootstrap — so this
    // stays a no-op on `undefined`, like every check helper.
    if (s.bootstrapModule === undefined) return;
    const rejection = checkWorkerModuleUrl(s.bootstrapModule);
    if (rejection !== undefined) this.fail('bootstrapModule', rejection.reason, rejection.value);
  }
}

/**
 * Accepted input for a {@link ParallelMultiNodeSpec}: the fluent
 * {@link ParallelMultiNodeSpecOptionsBuilder} OR a plain
 * {@link ParallelMultiNodeSpecOptionsType}.
 */
export type ParallelMultiNodeSpecOptions =
  | ParallelMultiNodeSpecOptionsBuilder
  | Partial<ParallelMultiNodeSpecOptionsType>;
/** Value alias so `ParallelMultiNodeSpecOptions.create()` resolves to the builder. */
export const ParallelMultiNodeSpecOptions = ParallelMultiNodeSpecOptionsBuilder;
