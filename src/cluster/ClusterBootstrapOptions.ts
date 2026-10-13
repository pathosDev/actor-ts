import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import { ConfigError } from '../config/Config.js';
import type { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { ClusterReadinessOptionsValidator } from './ClusterReadiness.js';
import type { ClusterReadinessOptions } from './ClusterReadiness.js';
import type { ActorSystemOptionsType } from '../ActorSystemOptions.js';
import type { SeedProvider } from '../discovery/index.js';
import type { ClusterOptionsType } from './ClusterOptions.js';
import type { StableObservationTuning } from './bootstrap/StableObservationOptions.js';
import type { ProcessSignal } from '../util/ProcessSignal.js';

/**
 * Built-in timeout for {@link ClusterBootstrapOptionsType.awaitReady} when it
 * is `true` rather than a number of milliseconds — how long `bootstrap`
 * waits for the node to reach `up` before giving up.
 */
export const DEFAULT_AWAIT_READY_MS = 5_000;

/**
 * The `discovery:` values `actor-ts.cluster.bootstrap.discovery.method` can
 * name — the string half of {@link ClusterBootstrapOptionsType.discovery},
 * since the object halves (a `SeedProvider`, a `{ providers }` chain) are
 * shapes HOCON cannot express.
 *
 * One list, three consumers: the option's own type is
 * {@link DiscoveryMethod}, the reader validates against this array, and the
 * published enum in `reference.conf` is documented from it.  A second copy
 * anywhere would be a place for the three to drift.
 */
export const DISCOVERY_METHODS = ['auto', 'kubernetes', 'dns', 'config'] as const;

/** One of {@link DISCOVERY_METHODS}. */
export type DiscoveryMethod = (typeof DISCOVERY_METHODS)[number];

/**
 * Built-in default for {@link ClusterBootstrapOptionsType.discovery} — the
 * env-driven ladder rather than one pinned provider.
 *
 * Named out of the two `?? 'auto'` literals in `ClusterBootstrap` so
 * `actor-ts.cluster.bootstrap.discovery.method` has a constant to be pinned
 * against (#860).  `'auto'` is also why the published enum lists four values
 * and not the issue's three: a key that could not express the behaviour the
 * framework already ships would be a trap, not a knob.  Annotated rather than
 * inferred so a typo here is a compile error rather than a fifth method.
 */
export const DEFAULT_DISCOVERY_METHOD: DiscoveryMethod = 'auto';

/**
 * Built-in default for {@link ClusterBootstrapOptionsType.newClusterEnabled}
 * — on, so a deployment's first start and single-node development need no
 * configuration to form a cluster (#860).  The cost of on is carried by the
 * warning `bootstrapCluster` logs at every start while it is, not by the
 * default: a default of off would make every first start fail.
 */
export const DEFAULT_NEW_CLUSTER_ENABLED = true;

/**
 * Options accepted by {@link Cluster.bootstrap}.  Everything is
 * optional except `name`; sensible defaults turn the call into a
 * single-line hello-cluster.  Build one with {@link ClusterBootstrapOptions}.
 */
export type ClusterBootstrapOptionsType = {
  /* ----------------------------- System -------------------------------- */

  /** ActorSystem name. */
  readonly name: string;

  /** Optional logger / log level / config overrides — forwarded to `ActorSystem.create`. */
  readonly logger?: ActorSystemOptionsType['logger'];
  readonly logLevel?: ActorSystemOptionsType['logLevel'];
  readonly config?: ActorSystemOptionsType['config'];
  readonly configFile?: ActorSystemOptionsType['configFile'];
  readonly persistence?: ActorSystemOptionsType['persistence'];

  /**
   * Whether the bootstrap helper installs `SIGTERM` + `SIGINT`
   * handlers that call the returned `shutdown()` once.  Set
   * to a list of signals to customise, or to `false` to disable.
   *
   * Left unset, the default comes from
   * `actor-ts.coordinated-shutdown.run-by-process-signals` (itself `true`),
   * so a deployment can take the handlers off every bootstrapped node from
   * its config file.  Any value here is explicit and wins over that key.
   */
  readonly shutdownOnSignals?: boolean | ReadonlyArray<ProcessSignal>;

  /* ----------------------------- Cluster ------------------------------- */

  /**
   * The interface to bind — **and, unless {@link advertisedHost} says
   * otherwise, the address this node gossips for peers to dial back.**
   *
   * That second half is the part worth reading twice.  The value does not stay
   * a bind target: it becomes `selfAddress`, which travels in every gossip
   * frame, every heartbeat and every member record, and which the
   * stable-observation election orders on.  Naming one routable host here is
   * the ordinary case and covers both jobs; naming a wildcard binds every
   * interface and leaves the advertised address to be derived (#944).
   *
   * Resolution order for the bind host — the framework's usual precedence
   * with the environment appended at the bottom (#1435):
   *   1. `options.host`
   *   2. `actor-ts.remote.tcp.host`
   *   3. `process.env.CLUSTER_HOST`
   *   4. `process.env.POD_IP` (Kubernetes, via the downward API)
   *   5. `process.env.HOSTNAME`
   *   6. `DEFAULT_BIND_HOST` (`'0.0.0.0'`, in `ClusterOptions.ts`)
   *
   * The key sits above the variables, as `actor-ts.discovery.*` does above
   * the `CLUSTER_*` variables discovery reads, and ships comment-only for the
   * same reason: a published value would be the config layer on every node
   * and leave the variables below it unreachable.  A deployment that wants a
   * variable to win over its own file lifts it with a substitution —
   * `host = ${?CLUSTER_HOST}` — which is a read during parsing, not a fourth
   * layer.
   *
   * Two caveats on the environment stages, both of which cost a cluster when
   * they are assumed away.  `POD_IP` exists only if the pod spec exports it —
   * it is not automatic.  And `HOSTNAME` is a *shell* variable: Docker and
   * Kubernetes put it in the environment, but a service started by systemd or
   * a process manager on a plain host sees `process.env.HOSTNAME === undefined`.
   * Even when present it is the pod name, which resolves under a StatefulSet
   * with a headless service and nowhere else — under a Deployment it is a name
   * no peer can dial.
   */
  readonly host?: string;

  /**
   * The address peers dial, when it differs from the bound interface (#944).
   *
   * The Kubernetes shape, and the reason the two are separate fields: bind
   * `0.0.0.0` because the pod does not know its address, advertise `POD_IP`
   * because that is the one the platform assigned. A wildcard is rejected
   * here — an address meaning "every interface" identifies nothing, and every
   * node that claimed it would claim the same string.
   *
   * Unset resolves through `actor-ts.remote.tcp.advertised-host`, then
   * {@link host} (when that is not a wildcard), then `CLUSTER_HOST` /
   * `POD_IP` / `HOSTNAME`, then loopback — the chain `Cluster.join` runs, so
   * the identity the bootstrap elects on is the one the node announces.
   */
  readonly advertisedHost?: string;

  /**
   * The port to bind — and, unless {@link advertisedPort} overrides it, the
   * port peers dial.  Resolution order, the same shape as {@link host}'s
   * (#1435): `options.port`, then `actor-ts.remote.tcp.port`, then
   * `process.env.CLUSTER_PORT` (when present and a positive integer), then
   * `DEFAULT_PORT` (`2552`, in `ClusterOptions.ts`).  A port in the file
   * therefore outranks `CLUSTER_PORT`; the variable answers on a node whose
   * file names none.
   */
  readonly port?: number;

  /**
   * The port peers dial, when it differs from the bound one (#845).
   *
   * The published-container-port shape: the process listens on 2552 and the
   * outside world reaches it on whatever `docker run -p 3000:2552` published,
   * so 3000 is what belongs in the seed lists and the gossip frames.  There is
   * no environment stage behind it — unlike {@link port}, which reads
   * `CLUSTER_PORT` — because no platform publishes the mapping anywhere a
   * process can read it.
   *
   * Unset means `actor-ts.remote.tcp.advertised-port`, and without that the
   * same as {@link port}.
   */
  readonly advertisedPort?: number;

  /** Transport override.  Default: `TcpTransport`. */
  readonly transport?: ClusterOptionsType['transport'];

  /**
   * Explicit seed list.  When set, `discovery` is ignored and the
   * cluster contacts exactly these addresses.
   */
  readonly seeds?: ReadonlyArray<string>;

  /**
   * Discovery strategy.  Values:
   *
   *   - `'auto'` (default) — the {@link autoDiscovery} ladder.
   *   - `'kubernetes' | 'dns' | 'config'` — pin to a single provider.
   *   - a `SeedProvider` instance — use as-is.
   *   - `{ providers: [...] }` — assemble a custom aggregate chain.
   *
   * Unset, the string half falls through to
   * `actor-ts.cluster.bootstrap.discovery.method` and then to
   * {@link DEFAULT_DISCOVERY_METHOD}; the two object halves are code-only,
   * since HOCON cannot express either.  Whichever provider results reads its
   * own settings from `actor-ts.discovery.*` and then from the `CLUSTER_*`
   * variables (#860).
   *
   * Ignored when `seeds` is set.
   */
  readonly discovery?:
    | DiscoveryMethod
    | SeedProvider
    | { readonly providers: ReadonlyArray<SeedProvider> };

  /**
   * Run the **stable-observation** phase before joining (#148).
   *
   *   - unset / `false` (default) — resolve the seeds once and join, the
   *     v0.9.0 behaviour.
   *   - `true` — poll discovery until the contact-point set has been
   *     unchanged for the stable margin, then let exactly one node (the
   *     lowest-addressed) form a cluster if no peer promoted it in time.
   *   - an options object — the same, with the timings overridden.  Unset
   *     fields fall through to `actor-ts.cluster.bootstrap.*` and then to
   *     the built-in defaults.
   *
   * Turn it on wherever nodes start simultaneously and discovery is dynamic —
   * a Kubernetes Deployment, an autoscaling group, anything where DNS
   * propagation races pod readiness.  It closes the cold-start split brain
   * (each node forming a cluster out of the subset it happened to see) and
   * the symmetric-seed-list deadlock (every node listing every other, so no
   * node has the empty seed list that `'immediate'` self-election needs).
   *
   * It costs at least `stableMarginMs` of startup latency and requires this
   * node's advertised {@link host} to be a real address rather than a
   * wildcard — the election is ordered on it (see #944).
   *
   * Works with an explicit {@link seeds} list too: discovery is then a fixed
   * set, the margin is satisfied on the second poll, and what remains is the
   * election — which is exactly what a symmetric seed list is missing.
   */
  readonly stableObservation?: boolean | StableObservationTuning;

  /**
   * May this node **form a new cluster** when it finds nobody to join (#860)?
   *
   *   - `true` — yes, which is what a deployment's very first start needs and
   *     what single-node development relies on.  The bootstrap logs one WARN
   *     per start while it is on, naming
   *     `actor-ts.cluster.bootstrap.new-cluster-enabled`.
   *   - `false` — never.  The self-election policy handed to the join is
   *     `'never'` on both paths — the plain one, where it would otherwise be
   *     `'immediate'`, and stable observation, where the elected node would
   *     otherwise self-elect after its grace — and an explicit `seeds: []`,
   *     which says "I am the first node", is refused with an `OptionsError`.
   *     A node that then finds nobody stays `joining`: under the default
   *     {@link awaitReady} the start rejects with `ClusterReadyTimeoutError`;
   *     with `awaitReady: false` it resolves and goes on waiting for a leader
   *     to promote it.
   *
   * Unset falls through to `actor-ts.cluster.bootstrap.new-cluster-enabled`
   * and then to {@link DEFAULT_NEW_CLUSTER_ENABLED}.  Turn it off once the
   * cluster exists: on every start after the first, a node cut off from its
   * peers would otherwise found a second cluster beside the running one.
   */
  readonly newClusterEnabled?: boolean;

  readonly roles?: ClusterOptionsType['roles'];
  readonly failureDetector?: ClusterOptionsType['failureDetector'];
  readonly gossipIntervalMs?: ClusterOptionsType['gossipIntervalMs'];
  readonly downing?: ClusterOptionsType['downing'];

  /**
   * Auto-start the {@link Receptionist} extension so service-key
   * lookups (`Find`, `Subscribe`) work without explicit wiring.
   * Default: `true`.
   */
  readonly receptionist?: boolean;

  /**
   * Wait for the cluster to be **ready** — self a full member (`up`) and at
   * least `minimumMembers` members up — before resolving.
   *
   *   - `true` (default) — wait with the computed budget:
   *     `actor-ts.cluster.bootstrap.await-ready` if set, else the
   *     self-election grace + 5 000 ms behind stable observation, else a
   *     flat 5 000 ms.
   *   - `false` / `0`    — return immediately, without waiting.
   *   - a number         — the budget in ms.
   *   - a {@link ClusterReadinessOptions} bag — full control; unset fields
   *     fall through to the HOCON layer and then the computed budget.
   *
   * **On timeout the bootstrap runs the coordinated-shutdown pipeline and
   * rejects with `ClusterReadyTimeoutError`** — a resolved `bootstrap()` now
   * means a formed cluster, never a node still `joining` (#943).  To restore
   * the old fire-and-forget shape, pass `awaitReady: false` and wait (or
   * don't) yourself via `cluster.awaitReady().catch(…)`.
   */
  readonly awaitReady?: boolean | number | ClusterReadinessOptions;
};

/**
 * Fluent builder for {@link ClusterBootstrapOptionsType} — the sole input
 * to {@link Cluster.bootstrap}.  `name` is required; everything else has
 * a sensible default.  Polymorphic / whole-value fields (`transport`,
 * `downing`, `discovery`, `failureDetector`, `seeds`, `roles`, the
 * logger / config / persistence forwards) are passed as-is via a single
 * `withX(value)`.
 *
 *     const { system, cluster, shutdown } = await Cluster.bootstrap(
 *       ClusterBootstrapOptions.create('my-app').withPort(2552),
 *     );
 */
export class ClusterBootstrapOptionsBuilder extends OptionsBuilder<ClusterBootstrapOptionsType> {
  /**
   * Start a fresh builder for the given ActorSystem name.  `name` is the
   * one required field, so it is taken up-front rather than via a
   * separate `withX`.
   */
  static create(name: string): ClusterBootstrapOptionsBuilder {
    return new ClusterBootstrapOptionsBuilder().set('name', name);
  }

  /* ----------------------------- System -------------------------------- */

  /** Logger forwarded to `ActorSystem.create`. */
  withLogger(logger: NonNullable<ClusterBootstrapOptionsType['logger']>): this {
    return this.set('logger', logger);
  }

  /** Log level forwarded to `ActorSystem.create`. */
  withLogLevel(logLevel: NonNullable<ClusterBootstrapOptionsType['logLevel']>): this {
    return this.set('logLevel', logLevel);
  }

  /** Inline HOCON / config object forwarded to `ActorSystem.create`. */
  withConfig(config: NonNullable<ClusterBootstrapOptionsType['config']>): this {
    return this.set('config', config);
  }

  /** Config file path forwarded to `ActorSystem.create`. */
  withConfigFile(configFile: NonNullable<ClusterBootstrapOptionsType['configFile']>): this {
    return this.set('configFile', configFile);
  }

  /** Persistence options forwarded to `ActorSystem.create`. */
  withPersistence(persistence: NonNullable<ClusterBootstrapOptionsType['persistence']>): this {
    return this.set('persistence', persistence);
  }

  /**
   * Signals that trigger `shutdown()`.  `true` (default) uses
   * `['SIGTERM','SIGINT']`; pass a list to customise or `false` to
   * disable.
   */
  withShutdownOnSignals(signals: NonNullable<ClusterBootstrapOptionsType['shutdownOnSignals']>): this {
    return this.set('shutdownOnSignals', signals);
  }

  /* ----------------------------- Cluster ------------------------------- */

  /**
   * The interface to bind — and, unless {@link withAdvertisedHost} overrides
   * it, the address gossiped for peers to dial back.  Unset resolves via
   * `actor-ts.remote.tcp.host`, then `CLUSTER_HOST` / `POD_IP` / `HOSTNAME`,
   * then `0.0.0.0`.
   */
  withHost(host: string): this {
    return this.set('host', host);
  }

  /**
   * The address peers dial, when it differs from the bound interface — bind
   * `0.0.0.0`, advertise the pod IP.  A wildcard is rejected (#944).
   */
  withAdvertisedHost(advertisedHost: string): this {
    return this.set('advertisedHost', advertisedHost);
  }

  /**
   * The port to bind — and, unless {@link withAdvertisedPort} overrides it,
   * the port gossiped for peers to dial back.  Unset resolves via
   * `actor-ts.remote.tcp.port`, then the `CLUSTER_PORT` env var, then `2552`.
   */
  withPort(port: number): this {
    return this.set('port', port);
  }

  /**
   * The port peers dial, when it differs from the bound one — the published
   * port of a `docker run -p 3000:2552` (#845).
   */
  withAdvertisedPort(advertisedPort: number): this {
    return this.set('advertisedPort', advertisedPort);
  }

  /** Transport override.  Default: `TcpTransport`. */
  withTransport(transport: NonNullable<ClusterBootstrapOptionsType['transport']>): this {
    return this.set('transport', transport);
  }

  /** Explicit seed list.  When set, `discovery` is ignored. */
  withSeeds(seeds: NonNullable<ClusterBootstrapOptionsType['seeds']>): this {
    return this.set('seeds', seeds);
  }

  /** Discovery strategy — `'auto'`, a named provider, or a custom aggregate. */
  withDiscovery(discovery: NonNullable<ClusterBootstrapOptionsType['discovery']>): this {
    return this.set('discovery', discovery);
  }

  /**
   * Run the stable-observation phase before joining — `true` for the
   * defaults, or an options object to override the timings.  Default: off.
   */
  withStableObservation(stableObservation: boolean | StableObservationTuning = true): this {
    return this.set('stableObservation', stableObservation);
  }

  /**
   * Whether this node may form a new cluster when it finds nobody to join —
   * `true` (the default), or `false`, the setting for every start after a
   * deployment's first.  See
   * {@link ClusterBootstrapOptionsType.newClusterEnabled}.
   */
  withNewClusterEnabled(enabled = true): this {
    return this.set('newClusterEnabled', enabled);
  }

  /** Role tags exposed to other members. */
  withRoles(roles: NonNullable<ClusterBootstrapOptionsType['roles']>): this {
    return this.set('roles', roles);
  }

  /** Failure-detector thresholds. */
  withFailureDetector(failureDetector: NonNullable<ClusterBootstrapOptionsType['failureDetector']>): this {
    return this.set('failureDetector', failureDetector);
  }

  /** How often gossip is pushed to a random reachable peer. */
  withGossipIntervalMs(ms: number): this {
    return this.set('gossipIntervalMs', ms);
  }

  /** Optional split-brain resolver. */
  withDowning(downing: NonNullable<ClusterBootstrapOptionsType['downing']>): this {
    return this.set('downing', downing);
  }

  /** Auto-start the Receptionist extension.  Default `true`. */
  withReceptionist(enabled = true): this {
    return this.set('receptionist', enabled);
  }

  /**
   * Wait for cluster readiness before resolving — `true` (computed budget),
   * `false`/`0` (skip), a millisecond budget, or a full
   * {@link ClusterReadinessOptions} bag.  On timeout the bootstrap tears the
   * system down and rejects; see {@link ClusterBootstrapOptionsType.awaitReady}.
   */
  withAwaitReady(awaitReady: boolean | number | ClusterReadinessOptions): this {
    return this.set('awaitReady', awaitReady);
  }
}

/** Validates resolved {@link ClusterBootstrapOptionsType} settings. */
export class ClusterBootstrapOptionsValidator extends OptionsValidator<ClusterBootstrapOptionsType> {
  constructor() {
    super('ClusterBootstrapOptions');
  }
  protected rules(s: Partial<ClusterBootstrapOptionsType>): void {
    this.nonEmptyString('name');
    this.nonEmptyString('host');
    // Only non-emptiness here; the wildcard rule lives on
    // `ClusterOptionsValidator`, which every path reaches — including a direct
    // `Cluster.join` that never sees these options at all (#944).
    this.nonEmptyString('advertisedHost');
    // Positive integer (not the TCP 1..65535 range) — the bootstrap port may
    // be a synthetic InMemoryTransport node id, same as ClusterOptions.port.
    this.positiveInt('port');
    // Same helper for the same reason as `port` — the advertised port is an
    // identity discriminator, not necessarily a TCP port number (#845).
    this.positiveInt('advertisedPort');
    this.positiveNumber('gossipIntervalMs');
    // awaitReady is boolean | number(ms) | readiness bag; a numeric budget
    // must be >= 0 (0 = skip), and a bag is held to the readiness rules here
    // — before the ActorSystem exists — rather than only at consume time.
    if (typeof s.awaitReady === 'number' && (!Number.isFinite(s.awaitReady) || s.awaitReady < 0)) {
      this.fail('awaitReady', 'must be a boolean, a non-negative number of ms, or a readiness options object', s.awaitReady);
    }
    if (typeof s.awaitReady === 'object' && s.awaitReady !== null) {
      new ClusterReadinessOptionsValidator().validate(s.awaitReady);
    }
  }
}

/**
 * The readiness knobs of the `actor-ts.cluster.bootstrap` block, in the
 * shape {@link bootstrapCluster} and `Cluster.awaitReady` layer between the
 * explicit options and the built-in defaults.  `awaitReadyMs` has no
 * `reference.conf` value on purpose: a leaf that is always present could not
 * express "unset", and unset is what selects the grace-aware computed
 * default (#1086) — the same reasoning as `advertised-host`.
 */
export type ClusterBootstrapConfigDefaults = {
  readonly awaitReadyMs?: number;
  readonly minimumMembers?: number;
};

/**
 * The half of `actor-ts.cluster.bootstrap` that decides the join plan — which
 * provider the bootstrap builds, what it asks about, and what an empty answer
 * means (#860).
 *
 * Its own type and its own reader rather than more fields on
 * {@link ClusterBootstrapConfigDefaults}, for the reason the block already
 * has two readers instead of one: they have different consumers and different
 * lifetimes.  The timings behind `readStableObservationOptionsFromConfig` are
 * read only under stable observation, the readiness pair is read after the
 * join, and these are read before it.  Widening the readiness type would
 * also have made every exact-object assertion about it an assertion about
 * discovery, which is how a test stops saying what its name says.
 *
 * `newClusterEnabled` sits beside the `discovery` pair rather than in a reader
 * of its own because it shares their consumer and their moment: it is the
 * other half of the same decision — a provider that answers nothing is "join
 * nobody", and this flag says whether "nobody" may mean "found a cluster".
 */
export type ClusterBootstrapDiscoveryDefaults = {
  /**
   * Which seed provider the bootstrap builds when the caller named no
   * `discovery:` — the string half of that option only.  A `SeedProvider`
   * instance and a `{ providers }` chain stay code-only: they are objects
   * HOCON cannot express, and a name-to-instance registry is #160's shape,
   * not this one's.
   */
  readonly method?: DiscoveryMethod;
  /**
   * The service the provider asks about — the DNS name resolved and the
   * Kubernetes Service whose `Endpoints` are read.  Layered above
   * `CLUSTER_SERVICE_NAME` rather than below it; see
   * `AutoDiscoveryOptionsType`.
   */
  readonly serviceName?: string;
  /**
   * `actor-ts.cluster.bootstrap.new-cluster-enabled` — whether a node that
   * finds nobody may form a new cluster.  Published `on`, so it is present
   * on every node that loads the reference layer; absent only from a config
   * built without it.
   */
  readonly newClusterEnabled?: boolean;
};

/**
 * Read the readiness pair of the bootstrap block.  Only keys actually
 * present are returned, so an absent one falls through to the computed /
 * built-in default instead of landing as an explicit `undefined`.
 */
export function readClusterBootstrapDefaultsFromConfig(
  config: Config,
): ClusterBootstrapConfigDefaults {
  const keys = ConfigKeys.cluster.bootstrap;
  // Mutable while being filled; consumers see the readonly shape.
  const out: {
    -readonly [K in keyof ClusterBootstrapConfigDefaults]:
    ClusterBootstrapConfigDefaults[K]
  } = {};
  if (config.hasPath(keys.awaitReady)) out.awaitReadyMs = config.getDuration(keys.awaitReady);
  if (config.hasPath(keys.minimumMembers)) out.minimumMembers = config.getInt(keys.minimumMembers);
  return out;
}

/**
 * Read the `discovery` sub-block and `new-cluster-enabled` — what
 * `bootstrapCluster` layers under the caller's `discovery:` and
 * `newClusterEnabled` options (#860).  Absent keys stay absent, for the
 * reason the reader above gives.
 *
 * `service-name` is additionally dropped when it is the empty string it
 * ships as: `""` is the published *shape* of the key, not a service anyone
 * runs with, and passing it on would shadow `CLUSTER_SERVICE_NAME` with a
 * value nobody wrote — the reading `readDowningFromConfig` gives the three
 * `role` placeholders.
 *
 * `method` is rejected rather than ignored when it names something outside
 * {@link DISCOVERY_METHODS}: a typo would otherwise select the `auto` ladder
 * silently, and a node that quietly discovers *differently* from its peers is
 * the split-brain shape the bootstrap exists to close.  A `ConfigError` here
 * reaches the caller through `bootstrapCluster`'s own guard, which terminates
 * the just-created system before rethrowing.
 */
export function readClusterBootstrapDiscoveryFromConfig(
  config: Config,
): ClusterBootstrapDiscoveryDefaults {
  const keys = ConfigKeys.cluster.bootstrap;
  const out: {
    -readonly [K in keyof ClusterBootstrapDiscoveryDefaults]:
    ClusterBootstrapDiscoveryDefaults[K]
  } = {};
  if (config.hasPath(keys.discovery.method)) {
    const method = config.getString(keys.discovery.method);
    if (!(DISCOVERY_METHODS as readonly string[]).includes(method)) {
      throw new ConfigError(
        `${keys.discovery.method} must be one of ${DISCOVERY_METHODS.join(' | ')} — got "${method}"`,
      );
    }
    out.method = method as DiscoveryMethod;
  }
  if (config.hasPath(keys.discovery.serviceName)) {
    const serviceName = config.getString(keys.discovery.serviceName).trim();
    if (serviceName.length > 0) out.serviceName = serviceName;
  }
  // `getBoolean` refuses anything that is not one of HOCON's six boolean
  // spellings, which reaches the caller through the bootstrap's guard.  A
  // malformed formation switch guessed either way is the wrong outcome on
  // half the deployments that wrote it.
  if (config.hasPath(keys.newClusterEnabled)) out.newClusterEnabled = config.getBoolean(keys.newClusterEnabled);
  return out;
}

/**
 * Accepted input for {@link Cluster.bootstrap}: the fluent
 * {@link ClusterBootstrapOptionsBuilder} OR a plain
 * {@link ClusterBootstrapOptionsType} object.
 */
export type ClusterBootstrapOptions = ClusterBootstrapOptionsBuilder | Partial<ClusterBootstrapOptionsType>;
/** Value alias so `ClusterBootstrapOptions.create()` / `new ClusterBootstrapOptions()` resolve to the builder. */
export const ClusterBootstrapOptions = ClusterBootstrapOptionsBuilder;
