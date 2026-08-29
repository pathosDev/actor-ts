import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
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
 * Built-in default for {@link ClusterBootstrapOptionsType.port} — the
 * remoting port a node binds when neither the options nor `reference.conf`
 * name one.  2552 is Akka's historical cluster port, kept so a mixed
 * toolchain's firewall rules and runbooks carry over unchanged.
 */
export const DEFAULT_PORT = 2552;

/**
 * Built-in default for {@link ClusterBootstrapOptionsType.host} — the
 * interface a node binds when neither the options nor the environment name
 * one.
 *
 * A wildcard is the right answer for *binding*, and only for binding: a
 * container accepts traffic on an address it does not know at start-up, so
 * "every interface" is what it has to say.  What this value must never become
 * is the node's identity — see
 * {@link ClusterBootstrapOptionsType.advertisedHost} and #944.
 */
export const DEFAULT_BIND_HOST = '0.0.0.0';

/**
 * Built-in timeout for {@link ClusterBootstrapOptionsType.awaitReady} when it
 * is `true` rather than a number of milliseconds — how long `bootstrap`
 * waits for the node to reach `up` before giving up.
 */
export const DEFAULT_AWAIT_READY_MS = 5_000;

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
   * Default: `['SIGTERM', 'SIGINT']`.
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
   * Resolution order for the bind host:
   *   1. `options.host`
   *   2. `process.env.CLUSTER_HOST`
   *   3. `process.env.POD_IP` (Kubernetes, via the downward API)
   *   4. `process.env.HOSTNAME`
   *   5. {@link DEFAULT_BIND_HOST}
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
   * Unset resolves through {@link host} (when that is not a wildcard), then
   * `CLUSTER_HOST` / `POD_IP` / `HOSTNAME`, then loopback.
   */
  readonly advertisedHost?: string;

  /**
   * Bind port.  Default: `process.env.CLUSTER_PORT` (when present and
   * a finite integer), otherwise `2552`.
   */
  readonly port?: number;

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
   *   - `'auto'` (default) — env-driven {@link autoDiscovery} chain.
   *   - `'kubernetes' | 'dns' | 'config'` — pin to a single provider,
   *     still configured from env vars.
   *   - a `SeedProvider` instance — use as-is.
   *   - `{ providers: [...] }` — assemble a custom aggregate chain.
   *
   * Ignored when `seeds` is set.
   */
  readonly discovery?:
    | 'auto'
    | 'kubernetes'
    | 'dns'
    | 'config'
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
   * it, the address gossiped for peers to dial back.  Defaults resolve via
   * `CLUSTER_HOST` / `POD_IP` / `HOSTNAME` / `0.0.0.0`.
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

  /** Bind port.  Defaults to `CLUSTER_PORT` env or `2552`. */
  withPort(port: number): this {
    return this.set('port', port);
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
 * Accepted input for {@link Cluster.bootstrap}: the fluent
 * {@link ClusterBootstrapOptionsBuilder} OR a plain
 * {@link ClusterBootstrapOptionsType} object.
 */
export type ClusterBootstrapOptions = ClusterBootstrapOptionsBuilder | Partial<ClusterBootstrapOptionsType>;
/** Value alias so `ClusterBootstrapOptions.create()` / `new ClusterBootstrapOptions()` resolve to the builder. */
export const ClusterBootstrapOptions = ClusterBootstrapOptionsBuilder;
