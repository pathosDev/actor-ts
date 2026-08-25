import type { ActorRef } from '../ActorRef.js';
import { ActorSystem } from '../ActorSystem.js';
import { ActorSystemOptions } from '../ActorSystemOptions.js';
import {
  ReceptionistId,
  type SeedProvider,
} from '../discovery/index.js';
import { autoDiscovery, singleProviderDiscovery } from '../discovery/AutoDiscovery.js';
import { AutoDiscoveryOptions } from '../discovery/AutoDiscoveryOptions.js';
import { AggregateSeedProvider } from '../discovery/AggregateSeedProvider.js';
import { ConfigSeedProvider } from '../discovery/ConfigSeedProvider.js';
import { ConfigSeedProviderOptions } from '../discovery/ConfigSeedProviderOptions.js';
import { mergeOptions } from '../util/OptionsMerge.js';
import { ClusterLeavingReason, CoordinatedShutdownId, type CoordinatedShutdown } from '../CoordinatedShutdown.js';
import { Cluster } from './Cluster.js';
import { ClusterOptions, resolveAdvertisedHost } from './ClusterOptions.js';
import type { SelfElectionPolicy } from './ClusterOptions.js';
import { NodeAddress } from './NodeAddress.js';
import { StableObservation } from './bootstrap/StableObservation.js';
import { readStableObservationOptionsFromConfig } from './bootstrap/StableObservationOptions.js';
import type { ProcessSignal } from '../util/ProcessSignal.js';
import type { StableObservationTuning } from './bootstrap/StableObservationOptions.js';
import {
  ClusterBootstrapOptionsValidator,
  DEFAULT_AWAIT_READY_MS,
  DEFAULT_BIND_HOST,
  DEFAULT_PORT,
  readClusterBootstrapDefaultsFromConfig,
} from './ClusterBootstrapOptions.js';
import type {
  ClusterBootstrapConfigDefaults,
  ClusterBootstrapOptions,
  ClusterBootstrapOptionsType,
} from './ClusterBootstrapOptions.js';
import type { ClusterReadinessOptions } from './ClusterReadiness.js';

