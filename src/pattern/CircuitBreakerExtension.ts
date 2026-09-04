import type { ActorSystem } from '../ActorSystem.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { extensionId, type Extension, type ExtensionId } from '../Extension.js';
import { mergeOptions } from '../util/OptionsMerge.js';
import { CircuitBreaker } from './CircuitBreaker.js';
import {
  circuitBreakerKeysUnder,
  DEFAULT_CIRCUIT_BREAKER_MAX_FAILURES,
  DEFAULT_CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
  readCircuitBreakerOptionsFromConfig,
} from './CircuitBreakerOptions.js';
import type { CircuitBreakerOptions, CircuitBreakerOptionsType } from './CircuitBreakerOptions.js';

/**
 * The id {@link CircuitBreakerExtension.breaker} resolves with no argument,
 * and the reserved name of the defaults block under
 * `actor-ts.circuit-breaker`.
 *
 * Reserving it costs nothing, because the two readings coincide: the block
 * that configures every breaker *is* the block that configures the default
 * breaker.  No other id can reach it and it can reach no other id's block, so
 * a per-breaker block never shadows the defaults and the defaults never
 * shadow a per-breaker block — which is the property the alternative shape,
 * defaults at the block root with ids beside them, cannot have.  There
 * `breaker('random-factor')` would look for its settings inside a number.
 */
export const DEFAULT_CIRCUIT_BREAKER_ID = 'default';

/**
 * The floor under both config layers.  Only the two fields the constructor
 * refuses to invent are here: every other default lives at its read site in
 * {@link CircuitBreaker}, so the number has one home rather than two — the
 * same split `CacheExtension` makes when it passes `{}` and lets
 * `InMemoryCache` own its own defaults.
 *
 * These two cannot follow that rule, because `new CircuitBreaker({})` throws
 * on purpose: a breaker with no failure budget and no reset window would
 * silently never open and never probe.  What the extension adds is a
 * configuration file underneath, so it is the door that can supply a floor
 * without inventing one.
 */
const CIRCUIT_BREAKER_BUILT_IN_DEFAULTS: Partial<CircuitBreakerOptionsType> = {
  maxFailures: DEFAULT_CIRCUIT_BREAKER_MAX_FAILURES,
  resetTimeoutMs: DEFAULT_CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
};

/**
 * System-wide registry for named circuit breakers.
 *
 * `new CircuitBreaker({...})` is unchanged and remains the door for a breaker
 * whose settings live in code.  What this adds is the other door: a breaker
 * resolved by id, whose numbers an operator can change in
 * `application.conf` without a deploy, and whose *state* outlives the actor
 * that uses it — which is what the "don't share a breaker across an actor
 * restart" advice on the pattern page has been asking for.
 *
 *     const breaker = system.extension(CircuitBreakerExtensionId).breaker('payment-api');
 *
 * **Each id is a separate instance with separate settings**, layered in the
 * project's precedence order: `actor-ts.circuit-breaker.<id>.*` over
 * `actor-ts.circuit-breaker.default.*` over the built-in floor, leaf by leaf,
 * with explicit options above all three.  Two consumers that trip
 * independently is the whole of the one-breaker-per-dependency advice, applied
 * to a place where it can be configured rather than only recommended.
 */
export class CircuitBreakerExtension implements Extension {
  private readonly instances = new Map<string, CircuitBreaker>();

  constructor(private readonly system: ActorSystem) {}

  /**
   * The breaker configured as `id`, created on first use and cached after.
   *
   * `explicitOptions` sits above both config layers and is read **once**, when
   * the instance is created — a second `breaker(id)` with different options
   * returns the instance that already exists rather than reconfiguring it,
   * the same contract `CacheExtension.cache(name)` has.  Options a config file
   * cannot express (`isFailure`, `random`) are what it is for.
   *
   * Values from either block are validated when the breaker is constructed, so
   * a typo'd override throws `OptionsError` at the first `breaker(id)` rather
   * than leaving that one instance quietly running the framework defaults.
   */
  breaker(id: string = DEFAULT_CIRCUIT_BREAKER_ID, explicitOptions: CircuitBreakerOptions = {}): CircuitBreaker {
    const existing = this.instances.get(id);
    if (existing) return existing;
    const created = new CircuitBreaker(this.optionsFor(id, explicitOptions));
    this.instances.set(id, created);
    return created;
  }

  /** Replace the breaker instance for `id` directly — useful for tests. */
  setBreaker(id: string, breaker: CircuitBreaker): void {
    this.instances.set(id, breaker);
  }

  /** The ids resolved so far — diagnostic only. */
  names(): string[] {
    return Array.from(this.instances.keys());
  }

  /**
   * The merged settings for `id`.
   *
   * The per-id read is skipped for {@link DEFAULT_CIRCUIT_BREAKER_ID}: its
   * block and the defaults block are the same path, so reading it twice would
   * be the same object spread over itself.  Skipping it is what makes the
   * reservation legible here rather than only in prose.
   *
   * The per-id path carries no `reference.conf` leaf for the same reason
   * `actor-ts.cache.<name>.*` carries none — the id is the application's, so
   * the path cannot be enumerated.  Which is also why the defaults block reads
   * its paths straight out of `ConfigKeys` while the per-id one composes the
   * same suffixes: only the first can be declared, and declaring it leaf by
   * leaf is what puts the leaves in front of `NoDeadConfigKeys` instead of a
   * block root that would cover them whether or not anything read them.
   */
  private optionsFor(id: string, explicitOptions: CircuitBreakerOptions): CircuitBreakerOptionsType {
    const config = this.system.config;
    const fromDefaultBlock = readCircuitBreakerOptionsFromConfig(config, ConfigKeys.circuitBreaker.default);
    const fromNamedBlock = id === DEFAULT_CIRCUIT_BREAKER_ID
      ? {}
      : readCircuitBreakerOptionsFromConfig(
        config,
        circuitBreakerKeysUnder(`${ConfigKeys.circuitBreaker.root}.${id}`),
      );
    return mergeOptions<CircuitBreakerOptionsType>(
      CIRCUIT_BREAKER_BUILT_IN_DEFAULTS,
      { ...fromDefaultBlock, ...fromNamedBlock },
      explicitOptions as Partial<CircuitBreakerOptionsType>,
    );
  }
}

export const CircuitBreakerExtensionId: ExtensionId<CircuitBreakerExtension> = extensionId(
  'CircuitBreakerExtension',
  (system) => new CircuitBreakerExtension(system),
);
