import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { ClusterBootstrapSettings } from './ClusterBootstrap.js';

/**
 * Fluent builder for {@link ClusterBootstrapSettings} — the sole input
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
export class ClusterBootstrapOptions extends OptionsBuilder<ClusterBootstrapSettings> {
  /**
   * Start a fresh builder for the given ActorSystem name.  `name` is the
   * one required field, so it is taken up-front rather than via a
   * separate `withX`.
   */
  static create(name: string): ClusterBootstrapOptions {
    return new ClusterBootstrapOptions().set('name', name);
  }

  /* ----------------------------- System -------------------------------- */

  /** Logger forwarded to `ActorSystem.create`. */
  withLogger(logger: NonNullable<ClusterBootstrapSettings['logger']>): this {
    return this.set('logger', logger);
  }

  /** Log level forwarded to `ActorSystem.create`. */
  withLogLevel(logLevel: NonNullable<ClusterBootstrapSettings['logLevel']>): this {
    return this.set('logLevel', logLevel);
  }

  /** Inline HOCON / config object forwarded to `ActorSystem.create`. */
  withConfig(config: NonNullable<ClusterBootstrapSettings['config']>): this {
    return this.set('config', config);
  }

  /** Config file path forwarded to `ActorSystem.create`. */
  withConfigFile(configFile: NonNullable<ClusterBootstrapSettings['configFile']>): this {
    return this.set('configFile', configFile);
  }

  /** Persistence settings forwarded to `ActorSystem.create`. */
  withPersistence(persistence: NonNullable<ClusterBootstrapSettings['persistence']>): this {
    return this.set('persistence', persistence);
  }

  /**
   * Signals that trigger `shutdown()`.  `true` (default) uses
   * `['SIGTERM','SIGINT']`; pass a list to customise or `false` to
   * disable.
   */
  withShutdownOnSignals(signals: NonNullable<ClusterBootstrapSettings['shutdownOnSignals']>): this {
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
  withTransport(transport: NonNullable<ClusterBootstrapSettings['transport']>): this {
    return this.set('transport', transport);
  }

  /** Explicit seed list.  When set, `discovery` is ignored. */
  withSeeds(seeds: NonNullable<ClusterBootstrapSettings['seeds']>): this {
    return this.set('seeds', seeds);
  }

  /** Discovery strategy — `'auto'`, a named provider, or a custom aggregate. */
  withDiscovery(discovery: NonNullable<ClusterBootstrapSettings['discovery']>): this {
    return this.set('discovery', discovery);
  }

  /** Role tags exposed to other members. */
  withRoles(roles: NonNullable<ClusterBootstrapSettings['roles']>): this {
    return this.set('roles', roles);
  }

  /** Failure-detector thresholds. */
  withFailureDetector(failureDetector: NonNullable<ClusterBootstrapSettings['failureDetector']>): this {
    return this.set('failureDetector', failureDetector);
  }

  /** How often gossip is pushed to a random reachable peer. */
  withGossipIntervalMs(ms: number): this {
    return this.set('gossipIntervalMs', ms);
  }

  /** Optional split-brain resolver. */
  withDowning(downing: NonNullable<ClusterBootstrapSettings['downing']>): this {
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
