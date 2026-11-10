import type { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/**
 * How long one health check may take before the registry answers for it.
 *
 * One second, because the deadline exists to keep a *probe response* moving,
 * not to bound the work a check does.  Kubernetes' own `timeoutSeconds`
 * defaults to 1 s and its failure is a restart or an eviction; a per-check
 * budget at or above that would let the orchestrator time out first, which is
 * the outcome this deadline exists to prevent — the aggregate would then carry
 * no information about *which* check hung.  Raise it in a deployment whose
 * probe timeout is genuinely higher.
 */
export const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 1_000;

/** Plain options-object shape accepted by `HealthCheckRegistry`. */
export type HealthCheckRegistryOptionsType = {
  /** Deadline for a single liveness or readiness check, in milliseconds. */
  readonly checkTimeoutMs?: number;
};

/** Fluent builder for {@link HealthCheckRegistryOptionsType}. */
export class HealthCheckRegistryOptionsBuilder extends OptionsBuilder<HealthCheckRegistryOptionsType> {
  /** Start a fresh builder. */
  static create(): HealthCheckRegistryOptionsBuilder {
    return new HealthCheckRegistryOptionsBuilder();
  }

  /** Deadline for a single check, in milliseconds. */
  withCheckTimeoutMs(checkTimeoutMs: number): this {
    return this.set('checkTimeoutMs', checkTimeoutMs);
  }
}

/**
 * Accepted input for `HealthCheckRegistry`: the fluent
 * {@link HealthCheckRegistryOptionsBuilder} OR a plain
 * {@link HealthCheckRegistryOptionsType} object.
 */
export type HealthCheckRegistryOptions =
  | HealthCheckRegistryOptionsBuilder
  | Partial<HealthCheckRegistryOptionsType>;
/** Value alias so `HealthCheckRegistryOptions.create()` resolves to the builder. */
export const HealthCheckRegistryOptions = HealthCheckRegistryOptionsBuilder;

/**
 * `positiveInt` rather than `nonNegativeInt`: a `0` ms deadline would expire
 * before any check could answer, so every probe would report every check as
 * timed out — there is no "disabled" reading of zero to preserve, and a
 * deployment that wants no deadline wants a large one, which it can say.
 */
export class HealthCheckRegistryOptionsValidator extends OptionsValidator<HealthCheckRegistryOptionsType> {
  constructor() {
    super('HealthCheckRegistryOptions');
  }

  protected rules(): void {
    this.positiveInt('checkTimeoutMs');
  }
}

/**
 * Read `actor-ts.management.health-checks.*` into the shape the per-system
 * registry is built with.  Only keys actually present are returned, so an
 * absent one falls through to {@link DEFAULT_HEALTH_CHECK_TIMEOUT_MS} instead
 * of landing as an explicit `undefined` and shadowing it.
 *
 * A separate reader from `readManagementRoutesOptionsFromConfig` even though
 * both live under `actor-ts.management`: the registry exists from the first
 * `healthChecksOf(system)` call, which is typically long before anything
 * builds a route tree, and the two consumers therefore read at different
 * moments in a system's life.
 */
export function readHealthCheckRegistryOptionsFromConfig(
  config: Config,
): Partial<HealthCheckRegistryOptionsType> {
  const keys = ConfigKeys.management.healthChecks;
  const out: {
    -readonly [K in keyof HealthCheckRegistryOptionsType]?: HealthCheckRegistryOptionsType[K]
  } = {};
  if (config.hasPath(keys.checkTimeout)) out.checkTimeoutMs = config.getDuration(keys.checkTimeout);
  return out;
}
