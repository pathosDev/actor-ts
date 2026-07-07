import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { ClusterSettings } from './Cluster.js';
import type { FailureDetectorSettings } from './FailureDetector.js';
import type { Transport } from './Transport.js';
import type { DowningProvider } from './downing/DowningProvider.js';

/**
 * Fluent builder for {@link ClusterSettings} — the sole input to
 * {@link Cluster.join}.  `host` + `port` are required; every other knob
 * is optional.  Polymorphic / whole-value fields (`transport`,
 * `downing`, `failureDetector`, `roles`, `seeds`) are passed as-is via a
 * single `withX(value)` — no nested builders.
 *
 *     await Cluster.join(
 *       system,
 *       ClusterOptions.create()
 *         .withHost('127.0.0.1')
 *         .withPort(2552)
 *         .withSeeds(['sys@127.0.0.1:2551']),
 *     );
 */
export class ClusterOptions extends OptionsBuilder<ClusterSettings> {
  /** Start a fresh builder.  Equivalent to `new ClusterOptions()`. */
  static create(): ClusterOptions {
    return new ClusterOptions();
  }

  /** Bind host. */
  withHost(host: string): this {
    return this.set('host', host);
  }

  /** Bind port. */
  withPort(port: number): this {
    return this.set('port', port);
  }

  /** Other nodes this node should try to contact on startup. */
  withSeeds(seeds: string[]): this {
    return this.set('seeds', seeds);
  }

  /** Role tags exposed to other members — constrain sharding placement. */
  withRoles(roles: string[]): this {
    return this.set('roles', roles);
  }

  /** Failure-detector thresholds (merged over the built-in defaults). */
  withFailureDetector(failureDetector: Partial<FailureDetectorSettings>): this {
    return this.set('failureDetector', failureDetector);
  }

  /** Override the transport (e.g. `InMemoryTransport` for tests). */
  withTransport(transport: Transport): this {
    return this.set('transport', transport);
  }

  /** How often gossip is pushed to a random reachable peer. */
  withGossipIntervalMs(ms: number): this {
    return this.set('gossipIntervalMs', ms);
  }

  /** How often to resend the initial join gossip to seeds until self is Up. */
  withSeedRetryIntervalMs(ms: number): this {
    return this.set('seedRetryIntervalMs', ms);
  }

  /** How long to keep a `removed` tombstone before pruning it.  Default 24 h. */
  withTombstoneTtlMs(ms: number): this {
    return this.set('tombstoneTtlMs', ms);
  }

  /** How often the tombstone-prune pass runs.  Default 5 min. */
  withTombstonePruneIntervalMs(ms: number): this {
    return this.set('tombstonePruneIntervalMs', ms);
  }

  /** Minimum age before a tombstone is eligible for pruning.  Default `6 × downAfterMs`. */
  withTombstoneMinRetentionMs(ms: number): this {
    return this.set('tombstoneMinRetentionMs', ms);
  }

  /** Auto-promote `joining` → `weakly-up` after this many ms.  0 disables (default). */
  withWeaklyUpAfterMs(ms: number): this {
    return this.set('weaklyUpAfterMs', ms);
  }

  /** Optional split-brain resolver (KeepMajority, KeepOldest, …). */
  withDowning(downing: DowningProvider): this {
    return this.set('downing', downing);
  }
}