/** Return value of {@link Cluster.bootstrap}. */
export type BootstrappedCluster = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  /** `null` when `receptionist: false` was passed. */
  readonly receptionist: ActorRef<unknown> | null;
  /**
   * Graceful shutdown — runs the {@link CoordinatedShutdown} pipeline, which
   * unbinds HTTP servers, closes brokers, leaves the cluster and terminates
   * the system, in that order.  Idempotent; safe to call multiple times.
   * Bound to SIGTERM/SIGINT by default (see
   * {@link ClusterBootstrapOptionsType.shutdownOnSignals}).
   *
   * It used to leave and terminate directly, which skipped every other
   * registered task; anything a bootstrapped node had registered — an HTTP
   * unbind, a DevTools detach — simply never ran on SIGTERM (#549).
   */
  readonly shutdown: () => Promise<void>;
  /**
   * Whether this node **formed a new cluster** (it self-elected to `up`)
   * rather than joining an existing one (a peer's leader promoted it) —
   * the distinction #943 asks for.  A live view of `cluster.selfElected`,
   * not a snapshot: under `awaitReady: false` a deferred election can fire
   * after `bootstrap()` has returned, and a snapshot taken at return time
   * would be stale exactly then.
   */
  readonly formedNewCluster: boolean;
};

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
  const host = resolveBindHost(resolvedOptions);
  // The two are the same value whenever one routable host was named, and
  // differ exactly where the bind target is a wildcard.  Resolved here as well
  // as in `Cluster.join` because three things upstream of the join need the
  // identity: the election orders on it, the seed filter compares against it,
  // and both run before `join` is called.
  const advertisedHost = resolveAdvertisedHost({ host, advertisedHost: resolvedOptions.advertisedHost });
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
        selfAddress: new NodeAddress(resolvedOptions.name, advertisedHost, port),
        log: (message) => system.log.info(message),
      })
      : {
        seeds: await resolveSeeds({
          explicit: resolvedOptions.seeds,
          discovery: resolvedOptions.discovery,
          systemName: resolvedOptions.name,
          port,
          selfHost: advertisedHost,
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
  // Forward only what the caller actually named, never the value derived from
  // it.  `Cluster.join` runs the same chain over the same `host` and the same
  // environment, so it arrives at the same answer — and it can still tell that
  // nobody named one, which is what the startup diagnostic is keyed on.
  // Passing the derived value would suppress that warning on the path most
  // deployments take.
  if (resolvedOptions.advertisedHost !== undefined) {
    clusterOptions.withAdvertisedHost(resolvedOptions.advertisedHost);
  }
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

  // Wire shutdown.  The pipeline is the whole implementation now: `leave()`
  // is a `cluster-leave` task registered by `Cluster.join`, and terminating
  // the system is the built-in `actor-system-terminate` task.  Doing it by
  // hand here is what made a SIGTERM on a bootstrapped node skip every other
  // registered task — the HTTP unbind above all, which is registered
  // correctly and never fired (#549).  `run()` hands back the same in-flight
  // promise on every call, so this stays idempotent without a latch.
  const coordinatedShutdown = system.extension(CoordinatedShutdownId);
  const shutdown = (): Promise<void> => coordinatedShutdown.run(ClusterLeavingReason.instance);

  const readiness = resolveAwaitReady(
    resolvedOptions.awaitReady,
    readClusterBootstrapDefaultsFromConfig(system.config),
    joinPlan,
  );
  if (readiness !== null) {
    try {
      await cluster.awaitReady(readiness);
    } catch (err) {
      // Unlike the JoinPlan-throw path above, `Cluster.join` HAS completed
      // here: the cluster-leave task is registered and the receptionist may
      // be running.  The pipeline is therefore the right teardown — a bare
      // `system.terminate()` would skip both, the exact #549 shape.  A
      // teardown failure must not mask the readiness error, so it is
      // swallowed; the error the caller gets is the one that matters.
      await shutdown().catch(() => {});
      throw err;
    }
  }

  installSignalHandlers(resolvedOptions.shutdownOnSignals ?? true, coordinatedShutdown);

  return {
    system,
    cluster,
    receptionist,
    shutdown,
    get formedNewCluster(): boolean { return cluster.selfElected; },
  };
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The interface this node **binds**.
 *
 * The chain is unchanged from when this function resolved one value for both
 * jobs, and that is deliberate: naming a single routable host still binds and
 * advertises it, so no configuration that works today moves.  What changed is
 * only the last resort — `'0.0.0.0'` now stops at the socket instead of
 * travelling on into `selfAddress`, where it was never an identity (#944).
 *
 * `CLUSTER_HOST` leads the env vars because it is the only one that means
 * *"this is my address"*: `POD_IP` is right by construction but exists only
 * where the pod spec exports it, and `HOSTNAME` is a pod name that resolves
 * under a StatefulSet with a headless service and nowhere else.  Naming it
 * after `CLUSTER_PORT` keeps the pair symmetric.
 */
function resolveBindHost(resolvedOptions: ClusterBootstrapOptionsType): string {
  if (resolvedOptions.host) return resolvedOptions.host;
  const clusterHost = (process.env.CLUSTER_HOST ?? '').trim();
  if (clusterHost) return clusterHost;
  const podIp = (process.env.POD_IP ?? '').trim();
  if (podIp) return podIp;
  const hostname = (process.env.HOSTNAME ?? '').trim();
  if (hostname) return hostname;
  return DEFAULT_BIND_HOST;
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
  // A rejection propagates — into bootstrapCluster's JoinPlan catch, which
  // terminates the just-created system and rethrows.  Catching it here and
  // returning [] is what turned a DNS blip into a self-elected one-node
  // cluster: an empty list reads as "we are the first node" (#943).
  const addrs = await provider.lookup();
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
  /**
   * The election grace, present exactly when stable observation ran —
   * carried for winners and `'never'` nodes alike, because the readiness
   * budget of a non-winner depends on the winner's grace (#1086).
   */
  readonly selfElectionGraceMs?: number;
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
    selfElectionGraceMs: targets.selfElectionGraceMs,
  };
}

/**
 * Normalise the `awaitReady` option into what `cluster.awaitReady` takes —
 * or `null` for "do not wait".
 *
 * The computed budget is five seconds — except behind stable observation,
 * where the readiness of **every** node hangs on the election grace, not
 * only the winner's: the winner's `SelfUp` is not due until its grace has
 * elapsed, and a non-winner's promotion cannot arrive before that same
 * deadline fires on the winner.  A flat default therefore expired on N-1 of
 * N nodes of every genuine cold start while nothing was wrong (#1086).
 *
 * Precedence per field: explicit option > `actor-ts.cluster.bootstrap.*` >
 * the computed budget.  Layered by hand rather than through `mergeOptions`
 * because the lowest layer is plan-dependent, not a constant.  A HOCON
 * `await-ready = 0s` disables the wait, mirroring `awaitReady: 0`.
 */
function resolveAwaitReady(
  option: ClusterBootstrapOptionsType['awaitReady'],
  fromConfig: ClusterBootstrapConfigDefaults,
  plan: JoinPlan,
): ClusterReadinessOptions | null {
  const computedTimeoutMs = (): number => (
    plan.selfElectionGraceMs !== undefined
      ? plan.selfElectionGraceMs + DEFAULT_AWAIT_READY_MS
      : DEFAULT_AWAIT_READY_MS
  );
  if (option === false || option === 0) return null;
  const timeoutMs = typeof option === 'number'
    ? option
    : (typeof option === 'object' ? option.timeoutMs : undefined)
      ?? fromConfig.awaitReadyMs
      ?? computedTimeoutMs();
  if (timeoutMs === 0) return null;
  const minimumMembers = (typeof option === 'object' ? option.minimumMembers : undefined)
    ?? fromConfig.minimumMembers;
  return minimumMembers !== undefined ? { timeoutMs, minimumMembers } : { timeoutMs };
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

/**
 * Hand the signal wiring to {@link CoordinatedShutdown}, which installs it
 * through the `src/runtime/signals/` backend.
 *
 * The raw `process.once` this replaces registered nothing at all on Deno —
 * its `process` shim carries no signal events — and could not be detached,
 * so a bootstrapped system was un-embeddable: nothing gave the handlers back.
 */
function installSignalHandlers(
  mode: boolean | ReadonlyArray<ProcessSignal>,
  coordinatedShutdown: CoordinatedShutdown,
): void {
  if (mode === false) return;
  coordinatedShutdown.installProcessHooks(Array.isArray(mode) ? mode : undefined);
}
