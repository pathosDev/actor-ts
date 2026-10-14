import { match } from 'ts-pattern';
import { ConfigError } from '../../config/Config.js';
import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import type { Lease } from '../../coordination/Lease.js';
import { checkLeaseConfiguration, configuredLeaseFor } from '../../coordination/LeaseFromConfig.js';
import { rejectAbsentLeaseKeys } from '../../coordination/LeaseOptions.js';
import type { AbsentLeaseKeys } from '../../coordination/LeaseOptions.js';
import { OptionsError } from '../../util/OptionsValidator.js';
import type { NodeAddress } from '../NodeAddress.js';
import type { ClusterPartitionView, DowningDecision, DowningProvider } from './DowningProvider.js';
import { KeepMajority } from './KeepMajority.js';
import type { KeepMajorityOptionsType } from './KeepMajorityOptions.js';
import { KeepOldest } from './KeepOldest.js';
import type { KeepOldestOptionsType } from './KeepOldestOptions.js';
import { KeepReferee } from './KeepReferee.js';
import type { KeepRefereeOptionsType } from './KeepRefereeOptions.js';
import { LeaseMajority } from './LeaseMajority.js';
import { LeaseMajorityOptions } from './LeaseMajorityOptions.js';
import { StaticQuorum } from './StaticQuorum.js';
import type { StaticQuorumOptionsType } from './StaticQuorumOptions.js';

/**
 * The values `actor-ts.cluster.split-brain-resolver.active-strategy` accepts.
 *
 * `implementation`-style vocabulary, deliberately: #840 established the
 * spelling for swapping one framework-internal algorithm for another with no
 * registry of ids behind it, and this is the same shape one block over.
 *
 * All five strategies.  `lease-majority` was the one missing until a lease
 * could be built from configuration (#1454): its lease comes from
 * `actor-ts.coordination.lease`, and a deployment that names no backend there
 * is refused rather than handed a strategy with nothing to arbitrate through.
 *
 * A lookup table that *is* the implementation, so it stays in this file
 * rather than moving to `src/cluster/Constants.ts`: the union type below is
 * derived from it, and `Constants.ts` imports nothing from its own subsystem
 * by construction.
 */
const CONFIG_SELECTABLE_STRATEGIES = [
  'off',
  'keep-majority',
  'keep-oldest',
  'keep-referee',
  'static-quorum',
  'lease-majority',
] as const;

/** Which split-brain resolver a config file asks this node to run. */
export type SplitBrainResolverStrategy = (typeof CONFIG_SELECTABLE_STRATEGIES)[number];

/**
 * Built-in default for `active-strategy` — no resolver, which is what every
 * cluster ran before the choice was expressible at all.
 *
 * Opt-in on purpose: turning one on changes what a partition does to a live
 * cluster, so wiring the selector must move nothing for a deployment that
 * does not ask for it.  It lives here rather than in `src/cluster/Constants.ts`
 * because it is the sentinel {@link readDowningFromConfig} compares against
 * and is typed by the union declared above it — a `Constants.ts` reaching for
 * that type would be importing from its own subsystem.
 */
export const DEFAULT_SPLIT_BRAIN_RESOLVER_STRATEGY: SplitBrainResolverStrategy = 'off';

/**
 * Build the {@link DowningProvider} the config file names, or `undefined` when
 * it names none.
 *
 * `undefined` for `off` **and** for an absent key, and that is load-bearing in
 * two directions.  `readClusterOptionsFromConfig` only sets `downing` when
 * this returns something, so the shipped `active-strategy = off` leaves the
 * merged options without a `downing` key at all — an explicit `undefined`
 * would still be a key, and `ClusterConfigDefaults.test.ts` pins the exact
 * object the reference config reads back to.  And an absent key has to behave
 * exactly like the shipped default, or a file that spells the default out
 * would differ from one that omits it (#841).
 *
 * The result lands in the existing {@link ClusterOptionsType.downing} slot, so
 * precedence needs no new code: `withClusterConfigDefaults` strips `undefined`
 * from the explicit layer, and an explicit `withDowning(…)` therefore wins
 * while an absent one falls through to this.
 *
 * A plain function rather than an options triad, matching
 * `readFailureDetectorFromConfig`: the strategies already own their options
 * types, and this file value-imports their classes — which an `XOptions.ts`
 * may not do.
 *
 * It also checks `actor-ts.coordination.lease`, whatever the strategy (#1454).
 * Every `Cluster.join` runs this reader, and the coordination block is
 * otherwise read only when a consumer asks for a lease — so a misspelt
 * backend, or an `owner` an operator expects to be used, would be refused by
 * the first singleton started on demand, or by nothing.
 */
