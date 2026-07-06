import type { ActorRef } from '../ActorRef.js';
import { ActorSystem, type ActorSystemSettings } from '../ActorSystem.js';
import {
  ReceptionistId,
  type SeedProvider,
} from '../discovery/index.js';
import { autoDiscovery, singleProviderDiscovery, AutoDiscoveryOptions } from '../discovery/autoDiscovery.js';
import { AggregateSeedProvider } from '../discovery/AggregateSeedProvider.js';
import { Cluster, ClusterOptions, type ClusterSettings } from './Cluster.js';
import { SelfUp, type ClusterEvent } from './ClusterEvents.js';
import { NodeAddress } from './NodeAddress.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';

/**
 * Settings accepted by {@link Cluster.bootstrap}.  Everything is
 * optional except `name`; sensible defaults turn the call into a
 * single-line hello-cluster.  Build one with {@link ClusterBootstrapOptions}.
 */
export interface ClusterBootstrapSettings {
  /* ----------------------------- System -------------------------------- */

  /** ActorSystem name. */
  readonly name: string;

  /** Optional logger / log level / config overrides — forwarded to `ActorSystem.create`. */
  readonly logger?: ActorSystemSettings['logger'];
  readonly logLevel?: ActorSystemSettings['logLevel'];
  readonly config?: ActorSystemSettings['config'];
  readonly configFile?: ActorSystemSettings['configFile'];
  readonly persistence?: ActorSystemSettings['persistence'];

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
  readonly transport?: ClusterSettings['transport'];

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

  readonly roles?: ClusterSettings['roles'];
  readonly failureDetector?: ClusterSettings['failureDetector'];
  readonly gossipIntervalMs?: ClusterSettings['gossipIntervalMs'];
  readonly downing?: ClusterSettings['downing'];

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

/** Return value of {@link Cluster.bootstrap}. */
export interface BootstrappedCluster {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  /** `null` when `receptionist: false` was passed. */
  readonly receptionist: ActorRef<unknown> | null;
  /**
   * Graceful shutdown — leaves the cluster, then terminates the
   * system.  Idempotent; safe to call multiple times.  Bound to
   * SIGTERM/SIGINT by default (see {@link ClusterBootstrapSettings.shutdownOnSignals}).
   */
  readonly shutdown: () => Promise<void>;
}

const DEFAULT_AWAIT_READY_MS = 5_000;
const DEFAULT_PORT = 2552;

/**
 * One-call setup for a clustered ActorSystem.  Designed for the
 * 90 % case — defaults wire transport, discovery, receptionist and
 * signal-based shutdown so the call site reads as a single line.
 * Power users keep `ActorSystem.create()` + `Cluster.join()` for
 * full control.
 *
 * See the {@link ClusterBootstrapSettings} doc for what each field
 * controls and which env vars steer the defaults.
 */
export async function bootstrapCluster(
  options: ClusterBootstrapOptions,
): Promise<BootstrappedCluster> {
  const opts = options.build() as ClusterBootstrapSettings;
  const host = resolveHost(opts);
  const port = resolvePort(opts);

  const system = ActorSystem.create(opts.name, extractSystemSettings(opts));

  const seeds = await resolveSeeds({
    explicit: opts.seeds,
    discovery: opts.discovery,
    systemName: opts.name,
    port,
    selfHost: host,
    log: (msg, err) => system.log.warn(`bootstrap discovery: ${msg}${err ? ` (${(err as Error).message ?? err})` : ''}`),
  });

  const clusterOptions = ClusterOptions.create()
    .withHost(host)
    .withPort(port)
    .withSeeds([...seeds]);
  if (opts.roles) clusterOptions.withRoles([...opts.roles]);
  if (opts.transport) clusterOptions.withTransport(opts.transport);
  if (opts.failureDetector) clusterOptions.withFailureDetector(opts.failureDetector);
  if (opts.gossipIntervalMs !== undefined) clusterOptions.withGossipIntervalMs(opts.gossipIntervalMs);
  if (opts.downing) clusterOptions.withDowning(opts.downing);

  const cluster = await Cluster.join(system, clusterOptions);

  const startReceptionist = opts.receptionist ?? true;
  const receptionist = startReceptionist
    ? (system.extension(ReceptionistId).start(cluster) as ActorRef<unknown>)
    : null;

  await awaitSelfUp(cluster, opts.awaitReady ?? true);

  // Wire shutdown.
  let shuttingDown: Promise<void> | null = null;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      try { await cluster.leave(); } catch { /* best-effort */ }
      await system.terminate();
    })();
    return shuttingDown;
  };

  installSignalHandlers(opts.shutdownOnSignals ?? true, shutdown);

  return { system, cluster, receptionist, shutdown };
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                            */
/* -------------------------------------------------------------------------- */

