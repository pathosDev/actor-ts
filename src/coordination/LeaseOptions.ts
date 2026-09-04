import { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { mergeOptions } from '../util/OptionsMerge.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/**
 * Plain options-object shape shared by every {@link Lease} backend — the
 * common construction-time options.  A plain object of these fields is an
 * accepted alternative to the {@link LeaseOptionsBuilder}; concrete backends
 * extend it (e.g. `KubernetesLeaseOptionsType`).
 */
export type LeaseOptionsType = {
  /** Lease name — unique identifier within the namespace. */
  readonly name: string;
  /** Identifier of the holder (pod name / host name / uuid). */
  readonly owner: string;
  /** Time-to-live in ms — the backend auto-expires if we fail to renew. */
  readonly ttlMs: number;
  /** How often to renew (< ttlMs — typically ttl/3). */
  readonly renewalIntervalMs?: number;
  /** Max attempts for a single `acquire()` before returning false. */
  readonly acquireRetries?: number;
  /** Delay between acquire retries. */
  readonly acquireRetryDelayMs?: number;
};

/**
 * Fluent builder for {@link LeaseOptionsType} — the common construction-time
 * options every {@link Lease} backend shares.  The concrete
 * `KubernetesLeaseOptionsBuilder` subclass extends this with the K8s-specific
 * `withX(...)` methods.
 *
 *     new InMemoryLease(
 *       LeaseOptions.create().withName('singleton').withOwner(nodeId).withTtlMs(10_000),
 *     );
 *
 * Generic over `T extends LeaseOptionsType` so `KubernetesLeaseOptionsBuilder`
 * can inherit these six setters while adding its own — same shape as the
 * broker `BrokerOptionsBuilder<T>` base.  The `as keyof T` casts pay for
 * writing the shared setters once against the generic; concrete subclasses
 * stay type-safe because their extra methods target concrete field types.
 */
export class LeaseOptionsBuilder<T extends LeaseOptionsType = LeaseOptionsType> extends OptionsBuilder<T> {
  /** Start a fresh builder.  Equivalent to `new LeaseOptionsBuilder()`. */
  static create(): LeaseOptionsBuilder {
    return new LeaseOptionsBuilder();
  }

  /** Lease name — unique identifier within the namespace. */
  withName(name: string): this {
    return this.set('name' as keyof T, name as T[keyof T]);
  }

  /** Identifier of the holder (pod name / host name / uuid). */
  withOwner(owner: string): this {
    return this.set('owner' as keyof T, owner as T[keyof T]);
  }

  /** Time-to-live in ms — the backend auto-expires if we fail to renew. */
  withTtlMs(ttlMs: number): this {
    return this.set('ttlMs' as keyof T, ttlMs as T[keyof T]);
  }

  /** How often to renew (< ttlMs — typically ttl/3). */
  withRenewalIntervalMs(renewalIntervalMs: number): this {
    return this.set('renewalIntervalMs' as keyof T, renewalIntervalMs as T[keyof T]);
  }

  /** Max attempts for a single `acquire()` before returning false. */
  withAcquireRetries(acquireRetries: number): this {
    return this.set('acquireRetries' as keyof T, acquireRetries as T[keyof T]);
  }

  /** Delay between acquire retries. */
  withAcquireRetryDelayMs(acquireRetryDelayMs: number): this {
    return this.set('acquireRetryDelayMs' as keyof T, acquireRetryDelayMs as T[keyof T]);
  }
}

/**
 * Validates resolved lease settings.  Generic over `T extends LeaseOptionsType`
 * so `KubernetesLeaseOptionsValidator` can extend it; the shared fields are
 * checked imperatively in {@link commonRules} (a cast to `LeaseOptionsType`
 * sidesteps the generic-key friction, mirroring `BrokerOptionsValidator`).
 * Only present values are checked — an unset optional passes.
 */
export class LeaseOptionsValidator<T extends LeaseOptionsType = LeaseOptionsType> extends OptionsValidator<T> {
  constructor(optionsName = 'LeaseOptions') {
    super(optionsName);
  }
  protected rules(s: Partial<T>): void {
    this.commonRules(s);
  }

  /**
   * Fields a lease cannot be constructed without.  Subclasses widen the
   * list (`KubernetesLeaseOptionsValidator` adds `namespace`).
   */
  protected requiredFields(): readonly string[] {
    return ['name', 'owner', 'ttlMs'];
  }

  /**
   * Assert every {@link requiredFields} entry is present, throwing
   * `OptionsError` on the first one that is not.
   *
   * Deliberately separate from {@link validate}: the check helpers of
   * `OptionsValidator` are contractually a no-op on `undefined` — an unset
   * optional always passes — so required-ness has to be enforced by the
   * consumer, the way `BrokerActor.requiredOptions()` does it for brokers.
   * Folding the check into {@link rules} would also break every caller that
   * validates a deliberately partial object.
   *
   * The stakes are why this exists at all (#596): a lease built without an
   * `owner` wrote no `spec.holderIdentity`, so every node's `acquire()`
   * succeeded and mutual exclusion was silently off; a lease built without
   * `ttlMs` computed a `NaN` expiry, with the same effect by a different
   * route.  Both used to construct without a murmur.
   */
  validateRequired(settings: Partial<T>): void {
    for (const field of this.requiredFields()) {
      if ((settings as Record<string, unknown>)[field] === undefined) {
        this.fail(field, 'is required');
      }
    }
  }
  protected commonRules(s: Partial<T>): void {
    const options = s as Partial<LeaseOptionsType>;
    if (options.name !== undefined && (typeof options.name !== 'string' || options.name.length === 0)) {
      this.fail('name', 'must be a non-empty string', options.name);
    }
    if (options.owner !== undefined && (typeof options.owner !== 'string' || options.owner.length === 0)) {
      this.fail('owner', 'must be a non-empty string', options.owner);
    }
    if (options.ttlMs !== undefined && (typeof options.ttlMs !== 'number' || !Number.isFinite(options.ttlMs) || options.ttlMs <= 0)) {
      this.fail('ttlMs', 'must be a positive finite number', options.ttlMs);
    }
    if (
      options.renewalIntervalMs !== undefined &&
      (typeof options.renewalIntervalMs !== 'number' || !Number.isFinite(options.renewalIntervalMs) || options.renewalIntervalMs <= 0)
    ) {
      this.fail('renewalIntervalMs', 'must be a positive finite number', options.renewalIntervalMs);
    }
    if (options.acquireRetries !== undefined && (!Number.isInteger(options.acquireRetries) || options.acquireRetries < 0)) {
      this.fail('acquireRetries', 'must be an integer >= 0', options.acquireRetries);
    }
    if (
      options.acquireRetryDelayMs !== undefined &&
      (typeof options.acquireRetryDelayMs !== 'number' || !Number.isFinite(options.acquireRetryDelayMs) || options.acquireRetryDelayMs < 0)
    ) {
      this.fail('acquireRetryDelayMs', 'must be a non-negative finite number', options.acquireRetryDelayMs);
    }
  }
}

/**
 * The slice of the common lease settings HOCON can supply — `ttl` and
 * `renewal-interval`, and deliberately nothing else (#859).
 *
 * `name` and `owner` are per-lease identity: one is what the record is called,
 * the other is *which process holds it*, and a value shared by every lease in a
 * deployment is the opposite of what either means. `acquireRetries` /
 * `acquireRetryDelayMs` are left out for a different reason — the two backends
 * ship different built-in defaults for them (3 attempts / 100 ms for
 * Kubernetes, 1 / 50 ms in memory), so one leaf would silently unify them.
 *
 * Both fields drop the `Ms` suffix in HOCON and take a duration literal
 * instead, the same spelling `actor-ts.logger.close-timeout` uses for
 * `closeTimeoutMs`.
 */
export type LeaseConfigDefaults = Partial<Pick<LeaseOptionsType, 'ttlMs' | 'renewalIntervalMs'>>;

/**
 * Read `actor-ts.coordination.lease.*`.
 *
 * Loads the config itself, for the reason `readWorkerClusterOptionsFromConfig`
 * does: a `Lease` is constructed directly by application code and there is no
 * `ActorSystem` in scope to read `system.config` from — nothing in `src/` ever
 * builds one, every `withLease(...)` slot takes an instance. {@link Config.load}
 * is the same chain `ActorSystem.create` uses, honouring `ACTOR_TS_CONFIG` and
 * `./application.conf`.
 *
 * It is synchronous but **not** memoised (unlike `Config.loadReference`), so a
 * deployment that builds leases in a loop should load once and pass the same
 * `Config` in. The leases seen in practice are one per singleton.
 *
 * Neither key ships a leaf in `reference.conf`, so both `hasPath` checks are
 * false until an operator sets one — which is what keeps `ttlMs is required`
 * (#596) reachable and keeps an unset `renewal-interval` meaning "derive
 * `max(500ms, ttl/3)`" rather than "0".
 */
export function readLeaseOptionsFromConfig(config: Config = Config.load()): LeaseConfigDefaults {
  const keys = ConfigKeys.coordination.lease;
  const out: { -readonly [K in keyof LeaseConfigDefaults]: LeaseConfigDefaults[K] } = {};
  if (config.hasPath(keys.ttl)) {
    out.ttlMs = config.getDuration(keys.ttl);
  }
  if (config.hasPath(keys.renewalInterval)) {
    out.renewalIntervalMs = config.getDuration(keys.renewalInterval);
  }
  return out;
}

/**
 * Layer the config block under the caller's options — **explicit options >
 * HOCON > built-in defaults**, as everywhere else.  The result is what
 * {@link LeaseOptionsValidator} sees, so a negative `renewal-interval` in a
 * config file is rejected exactly like a negative one in code.
 */
export function withLeaseConfigDefaults(
  options: LeaseOptionsType,
  config?: Config,
): LeaseOptionsType {
  return mergeOptions<LeaseOptionsType>({}, readLeaseOptionsFromConfig(config), options);
}

/**
 * Accepted input for any lease constructor: the fluent
 * {@link LeaseOptionsBuilder} OR a plain {@link LeaseOptionsType} object.
 */
export type LeaseOptions = LeaseOptionsBuilder | Partial<LeaseOptionsType>;
/** Value alias so `LeaseOptions.create()` / `new LeaseOptions()` resolve to the builder. */
export const LeaseOptions = LeaseOptionsBuilder;