export function readDowningFromConfig(config: Config): DowningProvider | undefined {
  checkLeaseConfiguration(config);
  rejectAbsentLeaseKeys(config, ABSENT_LEASE_MAJORITY_KEYS);
  const keys = ConfigKeys.cluster.splitBrainResolver;
  if (!config.hasPath(keys.activeStrategy)) return undefined;
  // `getString`, never `getBoolean`: HOCON's literal parser maps only
  // `true`/`false`/`null`/numbers, so `off` arrives as the string `'off'` —
  // but `getBoolean` *would* coerce it, and reading the key that way would
  // turn every strategy name into a type error instead of a selection.
  const strategy = asStrategy(config.getString(keys.activeStrategy), keys.activeStrategy);
  return match(strategy)
    .with('off', () => undefined)
    .with('keep-majority', () => new KeepMajority(keepMajorityOptions(config)))
    .with('keep-oldest', () => new KeepOldest(keepOldestOptions(config)))
    .with('keep-referee', () => keepReferee(config))
    .with('static-quorum', () => staticQuorum(config))
    .with('lease-majority', () => leaseMajority(config))
    .exhaustive();
}

/**
 * The `lease-majority` sub-block this block deliberately lacks, refused whole
 * rather than leaf by leaf: a `lease-name` or a `role` written by analogy with
 * `keep-majority.role` would each read as a setting in force.
 */
const ABSENT_LEASE_MAJORITY_KEYS: AbsentLeaseKeys = {
  'actor-ts.cluster.split-brain-resolver.lease-majority':
    'lease-majority takes nothing from this block — its lease comes from actor-ts.coordination.lease, named '
    + '<system>-split-brain-resolver and owned by this node, and its role and acquire timeout are set in code '
    + 'with withDowning(new LeaseMajority(...))',
};

/** Narrow the raw value, refusing anything else by name with the legal list. */
function asStrategy(raw: string, key: string): SplitBrainResolverStrategy {
  if (!isStrategy(raw)) {
    throw new ConfigError(
      `${key} must be one of ${CONFIG_SELECTABLE_STRATEGIES.join(' | ')} (got "${raw}")`,
    );
  }
  return raw;
}

function isStrategy(value: string): value is SplitBrainResolverStrategy {
  return (CONFIG_SELECTABLE_STRATEGIES as readonly string[]).includes(value);
}

/**
 * The optional `role` narrowing three of the four strategies share.
 *
 * An empty string is dropped rather than passed through.  `""` is the shape
 * the key ships with rather than a value anyone runs with, and every strategy
 * already tests `!this.options.role`, so the two are equivalent at the read
 * site — omitting it keeps the constructed options identical to what a caller
 * who named no role builds in code.
 */
function readRole(config: Config, key: string): { readonly role?: string } {
  if (!config.hasPath(key)) return {};
  const role = config.getString(key);
  return role === '' ? {} : { role };
}

function keepMajorityOptions(config: Config): KeepMajorityOptionsType {
  return readRole(config, ConfigKeys.cluster.splitBrainResolver.keepMajority.role);
}

function keepOldestOptions(config: Config): KeepOldestOptionsType {
  // `down-if-alone` has no key on purpose: `KeepOldest.decide`'s two arms are
  // byte-identical today, so the flag provably changes nothing (#932).
  // `NoDeadConfigKeys` would pass it — the field *is* read — which is exactly
  // why the guard cannot be the thing that decides this.
  return readRole(config, ConfigKeys.cluster.splitBrainResolver.keepOldest.role);
}

