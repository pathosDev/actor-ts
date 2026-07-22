import type { ActorRef } from '../ActorRef.js';
import { ActorSystem } from '../ActorSystem.js';
import { ActorSystemOptions } from '../ActorSystemOptions.js';
import {
  ReceptionistId,
  type SeedProvider,
} from '../discovery/index.js';
import { autoDiscovery, singleProviderDiscovery } from '../discovery/autoDiscovery.js';
import { AutoDiscoveryOptions } from '../discovery/AutoDiscoveryOptions.js';
import { AggregateSeedProvider } from '../discovery/AggregateSeedProvider.js';
import { Cluster } from './Cluster.js';
import { ClusterOptions } from './ClusterOptions.js';
import { SelfUp, type ClusterEvent } from './ClusterEvents.js';
import { NodeAddress } from './NodeAddress.js';
import { ClusterBootstrapOptionsValidator } from './ClusterBootstrapOptions.js';
import type { ClusterBootstrapOptions, ClusterBootstrapOptionsType } from './ClusterBootstrapOptions.js';

/** Return value of {@link Cluster.bootstrap}. */
export interface BootstrappedCluster {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  /** `null` when `receptionist: false` was passed. */
  readonly receptionist: ActorRef<unknown> | null;
  /**
   * Graceful shutdown — leaves the cluster, then terminates the
   * system.  Idempotent; safe to call multiple times.  Bound to
   * SIGTERM/SIGINT by default (see {@link ClusterBootstrapOptionsType.shutdownOnSignals}).
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
 * See the {@link ClusterBootstrapOptionsType} doc for what each field
 * controls and which env vars steer the defaults.
 */
export async function bootstrapCluster(
  options: ClusterBootstrapOptions,
): Promise<BootstrappedCluster> {
  const resolvedOptions = options as ClusterBootstrapOptionsType;
  new ClusterBootstrapOptionsValidator().validate(resolvedOptions);
  const host = resolveHost(resolvedOptions);
  const port = resolvePort(resolvedOptions);

  const system = ActorSystem.create(resolvedOptions.name, extractSystemOptions(resolvedOptions));

  const seeds = await resolveSeeds({
    explicit: resolvedOptions.seeds,
    discovery: resolvedOptions.discovery,
    systemName: resolvedOptions.name,
    port,
    selfHost: host,
    log: (message, err) => system.log.warn(`bootstrap discovery: ${message}${err ? ` (${(err as Error).message ?? err})` : ''}`),
  });

  const clusterOptions = ClusterOptions.create()
    .withHost(host)
    .withPort(port)
    .withSeeds([...seeds]);
  if (resolvedOptions.roles) clusterOptions.withRoles([...resolvedOptions.roles]);
  if (resolvedOptions.transport) clusterOptions.withTransport(resolvedOptions.transport);
  if (resolvedOptions.failureDetector) clusterOptions.withFailureDetector(resolvedOptions.failureDetector);
  if (resolvedOptions.gossipIntervalMs !== undefined) clusterOptions.withGossipIntervalMs(resolvedOptions.gossipIntervalMs);
  if (resolvedOptions.downing) clusterOptions.withDowning(resolvedOptions.downing);

  const cluster = await Cluster.join(system, clusterOptions);

  const startReceptionist = resolvedOptions.receptionist ?? true;
  const receptionist = startReceptionist
    ? (system.extension(ReceptionistId).start(cluster) as ActorRef<unknown>)
    : null;

  await awaitSelfUp(cluster, resolvedOptions.awaitReady ?? true);

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

  installSignalHandlers(resolvedOptions.shutdownOnSignals ?? true, shutdown);

  return { system, cluster, receptionist, shutdown };
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                            */
/* -------------------------------------------------------------------------- */

function resolveHost(resolvedOptions: ClusterBootstrapOptionsType): string {
  if (resolvedOptions.host) return resolvedOptions.host;
  const podIp = (process.env.POD_IP ?? '').trim();
  if (podIp) return podIp;
  const hostname = (process.env.HOSTNAME ?? '').trim();
  if (hostname) return hostname;
  return '0.0.0.0';
}

function resolvePort(resolvedOptions: ClusterBootstrapOptionsType): number {
  if (typeof resolvedOptions.port === 'number' && Number.isFinite(resolvedOptions.port)) return resolvedOptions.port;
  const raw = (process.env.CLUSTER_PORT ?? '').trim();
  if (raw.length > 0) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_PORT;
}

function extractSystemOptions(resolvedOptions: ClusterBootstrapOptionsType): ActorSystemOptions {
  const out = ActorSystemOptions.create();
  if (resolvedOptions.logger) out.withLogger(resolvedOptions.logger);
  if (resolvedOptions.logLevel !== undefined) out.withLogLevel(resolvedOptions.logLevel);
  if (resolvedOptions.config !== undefined) out.withConfig(resolvedOptions.config);
  if (resolvedOptions.configFile !== undefined) out.withConfigFile(resolvedOptions.configFile);
  if (resolvedOptions.persistence) out.withPersistence(resolvedOptions.persistence);
  return out;
}

async function resolveSeeds(args: {
  explicit: ClusterBootstrapOptionsType['seeds'];
  discovery: ClusterBootstrapOptionsType['discovery'];
  systemName: string;
  port: number;
  selfHost: string;
  log: (message: string, err?: unknown) => void;
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
  spec: NonNullable<ClusterBootstrapOptionsType['discovery']>,
  base: { systemName: string; port: number; log: (message: string, err?: unknown) => void },
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
    // `unsubscribe` is assigned AFTER cluster.subscribe() returns, but the
    // subscribe callback may fire synchronously during replay (when
    // self is already up).  Hold `unsubscribe` in a mutable slot so the
    // callback can both read it without a TDZ error and clear it
    // safely once.
    let unsubscribe: (() => void) | null = null;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    unsubscribe = cluster.subscribe((evt: ClusterEvent) => {
      if (evt instanceof SelfUp) finish();
    });
    // If replay already fired SelfUp synchronously, finish() ran with
    // `unsubscribe === null` and resolved — clean up the listener now.
    if (done && unsubscribe) { (unsubscribe as () => void)(); unsubscribe = null; }
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