function resolveHost(opts: ClusterBootstrapSettings): string {
  if (opts.host) return opts.host;
  const podIp = (process.env.POD_IP ?? '').trim();
  if (podIp) return podIp;
  const hostname = (process.env.HOSTNAME ?? '').trim();
  if (hostname) return hostname;
  return '0.0.0.0';
}

function resolvePort(opts: ClusterBootstrapSettings): number {
  if (typeof opts.port === 'number' && Number.isFinite(opts.port)) return opts.port;
  const raw = (process.env.CLUSTER_PORT ?? '').trim();
  if (raw.length > 0) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_PORT;
}

function extractSystemSettings(opts: ClusterBootstrapSettings): ActorSystemSettings {
  const out: ActorSystemSettings = {};
  if (opts.logger) (out as { logger?: typeof opts.logger }).logger = opts.logger;
  if (opts.logLevel !== undefined) (out as { logLevel?: typeof opts.logLevel }).logLevel = opts.logLevel;
  if (opts.config !== undefined) (out as { config?: typeof opts.config }).config = opts.config;
  if (opts.configFile !== undefined) (out as { configFile?: typeof opts.configFile }).configFile = opts.configFile;
  if (opts.persistence) (out as { persistence?: typeof opts.persistence }).persistence = opts.persistence;
  return out;
}

async function resolveSeeds(args: {
  explicit: ClusterBootstrapSettings['seeds'];
  discovery: ClusterBootstrapSettings['discovery'];
  systemName: string;
  port: number;
  selfHost: string;
  log: (msg: string, err?: unknown) => void;
}): Promise<string[]> {
  if (args.explicit !== undefined) {
    return [...args.explicit];
  }
  const provider = buildSeedProvider(args.discovery ?? 'auto', {
    systemName: args.systemName,
    port: args.port,
    log: args.log,
  });
  const addrs = await provider.lookup().catch((err) => {
    args.log('seed provider lookup failed', err);
    return [] as NodeAddress[];
  });
  return addrs
    // Filter out our own address — gossiping at ourselves is harmless but
    // adds noise to the log.
    .filter((a) => !(a.host === args.selfHost && a.port === args.port))
    .map((a) => a.toString());
}

function buildSeedProvider(
  spec: NonNullable<ClusterBootstrapSettings['discovery']>,
  base: { systemName: string; port: number; log: (msg: string, err?: unknown) => void },
): SeedProvider {
  const discoveryOptions = AutoDiscoveryOptions.create()
    .withSystemName(base.systemName)
    .withPort(base.port)
    .withLog(base.log);
  if (spec === 'auto') return autoDiscovery(discoveryOptions);
  if (spec === 'config' || spec === 'dns' || spec === 'kubernetes') {
    return singleProviderDiscovery(spec, discoveryOptions);
  }
  if ('providers' in spec) {
    return new AggregateSeedProvider([...spec.providers], base.log);
  }
  return spec;
}

async function awaitSelfUp(cluster: Cluster, mode: boolean | number): Promise<void> {
  if (mode === false || mode === 0) return;
  const timeoutMs = mode === true ? DEFAULT_AWAIT_READY_MS : mode;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;

  await new Promise<void>((resolve) => {
    let done = false;
    // `unsub` is assigned AFTER cluster.subscribe() returns, but the
    // subscribe callback may fire synchronously during replay (when
    // self is already up).  Hold `unsub` in a mutable slot so the
    // callback can both read it without a TDZ error and clear it
    // safely once.
    let unsub: (() => void) | null = null;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (unsub) { unsub(); unsub = null; }
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    unsub = cluster.subscribe((evt: ClusterEvent) => {
      if (evt instanceof SelfUp) finish();
    });
    // If replay already fired SelfUp synchronously, finish() ran with
    // `unsub === null` and resolved — clean up the listener now.
    if (done && unsub) { (unsub as () => void)(); unsub = null; }
  });
}

function installSignalHandlers(
  mode: boolean | ReadonlyArray<NodeJS.Signals>,
  shutdown: () => Promise<void>,
): void {
  if (mode === false) return;
  const signals: ReadonlyArray<NodeJS.Signals> = Array.isArray(mode)
    ? mode
    : (['SIGTERM', 'SIGINT'] as const);
  for (const sig of signals) {
    process.once(sig, () => { void shutdown(); });
  }
}
