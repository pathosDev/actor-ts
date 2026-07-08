import type { TlsTransportOptionsType } from '../runtime/tcp/index.js';
import type { Logger } from '../Logger.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';

/** Plain settings-object shape accepted by a {@link ClusterClient}. */
export interface ClusterClientOptionsType {
  /**
   * Cluster nodes to dial.  Each is a `host:port` or `<system>@host:port`
   * string — the same shape `Cluster.join` accepts for seeds.  Tried in
   * order; on dial failure the next is attempted.
   */
  readonly contactPoints: ReadonlyArray<string>;
  /** Synthetic system name embedded in the client's hello.  Default: 'cluster-client'. */
  readonly systemName?: string;
  /**
   * Host + port the client claims as its identity.  The cluster uses this
   * to route `cluster-client-reply` frames back over the right connection.
   * Use a host:port that uniquely identifies this client instance — random
   * defaults are fine because the cluster only needs it for connection
   * routing, not for actual networking back to the client.
   */
  readonly clientIdentity?: { readonly host: string; readonly port: number };
  /** Default ask timeout (ms).  Default: 5_000. */
  readonly askTimeoutMs?: number;
  /** Optional TLS config — must match the cluster's. */
  readonly tls?: TlsTransportOptionsType;
  /** Custom logger; default: ConsoleLogger at WARN. */
  readonly logger?: Logger;
}

/**
 * Fluent builder for {@link ClusterClientOptionsType}:
 *
 *     new ClusterClient(
 *       ClusterClientOptions.create()
 *         .withContactPoints(['sys@127.0.0.1:2551'])
 *         .withAskTimeoutMs(3_000),
 *     );
 */
export class ClusterClientOptionsBuilder extends OptionsBuilder<ClusterClientOptionsType> {
  /** Start a fresh builder.  Equivalent to `new ClusterClientOptionsBuilder()`. */
  static create(): ClusterClientOptionsBuilder {
    return new ClusterClientOptionsBuilder();
  }

  /** Cluster nodes to dial (`host:port` or `<system>@host:port`).  Tried in order. */
  withContactPoints(contactPoints: ReadonlyArray<string>): this {
    return this.set('contactPoints', contactPoints);
  }

  /** Synthetic system name embedded in the client's hello.  Default `cluster-client`. */
  withSystemName(systemName: string): this {
    return this.set('systemName', systemName);
  }

  /** Host + port the client claims as its identity for reply routing. */
  withClientIdentity(host: string, port: number): this {
    return this.set('clientIdentity', { host, port });
  }

  /** Default ask timeout in ms.  Default 5 s. */
  withAskTimeoutMs(ms: number): this {
    return this.set('askTimeoutMs', ms);
  }

  /** TLS config — must match the cluster's. */
  withTls(tls: TlsTransportOptionsType): this {
    return this.set('tls', tls);
  }

  /** Custom logger; default ConsoleLogger at WARN. */
  withLogger(logger: Logger): this {
    return this.set('logger', logger);
  }
}

/**
 * Accepted input for the {@link ClusterClient} constructor: the fluent
 * {@link ClusterClientOptionsBuilder} OR a plain
 * {@link ClusterClientOptionsType} object.
 */
export type ClusterClientOptions = ClusterClientOptionsBuilder | Partial<ClusterClientOptionsType>;
/** Value alias so `ClusterClientOptions.create()` / `new ClusterClientOptions()` resolve to the builder. */
export const ClusterClientOptions = ClusterClientOptionsBuilder;
