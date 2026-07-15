import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import type { ActorSystemOptionsType } from '../ActorSystemOptions.js';
import type { SeedProvider } from '../discovery/index.js';
import type { ClusterOptionsType } from './ClusterOptions.js';

/**
 * Options accepted by {@link Cluster.bootstrap}.  Everything is
 * optional except `name`; sensible defaults turn the call into a
 * single-line hello-cluster.  Build one with {@link ClusterBootstrapOptions}.
 */
export interface ClusterBootstrapOptionsType {
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
  readonly shutdownOnSignals?: boolean | ReadonlyArray<NodeJS.Signals>;

  /* ----------------------------- Cluster ------------------------------- */

  /**
   * Bind host.  Default resolution order:
   *   1. `opts.host`
   *   2. `process.env.POD_IP` (Kubernetes)
   *   3. `process.env.HOSTNAME`
   *   4. `'0.0.0.0'`
   */
  readonly host?: string;

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
   * Wait for this node's `SelfUp` event before resolving.
   *
   *   - `true` (default) — wait up to 5 000 ms.
   *   - `false` / `0`    — return immediately.
   *   - a number         — wait at most that many ms.
   *
   * On timeout the returned promise still resolves — the cluster
   * keeps trying in the background.  Set a custom value when seed
   * contact is slow (e.g. K8s pod start lag).
   */
  readonly awaitReady?: boolean | number;
}

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

  /** Bind host.  Defaults resolve via `POD_IP` / `HOSTNAME` / `0.0.0.0`. */
  withHost(host: string): this {
    return this.set('host', host);
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
   * Wait for this node's `SelfUp` before resolving — `true` (5 000 ms),
   * `false`/`0` (immediate), or a millisecond budget.
   */
  withAwaitReady(awaitReady: boolean | number): this {
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
    // Positive integer (not the TCP 1..65535 range) — the bootstrap port may
    // be a synthetic InMemoryTransport node id, same as ClusterOptions.port.
    this.positiveInt('port');
    this.positiveNumber('gossipIntervalMs');
    // awaitReady is boolean | number(ms); a numeric budget must be >= 0 (0 = immediate).
    if (typeof s.awaitReady === 'number' && (!Number.isFinite(s.awaitReady) || s.awaitReady < 0)) {
      this.fail('awaitReady', 'must be a boolean or a non-negative number of ms', s.awaitReady);
    }
  }
}

/**
 * Accepted input for {@link Cluster.bootstrap}: the fluent
 * {@link ClusterBootstrapOptionsBuilder} OR a plain
 * {@link ClusterBootstrapOptionsType} object.
 */
export type ClusterBootstrapOptions = ClusterBootstrapOptionsBuilder | Partial<ClusterBootstrapOptionsType>;
/** Value alias so `ClusterBootstrapOptions.create()` / `new ClusterBootstrapOptions()` resolve to the builder. */
export const ClusterBootstrapOptions = ClusterBootstrapOptionsBuilder;
