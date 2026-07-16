import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { FailureDetectorOptionsType } from '../cluster/FailureDetectorOptions.js';
import type { LogLevel } from '../Logger.js';

type AddressMap = Readonly<Record<string, { host: string; port: number }>>;

/** Plain options-object shape accepted by a {@link ParallelMultiNodeSpec}. */
export interface ParallelMultiNodeSpecOptionsType {
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
}

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

  /** URL of the bootstrap script.  Defaults to the bundled one. */
  withBootstrapModule(bootstrapModule: URL): this {
    return this.set('bootstrapModule', bootstrapModule);
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