function keepReferee(config: Config): KeepReferee {
  const keys = ConfigKeys.cluster.splitBrainResolver.keepReferee;
  if (!config.hasPath(keys.refereeAddress)) {
    throw new ConfigError(
      `${ConfigKeys.cluster.splitBrainResolver.activeStrategy} = keep-referee needs `
      + `${keys.refereeAddress}, which ships comment-only in reference.conf: the referee is `
      + 'a specific node\'s address and there is no default that could stand for one.',
    );
  }
  const options: KeepRefereeOptionsType = {
    refereeAddress: config.getString(keys.refereeAddress),
    ...(config.hasPath(keys.downAllIfBelowQuorum)
      ? { downAllIfBelowQuorum: config.getInt(keys.downAllIfBelowQuorum) }
      : {}),
  };
  return buildNamingTheConfigKey(() => new KeepReferee(options), {
    refereeAddress: keys.refereeAddress,
    downAllIfBelowQuorum: keys.downAllIfBelowQuorum,
  });
}

function staticQuorum(config: Config): StaticQuorum {
  const keys = ConfigKeys.cluster.splitBrainResolver.staticQuorum;
  if (!config.hasPath(keys.quorumSize)) {
    throw new ConfigError(
      `${ConfigKeys.cluster.splitBrainResolver.activeStrategy} = static-quorum needs `
      + `${keys.quorumSize}, which ships comment-only in reference.conf: the quorum is the `
      + 'size this deployment refuses to run below, and no default can guess it.',
    );
  }
  const options: StaticQuorumOptionsType = {
    quorumSize: config.getInt(keys.quorumSize),
    ...readRole(config, keys.role),
  };
  return buildNamingTheConfigKey(() => new StaticQuorum(options), { quorumSize: keys.quorumSize });
}

/**
 * `lease-majority`, arbitrating through a lease built from
 * `actor-ts.coordination.lease` (#1454).
 *
 * Everything the file can get wrong is refused here, at `Cluster.join`: no
 * backend, an unknown one, no `ttl`, a value the backend rejects.  Only the
 * lease itself waits, for the reason {@link LeaseMajorityFromConfig} gives.
 */
function leaseMajority(config: Config): DowningProvider {
  const configured = configuredLeaseFor(
    config,
    `${ConfigKeys.cluster.splitBrainResolver.activeStrategy} = lease-majority`,
  );
  return new LeaseMajorityFromConfig((self) => configured.build({ kind: 'split-brain-resolver' }, self));
}

/**
 * `LeaseMajority` whose lease is built at its first decision.
 *
 * The lease's owner is this node's address and incarnation, and this provider
 * is built by `Cluster.join` before the `Cluster` that mints them exists — the
 * address reaches a provider first in `ClusterPartitionView.self`.  So the
 * strategy is assembled there, once, and every decision after it is the plain
 * `LeaseMajority`'s: a wrapper rather than a change to `LeaseMajority`, whose
 * contract — a lease passed in, ready to use — stays what code relies on.
 */
class LeaseMajorityFromConfig implements DowningProvider {
  private strategy: LeaseMajority | null = null;

  constructor(private readonly leaseFor: (self: NodeAddress) => Lease) {}

  decide(view: ClusterPartitionView): DowningDecision {
    if (this.strategy === null) {
      const leaseMajorityOptions = LeaseMajorityOptions.create().withLease(this.leaseFor(view.self));
      this.strategy = new LeaseMajority(leaseMajorityOptions);
    }
    return this.strategy.decide(view);
  }
}

/**
 * Re-throw a strategy's own `OptionsError` as a `ConfigError` naming the key
 * the value came from.
 *
 * The bound itself stays where it is — `StaticQuorumOptionsValidator` and
 * `KeepRefereeOptionsValidator` are the single source of truth for what a
 * legal value is, and restating it here is how two copies drift apart.  What a
 * validator cannot know is that the value arrived from a file, so its message
 * names a field (`quorumSize`) and not the line an operator has to go and edit.
 *
 * Anything that is not an `OptionsError`, and any field with no key mapped to
 * it, is re-thrown untouched: this widens a message, it does not swallow a bug.
 */
function buildNamingTheConfigKey<T>(build: () => T, fields: Readonly<Record<string, string>>): T {
  try {
    return build();
  } catch (error) {
    if (!(error instanceof OptionsError)) throw error;
    const key = fields[error.field];
    if (key === undefined) throw error;
    throw new ConfigError(`${key}: ${error.message}`);
  }
}
