import type { TlsTransportOptionsType } from '../runtime/tcp/index.js';
import type { Logger } from '../Logger.js';
import { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { mergeOptions } from '../util/OptionsMerge.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/**
 * Synthetic system name a client puts in its `hello` when none is set.
 *
 * It names the client's side of the handshake and nothing else: it is not an
 * identity, not an authorisation, and the cluster being dialled need not carry
 * it.  Named rather than left as a literal because it is now also the
 * published default of `actor-ts.cluster.client.system-name`, and a published
 * default with no constant behind it has nothing to be compared against.
 */
export const DEFAULT_CLUSTER_CLIENT_SYSTEM_NAME = 'cluster-client';

/**
 * How long a `ClusterClient` waits for the receptionist's `hello-ack` before
 * giving up on a contact point and trying the next one.  Matches
 * `HANDSHAKE_TIMEOUT_MS` (`src/cluster/Constants.ts`): both bound the same
 * thing from opposite ends of the same handshake.
 *
 * Lives here rather than beside its counterpart because it is this options
 * type's built-in default — the `connectTimeoutMs` field below and the
 * published `actor-ts.cluster.client.connect-timeout` both resolve to it.
 * The pairing the two constants document is real and a pointer beside
 * `HANDSHAKE_TIMEOUT_MS` keeps it findable from the other end.
 */
export const DEFAULT_CLUSTER_CLIENT_CONNECT_TIMEOUT_MS = 5_000;

/** Plain options-object shape accepted by a {@link ClusterClient}. */
export type ClusterClientOptionsType = {
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
  /**
   * How long ONE contact point gets to answer the `hello` handshake before the
   * client abandons it and dials the next.  Default:
   * {@link DEFAULT_CLUSTER_CLIENT_CONNECT_TIMEOUT_MS}.
   *
   * Not `actor-ts.remote.handshake-timeout`, which bounds the same handshake
   * from the *accepting* side.  Two numbers rather than one because the two
   * clocks start at different moments — this one before the TCP connect and
   * the TLS handshake, that one after the accept — so the dialling side has
   * always given up first and a slow-but-legitimate peer is never punished by
   * the acceptor's deadline.
   */
  readonly connectTimeoutMs?: number;
  /** Optional TLS config — must match the cluster's. */
  readonly tls?: TlsTransportOptionsType;
  /** Custom logger; default: ConsoleLogger at WARN. */
  readonly logger?: Logger;
};

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

  /** Per-contact-point wait for the `hello-ack`, in ms.  Default 5 s. */
  withConnectTimeoutMs(ms: number): this {
    return this.set('connectTimeoutMs', ms);
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
 * Validates resolved {@link ClusterClientOptionsType} settings.  `contactPoints`
 * is required and non-empty (there is nothing to dial otherwise); it is
 * checked explicitly because the field-name helpers treat an unset value as
 * "not provided" and pass.
 */
export class ClusterClientOptionsValidator extends OptionsValidator<ClusterClientOptionsType> {
  constructor() {
    super('ClusterClientOptions');
  }
  protected rules(s: Partial<ClusterClientOptionsType>): void {
    if (s.contactPoints === undefined || s.contactPoints.length === 0) {
      this.fail('contactPoints', 'must contain at least one entry', s.contactPoints);
    }
    this.positiveNumber('askTimeoutMs');
    this.positiveNumber('connectTimeoutMs');
  }
}

/**
 * The slice of {@link ClusterClientOptionsType} that
 * `actor-ts.cluster.client` can state.
 *
 * `clientIdentity`, `tls` and `logger` are absent on purpose.  `logger` is a
 * `Logger` instance and `tls` is certificate material, neither of which HOCON
 * spells; `clientIdentity` is the one that is a *security* decision rather
 * than a packaging one — its port is drawn from the CSPRNG so a peer cannot
 * predict, address or pre-claim a client's slot, and one value shared across a
 * fleet is precisely what that draw exists to prevent.  Same reasoning that
 * keeps `ClusterOptions.selfElection` out of the cluster block.
 */
export type ClusterClientConfigDefaults = Partial<Pick<
  ClusterClientOptionsType,
  'contactPoints' | 'systemName' | 'askTimeoutMs' | 'connectTimeoutMs'
>>;

/**
 * Read `actor-ts.cluster.client.*`.  Like
 * `readWorkerClusterOptionsFromConfig` and unlike the rest of the framework's
 * config readers, this one loads the config itself: `new ClusterClient(...)`
 * is standalone — the client is by definition outside the cluster, holds no
 * `ActorSystem`, and therefore has no `system.config` above it.
 * {@link Config.load} is the same chain `ActorSystem.create` uses, honouring
 * `ACTOR_TS_CONFIG` and `./application.conf`.
 *
 * The `config` parameter is the seam that keeps that honest: a test (or a
 * caller that wants a client immune to whatever `application.conf` happens to
 * sit in the working directory) passes one explicitly and the filesystem is
 * never consulted.
 *
 * An absent leaf stays absent in the result rather than arriving as an
 * explicit `undefined` — the merge below spreads this object over the caller's
 * options, and a key present with `undefined` would shadow the built-in
 * default underneath it.
 */
export function readClusterClientOptionsFromConfig(
  config: Config = Config.load(),
): ClusterClientConfigDefaults {
  const keys = ConfigKeys.cluster.client;
  const out: { -readonly [K in keyof ClusterClientConfigDefaults]: ClusterClientConfigDefaults[K] } = {};
  if (config.hasPath(keys.contactPoints)) {
    out.contactPoints = config.getStringList(keys.contactPoints);
  }
  if (config.hasPath(keys.systemName)) {
    out.systemName = config.getString(keys.systemName);
  }
  if (config.hasPath(keys.askTimeout)) {
    out.askTimeoutMs = config.getDuration(keys.askTimeout);
  }
  if (config.hasPath(keys.connectTimeout)) {
    out.connectTimeoutMs = config.getDuration(keys.connectTimeout);
  }
  return out;
}

/**
 * Layer the config block under the caller's options — **explicit options >
 * HOCON > built-in defaults**, as everywhere else.  The result is what
 * {@link ClusterClientOptionsValidator} sees, so an empty `contact-points` in
 * a config file is rejected exactly like an empty one in code.
 *
 * Left deliberately extensible: #689's `buffer-size` and `reconnect-timeout`
 * are two more leaves read into {@link ClusterClientConfigDefaults}, not a
 * different shape.
 */
export function withClusterClientConfigDefaults(
  options: Partial<ClusterClientOptionsType>,
  config?: Config,
): ClusterClientOptionsType {
  return mergeOptions<ClusterClientOptionsType>(
    {},
    readClusterClientOptionsFromConfig(config),
    options,
  );
}

/**
 * Accepted input for the {@link ClusterClient} constructor: the fluent
 * {@link ClusterClientOptionsBuilder} OR a plain
 * {@link ClusterClientOptionsType} object.
 */
export type ClusterClientOptions = ClusterClientOptionsBuilder | Partial<ClusterClientOptionsType>;
/** Value alias so `ClusterClientOptions.create()` / `new ClusterClientOptions()` resolve to the builder. */
export const ClusterClientOptions = ClusterClientOptionsBuilder;
