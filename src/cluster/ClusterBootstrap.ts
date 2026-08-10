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
import { ConfigSeedProvider } from '../discovery/ConfigSeedProvider.js';
import { ConfigSeedProviderOptions } from '../discovery/ConfigSeedProviderOptions.js';
import { mergeOptions } from '../util/OptionsMerge.js';
import { Cluster } from './Cluster.js';
import { ClusterOptions } from './ClusterOptions.js';
import type { SelfElectionPolicy } from './ClusterOptions.js';
import { SelfUp, type ClusterEvent } from './ClusterEvents.js';
import { NodeAddress } from './NodeAddress.js';
import { StableObservation } from './bootstrap/StableObservation.js';
import { readStableObservationOptionsFromConfig } from './bootstrap/StableObservationOptions.js';
import type { StableObservationTuning } from './bootstrap/StableObservationOptions.js';
import { ClusterBootstrapOptionsValidator } from './ClusterBootstrapOptions.js';
import type { ClusterBootstrapOptions, ClusterBootstrapOptionsType } from './ClusterBootstrapOptions.js';

/** Return value of {@link Cluster.bootstrap}. */
export type BootstrappedCluster = {
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
};

const DEFAULT_AWAIT_READY_MS = 5_000;
const DEFAULT_PORT = 2552;

/** Stands in for discovery when the caller passed an explicit empty seed list. */
const EMPTY_SEED_PROVIDER: SeedProvider = { lookup: async () => [] };

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
  const log = (message: string, err?: unknown): void => system.log.warn(
    `bootstrap discovery: ${message}${err ? ` (${(err as Error).message ?? err})` : ''}`,
  );

  // A refused bootstrap must not leave the system (and its scheduler) running:
  // the stable-observation phase fails *by design* when discovery cannot be
  // agreed on, and a process that reports the failure and then hangs is not
  // the loud failure the design promised.
  let joinPlan: JoinPlan;
  try {
    joinPlan = resolvedOptions.stableObservation
      ? await observeStableSeeds({
        tuning: resolvedOptions.stableObservation === true ? {} : resolvedOptions.stableObservation,
        fromConfig: readStableObservationOptionsFromConfig(system.config),
        seedProvider: buildSeedProviderFor(resolvedOptions, port, log),
        selfAddress: new NodeAddress(resolvedOptions.name, host, port),
        log: (message) => system.log.info(message),
      })
      : {
        seeds: await resolveSeeds({
          explicit: resolvedOptions.seeds,
          discovery: resolvedOptions.discovery,
          systemName: resolvedOptions.name,
          port,
          selfHost: host,
          log,
        }),
      };
  } catch (err) {
    await system.terminate();
    throw err;
  }
  const { seeds, selfElection } = joinPlan;

  const clusterOptions = ClusterOptions.create()
    .withHost(host)
    .withPort(port)
    .withSeeds([...seeds]);
  if (selfElection !== undefined) clusterOptions.withSelfElection(selfElection);
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

  await awaitSelfUp(cluster, resolvedOptions.awaitReady ?? defaultAwaitReady(joinPlan));

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

/**
 * The host this node **advertises** — not merely the one it binds.  The value
 * becomes `selfAddress`, so it is what peers dial back and what the bootstrap
 * election orders on (#944).
 *
 * `CLUSTER_HOST` leads the env vars because it is the only one that means
 * *"this is my address"*: `POD_IP` is right by construction but exists only
 * where the pod spec exports it, and `HOSTNAME` is a pod name that resolves
 * under a StatefulSet with a headless service and nowhere else.  Naming it
 * after `CLUSTER_PORT` keeps the pair symmetric.
 *
 * `'0.0.0.0'` survives as the last resort so a single-node development run
 * still starts with no configuration at all — with more than one node it is
 * not an identity, which the stable-observation phase refuses outright rather
 * than letting an election run on it.
 */
function resolveHost(resolvedOptions: ClusterBootstrapOptionsType): string {
  if (resolvedOptions.host) return resolvedOptions.host;
  const clusterHost = (process.env.CLUSTER_HOST ?? '').trim();
  if (clusterHost) return clusterHost;
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

/** What the seed-resolution step decided, whichever branch produced it. */
type JoinPlan = {
  readonly seeds: string[];
  /** Absent on the legacy path — `Cluster` then keeps its `'immediate'` default. */
  readonly selfElection?: SelfElectionPolicy;
};

/**
 * Run the stable-observation phase and hand back what `Cluster.join` needs.
 *
 * The settings merge follows the project's precedence — explicit tuning >
 * `actor-ts.cluster.bootstrap.*` > built-in defaults — with the last layer
 * applied inside {@link StableObservation}, which is also where the merged
 * result is validated.
 */
async function observeStableSeeds(args: {
  tuning: StableObservationTuning;
  fromConfig: StableObservationTuning;
  seedProvider: SeedProvider;
  selfAddress: NodeAddress;
  log: (message: string) => void;
}): Promise<JoinPlan> {
  const tuning = mergeOptions<StableObservationTuning>({}, args.fromConfig, args.tuning);
  const observation = new StableObservation({
    ...tuning,
    seedProvider: args.seedProvider,
    selfAddress: args.selfAddress,
    log: tuning.log ?? args.log,
  });
  const targets = await observation.resolveJoinTargets();
  return {
    seeds: targets.seeds.map((address) => address.toString()),
    selfElection: targets.selfElection,
  };
}

/**
 * How long an unconfigured `awaitReady` waits.
 *
 * `true` — five seconds — everywhere except behind an election this node won:
 * there, `SelfUp` is not due until the self-election grace has elapsed, so the
 * flat default would time out on every genuine cold start and report a node
 * that is still `joining` as ready.  The budget is the grace plus the usual
 * five seconds of slack for the join round it is waiting on.
 */
function defaultAwaitReady(plan: JoinPlan): boolean | number {
  return typeof plan.selfElection === 'number'
    ? plan.selfElection + DEFAULT_AWAIT_READY_MS
    : true;
}

/**
 * The provider the stable observation polls.  An explicit `seeds` list is
 * wrapped rather than short-circuited: repeated polls over a fixed set settle
 * on the second one, and what the phase then contributes is the election —
 * which is exactly what the "give every node the same seed list" convention
 * lacks, since it leaves no node with the empty list that `'immediate'`
 * self-election requires.
 */
function buildSeedProviderFor(
  resolvedOptions: ClusterBootstrapOptionsType,
  port: number,
  log: (message: string, err?: unknown) => void,
): SeedProvider {
  if (resolvedOptions.seeds !== undefined) {
    // `seeds: []` is a deliberate "there is nobody else", which
    // `ConfigSeedProvider` rejects as a missing value.  The observation adds
    // self regardless, so an empty provider resolves to a one-node election.
    if (resolvedOptions.seeds.length === 0) return EMPTY_SEED_PROVIDER;
    const seedOptions = ConfigSeedProviderOptions.create()
      .withSeeds([...resolvedOptions.seeds])
      .withSystemName(resolvedOptions.name);
    return new ConfigSeedProvider(seedOptions);
  }
  return buildSeedProvider(resolvedOptions.discovery ?? 'auto', {
    systemName: resolvedOptions.name,
    port,
    log,
  });
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
