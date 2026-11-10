/**
 * The lease the framework builds from `actor-ts.coordination.lease` (#1454).
 *
 * Three consumers ask for one by configuration — `actor-ts.sharding.use-lease`,
 * `actor-ts.cluster.singleton.use-lease` and `split-brain-resolver
 * .active-strategy = lease-majority` — and they all reach it through here, so
 * the three cannot disagree about what a configured lease is.  What the file
 * decides is the **backend** and its tuning; what it never decides is the
 * lease's identity.  The name is derived per consumer and the owner per node,
 * because both mean "which one": a single value shared by a deployment would
 * put every singleton on one record, or let every node believe it holds every
 * lease.
 *
 * Internal: not on the `coordination` subpath.  A lease built in code still
 * goes into `withLease(…)` and wins over all of this.
 */
import { match } from 'ts-pattern';
import type { NodeAddress } from '../cluster/NodeAddress.js';
import { ConfigError } from '../config/Config.js';
import type { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { Scheduler } from '../Scheduler.js';
import { OptionsError } from '../util/OptionsValidator.js';
import type { Lease } from './Lease.js';
import { readLeaseOptionsFromConfig } from './LeaseOptions.js';
import type { LeaseOptionsType } from './LeaseOptions.js';
import { KubernetesLease } from './leases/KubernetesLease.js';
import {
  DEFAULT_LEASE_NAME_MAX_LENGTH,
  KubernetesLeaseOptionsValidator,
  readKubernetesLeaseOptionsFromConfig,
} from './leases/KubernetesLeaseOptions.js';
import type { KubernetesLeaseOptionsType } from './leases/KubernetesLeaseOptions.js';
import { deriveLeaseName } from './leases/LeaseName.js';

/**
 * The values `actor-ts.coordination.lease.backend` accepts.
 *
 * `in-memory` is deliberately absent, and refused by name rather than as an
 * unknown word.  An `InMemoryLease` keeps its records in its own isolate — one
 * process, or one worker thread of it — so two nodes never contend on a record
 * and a configured lease would gate nothing: split-brain protection that
 * protects nothing, on every node at once.  A `WorkerMesh` runs cluster nodes
 * on threads of one process, and they do not share the store either.
 *
 * A lookup table that *is* the implementation, so it stays in this file: the
 * union below is derived from it.
 */
const CONFIG_SELECTABLE_LEASE_BACKENDS = ['none', 'kubernetes'] as const;

/** Which backend a config file asks the framework to build its leases with. */
export type LeaseBackend = (typeof CONFIG_SELECTABLE_LEASE_BACKENDS)[number];

/** A backend that builds something — every selectable value but `none`. */
type BuildingLeaseBackend = Exclude<LeaseBackend, 'none'>;

/**
 * Built-in default for `actor-ts.coordination.lease.backend` — none, so nothing
 * builds a lease until a deployment names a backend, which is what every
 * release before the key did.  It lives here, beside the table its union is
 * derived from, for the reason `DEFAULT_SPLIT_BRAIN_RESOLVER_STRATEGY` lives
 * beside its own.
 */
export const DEFAULT_LEASE_BACKEND: LeaseBackend = 'none';

/**
 * The backend `actor-ts.coordination.lease.backend` names, or `undefined` when
 * the key is unset — the default is the caller's to apply, the way
 * `readHttpBackendFromConfig` leaves `http.backend`'s.
 *
 * The one place an unknown name is refused, so the `ConfigError` naming the key
 * is raised here and every consumer sees nothing but a backend it can build.
 */
export function readLeaseBackendFromConfig(config: Config): LeaseBackend | undefined {
  const key = ConfigKeys.coordination.lease.backend;
  if (!config.hasPath(key)) return undefined;
  const backend = config.getString(key);
  if (backend === 'in-memory') {
    throw new ConfigError(
      `${key} = in-memory is not selectable: an InMemoryLease keeps its records in its own isolate, `
      + 'so two nodes never contend on one and a lease built from configuration would gate nothing. '
      + 'Name kubernetes, or build an InMemoryLease in code for a test and pass it to withLease(...).',
    );
  }
  if (!isLeaseBackend(backend)) {
    throw new ConfigError(
      `${key} must be one of ${CONFIG_SELECTABLE_LEASE_BACKENDS.join(' | ')} (got "${backend}")`,
    );
  }
  return backend;
}

function isLeaseBackend(value: string): value is LeaseBackend {
  return (CONFIG_SELECTABLE_LEASE_BACKENDS as readonly string[]).includes(value);
}

/**
 * Check the whole coordination block once, where a node starts its cluster.
 *
 * A consumer reads the block only when its switch asks for a lease, so a
 * misspelt backend — or an `owner` an operator wrote expecting it to be used —
 * would otherwise be refused hours later, by the first singleton started on
 * demand, or never.  Called from `readDowningFromConfig`, which every
 * `Cluster.join` runs whatever strategy it selects.
 */
export function checkLeaseConfiguration(config: Config): void {
  readLeaseBackendFromConfig(config);
  readLeaseOptionsFromConfig(config);
}

/** A cluster singleton's lease — one per singleton type name. */
export type SingletonLeaseConsumer = { readonly kind: 'singleton'; readonly typeName: string };
/** A sharded type's coordinator lease — one per sharded type name. */
export type ShardingLeaseConsumer = { readonly kind: 'sharding'; readonly typeName: string };
/** `lease-majority`'s arbiter — one per cluster. */
export type SplitBrainResolverLeaseConsumer = { readonly kind: 'split-brain-resolver' };

/** Who a configured lease is built for, which is what its object name is derived from. */
export type LeaseConsumer = SingletonLeaseConsumer | ShardingLeaseConsumer | SplitBrainResolverLeaseConsumer;

/**
 * What the framework hands a backend for one configured lease: the identity it
 * derived and the scheduler the renewal is armed on.  Everything else — the
 * TTL, the renewal interval, the backend's own block — the backend reads from
 * the `Config` handed beside this, which is the node's own.
 */
export type ConfiguredLeaseOptions = Required<Pick<LeaseOptionsType, 'name' | 'owner' | 'scheduler'>>;

/** How a backend turns {@link ConfiguredLeaseOptions} and the node's config into a lease. */
export type LeaseBackendBuilder = (options: ConfiguredLeaseOptions, config: Config) => Lease;

const BUILT_IN_BACKENDS: Readonly<Record<BuildingLeaseBackend, LeaseBackendBuilder>> = {
  kubernetes: (options, config) => new KubernetesLease(options, config),
};

/** See {@link _substituteLeaseBackendForTest}. */
let substituteBackend: LeaseBackendBuilder | null = null;

/**
 * @internal Build every configured lease with `builder` until the returned
 * function is called.
 *
 * The seam the behavioural tests need, and the only one: `in-memory` is not
 * selectable, and the Kubernetes backend talks to a real API server.  The
 * substitute receives exactly what the real backend would — the derived name
 * and owner, the scheduler, the node's config — so a test that builds an
 * `InMemoryLease` from them exercises everything but the wire.
 */
export function _substituteLeaseBackendForTest(builder: LeaseBackendBuilder): () => void {
  substituteBackend = builder;
  return () => { substituteBackend = null; };
}

/**
 * The tuning fields a backend reads from the block, each with the key it came
 * from — so a validator's refusal, which names a field, can be re-raised naming
 * the line an operator has to edit.
 */
const SETTING_KEYS: Readonly<Record<string, string>> = {
  ttlMs: ConfigKeys.coordination.lease.ttl,
  renewalIntervalMs: ConfigKeys.coordination.lease.renewalInterval,
  namespace: ConfigKeys.coordination.lease.kubernetes.namespace,
  namespacePath: ConfigKeys.coordination.lease.kubernetes.namespacePath,
  tokenPath: ConfigKeys.coordination.lease.kubernetes.tokenPath,
  caPath: ConfigKeys.coordination.lease.kubernetes.caPath,
  tokenReloadIntervalMs: ConfigKeys.coordination.lease.kubernetes.tokenReloadInterval,
  operationTimeoutMs: ConfigKeys.coordination.lease.kubernetes.operationTimeout,
  leaseNameMaxLength: ConfigKeys.coordination.lease.kubernetes.leaseNameMaxLength,
};

/**
 * A coordination block that has been read and checked, ready to build one lease
 * per consumer with {@link build}.
 *
 * Split from the build because the two happen at different moments: the check
 * runs where the consumer starts — `Cluster.join` for `lease-majority`, whose
 * provider exists before the node's address does — and the build needs that
 * address.  Everything that can be wrong in a file is wrong before the split,
 * so a build cannot fail on configuration at a partition.
 */
export class ConfiguredLease {
  /** @internal — reached through {@link configuredLeaseFor}, which does the checking. */
  constructor(
    private readonly backend: BuildingLeaseBackend,
    private readonly config: Config,
    private readonly nameMaxLength: number,
  ) {}

  /**
   * The lease `consumer` holds on the node at `self`.
   *
   * @param scheduler Where the renewal is armed.  A consumer inside a system
   *   passes `system.scheduler`; `lease-majority`, which is built from a config
   *   and nothing else, gets a scheduler of its own.  Either way the renewal
   *   goes through a scheduler, which chains an interval longer than one host
   *   timer holds rather than firing it every millisecond.
   */
  build(consumer: LeaseConsumer, self: NodeAddress, scheduler: Scheduler = new Scheduler()): Lease {
    const options: ConfiguredLeaseOptions = {
      name: deriveLeaseName(composedNameOf(consumer, self.systemName), this.nameMaxLength),
      owner: ownerOf(self),
      scheduler,
    };
    const builder = substituteBackend ?? BUILT_IN_BACKENDS[this.backend];
    return builder(options, this.config);
  }
}

/**
 * Read and check `actor-ts.coordination.lease` for a consumer that asked for a
 * lease built from it.
 *
 * Refused here, each with a `ConfigError` naming the key: no backend (`none`, the
 * shipped default), an unknown or `in-memory` backend, a spelling the block does
 * not have, no `ttl`, and a value the backend's validator would reject.  The
 * missing TTL is the #596 requirement surfaced where it can name the key: a
 * shipped default would supply one to every lease in the process, and how long
 * the other side waits out a silent holder is the one number no default can
 * know.
 *
 * @param requestedBy what asked, as the refusals should name it — the switch,
 *   and the consumer it switched on.
 */
export function configuredLeaseFor(config: Config, requestedBy: string): ConfiguredLease {
  const backendKey = ConfigKeys.coordination.lease.backend;
  const backend = readLeaseBackendFromConfig(config) ?? DEFAULT_LEASE_BACKEND;
  if (backend === 'none') {
    throw new ConfigError(
      `${requestedBy} asks for a lease built from configuration, but ${backendKey} = none, so there is `
      + `no backend to build it with. Set ${backendKey} = kubernetes, or pass a lease in code with withLease(...).`,
    );
  }
  const settings = settingsOf(config, backend);
  if (settings.ttlMs === undefined) {
    throw new ConfigError(
      `${requestedBy} needs ${ConfigKeys.coordination.lease.ttl}, which ships unset: it is how long the other `
      + 'side waits out a holder that went silent, and no default can know what this deployment can stand.',
    );
  }
  checkNamingTheConfigKey(settings);
  return new ConfiguredLease(backend, config, settings.leaseNameMaxLength ?? DEFAULT_LEASE_NAME_MAX_LENGTH);
}

/** The block as `backend` reads it — the shared tuning and the backend's own sub-block. */
function settingsOf(config: Config, backend: BuildingLeaseBackend): Partial<KubernetesLeaseOptionsType> {
  return match(backend)
    .with('kubernetes', () => ({
      ...readLeaseOptionsFromConfig(config),
      ...readKubernetesLeaseOptionsFromConfig(config),
    }))
    .exhaustive();
}

/**
 * Run the backend's validator over the configured settings, re-raising its
 * `OptionsError` as a `ConfigError` that names the key — the value came from a
 * file, and the field name is not the line an operator has to edit.  Anything
 * else is re-thrown untouched.
 */
function checkNamingTheConfigKey(settings: Partial<KubernetesLeaseOptionsType>): void {
  try {
    new KubernetesLeaseOptionsValidator().validate(settings);
  } catch (error) {
    if (!(error instanceof OptionsError)) throw error;
    const key = SETTING_KEYS[error.field];
    if (key === undefined) throw error;
    throw new ConfigError(`${key}: ${error.message}`);
  }
}

/**
 * The name a consumer's lease is composed as, before it is made an object name:
 * `<system>-singleton-<type>`, `<system>-sharding-<type>`,
 * `<system>-split-brain-resolver`.  The system name keeps two clusters sharing
 * a namespace apart; the type name keeps two singletons of one cluster apart.
 */
function composedNameOf(consumer: LeaseConsumer, systemName: string): string {
  return match(consumer)
    .with({ kind: 'singleton' }, (singleton) => `${systemName}-singleton-${singleton.typeName}`)
    .with({ kind: 'sharding' }, (sharding) => `${systemName}-sharding-${sharding.typeName}`)
    .with({ kind: 'split-brain-resolver' }, () => `${systemName}-split-brain-resolver`)
    .exhaustive();
}

/**
 * Who holds a configured lease: this node's address, and the incarnation that
 * tells this run of it from the one before (#940).
 *
 * The address alone would hand a restarted pod its predecessor's record — the
 * backend reads a matching holder as "already mine" — while the predecessor
 * may only be partitioned, not gone, and still acting on it.  With the
 * incarnation the newcomer waits the TTL out like any other contender.
 */
function ownerOf(self: NodeAddress): string {
  return self.incarnation === undefined ? self.toString() : `${self.toString()}#${self.incarnation}`;
}
