import { match, P } from 'ts-pattern';
import { parsePathSegments } from '../ActorPath.js';
import type { ActorRef } from '../ActorRef.js';
import type { ActorSystem } from '../ActorSystem.js';
import { LogContext } from '../LogContext.js';
import type { Logger } from '../Logger.js';
import { metricsOf } from '../metrics/MetricsExtension.js';
import { tracerOf } from '../tracing/TracingExtension.js';
import type { Cancellable } from '../Scheduler.js';
import { DEFAULT_GOSSIP_INTERVAL_MS } from '../util/Constants.js';
import { COLD_START_STALL_AFTER_SEED_ROUNDS, MAX_WALL_CLOCK_SKEW_MS } from './Constants.js';
import { none, some, type Option } from '../util/Option.js';
import { CoordinatedShutdownId, Phases } from '../CoordinatedShutdown.js';
import { ClusterExtensionId } from './ClusterExtension.js';
import { registerClusterHealthChecks } from './ClusterHealthChecks.js';
import { awaitClusterReady, isClusterReadyNow } from './ClusterReadiness.js';
import type { ClusterReadinessOptions } from './ClusterReadiness.js';
import { healthChecksOf } from '../management/HealthCheckExtension.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import {
  ADVERTISED_HOST_ENV_VARS,
  ClusterOptionsValidator,
  DEFAULT_ADVERTISED_HOST,
  DEFAULT_MAX_MEMBERS,
  DEFAULT_MAX_TOMBSTONES,
  DEFAULT_MAX_VERSION_SKEW_MS,
  DEFAULT_SEED_RETRY_INTERVAL_MS,
  DEFAULT_TOMBSTONE_PRUNE_INTERVAL_MS,
  DEFAULT_TOMBSTONE_TTL_MS,
  advertisedHostWasDerived,
  isRemoteTlsRequested,
  resolveAdvertisedHost,
  withClusterConfigDefaults,
} from './ClusterOptions.js';
import type { ClusterOptions, ClusterOptionsType, SelfElectionPolicy } from './ClusterOptions.js';
import {
  CurrentClusterState,
  LeaderChanged,
  MemberDown,
  MemberJoined,
  MemberLeft,
  MemberReachable,
  MemberRemoved,
  MemberUnreachable,
  MemberUp,
  MemberWeaklyUp,
  ReachabilityChanged,
  SelfRemoved,
  SelfUp,
  type ClusterEvent,
} from './ClusterEvents.js';
import {
  defaultFailureDetectorOptions,
  FailureDetector,
  type FailureDecision,
} from './FailureDetector.js';
import { FailureDetectorOptions, type FailureDetectorOptionsType } from './FailureDetectorOptions.js';
import { Member } from './Member.js';
import { NodeAddress } from './NodeAddress.js';
// `ClusterSharding`, `ClusterSingleton` and `ClusterEventStream` only import
// `Cluster` as a type (erased at runtime), so the value-imports here don't
// create a runtime cycle — every sharding, singleton and event-stream file
// uses `import type { Cluster }`.
import { ClusterSharding } from './sharding/ClusterSharding.js';
import { ClusterSingleton } from './singleton/ClusterSingleton.js';
import { ClusterEventStream } from './eventstream/ClusterEventStream.js';
import type {
  EnvelopeMessage,
  GossipMessage,
  HeartbeatMessage,
  LeaveMessage,
  MemberData,
  MemberStatus,
  StorageIdentitiesData,
  WireMessage,
} from './Protocol.js';
import { decodeRefs, encodeRefs } from './RefCodec.js';
import { sanitizeWireLogContext } from './WireValidation.js';
import { InMemoryTransport, TcpTransport, type Transport } from './Transport.js';
import type {
  ClusterPartitionView,
  DowningProvider,
} from './downing/DowningProvider.js';

type EnvelopeHandler = (env: EnvelopeMessage, from: NodeAddress) => void;

/**
 * Which merge-path guard refused a gossiped member record.  Closed, and
 * deliberately coarse: it is a metric label, so every value here is a time
 * series an operator carries forever.
 */
const GOSSIP_REFUSAL_REASONS = [
  'map-cap', 'version-skew', 'timestamp-skew', 'replayed-frame', 'self-claim',
] as const;

/** One of {@link GOSSIP_REFUSAL_REASONS}. */
type GossipRefusalReason = typeof GOSSIP_REFUSAL_REASONS[number];

/** Refusals since startup, one running total per reason. */
type GossipRefusalCounts = Record<GossipRefusalReason, number>;

/**
 * How {@link Cluster.subscribe} states the membership that already exists when
 * a listener attaches (#161).
 *
 * - **`'events'`** (default) — the current membership as the events that would
 *   have built it: one `MemberJoined` per member, followed by the status event
 *   that member has already reached, then `LeaderChanged`.  A listener written
 *   for the live stream handles the replay with the same code and needs no
 *   initial-state branch.
 * - **`'snapshot'`** — one {@link CurrentClusterState}, whatever the cluster's
 *   size.  Pick it when the listener wants to *know where things stand* rather
 *   than to re-live how they got there: it is one callback instead of one per
 *   member, and it marks where the replay ends, which the event form cannot.
 *
 * The default stays `'events'` because it is what every existing subscriber
 * was written against, not because it is the better choice for new code.
 */
export type ClusterSubscriptionReplayMode = 'events' | 'snapshot';

/**
 * Name of the `cluster-leave` phase task {@link Cluster.join} registers and
 * {@link Cluster.leave} takes back out.
 *
 * Module-local rather than in `Constants.ts`: it is not a cap, bound, timeout
 * or cadence, and only this file reads it.  It is a constant at all so the
 * two ends of that register/unregister pair cannot drift into two spellings —
 * which would leave a task behind that a re-join then collides with.
 */
const CLUSTER_LEAVE_TASK_NAME = 'cluster-leave';

/**
 * The Cluster is a single-instance "extension" attached to an ActorSystem.
 * It owns a Transport, a gossip-based membership view, a failure detector
 * and the plumbing that dispatches inbound envelope messages to local actors.
 */

/** The three store kinds a member's identity claims cover (#1358). */
const STORAGE_IDENTITY_FIELDS = ['journal', 'snapshotStore', 'durableStateStore'] as const;

/** Wire field → the store-kind word the mismatch warning speaks (#1358). */
const STORAGE_IDENTITY_FIELD_LABELS: Record<keyof StorageIdentitiesData, string> = {
  journal: 'journal',
  snapshotStore: 'snapshot-store',
  durableStateStore: 'durable-state-store',
};

export class Cluster {
  readonly selfAddress: NodeAddress;
  readonly selfRoles: ReadonlySet<string>;
  readonly system: ActorSystem;
  readonly transport: Transport;
  private readonly log: Logger;

  private readonly members = new Map<string, Member>();
  private readonly failureDetector: FailureDetector;
  private readonly gossipIntervalMs: number;
  private readonly seedRetryIntervalMs: number;
  private readonly seedAddrs: NodeAddress[] = [];
  private readonly tombstoneTtlMs: number;
  private readonly tombstonePruneIntervalMs: number;
  private readonly tombstoneMinRetentionMs: number;
  private readonly maxVersionSkewMs: number;
  private readonly maxMembers: number;
  private readonly maxTombstones: number;

  /**
   * How many entries in {@link members} are `removed` tombstones.
   *
   * Kept incrementally rather than recomputed, and that is the whole reason
   * {@link setMember} / {@link deleteMember} exist: the caps are checked once
   * per gossiped record, and a frame may carry tens of thousands of them, so
   * an O(n) scan per record would turn the defence into the denial of service
   * it is meant to prevent.  Live entries are `members.size - tombstoneCount`.
   */
  private tombstoneCount = 0;

  /**
   * What this node's failure detector last said about each peer, keyed exactly
   * like {@link members} — the state {@link ReachabilityChanged} is the
   * transition of (#161).
   *
   * Kept separately rather than read off `member.status`, because the two are
   * not the same fact.  A member's status travels in gossip, so `unreachable`
   * there may be a *peer's* observation rather than this node's, and it is only
   * ever written for a member that was `up` — a `joining` or `leaving` peer
   * falling silent moves nothing at all.  This map is strictly the local
   * detector's verdict, which is what a per-peer health gauge or a partition
   * diagnosis is actually asking for.
   *
   * It cannot outgrow the map #138 caps: entries are only ever created while
   * iterating {@link members}, {@link deleteMember} drops them with the member,
   * and {@link trackReachability} drops them when a member turns terminal.
   */
  private readonly reachability = new Map<string, boolean>();

  /**
   * Cumulative counts of member records the merge path refused, split by the
   * guard that refused them.  `onGossip` diffs this across a frame to collapse
   * a frame's worth of refusals into one log line and one counter increment
   * per reason — logging per record would hand an attacker log amplification
   * in place of the growth it just lost, and it is a frame, not a record, that
   * an operator can act on.
   */
  private readonly refusalCounts: GossipRefusalCounts = {
    'map-cap': 0,
    'version-skew': 0,
    'timestamp-skew': 0,
    'replayed-frame': 0,
    'self-claim': 0,
  };

  /**
   * The highest {@link GossipMessage.sequence} accepted from each connection
   * peer — the high-water mark that makes a captured gossip frame worthless on
   * a second delivery **to a receiver that holds a mark for its sender** (#112).
   *
   * That qualifier is the whole bound, and it is narrower than it looks:
   * {@link rememberGossipSequence} is the only writer and it runs in the gossip
   * path, so an entry exists for a peer this node has *accepted a frame from*
   * and for no other address.  A member learned third-party has none — see the
   * residuals on {@link admitsGossipSequence}.
   *
   * Keyed on the **connection's** peer, exactly like every authority rule
   * since #562, and not on the frame's `from` field: the payload is the one
   * thing an attacker fully controls, so keying there would let any connection
   * pin *another* member's mark and cut it out of this node's gossip — the
   * shape of the exploit #114 closed, reintroduced one field to the left.
   *
   * Bounded exactly like {@link reachability}: entries are only written for an
   * address the member map already holds, and {@link deleteMember} drops them
   * with the member, so the map #138 caps caps this one too.
   */
  private readonly acceptedGossipSequences = new Map<string, number>();

  /**
   * This node's own gossip frame counter — see {@link GossipMessage.sequence}.
   * Seeded in `_start` from the wall-clock, for the same reason the self
   * member's version is: a restarted process must out-number anything its
   * previous incarnation sent, or peers would refuse its frames as replays
   * until it caught up.
   */
  private gossipSequence = 0;

  private heartbeatSeq = 0;
  private gossipTimer: Cancellable | null = null;
  private heartbeatTimer: Cancellable | null = null;
  private fdTimer: Cancellable | null = null;
  private seedTimer: Cancellable | null = null;
  private weaklyUpTimer: Cancellable | null = null;
  private tombstonePruneTimer: Cancellable | null = null;
  private selfElectionTimer: Cancellable | null = null;
  /** Fruitless seed-contact rounds so far, and whether the stall was reported (#1351). */
  private seedRounds = 0;
  private coldStartStallReported = false;
  /**
   * Whether {@link selfElect} promoted this node, as opposed to a peer's
   * leader doing it — the joined-vs-formed distinction #943 asks for.  Never
   * reset: election happens at most once per incarnation, and "formed a
   * cluster, then merged with another" is still a formation.
   */
  private _selfElected = false;
  private currentLeader: Option<Member> = none;
  private readonly weaklyUpAfterMs: number;
  private readonly selfElection: SelfElectionPolicy;

  private envelopeHandler: EnvelopeHandler | null = null;
  private readonly _envelopeHandlersByPath = new Map<string, EnvelopeHandler>();
  private readonly wireHandlers = new Map<string, (message: WireMessage, from: NodeAddress) => void>();
  private started = false;

  private readonly downing: DowningProvider | null;
  /**
   * Set of unreachable address keys observed at the last downing
   * evaluation.  We only re-invoke the provider when the set
   * actually changes — without this debounce a steady "always one
   * unreachable peer" state would call `decide()` on every tick.
   */
  private lastDownedView: string | null = null;

  private constructor(system: ActorSystem, options: ClusterOptionsType) {
    this.system = system;
    // The incarnation is minted here rather than in `_start` so that it is
    // established before anything can be sent or received: the transport is
    // constructed with `selfAddress` two lines down and ships it in every
    // `hello`, and a `Cluster` that changed its own identity between
    // construction and start would have peers holding two of them (#940).
    // One per `Cluster` instance is one per `Cluster.join`, which is the
    // granularity the identifier is *for* — two runs on the same `host:port`
    // are two incarnations.
    // The advertised host, not the bound one: `selfAddress` is what goes into
    // every gossip frame, heartbeat and member record as the address peers
    // dial back, and a wildcard is not an address (#944).  `join` fills
    // `advertisedHost` in before constructing, so the `??` is for the private
    // constructor's other callers rather than a second policy.
    this.selfAddress = new NodeAddress(
      system.name,
      options.advertisedHost ?? resolveAdvertisedHost(options),
      options.port,
      NodeAddress.mintIncarnation(),
    );
    this.selfRoles = new Set(options.roles ?? []);
    this.log = system.log.withSource(`cluster@${this.selfAddress}`);
    // The frame cap only reaches a transport this constructor builds; an
    // injected one was constructed with its own, and silently re-capping
    // someone else's transport would be a surprise.
    // `options.host` is the *bind* target and may be a wildcard; `selfAddress`
    // is the identity the transport announces in its handshake and keys peers
    // on.  Passing both is what lets a container bind every interface and
    // still tell its peers a single address to dial back (#944).
    this.transport = options.transport
      ?? new TcpTransport(this.selfAddress, this.log, null, options.maxFrameBytes, options.host);
    // That `null` is the transport's TLS argument, and it is hard-coded: the
    // transport this constructor builds is always plaintext until #941 wires
    // the option up.  An operator who set the HOCON flag asked for the
    // opposite and would otherwise get plaintext with no error, no log line
    // and no way to tell (#591) — so say it, once, at startup.  Only when we
    // built the transport: an injected one was constructed by the caller and
    // may well carry its own TLS material, and warning about that would be a
    // false alarm.
    //
    // `== null` and not `=== undefined`, so the guard accepts exactly what the
    // `??` above falls through on.  A `transport: null` is unreachable from
    // typed code, but it builds the plaintext transport all the same, and a
    // guard that missed it would go quiet in the one case it exists for.
    //
    // "asks for TLS" rather than "is true": HOCON spells a boolean `true`,
    // `on` or `yes`, and quoting back a spelling the operator did not write
    // sends them looking through their config for a line that is not in it.
    if (options.transport == null && isRemoteTlsRequested(system.config)) {
      this.log.warn(
        `${ConfigKeys.remote.tls.enabled} asks for TLS, but the cluster transport this node `
        + 'built is plaintext — TLS for it is not implemented yet (#941). The wire is '
        + 'unencrypted; keep the cluster on a trusted network until it lands.',
      );
    }
    const fdOptions: FailureDetectorOptionsType = {
      ...defaultFailureDetectorOptions,
      ...(options.failureDetector ?? {}),
    };
    this.failureDetector = new FailureDetector(
      FailureDetectorOptions.create()
        .withHeartbeatIntervalMs(fdOptions.heartbeatIntervalMs)
        .withUnreachableAfterMs(fdOptions.unreachableAfterMs)
        .withDownAfterMs(fdOptions.downAfterMs),
    );
    this.gossipIntervalMs = options.gossipIntervalMs ?? DEFAULT_GOSSIP_INTERVAL_MS;
    this.seedRetryIntervalMs = options.seedRetryIntervalMs ?? DEFAULT_SEED_RETRY_INTERVAL_MS;
    this.weaklyUpAfterMs = options.weaklyUpAfterMs ?? 0;
    this.selfElection = options.selfElection ?? 'immediate';
    this.downing = options.downing ?? null;
    this.tombstoneTtlMs = options.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL_MS;
    this.tombstonePruneIntervalMs = options.tombstonePruneIntervalMs ?? DEFAULT_TOMBSTONE_PRUNE_INTERVAL_MS;
    // `0` is not "no floor" but "derive one", so it falls through exactly like
    // an unset field.  The HOCON leaf ships with `0s` as its documented
    // default, and a config file that spells a default out must behave like
    // one that omits it (#841).
    const minRetention = options.tombstoneMinRetentionMs;
    this.tombstoneMinRetentionMs = minRetention === undefined || minRetention === 0
      ? 6 * fdOptions.downAfterMs
      : minRetention;
    this.maxVersionSkewMs = options.maxVersionSkewMs ?? DEFAULT_MAX_VERSION_SKEW_MS;
    this.maxMembers = options.maxMembers ?? DEFAULT_MAX_MEMBERS;
    this.maxTombstones = options.maxTombstones ?? DEFAULT_MAX_TOMBSTONES;
  }

  /**
   * Entry point: start the cluster and attempt to contact seed nodes.
   *
   * Also publishes the instance to the {@link ClusterExtension}, which is
   * what makes `system.cluster`, `context.cluster` and an actor's
   * `this.cluster` resolve — so a clustered actor no longer has to have
   * the `Cluster` threaded in through its constructor (#833).
   *
   * Registration happens *before* `_start` on purpose: startup already
   * emits `MemberJoined` / `SelfUp`, and a subscriber woken by `SelfUp`
   * asking `system.cluster` must not be told there is none.  A failed
   * start puts the previous value back rather than leaving a cluster
   * that never bound its transport reachable system-wide.
   */
  static async join(
    system: ActorSystem,
    options: ClusterOptions,
  ): Promise<Cluster> {
    const merged = withClusterConfigDefaults(system.config, options as ClusterOptionsType);
    // Resolved here rather than in the constructor, for two reasons: the
    // validator has to see the address the node will actually advertise (a
    // wildcard reaching `selfAddress` is the whole of #944), and this is the
    // one place both entry points pass through — `bootstrapCluster` calls
    // `join`, so deriving it here is what keeps the two from answering the
    // question differently.
    const resolvedOptions: ClusterOptionsType = {
      ...merged,
      advertisedHost: resolveAdvertisedHost(merged),
    };
    new ClusterOptionsValidator().validate(resolvedOptions);
    if (advertisedHostWasDerived(merged)) reportDerivedAdvertisedHost(system, resolvedOptions);
    const cluster = new Cluster(system, resolvedOptions);
    const extension = system.extension(ClusterExtensionId);
    const previous = extension.get();
    extension._register(cluster);
    try {
      await cluster._start(resolvedOptions.seeds ?? []);
    } catch (e) {
      previous.fold(
        () => extension._unregister(),
        (earlier) => extension._register(earlier),
      );
      throw e;
    }
    // Leaving is part of shutting down, and until now nothing said so: the
    // `cluster-leave` phase was empty in every deployment, so a SIGTERM took
    // the node down while its peers still counted it a member and kept
    // routing to it until the failure detector gave up (#549).  Registered
    // after a successful `_start` on purpose — a cluster that never bound its
    // transport has nothing to leave.
    system.extension(CoordinatedShutdownId).addFrameworkTask(
      Phases.ClusterLeave,
      CLUSTER_LEAVE_TASK_NAME,
      () => cluster.leave(),
    );
    return cluster;
  }

  /**
   * One-call bootstrap — creates the {@link ActorSystem}, joins the
   * cluster, starts the Receptionist, waits for `SelfUp`, and wires
   * SIGTERM/SIGINT shutdown.  The headline shape for the clustered
   * case:
   *
   * ```ts
   * const { system, cluster, shutdown } = await Cluster.bootstrap({ name: 'my-app' });
   * ```
   *
   * Build the argument with `ClusterBootstrapOptions.create(name)`.
   * For the power-user path (own `ActorSystem.create`, own
   * `Cluster.join`, own signal wiring) keep using those directly —
   * this is purely additive sugar.
   *
   * The helper lives in `ClusterBootstrap.ts` and is loaded lazily
   * here to avoid a static import cycle (`ClusterBootstrap` ↔
   * `Cluster.join`).
   */
  static async bootstrap(
    options: import('./ClusterBootstrapOptions.js').ClusterBootstrapOptions,
  ): Promise<import('./ClusterBootstrap.js').BootstrappedCluster> {
    const { bootstrapCluster } = await import('./ClusterBootstrap.js');
    return bootstrapCluster(options);
  }

  /**
   * The cluster's sharding facade.  Lazily constructs (and memoises) a
   * single `ClusterSharding` instance per `ActorSystem` so callers can
   * start regions inline:
   *
   * ```ts
   * const region = cluster.sharding.start('cart', CartActor, {
   *   extractEntityId: (m) => m.entityId,
   * });
   * ```
   *
   * Equivalent to `ClusterSharding.get(cluster.system, cluster)` —
   * which still works for callers that prefer the explicit form.
   */
  get sharding(): ClusterSharding {
    return ClusterSharding.get(this.system, this);
  }

  /**
   * The cluster's singleton facade.  Binds the `ClusterSingleton` extension to
   * this Cluster on first access, so starting one hands back the ref directly:
   *
   * ```ts
   * const scheduler = cluster.singleton.start(JobSchedulerActor);
   * scheduler.tell({ kind: 'schedule', jobId: '42' });
   * ```
   *
   * Equivalent to `ClusterSingleton.get(cluster.system, cluster)` — which still
   * works for callers that hold the two separately.
   */
  get singleton(): ClusterSingleton {
    return ClusterSingleton.get(this.system, this);
  }

  /**
   * The cluster-wide event stream — the counterpart to `system.eventStream`,
   * which is one `ActorSystem` and therefore one node.  A publish here reaches
   * subscribers on every node; a publish there never leaves the process.
   *
   * ```ts
   * cluster.eventStream.subscribe(ref, 'order-placed');
   * cluster.eventStream.publish({ kind: 'order-placed', sku: 'XYZ-1' });
   * ```
   *
   * **Not to be confused with {@link Cluster.subscribe} below**, which is the
   * narrower and older of the two: it takes a callback rather than a ref,
   * carries only membership events, and replays the current membership on
   * subscribe.  This one is a general bus and replays nothing.
   *
   * Equivalent to `ClusterEventStream.get(cluster.system, cluster)`.
   */
  get eventStream(): ClusterEventStream {
    return ClusterEventStream.get(this.system, this);
  }

  /**
   * Subscribe to membership events.  The listener is immediately replayed the
   * membership that already exists, so a late subscriber still sees the world
   * it joined; `options.replayMode` chooses the form — see
   * {@link ClusterSubscriptionReplayMode}.
   */
  subscribe(
    listener: (event: ClusterEvent) => void,
    options?: { readonly replayMode?: ClusterSubscriptionReplayMode },
  ): () => void {
    this._listeners.push(listener);
    // A match on this call's own argument rather than on an inbound message,
    // so the arms are the exempt kind; they still delegate, because the two
    // replays are two different shapes and reading them side by side is the
    // point.
    match(options?.replayMode ?? 'events')
      .with('events', () => this.replayAsEvents(listener))
      .with('snapshot', () => this.replayAsSnapshot(listener))
      .exhaustive();
    return () => {
      const index = this._listeners.indexOf(listener);
      if (index >= 0) this._listeners.splice(index, 1);
    };
  }

  /**
   * The membership as a subscriber is entitled to see it: no tombstones,
   * address order.
   *
   * The replay used to iterate the raw member map, so a `removed` entry — kept
   * for up to `tombstoneTtlMs` precisely so stale gossip cannot resurrect it —
   * was replayed as `MemberJoined`.  A listener attaching an hour after a node
   * left was told that node had just joined, and `getMembers()` disagreed with
   * the replay that was supposed to explain it.
   */
  private snapshotMembers(): ReadonlyArray<Member> {
    return [...this.getMembers()].sort((a, b) => a.address.compareTo(b.address));
  }

  private replayAsEvents(listener: (event: ClusterEvent) => void): void {
    for (const member of this.snapshotMembers()) {
      this.replay(listener, new MemberJoined(member));
      // The replay used to stop after `up`, so an `unreachable`, `leaving` or
      // `down` member reached a late subscriber as nothing but `joined` — the
      // states it most needs to know about, reported as the most benign one.
      for (const event of this.statusEventsOf(member)) this.replay(listener, event);
    }
    if (this.currentLeader.isSome()) {
      this.replay(listener, new LeaderChanged(this.currentLeader));
    }
  }

  private replayAsSnapshot(listener: (event: ClusterEvent) => void): void {
    const members = this.snapshotMembers();
    const unreachable = members.filter((member) => member.status === 'unreachable');
    this.replay(listener, new CurrentClusterState(members, unreachable, this.currentLeader));
  }

  /**
   * Deliver one replayed event to the subscribing listener alone.
   *
   * Deliberately not {@link emit}: a replay is addressed to the one listener
   * that just attached, and pushing it through the event stream would announce
   * a long-settled join to every other subscriber each time a panel opened.
   * The swallow-and-log contract is {@link emit}'s, so one bad event does not
   * cut the replay short.
   */
  private replay(listener: (event: ClusterEvent) => void, event: ClusterEvent): void {
    try { listener(event); } catch (e) { this.log.warn('listener threw during replay', e); }
  }

  private _listeners: Array<(event: ClusterEvent) => void> = [];

  /**
   * Current snapshot of known members.  `removed` entries are kept
   * internally as tombstones (so stale gossip can't resurrect them
   * via the merge path) but are filtered out here — the public
   * contract is "members the cluster currently considers part of
   * the topology".
   */
  getMembers(): ReadonlyArray<Member> {
    return Array.from(this.members.values()).filter((member) => member.status !== 'removed');
  }

  /**
   * This node's own membership record, or `undefined` before the join has
   * created it.  Unlike {@link getMembers} it does **not** filter a `removed`
   * self: the tombstoned record — status and all — is exactly the diagnostic
   * a caller holding a stale handle after {@link leave} is asking for.
   */
  selfMember(): Member | undefined {
    return this.members.get(this.selfAddress.toString());
  }

  /**
   * `true` once {@link selfElect} turned this node `up`: it formed a new
   * cluster (of one, until others join it) rather than being promoted by an
   * existing cluster's leader.  This is the observable behind
   * `BootstrappedCluster.formedNewCluster`, and the mechanism a test binds to
   * when "joined instead of forming a rival" is the claim (#1087).
   */
  get selfElected(): boolean {
    return this._selfElected;
  }

  /**
   * Whether this node is, or is configured to become, part of a multi-node
   * cluster: a member with an address other than our own is known, or seed
   * addresses are configured.  `seedAddrs` is self-excluding (`_start` skips
   * our own address), so a standalone single node stays `false` by
   * construction.  The persistence storage advisory keys on this (#1356):
   * per-node storage is the documented default on a single node and a
   * silent history fork on more than one.
   */
  expectsRemotePeers(): boolean {
    if (this.seedAddrs.length > 0) return true;
    return this.getMembers().some((member) => !member.address.equals(this.selfAddress));
  }

  /**
   * THIS node's resolved store identities — the facts
   * {@link publishStorageIdentity} gossips on the self member and
   * {@link checkStorageIdentityAgreement} compares peers against (#1358).
   * Filled lazily as stores resolve; a value that arrives before `_start`
   * mints the self member waits here and seeds it.
   */
  private readonly selfStorageIdentities: { journal?: string; snapshotStore?: string; durableStateStore?: string } = {};
  /** One mismatch warning per store kind per node lifetime — same latch shape as the #1356 advisory. */
  private readonly storageIdentityMismatchReported = new Set<keyof StorageIdentitiesData>();

  /**
   * Record one of this node's store identities (#1358).  Deliberately NOT a
   * version-bumped member update: the version clock has one lane and the
   * leader is already writing in it — a self bump here raced the leader's
   * `joining → up` promotion to the same `version + 1`, and with no
   * equal-version tie-break in `mergeMember` (#935's class) the two sides
   * wedged, each ignoring the other's record forever.  Instead the claims
   * ride as an overlay: {@link memberDataForGossip} stamps them onto every
   * self record this node sends, and receivers fill them in version-neutrally
   * ({@link adoptStorageIdentities}).  The next gossip round spreads them; no
   * membership event fires — nothing about the topology changed.
   */
  publishStorageIdentity(field: keyof StorageIdentitiesData, identity: string): void {
    this.selfStorageIdentities[field] = identity;
  }

  /**
   * The gossiped form of a member — the self record leaves stamped with the
   * current identity claims, whatever version it carries.  See
   * {@link publishStorageIdentity} for why this is a stamp and not a stored
   * member update.
   */
  private memberDataForGossip(member: Member): MemberData {
    if (!member.address.equals(this.selfAddress)) return member.toData();
    const identities = this.selfStorageIdentitiesSnapshot();
    if (identities === undefined) return member.toData();
    return { ...member.toData(), storageIdentities: identities };
  }

  /**
   * Fill identity claims into a record we otherwise ignore (equal or older
   * version).  Fill-only and version-neutral on purpose: the claims are the
   * subject node's own statement riding an overlay lane, so adopting them
   * must neither advance the merge clock nor overwrite claims we already
   * hold — a genuinely changed identity arrives with a new incarnation's
   * higher version and takes the full merge path.
   */
  private adoptStorageIdentities(existing: Member, incoming: Member): void {
    if (incoming.storageIdentities === undefined) return;
    if (existing.storageIdentities !== undefined) return;
    if (incoming.address.equals(this.selfAddress)) return;
    this.setMember(existing.withStorageIdentities(incoming.storageIdentities));
    this.checkStorageIdentityAgreement(incoming);
  }

  private selfStorageIdentitiesSnapshot(): StorageIdentitiesData | undefined {
    const { journal, snapshotStore, durableStateStore } = this.selfStorageIdentities;
    if (journal === undefined && snapshotStore === undefined && durableStateStore === undefined) return undefined;
    return { ...this.selfStorageIdentities };
  }

  /**
   * Two members claiming different identities for the same store kind are
   * not reading the same database — the failure #1358 exists to surface,
   * and the one that no locality declaration can catch: two nodes each on
   * their own Postgres, a stale connection string, a restored backup.  Once
   * per kind per node lifetime, at warn: by the time this fires the
   * divergence may already be real, and the operator needs the pointer, not
   * a page per gossip round.  Only claims both sides actually make are
   * compared — absence stays silent (mixed versions, undeclared stores,
   * replicated event sourcing, which publishes nothing).
   */
  private checkStorageIdentityAgreement(member: Member): void {
    if (member.address.equals(this.selfAddress)) return;
    const claims = member.storageIdentities;
    if (claims === undefined) return;
    for (const field of STORAGE_IDENTITY_FIELDS) {
      const ours = this.selfStorageIdentities[field];
      const theirs = claims[field];
      if (ours === undefined || theirs === undefined || ours === theirs) continue;
      if (this.storageIdentityMismatchReported.has(field)) continue;
      this.storageIdentityMismatchReported.add(field);
      this.log.warn(
        `persistence: ${STORAGE_IDENTITY_FIELD_LABELS[field]} storage identity differs between this node `
        + `and ${member.address} — the two are not reading the same database, so an entity that moves `
        + 'between them recovers a different history: two nodes, two histories, no error on either '
        + '(#1358). Point every node at the SAME database instance (matching connection strings, one '
        + 'bucket, one keyspace), or use replicated event sourcing where per-node journals are the '
        + 'intended design.',
      );
    }
  }

  /** Members in the `up` state, ordered by address — the "active set". */
  upMembers(): Member[] {
    return Array.from(this.members.values())
      .filter(member => member.status === 'up')
      .sort((a, b) => a.address.compareTo(b.address));
  }

  /** Reachable members (up + joining + leaving). */
  reachableMembers(): Member[] {
    return Array.from(this.members.values()).filter(member => member.isReachable());
  }

  /** Up members that carry the given role tag. */
  upMembersWithRole(role: string): Member[] {
    return this.upMembers().filter(member => member.hasRole(role));
  }

  /**
   * The cluster leader: the **lowest-addressed** up-member.
   *
   * Not the oldest member, which is what this used to claim and what Akka
   * actually does (#525).  Address order and join order are unrelated, so a
   * node that joins last leads immediately if its host/port sorts first — and
   * it takes over whatever the leader hosts, including cluster singletons.
   *
   * The property the leader is *for* is that every node names the same one
   * from gossip it already has, and address order gives that without a
   * monotonic join sequence in the gossip payload.  Worth knowing when you
   * reason about which node ends up leading: it is decided by addressing, not
   * by uptime, so it is stable across restarts of the same pod and unstable
   * across a re-address.
   */
  leader(): Option<Member> {
    const ups = this.upMembers();
    return ups.length > 0 ? some(ups[0]!) : none;
  }

  /** True if this node is currently the leader. */
  isLeader(): boolean {
    return this.leader().exists((l) => l.address.equals(this.selfAddress));
  }

  /**
   * Resolve once this node is a full member (`up`) and at least
   * `minimumMembers` members are `up`; with `timeoutMs` set, reject with
   * `ClusterReadyTimeoutError` when the deadline fires first.  Without
   * `timeoutMs` it waits indefinitely, like `ActorSystem.whenTerminated()` —
   * see {@link ClusterReadinessOptions.timeoutMs} for why no default
   * deadline exists at this layer.
   */
  awaitReady(options?: ClusterReadinessOptions): Promise<void> {
    return awaitClusterReady(this, options);
  }

  /**
   * Synchronous probe of the same predicate {@link awaitReady} waits on.
   * `timeoutMs` is ignored — a probe has no deadline.
   */
  isReady(options?: ClusterReadinessOptions): boolean {
    return isClusterReadyNow(this, options);
  }

  /**
   * Register a handler for inbound user envelopes.  Kept for backward
   * compatibility — prefer `_registerEnvelopeHandler(path, handler)` which
   * allows multiple extensions (ClusterSharding, DistributedPubSub, …) to
   * share the envelope pipeline.
   */
  _setEnvelopeHandler(handler: EnvelopeHandler): void {
    this.envelopeHandler = handler;
  }

  /**
   * Publish a cluster event that this Cluster did not produce itself.
   *
   * Membership events all originate here, but `ShardMapChanged` is derived
   * from state only the sharding coordinator has, and it has to surface on
   * every node rather than just the leader's.  Rather than let sharding reach
   * into `emit`, it goes through this door — same listeners, same event
   * stream.
   */
  _publishClusterEvent(event: ClusterEvent): void {
    this.emit(event);
  }

  /** Route envelopes addressed to `path` to `handler`.  Returns unsubscribe. */
  _registerEnvelopeHandler(path: string, handler: EnvelopeHandler): () => void {
    this._envelopeHandlersByPath.set(path, handler);
    return () => this._envelopeHandlersByPath.delete(path);
  }

  /**
   * Send an envelope to a remote node.  Used by RemoteActorRef and by the
   * PubSub / Singleton extensions.  Any `ActorRef` embedded in the user
   * payload is rewritten to a `WireActorRef` marker here — this is the
   * single chokepoint where every cross-node message leaves, so hooking
   * the encode step once covers all paths (sharding, pub-sub, singleton,
   * direct remote-ref).  Receiving nodes decode in `onEnvelope`.
   */
  _sendEnvelope(to: NodeAddress, env: EnvelopeMessage): void {
    const encoded: EnvelopeMessage = { ...env, body: encodeRefs(env.body, this) };
    this.transport.send(to, encoded);
  }

  /** Register a handler for a specific wire-message discriminator. */
  _onWire(kind: string, handler: (message: WireMessage, from: NodeAddress) => void): () => void {
    this.wireHandlers.set(kind, handler);
    return () => this.wireHandlers.delete(kind);
  }

  /**
   * Operator-initiated force-down of a remote peer (#56).  Mirrors the
   * private `evaluateDowning` path: marks the peer `down`, emits the
   * lifecycle events, tombstones with `removedAt` so stale gossip
   * can't resurrect it, and tells the failure detector to forget it.
   *
   * Returns `true` if a member was found and downed, `false` if the
   * address was unknown or already terminal (`down`/`removed`).
   *
   * Intended for operator tooling — the management HTTP endpoint
   * `POST /cluster/down` calls this directly.  Don't use it as a
   * replacement for the failure detector / downing provider in normal
   * flow; it's a manual override.
   */
  down(addr: NodeAddress | string): boolean {
    if (!this.started) return false;
    const key = typeof addr === 'string' ? addr : addr.toString();
    const member = this.members.get(key);
    if (!member) return false;
    if (member.status === 'down' || member.status === 'removed') return false;
    if (member.address.equals(this.selfAddress)) {
      // Don't try to tombstone ourselves — that's `leave()`'s job.
      return false;
    }
    const downed = member.withStatus('down');
    this.updateMember(downed);
    this.emit(new MemberDown(downed));
    const removed = downed.withRemoved(Date.now());
    this.setMember(removed);
    this.failureDetector.forget(member.address);
    this.emit(new MemberRemoved(removed));
    this.log.info(`operator force-down: ${member.address}`);
    return true;
  }

  /** Gracefully leave the cluster (broadcast `leave`, stop transport). */
  async leave(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    // Drop the pipeline's task with the membership it named.  A process that
    // leaves and re-joins — a test, a reconfiguration — would otherwise hit
    // `addTask`'s duplicate-name check on the second `Cluster.join`.  Safe to
    // do here even though `leave()` is usually *called by* that task:
    // `runPhase` snapshots the list before invoking anything.
    this.system.extension(CoordinatedShutdownId)
      .removeTask(Phases.ClusterLeave, CLUSTER_LEAVE_TASK_NAME);
    // The readiness checks stay registered, and this is the whole point of
    // them.  Leaving used to un-register the pair here — before self had even
    // been moved to `leaving` — which left `checkReadiness()` empty on a node
    // whose only readiness checks were the cluster's.  An empty aggregate
    // reads as healthy at every consumer, so `/ready` answered 200 and the
    // gRPC health service answered SERVING for a node that had deliberately
    // gone out of service: the load balancer kept sending it traffic right up
    // to the moment the process died (#655).  Both checks report DOWN from
    // here on instead — self stays `leaving` in its own view — and a re-`join`
    // retires them at its own registration point.
    const me = this.members.get(this.selfAddress.toString());
    if (me) {
      this.updateMember(me.withStatus('leaving'));
    }
    const leaveMessage: LeaveMessage = { kind: 'leave', node: this.selfAddress.toJSON() };
    const peers = this.reachableMembers().filter((member) => !member.address.equals(this.selfAddress));
    this.log.debug(`leaving — sending leave to ${peers.length} reachable peer(s)`);
    for (const member of peers) this.transport.send(member.address, leaveMessage);
    this.gossipTimer?.cancel();
    this.heartbeatTimer?.cancel();
    this.fdTimer?.cancel();
    this.seedTimer?.cancel();
    this.weaklyUpTimer?.cancel();
    this.tombstonePruneTimer?.cancel();
    this.selfElectionTimer?.cancel();
    await this.transport.shutdown();
  }

  /* ================================ Internal ================================ */

  private async _start(seeds: string[]): Promise<void> {
    this.transport.setHandler((from, message) => this.handleWire(from, message));
    await this.transport.start();
    this.started = true;

    // Self is "joining" initially; transitions to "up" once at least
    // one peer has acknowledged us (or we are the seed).  We seed
    // the version with a wall-clock epoch (`Date.now()`) instead of
    // a constant `1` so that, when this address is restarted after
    // a graceful leave, the new incarnation's gossip out-versions
    // the `removed` tombstone surviving on peers — that's what
    // makes rejoin-after-leave converge cleanly (see the
    // `existing.removed && incoming.version > existing.version`
    // branch in `mergeMember`).  Within a single incarnation
    // version is still a monotonically-increasing logical clock;
    // the epoch only ensures a fresh process starts above any
    // version that previous incarnation could have reached.
    const me = new Member(
      this.selfAddress, 'joining', Date.now(), this.selfRoles,
      // Store identities that resolved before the join seed the member here;
      // later ones arrive through `publishStorageIdentity` (#1358).
      undefined, this.selfStorageIdentitiesSnapshot(),
    );
    // Same seed, same argument: peers hold a high-water mark per sender, so a
    // fresh process has to start above every frame the previous incarnation of
    // this address ever sent (#112).
    this.gossipSequence = Date.now();
    this.setMember(me);
    this.emit(new MemberJoined(me));
    this.log.debug(
      `self joining: epoch=v${me.version} roles=[${[...this.selfRoles].join(',')}]`,
    );

    for (const seed of seeds) {
      const address = NodeAddress.parse(seed.includes('@') ? seed : `${this.system.name}@${seed}`);
      if (!address.equals(this.selfAddress)) this.seedAddrs.push(address);
    }

    if (this.seedAddrs.length > 0) {
      this.log.debug(
        `contacting ${this.seedAddrs.length} seed(s): [${this.seedAddrs.map((a) => a.toString()).join(',')}]`,
      );
      this.contactSeeds();
      // Keep retrying seed contact until self has transitioned to up, covering
      // the case where a seed hasn't started yet — and, since this is the one
      // timer that runs exactly while the node is stuck, carry the diagnosis
      // for the case where it never will (#1351).
      this.seedTimer = this.system.scheduler.scheduleAtFixedRateFunction(
        this.seedRetryIntervalMs, this.seedRetryIntervalMs, () => {
          const self = this.members.get(this.selfAddress.toString());
          if (!self || self.status !== 'joining') { this.seedTimer?.cancel(); this.seedTimer = null; return; }
          this.seedRounds += 1;
          this.reportColdStartStall();
          this.contactSeeds();
        },
      );
    }

    // Deliberately after seed contact, and no longer inside its `else`: with a
    // deferred policy the two run together — the node dials its seeds *and*
    // holds a deadline for the case where none of them answers.
    this.armSelfElection();

    // Schedule automatic joining→weakly-up promotion if configured.
    if (this.weaklyUpAfterMs > 0) {
      this.weaklyUpTimer = this.system.scheduler.scheduleOnceFunction(
        this.weaklyUpAfterMs, () => {
          const me = this.members.get(this.selfAddress.toString());
          if (me?.status === 'joining') {
            this.updateMember(me.withStatus('weakly-up'));
          }
          this.weaklyUpTimer = null;
        },
      );
    }

    this.gossipTimer = this.system.scheduler.scheduleAtFixedRateFunction(
      this.gossipIntervalMs, this.gossipIntervalMs, () => this.gossipTick(),
    );
    this.heartbeatTimer = this.system.scheduler.scheduleAtFixedRateFunction(
      this.failureDetector.interval, this.failureDetector.interval, () => this.heartbeatTick(),
    );
    this.fdTimer = this.system.scheduler.scheduleAtFixedRateFunction(
      this.failureDetector.interval, this.failureDetector.interval, () => this.failureDetectionTick(),
    );
    this.tombstonePruneTimer = this.system.scheduler.scheduleAtFixedRateFunction(
      this.tombstonePruneIntervalMs, this.tombstonePruneIntervalMs,
      () => this.tombstonePruneTick(),
    );

    // Last, so a start that threw earlier leaves nothing registered: the
    // rollback in `join` puts the extension slot back but has no cluster to
    // take checks off, and a half-started one answering `/ready` would be
    // worse than a system with none at all (#655).
    //
    // The undo is deliberately dropped.  Nothing on the way out of service
    // calls it — `leave()` leaves both checks reporting DOWN — and the one
    // caller that must, a later `join` on this same system, retires the
    // previous pair from inside `registerClusterHealthChecks`.
    registerClusterHealthChecks(this, healthChecksOf(this.system));
  }

  private contactSeeds(): void {
    const me = this.members.get(this.selfAddress.toString());
    if (!me) return;
    // One frame for the whole round: each seed keeps its own high-water mark
    // for this node, so a shared sequence is delivered once per peer.  A retry
    // round composes a new one and therefore out-numbers this.
    const initialGossip: GossipMessage = {
      kind: 'gossip',
      from: this.selfAddress.toJSON(),
      sequence: this.nextGossipSequence(),
      members: [this.memberDataForGossip(me)],
    };
    for (const seed of this.seedAddrs) {
      this.failureDetector.register(seed);
      this.transport.send(seed, initialGossip);
    }
  }

  /** The next value for {@link GossipMessage.sequence}. */
  private nextGossipSequence(): number {
    this.gossipSequence += 1;
    return this.gossipSequence;
  }

  /**
   * Apply {@link ClusterOptionsType.selfElection} — decide whether this node
   * is allowed to turn itself `up` without anyone's agreement, and if so when.
   *
   * A match on this node's own configuration rather than on an inbound
   * message, so the arms are the exempt kind; they still delegate, because the
   * three policies are three different mechanisms and reading them side by
   * side is the point.
   */
  private armSelfElection(): void {
    match(this.selfElection)
      .with('immediate', () => this.onImmediateSelfElection())
      .with('never', () => this.onNeverSelfElection())
      .with(P.number, (afterMs) => this.onDeferredSelfElection(afterMs))
      .exhaustive();
  }

  /** The historical rule: an empty seed list means "I am the first node". */
  private onImmediateSelfElection(): void {
    if (this.seedAddrs.length > 0) return;
    // Debug, unlike the deferred path: "started with no seeds, so I am the
    // first node" is a statement of the configuration, not a decision, and it
    // is the normal shape of every single-node development run.
    this.selfElect('no seeds configured', 'debug');
  }

  private onNeverSelfElection(): void {
    this.log.debug(
      "self-election disabled — staying 'joining' until a peer's leader promotes this node",
    );
  }

  /**
   * Self-elect only if seed contact has produced nothing by the deadline.
   *
   * The timer is not cancelled when self reaches `up` by other means — the
   * guard in {@link selfElect} makes a late firing a no-op, and that is the
   * same treatment {@link weaklyUpTimer} gets for the same reason.
   */
  private onDeferredSelfElection(afterMs: number): void {
    this.log.debug(
      `self-election deferred: this node forms a new cluster only if no peer has `
      + `promoted it within ${afterMs} ms`,
    );
    this.selfElectionTimer = this.system.scheduler.scheduleOnceFunction(afterMs, () => {
      this.selfElectionTimer = null;
      // Info: the node waited for a cluster, none answered, and it is now
      // creating one.  When that turns out to have been wrong it is the first
      // line worth finding in two nodes' logs side by side.
      this.selfElect(`no peer promoted this node within ${afterMs} ms`, 'info');
    });
  }

  /**
   * Move self from `joining` / `weakly-up` straight to `up`, forming a new
   * cluster of one that every later joiner attaches to.
   *
   * A no-op once self has left `joining` / `weakly-up` by any other route,
   * which is what makes a late-firing deferred timer harmless.
   */
  private selfElect(reason: string, level: 'debug' | 'info'): void {
    if (!this.started) return;
    const me = this.members.get(this.selfAddress.toString());
    if (!me) return;
    if (me.status !== 'joining' && me.status !== 'weakly-up') return;
    const message = `self-electing as first cluster member — ${reason}`;
    if (level === 'info') this.log.info(message); else this.log.debug(message);
    this._selfElected = true;
    this.updateMember(me.withStatus('up'));
  }

  /**
   * Say why this node is still `joining`, once, when nothing is going to
   * change that (#1351).
   *
   * The condition is exact rather than a heuristic. `joining → up` is the
   * leader's decision, `leader()` is the first of {@link upMembers}, and the
   * only way a node reaches `up` without one is self-election. So a node that
   * knows no `up` member and has no self-election pending cannot be promoted
   * by anything: no leader exists to promote it, and none can come into being
   * through it. The cluster is not slow, it is finished.
   *
   * `selfElectionTimer === null` is what covers both policies that strand a
   * node here. `'never'` arms no timer at all. `'immediate'` arms none either,
   * and its one chance has already passed: it self-elects only on an *empty*
   * seed list, and this loop exists only when the list is non-empty. A
   * deferred policy is the one that does hold a timer and will resolve this
   * without help — which is why a pending one is the signal to stay quiet.
   *
   * Held back {@link COLD_START_STALL_AFTER_SEED_ROUNDS} rounds because the
   * same condition is true, and harmless, for the first seconds of an ordinary
   * simultaneous start, while the peer that will form the cluster is still
   * coming up.
   *
   * Reported once. The condition holds on every round from here on, and this
   * is a verdict on the configuration rather than an event — repeating it per
   * round would bury the one line that matters, which is the noise this whole
   * area was cleaned of in #1352.
   *
   * **Not reachable from `weakly-up`.** The retry loop cancels itself on any
   * status but `joining`, so a node auto-promoted by `weaklyUpAfterMs` leaves
   * this behind and can stall unreported. That gap is real, but it belongs to
   * the loop's cancel condition rather than here, and `weaklyUpAfterMs`
   * defaults to 0, so nothing reaches it without being configured to.
   */
  private reportColdStartStall(): void {
    if (this.coldStartStallReported) return;
    if (this.seedRounds < COLD_START_STALL_AFTER_SEED_ROUNDS) return;
    if (this.selfElectionTimer !== null) return;
    if (this.upMembers().length > 0) return;
    this.coldStartStallReported = true;
    // Every member but our own record — what this node has actually heard from,
    // which is the half of the diagnosis it cannot state from configuration.
    const peers = this.members.size - 1;
    this.log.warn(
      `still "joining" after ${this.seedRounds} seed-contact round(s), and nothing can promote `
      + `this node: no member is "up", so there is no leader, and only a leader moves a node `
      + `from "joining" to "up" — ${this.coldStartStallRemedy(peers)}`,
    );
  }

  /**
   * The half of the stall report that depends on what this node can see.
   *
   * Split by peer count first, because it separates two failures that look
   * identical in the member map but have nothing else in common: seeds nobody
   * is answering on, and seeds answering perfectly while every node waits for
   * a leader none of them will elect.
   */
  private coldStartStallRemedy(peers: number): string {
    if (peers === 0) {
      return 'no seed has answered at all. Seeds: '
        + `[${this.seedAddrs.map((a) => a.toString()).join(', ')}]. Check that these are the `
        + 'addresses those nodes advertise (not their bind addresses), that their processes are '
        + 'running, and that the port is reachable from here';
    }
    return match(this.selfElection)
      .with('immediate', () =>
        `${peers} peer(s) are known and every one of them is stuck the same way. Each node was `
        + "started with a non-empty seed list and selfElection: 'immediate', which self-elects "
        + 'only on an *empty* one — so no node will ever form the cluster. Give exactly one node '
        + 'seeds: [], or pass stableObservation: true to Cluster.bootstrap, which elects an '
        + 'initial seed and derives the selfElection pairing itself')
      .with('never', () =>
        `${peers} peer(s) are known but none is "up". This node has selfElection: 'never', so it `
        + 'waits to be promoted — the node elected to form the cluster has not reached "up"')
      // Unreachable in practice, and kept for exhaustiveness rather than for
      // the message: a deferred election that has already fired left this node
      // `up`, which cancels the loop that calls this.
      .with(P.number, (afterMs) =>
        `${peers} peer(s) are known but none is "up", and this node's ${afterMs} ms `
        + 'self-election grace elapsed without forming one')
      .exhaustive();
  }

  private handleWire(from: NodeAddress, message: WireMessage): void {
    this.failureDetector.heartbeat(from);

    match(message)
      .with({ kind: 'heartbeat' }, (m) => this.onHeartbeat(from, m))
      .with({ kind: 'heartbeat-ack' }, () => this.onHeartbeatAcknowledgment())
      .with({ kind: 'gossip' }, (m) => this.onGossip(from, m))
      .with({ kind: 'envelope' }, (m) => this.onEnvelope(from, m))
      .with({ kind: 'leave' }, (m) => this.onLeave(from, m))
      .otherwise((m) => this.onUnhandledWire(m, from));
  }

  private onHeartbeatAcknowledgment(): void {
    /* already bumped fd */
  }

  /**
   * A frame whose `kind` is not one of the core ones — every extension's is.
   * `receptionist-gossip`, `pubsub-gossip`, `cluster-client-envelope` and
   * DistributedData's kinds all arrive here and are dispatched from
   * `wireHandlers`; falling through silently when nothing is registered is
   * deliberate, because an extension a node has not started is exactly the case.
   *
   * The comment here used to name `'shard-map'` as registry-handled. Nothing
   * ever registered it — sharding fans its allocation map out as a
   * `sharding.ShardMapUpdate` inside an envelope, not as a wire kind of its own
   * — so the frame was validated, arrived here, matched nothing and was dropped.
   * The type went with the comment (#681).
   */
  private onUnhandledWire(message: WireMessage, from: NodeAddress): void {
    const custom = this.wireHandlers.get(message.kind);
    if (custom) custom(message, from);
  }

  /**
   * A heartbeat's `seq` and `ts` arrive off the wire, and `seq` is echoed
   * straight back in the acknowledgment.  Our own sender only ever emits an
   * incrementing counter and `Date.now()`, so an implausible value means a
   * corrupted or forged frame — dropped rather than normalised, matching how
   * `mergeMember` treats an implausible gossip version.
   *
   * Dropping is safe: `handleWire` has already bumped the failure detector from
   * the socket-level address by the time this runs, so refusing the frame
   * cannot make a live peer look unreachable.
   *
   * Nothing consumes these fields yet — `onHeartbeatAcknowledgment` is a no-op
   * and `ts` is unread — so this is a boundary guard rather than a fix for a
   * live exploit.  It is here so the property still holds if RTT or clock-skew
   * tracking is added later, instead of a `NaN` quietly reaching that code.
   */
  private isPlausibleHeartbeat(from: NodeAddress, message: HeartbeatMessage): boolean {
    const sequenceOk = Number.isSafeInteger(message.seq) && message.seq >= 0;
    const timestampOk = Number.isFinite(message.ts)
      && message.ts <= Date.now() + MAX_WALL_CLOCK_SKEW_MS;
    if (sequenceOk && timestampOk) return true;
    this.log.warn(
      `heartbeat: rejecting implausible frame from ${from} ` +
      `(seq=${message.seq}, ts=${message.ts}) — possible corruption or forgery`,
    );
    return false;
  }

  /**
   * The liveness signal is *"traffic arrived on this connection"*, so it is the
   * connection's peer that is demonstrably alive — not whoever `message.from`
   * names.  Reading the payload field instead had two consequences (#572):
   * a peer could keep a node it had never contacted looking healthy forever,
   * which blocks the failure detector and with it singleton and shard
   * failover; and the acknowledgment was *sent* to that address, so a frame
   * naming an attacker-chosen `host:port` made the receiver dial it.
   */
  private onHeartbeat(from: NodeAddress, message: HeartbeatMessage): void {
    if (!this.isPlausibleHeartbeat(from, message)) return;
    const peer = from;
    this.failureDetector.heartbeat(peer);
    // Reply isn't strictly needed because send() also bumps the detector,
    // but it keeps symmetric latency information.
    this.transport.send(peer, { kind: 'heartbeat-ack', from: this.selfAddress.toJSON(), seq: message.seq });

    // If the peer was unreachable and we see traffic again, flip it back.
    const existing = this.members.get(peer.toString());
    if (existing && existing.status === 'unreachable') {
      this.updateMember(existing.withStatus('up'));
      this.emit(new MemberReachable(this.members.get(peer.toString())!));
    }
  }

  /**
   * `from` is the peer the *connection* belongs to; `message.from` is what the
   * payload says about itself.  They are only the same thing when nobody is
   * lying, so the connection identity is what the authority rules are keyed on
   * — see {@link maySpeakFor} (#562).
   */
  private onGossip(from: NodeAddress, message: GossipMessage): void {
    // Before anything the frame could achieve, including the failure-detector
    // refresh below: a replayed frame is a recording, not evidence that anyone
    // is alive.  The connection itself is still credited — `handleWire` bumped
    // the detector for `from` on arrival, and bytes did arrive.
    if (!this.admitsGossipSequence(from, message.sequence)) {
      this.refusalCounts['replayed-frame'] += message.members.length;
      this.reportRefusals(from, 'replayed-frame', message.members.length);
      return;
    }
    const sender = NodeAddress.fromJSON(message.from);
    // The failure detector's sample map is the *second* thing `message.from`
    // could grow without bound, and capping only the member map would have
    // moved #138 one map to the left rather than closed it: a sample is
    // allocated per distinct address, and nothing prunes one that has no
    // member behind it — `forget` is only called when a member is removed.
    //
    // The gate is an allocation bound, not a re-litigation of who may refresh
    // whom: `sender` equals `from` for every honest frame (the connection is
    // the peer), and a known member stays refreshable, so no legitimate
    // heartbeat is lost.  What it refuses is an address that is neither the
    // connection's peer nor anything this node tracks — which is only
    // reachable by forging the payload field.
    if (sender.equals(from) || this.members.has(sender.toString())) {
      this.failureDetector.heartbeat(sender);
    }
    this.log.debug(`gossip from ${sender}: ${message.members.length} member(s)`);

    // Snapshot the sender's standing *before* merging: this frame may be the
    // one that introduces the sender, and a claim must not be authorised by a
    // membership the same frame just created.
    const senderStatus = this.members.get(from.toString())?.status;
    const refusedBefore: GossipRefusalCounts = { ...this.refusalCounts };

    for (const data of message.members) {
      this.mergeMember(from, senderStatus, data);
    }

    // Ensure we know about the sender itself.  This insert sits *outside*
    // `mergeMember`, so it bypassed every guard the merge path grew — it is
    // capped here explicitly rather than left as the one door #138 forgot to
    // close.  `sender` is the payload's self-declaration, not the connection's
    // peer, which makes it the cheaper of the two addresses to fabricate.
    if (!this.members.has(sender.toString())) {
      const member = new Member(sender, 'joining', 1);
      if (this.admitsMember(member, undefined)) {
        this.setMember(member);
        this.emit(new MemberJoined(member));
      }
    }

    this.rememberGossipSequence(from, message.sequence);

    // One line and one counter increment per frame and reason, not per refused
    // record: an attacker who has just lost the memory growth must not be
    // handed log amplification instead, and the label set stays a closed three
    // values so the series count cannot follow the attacker's record count
    // (#131).
    for (const reason of GOSSIP_REFUSAL_REASONS) {
      this.reportRefusals(from, reason, this.refusalCounts[reason] - refusedBefore[reason]);
    }

    // Leader promotes joining (and weakly-up) members to up.
    if (this.isLeader()) {
      for (const member of this.members.values()) {
        if (member.status === 'joining' || member.status === 'weakly-up') {
          this.log.debug(`leader-promote: ${member.address} ${member.status}→up`);
          this.updateMember(member.withStatus('up'));
        }
      }
    }
  }

  /**
   * Whether this frame is newer than the last one accepted from the same
   * connection peer — the guard that makes a captured gossip frame worthless on
   * a second delivery, **to a receiver that holds a mark for that sender**
   * (#112).  The qualifier is load-bearing; see *What it does not close*.
   *
   * **What a replay buys without it.**  A gossip frame carries a snapshot of
   * the member map, and a member's `version` only moves when its status does,
   * so a frame captured off the wire stays byte-for-byte valid indefinitely.
   * Against a converged receiver that is harmless — every record loses the
   * `incoming.version <= existing.version` comparison in {@link mergeMember}.
   * What makes it an exploit is an entry the receiver has **deleted**: the
   * failure-detector down path deletes outright so a healed partition can
   * re-discover the peer, and {@link tombstonePruneTick} deletes an expired
   * tombstone.  Either leaves `existing === undefined`, and that branch of
   * `mergeMember` has no lower version bound at all — so replaying a downed
   * member's own pre-down record brings it back at its old version, `up`, and
   * carrying the roles it had, which is what shard placement, singleton
   * hosting and downing quorums are computed from (#940, step B3).
   *
   * **Why a counter rather than a timestamp.**  The issue asked for a
   * wall-clock staleness window, and a window tight enough to bound a replay —
   * a few gossip intervals, so seconds — is an order of magnitude below every
   * other clock-skew budget here ({@link ClusterOptionsType.maxVersionSkewMs}
   * is five minutes, {@link MAX_WALL_CLOCK_SKEW_MS} a day).  A node a few
   * seconds off NTP would have *all* of its gossip dropped: a liveness failure
   * worse than the replay it prevents.  A per-sender counter compares a peer
   * only against itself, so it is skew-free, needs no knob, and refuses every
   * replay rather than those older than a window.
   *
   * **A sequence must also be plausible, and refusing is what makes the guard
   * hold.**  The number is stamped from the author's wall clock, so it gets the
   * same clock-skew budget a gossiped `version` gets
   * ({@link ClusterOptionsType.maxVersionSkewMs}) and for the same reason.  This
   * check used to sit one step later — the frame was admitted and only *adopting*
   * it as the mark was refused, on the argument that a frame numbered
   * `Number.MAX_SAFE_INTEGER` "is by definition not a recording of a real frame".
   * That argument does not survive the observation that only the **sequence** is
   * fabricated: the `members` array is still the recording, and there is no MAC
   * or signature anywhere on this wire to stop one field being rewritten.  So a
   * captured frame restamped absurdly far ahead was merged, left the mark
   * untouched, and was therefore merged **again on every delivery, without
   * limit** — against a warm receiver with a live sender, which is the one
   * configuration the guard was claimed to hold in (#940).
   *
   * Refusing it instead keeps the property the old split was reaching for and
   * loses nothing: the mark stays where the last plausible frame left it, so the
   * real node's next frame still out-numbers it and still merges.  What a peer
   * can no longer do is pin the mark *or* replay through it — the pinning
   * exploit #114 closed on `version` is not reintroduced one field to the left,
   * it is closed on both sides.
   *
   * `Number.isFinite` is checked here as well as by the frame guard
   * ({@link wireFrameProblem}) — `NaN` loses every `>` comparison, so an
   * unchecked one would sail past both the mark and the budget.  Local to the
   * decision that depends on it, for the reason `Member.fromData` re-checks
   * `status`.
   *
   * **What it does not close.**  Three things, and the second is why the
   * headline above carries a qualifier.
   *
   * 1. A peer that has earned standing can still *compose* a fresh frame naming
   *    a deleted address at its old version — that is not a replay at all.
   * 2. **A missing mark admits everything, and eviction of the sender is only
   *    one of three ways to be missing one.**  {@link deleteMember} drops an
   *    evicted member's mark; a fresh or restarted process starts with the map
   *    empty; and a member learned **third-party** never had one, because
   *    {@link rememberGossipSequence} only ever runs for the connection the
   *    frame arrived on.  Gossip is epidemic — this node files C as `up` on B's
   *    word — so that third case has the sender a full member throughout, with
   *    nothing evicted anywhere.  Refusing a frame from a peer with no mark is
   *    *not* the missing check: the first frame from every peer is one, so a
   *    receiver that refused them would never converge.  What an empty mark
   *    concedes is a two-frame bootstrap, the first frame installing the mark
   *    off its own recorded number — and against a third-party-learned sender,
   *    one frame, since the standing is already there.
   * 3. Which is why 1 and 2 both stay open: nothing keyed on the sender's own
   *    counter separates a recording from a live frame, because one counter
   *    stamped both.  What separates them is *which process* emitted them, and
   *    the only receiver-checkable statement of that is
   *    {@link NodeAddress.incarnation} — deliberately optional today, so a
   *    refusal resting on it is one an attacker opts out of by stripping the
   *    field.  Requiring it breaks every address-bearing frame field at once and
   *    waits on protocol versioning (#940, #823).  It would close a recording of
   *    a *previous* incarnation, which is the restart case and the bulk of the
   *    exposure; a node downed while still running, and a first sighting at a
   *    receiver holding no earlier incarnation of the subject, would survive it.
   *
   * Both counterfactuals are asserted in
   * `tests/unit/cluster/GossipReplayGuard.test.ts`.
   */
  private admitsGossipSequence(from: NodeAddress, sequence: number): boolean {
    if (!Number.isFinite(sequence) || sequence > Date.now() + this.maxVersionSkewMs) return false;
    const lastAccepted = this.acceptedGossipSequences.get(from.toString());
    return lastAccepted === undefined || sequence > lastAccepted;
  }

  /**
   * Raise the high-water mark for a peer whose frame was just merged.
   *
   * **The only writer of {@link acceptedGossipSequences}, and it runs only
   * here** — inside the gossip path, for the connection the frame arrived on.
   * So a mark tracks the peers this node has *heard from*, never the peers it
   * merely knows about; that asymmetry is residual 2 on
   * {@link admitsGossipSequence} and is not an oversight to be fixed in this
   * method, because the number a third party reports about C says nothing about
   * where C's own counter has reached.
   *
   * **Only for an address the member map holds**, which is what bounds this map
   * by the same caps as that one — the sender fallback above has already run, so
   * an honest peer is on file by the time this is asked.
   *
   * Plausibility is not re-checked here: {@link admitsGossipSequence} refuses an
   * implausible frame outright, so nothing that reaches this point carries a
   * number the mark should not take.  Keeping the bound in one place is the
   * point — two copies of it is how the frame came to be admitted under a number
   * the mark itself rejected.
   */
  private rememberGossipSequence(from: NodeAddress, sequence: number): void {
    const key = from.toString();
    if (!this.members.has(key)) return;
    this.acceptedGossipSequences.set(key, sequence);
  }

  /**
   * Fold one frame's refusals into a WARN and the stock counter.
   *
   * The reason is a label rather than a metric name so an operator can alert
   * on "records are being refused at all" without knowing which guard fired,
   * and it is drawn from a closed union so the series count is fixed by this
   * file and not by what a peer sends — the cardinality trap #131 put a cap on.
   */
  private reportRefusals(from: NodeAddress, reason: GossipRefusalReason, count: number): void {
    if (count <= 0) return;
    this.log.warn(
      `gossip: dropped ${count} member record(s) from ${from} — ${this.refusalDetail(reason)}`,
    );
    metricsOf(this.system).counter(
      'cluster_gossip_records_refused_total', { reason },
      { help: 'Cumulative count of gossiped member records refused by a merge-path guard.' },
    ).inc(count);
  }

  /** The operator-facing half of one {@link GossipRefusalReason}. */
  private refusalDetail(reason: GossipRefusalReason): string {
    return match(reason)
      .with('map-cap', () =>
        `maxMembers (${this.maxMembers}) / maxTombstones (${this.maxTombstones}) is full`)
      .with('version-skew', () =>
        `version skew above maxVersionSkewMs (${this.maxVersionSkewMs}ms)`)
      .with('timestamp-skew', () =>
        `implausible removedAt — more than ${MAX_WALL_CLOCK_SKEW_MS}ms ahead, or not a number`)
      .with('replayed-frame', () =>
        'the frame does not out-number the last one accepted from that peer, or its sequence is not '
        + `a finite number within maxVersionSkewMs (${this.maxVersionSkewMs}ms) of this clock — `
        + 'a replay, a duplicate, or a capture with its sequence rewritten')
      .with('self-claim', () =>
        'a status for this node itself that is neither the one it already holds nor the leader '
        + 'promoting it to up — this node is the author of its own status (#562)')
      .exhaustive();
  }

  private onEnvelope(from: NodeAddress, message: EnvelopeMessage): void {
    // Re-install the originating MDC + active trace context for the
    // duration of dispatch (#53, #10).  Local refs that the
    // dispatcher subsequently `tell`s capture this same context onto
    // the next envelope, so both trails keep flowing across hops.
    // A missing trace skips its wrapper; a missing MDC gets a *cleared*
    // one rather than none at all (#718, below).
    let dispatch: () => void = (): void => this.dispatchEnvelope(from, message);

    // Tracing: if the envelope carries a parent context, open a
    // `cluster.envelope.received` span so the trace explicitly
    // shows the network hop and downstream local-tells see this
    // span as their active parent.
    if (message.trace) {
      const tracer = tracerOf(this.system);
      const parentContext = tracer.extractContext(message.trace);
      if (parentContext) {
        const inner = dispatch;
        dispatch = (): void => {
          const span = tracer.startSpan('cluster.envelope.received', {
            parent: parentContext,
            kind: 'consumer',
            attributes: {
              'cluster.from': from.toString(),
              'cluster.to.path': message.to,
            },
          });
          try {
            tracer.withActiveSpan(span, inner);
          } finally {
            span.end();
          }
        };
      }
    }

    // The MDC arrives from a remote peer and is installed for the whole
    // dispatch, from where both shipped loggers read it.  Unfiltered, a peer
    // could overwrite JsonLogger's own `ts`/`level`/`source`/`msg` — its record
    // spreads the context last — and put a newline in any value, which forges
    // whole extra lines in ConsoleLogger's one-line-per-record output (#573).
    const context = message.context ? sanitizeWireLogContext(message.context) : undefined;
    // The same emptiness question the two `tell` paths ask, through the same
    // helper.  Its identity fast path cannot fire here — the sanitiser hands
    // back a fresh object every time — but a peer that sends `context: {}`, or
    // one whose every key the sanitiser rejected, must still be treated as
    // having sent nothing, rather than having its emptiness installed as a
    // context of its own.  What the two branches now differ in is *whose*
    // emptiness that is (#718) — and the `else` still costs no
    // `AsyncLocalStorage` frame on a node with no MDC open, because `runFresh`
    // skips the wrapper when there is no store to shadow.
    if (context && !LogContext.isEmpty(context)) {
      LogContext.run(context, dispatch);
    } else {
      // `runFresh`, not a bare call: an inbound frame that carries no context
      // must be dispatched under a *cleared* one, and there is a store to clear
      // (#718).  `TcpTransport.send` opens the outbound socket lazily, so the
      // socket — and every `onData` callback on it — is bound to the
      // `AsyncLocalStorage` store of whichever request first sent to that peer.
      // Unwrapped, `dispatchEnvelope`'s `ref.tell(body)` snapshots that store
      // onto the local envelope, and a peer's context-free frame is delivered
      // under one of *our* earlier requests' correlation ids.
      LogContext.runFresh(dispatch);
    }
  }

  private dispatchEnvelope(from: NodeAddress, message: EnvelopeMessage): void {
    // Rehydrate any ActorRef markers embedded in the user payload before
    // handing it off — downstream handlers (sharding, pubsub, …) just
    // forward `env.body` and shouldn't each duplicate the decode step.
    const decoded: EnvelopeMessage = { ...message, body: decodeRefs(message.body, this) };

    // 1. Explicit per-path handler (pub-sub mediator, singleton manager,
    //    sharding coordinator, …).
    const perPath = this._envelopeHandlersByPath.get(message.to);
    if (perPath) { perPath(decoded, from); return; }

    // 2. Resolve the target path locally and deliver directly — covers the
    //    case where a RemoteActorRef rebuilt from a WireActorRef targets an
    //    arbitrary user-spawned actor (no extension routing).  This also
    //    happens to be functionally identical to sharding's own
    //    dispatchEnvelope for region paths (both end in `ref.tell(body)`).
    const segs = parsePathSegments(decoded.to);
    if (segs.length > 0) {
      const refOpt = this.system._resolvePath(segs);
      if (refOpt.isSome()) {
        refOpt.value.tell(decoded.body as never);
        return;
      }
    }

    // 3. Catch-all — kept for backward-compat with legacy handlers.
    if (this.envelopeHandler) {
      this.envelopeHandler(decoded, from);
    } else {
      this.log.warn(`no envelope handler registered, dropping message to ${message.to}`);
    }
  }

  /**
   * A `leave` is a node saying *"I am going away"* — a statement only that
   * node can truthfully make.  It was read from `message.node` instead of the
   * connection, and it writes a `removed` tombstone at `version + 2`, which
   * out-versions anything the victim can say about itself.  So one 120-byte
   * frame from anyone who could open a socket evicted any member, the eviction
   * gossiped to the whole cluster, and the victim could not argue its way back
   * — its own gossip stayed at its start epoch, below the tombstone.  Recovery
   * meant a restart, or waiting out the 24-hour tombstone TTL (#564).
   *
   * `handleWire` had the socket identity in hand the whole time and passed it
   * to the heartbeat and envelope handlers; this one just never asked for it.
   */
  private onLeave(from: NodeAddress, message: LeaveMessage): void {
    const peer = NodeAddress.fromJSON(message.node);
    if (!peer.equals(from)) {
      this.log.warn(
        `leave: refusing ${from}'s attempt to retire ${peer} — a node may only announce its own leave`,
      );
      return;
    }
    const existing = this.members.get(peer.toString());
    if (!existing) return;
    this.log.debug(`peer ${peer} sent leave — tombstoning (was ${existing.status} v${existing.version})`);
    const leaving = existing.withStatus('leaving');
    const removed = leaving.withRemoved(Date.now());
    // Tombstone (don't delete) so a stale `up` gossip from a peer that
    // hasn't seen the leave yet can't resurrect this address —
    // `mergeMember`'s version check filters it out.  Public APIs
    // (`getMembers`, `upMembers`, `reachableMembers`) all skip
    // `removed` entries.  The `removedAt` stamp is what
    // `tombstonePruneTick` uses to drop the entry once `tombstoneTtlMs`
    // has elapsed (#75).
    this.setMember(removed);
    this.failureDetector.forget(peer);
    this.emit(new MemberLeft(leaving));
    this.emit(new MemberRemoved(removed));
    this.maybeEmitLeaderChange();
  }

  private gossipTick(): void {
    const targets = this.reachableMembers().filter(member => !member.address.equals(this.selfAddress));
    if (targets.length === 0) return;
    // Push to one random reachable peer each tick — epidemic style.
    const target = targets[Math.floor(Math.random() * targets.length)]!;
    const gossip: GossipMessage = {
      kind: 'gossip',
      from: this.selfAddress.toJSON(),
      sequence: this.nextGossipSequence(),
      members: Array.from(this.members.values()).map(member => this.memberDataForGossip(member)),
    };
    this.transport.send(target.address, gossip);
    // Stock metric: gossip rounds count.
    metricsOf(this.system).counter(
      'cluster_gossip_rounds_total', {},
      { help: 'Cumulative count of gossip-push rounds initiated by this node.' },
    ).inc();
  }

  private heartbeatTick(): void {
    this.heartbeatSeq++;
    const hb: HeartbeatMessage = {
      kind: 'heartbeat',
      from: this.selfAddress.toJSON(),
      seq: this.heartbeatSeq,
      ts: Date.now(),
    };
    for (const member of this.reachableMembers()) {
      if (member.address.equals(this.selfAddress)) continue;
      this.transport.send(member.address, hb);
    }
  }

  private failureDetectionTick(): void {
    for (const member of Array.from(this.members.values())) {
      if (member.address.equals(this.selfAddress)) continue;
      const decision = this.failureDetector.decide(member.address);
      // Before the status branches below, because this is the raw observation
      // they are two coarser readings of: one of them only fires for a member
      // that was `up`, the other only once the peer is being evicted.
      this.trackReachability(member, decision);
      if (decision === 'unreachable' && member.status === 'up') {
        this.log.debug(`FD: ${member.address} → unreachable (heartbeat timeout)`);
        this.updateMember(member.withStatus('unreachable'));
        this.emit(new MemberUnreachable(this.members.get(member.address.toString())!));
      } else if (decision === 'down' && member.status !== 'down' && member.status !== 'removed') {
        if (this.downing) { this.holdForResolver(member); continue; }
        this.log.debug(`FD: ${member.address} → down (was ${member.status}); deleting from membership`);
        const downed = member.withStatus('down');
        this.updateMember(downed);
        this.emit(new MemberDown(downed));
        // Reached only with no `DowningProvider` configured — the guard
        // above hands that case to the resolver instead (#929).  We delete
        // rather than tombstone so a process that restarts on the same
        // `host:port` rejoins cleanly instead of meeting its own tombstone;
        // the definitive downing paths (`onLeave`, `evaluateDowning`'s
        // force-down) tombstone, which is what stops stale gossip
        // resurrecting an address nobody is listening on.
        //
        // Deleting does *not* buy a partition+heal recovery, and the note
        // that used to stand here claimed it did.  `gossipTick` and
        // `heartbeatTick` both target `reachableMembers()`, which excludes
        // `unreachable` — and after this delete the peer is not in the map
        // at all — so a symmetric partition leaves neither side with a way
        // to hear the other again.  Closing that is #930.
        this.deleteMember(member.address.toString());
        this.failureDetector.forget(member.address);
        // Transient `removed` Member only used for the event emit —
        // not stored, so the missing `removedAt` here is intentional.
        const removed = downed.withStatus('removed');
        this.emit(new MemberRemoved(removed));
      }
    }
    // Optional split-brain resolver — runs after the failure-detector
    // pass so it sees the latest unreachable set.
    if (this.downing) this.evaluateDowning();
  }

  /**
   * The detector said `down` and a {@link DowningProvider} is configured:
   * park the peer at `unreachable` and evict nothing.  Eviction is the
   * resolver's call (#929).
   *
   * **Why the detector must not evict here.**  `evaluateDowning` runs at the
   * end of the same tick, and it builds `view.unreachable` from members whose
   * status *is* `unreachable`.  Evicting first therefore handed the resolver a
   * view this loop had already emptied: every bundled strategy filters its
   * candidates on that set, so a deleted member reads as a healed cluster and
   * the strategy decides nothing.  The window the detector left was
   * `down-after` minus `unreachable-after` — 3 s on the reference defaults —
   * and two strategies need more than that: `LeaseMajority`'s acquire is
   * asynchronous with a 5 s default budget, and a stability window (#839) is
   * measured in tens of seconds.
   *
   * **Why the re-mark is not redundant** with the `unreachable` arm above:
   * that arm only fires for a member that was `up`.  A peer that fell silent
   * while `joining` or `weakly-up` was never marked — it was deleted here
   * instead — and all five bundled strategies filter their candidates to
   * `up | leaving | unreachable`, so leaving it unmarked would park it outside
   * every resolver's reach on every node but the leader.
   *
   * **Only `MemberUnreachable` is announced, never `MemberDown`.**  Announcing
   * the detector's verdict as a membership fact is exactly the authority this
   * change is taking away: `ClusterSingletonManager` reconciles on
   * `MemberDown` and deliberately not on `MemberUnreachable`, so emitting it
   * would let one node's failure detector trigger a takeover the resolver has
   * not sanctioned.  `updateMember` emits the transition itself, so this does
   * not emit again.
   *
   * The trade is integrity over availability, and it is not free: a strategy
   * that never reaches a verdict parks the member at `unreachable`
   * indefinitely — counting against `maxMembers`, never triggering a singleton
   * takeover or a shard reallocation, and with no path back to `up` until #930
   * lands.  That is the documented end state, not an oversight.
   */
  private holdForResolver(member: Member): void {
    if (member.status === 'unreachable') return;
    this.log.debug(
      `FD: ${member.address} → down (was ${member.status}); holding at unreachable for the downing provider`);
    this.updateMember(member.withStatus('unreachable'));
  }

  /**
   * Fold one detector verdict into {@link reachability} and emit
   * {@link ReachabilityChanged} when it moved (#161).
   *
   * Transition-only, and silent on a peer that has been healthy since this node
   * first saw it: a subscriber wants the edges, and announcing "still fine" for
   * every member on every tick would bury them.
   */
  private trackReachability(member: Member, decision: FailureDecision): void {
    const key = member.address.toString();
    // A downed or tombstoned peer has had its detector sample forgotten, and
    // `decide` answers `'healthy'` for an address it has no sample for — so
    // without this the eviction itself would read as a recovery.
    if (member.status === 'down' || member.status === 'removed') {
      this.reachability.delete(key);
      return;
    }
    const reachable = decision === 'healthy';
    const previous = this.reachability.get(key);
    if (previous === reachable) return;
    this.reachability.set(key, reachable);
    if (previous === undefined && reachable) return;
    this.emit(new ReachabilityChanged(member.address, reachable));
  }

  /**
   * Build a `ClusterPartitionView` from the current member set and
   * ask the configured `DowningProvider` to decide which addresses
   * (if any) need to be force-downed.  Debounces by the JSON shape of
   * the unreachable set + member view so a steady-state cluster
   * doesn't re-invoke the provider on every tick.
   */
  private evaluateDowning(): void {
    if (!this.downing) return;
    const allMembers = Array.from(this.members.values());
    const unreachable = new Set<string>(
      allMembers
        .filter((member) => member.status === 'unreachable')
        .map((member) => member.address.toString()),
    );
    // Cheap fingerprint — re-evaluate only when membership or
    // reachability shifts.  The fingerprint includes statuses so a
    // change like "leaving → unreachable" also triggers a re-check.
    const fingerprint = allMembers
      .map((member) => `${member.address.toString()}:${member.status}`)
      .sort()
      .join('|');
    // Debounce only when the LAST evaluation produced an applied
    // decision.  Strategies that need multiple ticks to converge
    // (e.g. `LeaseMajority` with an in-flight `acquire()`) will
    // return an empty set on the first call and a real decision on
    // a later call WITH THE SAME FINGERPRINT — we must keep
    // re-asking them.  `lastDownedView === null` means "nothing
    // committed yet", so we evaluate.
    if (this.lastDownedView !== null && fingerprint === this.lastDownedView) return;
    const view: ClusterPartitionView = {
      allMembers,
      unreachable,
      self: this.selfAddress,
    };
    let toDown: ReadonlySet<string>;
    try {
      toDown = this.downing.decide(view);
    } catch (err) {
      this.log.warn(`downing provider threw — treating as no decision`, err);
      return;
    }
    if (toDown.size === 0) return;
    this.lastDownedView = fingerprint;
    const selfKey = this.selfAddress.toString();
    const downsSelf = toDown.has(selfKey);
    for (const key of toDown) {
      // Self gets handled via `leave()` below — it gossips a Leaving
      // notice to peers + drains the transport cleanly, which is
      // strictly better than just deleting ourselves out of our own
      // member map.
      if (key === selfKey) continue;
      const member = this.members.get(key);
      if (!member) continue;
      if (member.status === 'down' || member.status === 'removed') continue;
      const downed = member.withStatus('down');
      this.updateMember(downed);
      this.emit(new MemberDown(downed));
      // Tombstone (don't delete) so later gossip from peers that
      // haven't seen the force-down can't resurrect this address.
      // `removedAt` lets `tombstonePruneTick` reclaim the entry
      // after `tombstoneTtlMs` (#75).
      const removed = downed.withRemoved(Date.now());
      this.setMember(removed);
      this.failureDetector.forget(member.address);
      this.emit(new MemberRemoved(removed));
    }
    if (downsSelf) {
      void this.leave().catch((e) =>
        this.log.warn(`self-leave after downing decision failed`, e));
    }
  }

  /**
   * Whether `from` is allowed to make this claim.
   *
   * Gossip is epidemic — A learns about C from B — so "only C may speak for C"
   * cannot be the rule without ending convergence.  What was missing was any
   * rule at all: the merge was decided purely by version magnitude, and
   * versions are seeded from `Date.now()`, so an attacker could always pick a
   * winning number and rewrite any member's status, **including the receiving
   * node's own** (#562).
   *
   * Two rules, chosen to close that without touching how the cluster
   * converges:
   *
   * 1. **Nobody downgrades us.** A record about `selfAddress` is refused,
   *    with one exception: promotion out of `joining`/`weakly-up` into `up`.
   *    That one has to come from outside — it is the *leader's* decision, and
   *    a node cannot promote itself — so refusing it outright leaves every
   *    joining node stuck in `joining` forever. Every other claim about our
   *    own record is refused, which is what closes the exploit: it set our
   *    record to `removed`, and no version is high enough to earn that right.
   *    Accepting a forged promotion costs nothing, because a node that is
   *    `joining` is already trying to become `up`.
   * 2. **Third-party claims need a sender with standing.** Asserting something
   *    about *another* node requires the connection's peer to be a member this
   *    node already considers active. A sender may always assert its own
   *    record — that is the join announcement, and refusing it would mean no
   *    node could ever join.
   *
   * Rule 2 deliberately keys on the connection, not on `message.from`: a
   * payload field is the one thing an attacker fully controls.
   *
   * **What this is not.** It does not make an unauthenticated peer harmless.
   * `hello` carries no credential, so an attacker can announce itself, wait to
   * be promoted, and then satisfy rule 2. Closing that needs the handshake
   * bound to the TLS peer certificate — tracked separately. What these rules
   * do is remove the free-for-all: a claim now needs standing this node
   * granted, rather than a large number.
   *
   * **What it deliberately leaves alone:** `unreachable` still merges from
   * third parties. Unreachability is inherently a third-party observation —
   * "I cannot reach C" — and every peer must converge on the same view before
   * a downing provider decides. Refusing those claims would leave each node
   * with only its own reachability picture, and `KeepMajority` would compute a
   * different answer on every node.
   */
  private maySpeakFor(
    from: NodeAddress,
    senderStatus: MemberStatus | undefined,
    subject: NodeAddress,
    incomingStatus: MemberStatus,
  ): boolean {
    if (subject.equals(this.selfAddress)) {
      if (this.isOwnPromotion(incomingStatus)) return true;
      // A peer echoing the status we already hold is the ordinary content of
      // every round, not an event: our own record travels back to us in each
      // frame, and refusing it changes nothing the version comparison in
      // `mergeMember` would not have dropped anyway.  Logged, it is one WARN
      // per gossip interval per peer describing a healthy cluster — which is
      // how it came to be read as the cause of a failure that lay elsewhere.
      //
      // A peer that *contradicts* us is the #562 case and still surfaces, but
      // through `refusalCounts` like every other guard on this path: one line
      // and one counter increment per frame rather than per record (#131).
      if (incomingStatus !== this.members.get(this.selfAddress.toString())?.status) {
        this.refusalCounts['self-claim']++;
      }
      return false;
    }
    if (subject.equals(from)) return true;      // a node announcing itself
    if (senderStatus === 'up' || senderStatus === 'weakly-up' || senderStatus === 'leaving') return true;
    this.log.debug(
      `merge: ignoring ${from}'s claim about ${subject} — sender is `
      + `${senderStatus ?? 'not a member'}, not an active one`,
    );
    return false;
  }

  /**
   * The one transition on our own record that legitimately originates
   * elsewhere: the leader moving us out of `joining`/`weakly-up` into `up`
   * (see the promotion loop in `onGossip`).  Anything else about us — and in
   * particular any downgrade — we decide ourselves.
   */
  private isOwnPromotion(incomingStatus: MemberStatus): boolean {
    if (incomingStatus !== 'up') return false;
    const current = this.members.get(this.selfAddress.toString())?.status;
    return current === 'joining' || current === 'weakly-up';
  }

  /**
   * How far ahead of this node's wall-clock a gossiped member version may be
   * (#114).
   *
   * **What a far-future version buys.**  Versions are seeded from `Date.now()`
   * and bumped by 1 per status change, so in normal operation they track the
   * owner's own clock.  Nothing capped them at first, and a peer gossiping
   * `version: Number.MAX_SAFE_INTEGER` for any target won the merge and then
   * beat every legitimate update from that target forever — `MAX_SAFE_INTEGER
   * + 1` rounds back to itself in JS, so not even a fresh start-from-zero
   * re-incarnation could escape.  That is the coarse form.  The fine form is
   * that "highest version wins" also decides what happens the *first* time an
   * address is mentioned at all.  {@link maySpeakFor} waves a
   * self-announcement through unconditionally
   * (`subject.equals(from)`), because refusing it would mean no node could
   * ever join and the `hello` frame carries no credential to check it against
   * (#562, #912).  So a stranger can announce itself under an address that is
   * *about* to exist — the next pod of a StatefulSet, a node being replaced —
   * date it far ahead, attach roles of its own choosing, and drop the
   * connection.  The squat outlives it: `onGossip`'s promotion loop lifts
   * anything `joining` to `up` on the next leader tick, so the phantom enters
   * the active set carrying **the attacker's roles** — and roles are what
   * routing, sharding placement, singleton hosting and downing quorums are
   * computed from.  The real node, when it finally starts, seeds its version
   * from its own clock, which is lower, so the monotonicity check in
   * {@link mergeMember} drops its record and the phantom stays.
   *
   * **Why there is one cap and not two.**  This began as a pair: a generous
   * 24 h bound on every merge, and a tight one on the branch that *introduces*
   * an address, on the reasoning that refusing a record for an address already
   * on file freezes a member the cluster is using, while a first sighting has
   * nothing to freeze.  The split does not survive contact, because "already
   * on file" is a property of a map the sender has just written to:
   *
   * - Two records for the same address **in one frame**.  `mergeMember` reads
   *   `members.get(…)` per record, so the first creates the entry under the
   *   tight cap and the second — same frame, same peer — is an update and got
   *   the wide one.
   * - A frame with **no member records at all**.  `onGossip`'s sender fallback
   *   files the connection's self-declared address by itself, so the next
   *   frame is an update too.  That fallback is what makes a refusal cost one
   *   gossip round rather than being permanent; the same property was the way
   *   around the cap.
   *
   * Any rule that lets a record *earn* the wide cap fails the same way, one
   * step later: without per-node credentials every step of the earning is
   * attacker-producible — pass the tight cap once, wait any interval, open a
   * second connection, get promoted and then speak as a third party.  So the
   * wide bound is not reachable from gossip at all any more.  It survives on
   * {@link MAX_WALL_CLOCK_SKEW_MS}, guarding the fields that are timestamps
   * rather than versions.
   *
   * **Why the default is minutes rather than seconds.**  A legitimate version
   * is the announcing node's wall-clock, so this is a clock-skew budget.  Five
   * minutes is the long-standing convention for exactly that judgement
   * (Kerberos has used it as its skew tolerance for decades), and the regimes
   * either side of it are far apart: an NTP-disciplined host sits milliseconds
   * from true, a host that never synced at all is hours out.
   *
   * **What a refusal costs.**  It is not exclusion: a node announcing itself
   * is still recorded by the sender fallback, at version 1 with no roles.  It
   * *is* durable, which the two-cap version was not — a node whose clock runs
   * more than `maxVersionSkewMs` ahead of this one stays in the member list
   * without roles until its clock comes back inside the budget.  That was
   * always this cap's verdict on such a node; what changed is that the verdict
   * now sticks instead of being reversed by the node's second frame.
   * Deployments whose clocks are known to run loose raise the knob.
   */
  private admitsVersion(incoming: Member): boolean {
    const maxAcceptableVersion = Date.now() + this.maxVersionSkewMs;
    if (Number.isFinite(incoming.version) && incoming.version <= maxAcceptableVersion) return true;
    this.refusalCounts['version-skew']++;
    return false;
  }

  /**
   * Whether the member map has room for the record `incoming` is about to
   * become, given whatever `existing` occupies today (#138).
   *
   * The map was unbounded, and every path that wrote to it set
   * unconditionally.  The other guards in front of the merge decide whether a
   * *claim* is believable; none of them bounds how *many* believable claims one
   * peer may make.  `maySpeakFor` waves a self-announcement through by design —
   * refusing it would mean no node could ever join — so a peer that opens a
   * connection per address, or one active peer asserting third-party records,
   * allocated an entry per name for free.
   *
   * **Why the tombstone cap is the load-bearing one.**  The obvious reading of
   * the attack is "flood phantom members", and it is the weaker half: a phantom
   * in `up` / `joining` / `unreachable` is a member the failure detector is
   * watching, so it is downed and deleted `downAfterMs` after the attacker
   * stops feeding it — seconds, at the default.  A record gossiped as `removed`
   * is the one that sticks: nothing heartbeats a tombstone, so only
   * {@link ClusterOptionsType.tombstoneTtlMs} reclaims it, a day later.  That
   * asymmetry is why the two caps are separate numbers rather than one.
   *
   * **Why the question is about the transition, not the record.**  Capping only
   * *creation* left the two caps trading headroom with each other, and the
   * exchange rate was free: a `removed` record admitted under the tombstone cap
   * and then re-incarnated as `up` moved an entry out of the tombstone bucket
   * **without giving up a map slot**, so the next block of tombstones was
   * admitted too.  Alternating the two floods grew `members` without bound —
   * `maxMembers` and `maxTombstones` were both respected at every individual
   * step.  The live→tombstone direction is the mirror image of the same hole.
   * So a record that stays in its bucket is a free in-place update, and one
   * that changes bucket has to be admitted by the bucket it is moving into.
   *
   * **What "full" costs.**  A refused *tombstone* costs nothing when it would
   * have created an entry: it suppresses an address this node has no record of.
   * A refused *conversion* leaves the member live, where the failure detector
   * reclaims it within `downAfterMs` — the slower but self-healing outcome.  A
   * refused *live* record costs one gossip round if it was legitimate, and the
   * operator has a WARN naming the cap.  Refusing the new entry rather than
   * evicting an old one is deliberate: eviction would let an attacker push real
   * members out, which is a strictly better exploit than the one being closed.
   *
   * Entries this node mints itself — self at startup, and the `removed`
   * tombstones written by `leave` / downing / {@link down} — never pass through
   * here.  They convert records this node authored, and capping its own
   * bookkeeping would be a liveness bug rather than a defence.
   */
  private admitsMember(incoming: Member, existing: Member | undefined): boolean {
    const wantsTombstone = incoming.status === 'removed';
    // Same bucket in and out: the entry is already counted, so nothing grows.
    if (existing !== undefined && (existing.status === 'removed') === wantsTombstone) return true;
    const cap = wantsTombstone ? this.maxTombstones : this.maxMembers;
    if (cap === 0) return true; // 0 = disabled
    const held = wantsTombstone ? this.tombstoneCount : this.members.size - this.tombstoneCount;
    if (held < cap) return true;
    this.refusalCounts['map-cap']++;
    return false;
  }

  private mergeMember(from: NodeAddress, senderStatus: MemberStatus | undefined, data: MemberData): void {
    const incoming = this.withLocalSelfIdentity(Member.fromData(data));

    if (!this.maySpeakFor(from, senderStatus, incoming.address, incoming.status)) return;

    // The same version bound whether the record creates an address or updates
    // one, because "does this address exist yet?" is a question about a map
    // the sender can write to first — see {@link admitsVersion}.  The refusal
    // is counted there and reported once per frame by `onGossip` rather than
    // logged per record.
    if (!this.admitsVersion(incoming)) return;

    // Reject expired tombstones from gossip — peers that haven't yet
    // pruned a long-dead address would otherwise resurrect it on
    // nodes that already pruned (#75).  Old nodes that pre-date the
    // `removedAt` field gossip without it; we treat such tombstones
    // as fresh (no age info ⇒ assume they need normal TTL) so a
    // mixed-version cluster still converges.
    // `removedAt` gets the same plausibility check as `version` above, and for
    // the same reason: it is a peer-supplied number that decides whether an
    // entry ages out.  Without it the age comparison fails *open* — with
    // `removedAt` at `Infinity` or `NaN`, `Date.now() - removedAt` is
    // `-Infinity` or `NaN`, neither of which is `>= ttl`, so the tombstone is
    // treated as fresh on every merge and never expires.  A far-future value
    // does the same via a negative age.  Since a tombstone suppresses its
    // address, an immortal one keeps that node from ever rejoining.
    if (incoming.status === 'removed' && incoming.removedAt !== undefined) {
      // Counted, not logged, for the same reason as the version cap above:
      // one frame can carry tens of thousands of these.
      const maxAcceptableRemovedAt = Date.now() + MAX_WALL_CLOCK_SKEW_MS;
      if (!Number.isFinite(incoming.removedAt) || incoming.removedAt > maxAcceptableRemovedAt) {
        this.refusalCounts['timestamp-skew']++;
        return;
      }
      const age = Date.now() - incoming.removedAt;
      if (age >= this.tombstoneTtlMs) {
        this.log.debug(
          `merge: dropping expired tombstone for ${incoming.address} ` +
          `(age ${age}ms ≥ ttl ${this.tombstoneTtlMs}ms)`,
        );
        return;
      }
    }
    const existing = this.members.get(incoming.address.toString());
    if (!existing) {
      // Last gate before the map grows — after every believability check, so a
      // record that was going to be dropped anyway never consumes cap headroom.
      if (!this.admitsMember(incoming, existing)) return;
      this.setMember(incoming);
      this.checkStorageIdentityAgreement(incoming);
      this.failureDetector.register(incoming.address);
      this.emit(new MemberJoined(incoming));
      // If we first learn about the member already in a terminal or
      // active state (common via gossip merging), also fire the matching
      // status event so subscribers (ShardRegion, etc.) re-allocate.
      if (incoming.status !== 'joining') {
        this.emitStatusTransition(new Member(incoming.address, 'joining', 0), incoming);
      }
      return;
    }

    // Re-incarnation: a previously-removed (tombstoned) address can
    // be revived by a fresh start on the same `host:port`.  We
    // detect the new incarnation by its strictly higher base
    // version: each `Cluster.join` seeds its self-member with a
    // wall-clock-based epoch (see `_start`), so any state the new
    // node reports — directly via its initial gossip OR indirectly
    // via a peer that has already seen the rejoin — out-versions
    // the tombstone left over from its previous run.  Drop the
    // tombstone, treat the address as a fresh member, and emit the
    // matching status event so subscribers (ShardRegion, etc.)
    // re-allocate.  Without this branch, `mergeMember`'s strict
    // version monotonicity below would pin the address to
    // `removed` forever even though the higher version is the
    // newer truth.
    if (existing.status === 'removed' && incoming.version > existing.version) {
      // A revival vacates the tombstone bucket and occupies a live slot, so it
      // is the live cap's call — without this the two caps traded headroom for
      // free and the map grew past both (#138).
      if (!this.admitsMember(incoming, existing)) return;
      this.log.debug(
        `merge: ${incoming.address} re-incarnation (was removed v${existing.version}, now ${incoming.status} v${incoming.version})`,
      );
      this.setMember(incoming);
      this.checkStorageIdentityAgreement(incoming);
      this.failureDetector.register(incoming.address);
      this.emit(new MemberJoined(incoming));
      if (incoming.status !== 'joining') {
        this.emitStatusTransition(new Member(incoming.address, 'joining', 0), incoming);
      }
      return;
    }

    if (incoming.version <= existing.version) {
      // Ignored for membership — but the identity overlay still lands, or a
      // claim published after a member's last status change would never
      // spread (#1358).
      this.adoptStorageIdentities(existing, incoming);
      return;
    }
    // The mirror of the revival check: a live member gossiped as `removed`
    // moves into the tombstone bucket, which frees a live slot for the next
    // flood while keeping the map entry.  Refused when the bucket is full, and
    // then the failure detector reclaims the member the slower way (#138).
    if (!this.admitsMember(incoming, existing)) return;
    if (existing.status !== incoming.status) {
      this.log.debug(
        `merge: ${incoming.address} ${existing.status}→${incoming.status} (v${existing.version}→v${incoming.version})`,
      );
    }
    this.setMember(incoming);
    this.checkStorageIdentityAgreement(incoming);
    this.emitStatusTransition(existing, incoming);
  }

  /**
   * A gossiped record *about this node* keeps this node's own address object,
   * incarnation included (#940).
   *
   * {@link maySpeakFor} already refuses every claim about `selfAddress` except
   * an own promotion, and a promotion is merged wholesale — the incoming
   * record's version, roles **and address** replace the local ones.  For the
   * three fields the string form is built from that is invisible, because they
   * had to match for the record to be about this node at all.  For the
   * incarnation it is not: a peer running the previous version sends none, and
   * a hostile one can send whatever it likes, so the self record's identifier
   * would be whatever the last peer to promote us happened to say.
   *
   * Substituting the local address is the one incarnation comparison that needs
   * no distributed agreement, because it only ever discards a peer's claim in
   * favour of a fact this node owns.  It is not a refusal: the promotion still
   * lands, which is what keeps a node joining a cluster whose leader predates
   * the field.
   */
  private withLocalSelfIdentity(member: Member): Member {
    if (!member.address.equals(this.selfAddress)) return member;
    // The store identities get the same substitution as the incarnation, for
    // the same reason (#1358): they are a fact this node owns.  A leader
    // promoting us from a view that predates our publication would otherwise
    // merge a self record without them — wholesale, per the rule above — and
    // wipe what only this node can know.
    const ownIdentities = this.selfStorageIdentitiesSnapshot() ?? member.storageIdentities;
    if (member.address.incarnation === this.selfAddress.incarnation
      && ownIdentities === member.storageIdentities) {
      return member;
    }
    return new Member(
      this.selfAddress, member.status, member.version, member.roles, member.removedAt,
      ownIdentities,
    );
  }

  /**
   * The single write door into {@link members}, so {@link tombstoneCount}
   * cannot drift from the map it describes.  Every mutation goes through here
   * or {@link deleteMember} — a `this.members.set(…)` elsewhere would silently
   * un-cap the tombstone half of #138.
   *
   * Keyed by `address.toString()` like every other entry; the map has no other
   * key shape.
   */
  private setMember(member: Member): void {
    const key = member.address.toString();
    const previous = this.members.get(key);
    if (previous?.status === 'removed') this.tombstoneCount--;
    if (member.status === 'removed') this.tombstoneCount++;
    this.members.set(key, member);
  }

  /** The matching delete — see {@link setMember}. */
  private deleteMember(key: string): void {
    const previous = this.members.get(key);
    if (previous === undefined) return;
    if (previous.status === 'removed') this.tombstoneCount--;
    this.members.delete(key);
    // Same key space, same lifetime.  A verdict left behind here would make the
    // address's next incarnation look like a peer that had recovered.
    this.reachability.delete(key);
    // Likewise: a high-water mark outliving its member would refuse the first
    // frames of the address's next incarnation, whose counter starts from its
    // own clock rather than from where the previous one left off (#112).
    this.acceptedGossipSequences.delete(key);
  }

  private updateMember(next: Member): void {
    const key = next.address.toString();
    const prev = this.members.get(key);
    this.setMember(next);
    if (prev) this.emitStatusTransition(prev, next);
    else this.emit(new MemberJoined(next));
    // Stock metric: members-up gauge.  Updated on every member-set
    // mutation so all transitions (join, up, down, removed) keep it
    // current.  Single value per node — labels are deliberately empty
    // because the gauge is always the local view's snapshot.
    metricsOf(this.system).gauge(
      'cluster_members_up', {},
      { help: 'Number of cluster members currently in `up` state.' },
    ).set(this.upMembers().length);
  }

  private emitStatusTransition(prev: Member, next: Member): void {
    if (prev.status === next.status) return;
    for (const event of this.statusEventsOf(next)) this.emit(event);
    this.maybeEmitLeaderChange();
  }

  /**
   * The events that announce `member` in the status it currently holds.
   *
   * Shared by {@link emitStatusTransition} and the `'events'` replay so that a
   * late subscriber is told the same thing an early one was — the replay used
   * to carry its own, shorter idea of which statuses were worth mentioning, and
   * the two drifted.  A match that computes a value, so the arms stay inline.
   *
   * `joining` yields nothing: it is the state every member starts in, and
   * `MemberJoined` has already said so.
   */
  private statusEventsOf(member: Member): ReadonlyArray<ClusterEvent> {
    const isSelf = member.address.equals(this.selfAddress);
    return match(member.status)
      .with('up', () => (isSelf ? [new MemberUp(member), new SelfUp(member)] : [new MemberUp(member)]))
      .with('weakly-up', () => [new MemberWeaklyUp(member)])
      .with('unreachable', () => [new MemberUnreachable(member)])
      .with('down', () => [new MemberDown(member)])
      .with('leaving', () => [new MemberLeft(member)])
      .with('removed', () => (
        isSelf ? [new MemberRemoved(member), new SelfRemoved(member)] : [new MemberRemoved(member)]
      ))
      .with('joining', () => [])
      .exhaustive();
  }

  private maybeEmitLeaderChange(): void {
    const newLeader = this.leader();
    const prev = this.currentLeader;
    const changed = prev.isSome() !== newLeader.isSome()
      || (prev.isSome() && newLeader.isSome() && !prev.value.address.equals(newLeader.value.address));
    if (changed) {
      this.currentLeader = newLeader;
      const prevStr = prev.fold(() => 'none', (member) => member.address.toString());
      const nextStr = newLeader.fold(() => 'none', (member) => member.address.toString());
      this.log.debug(`leader changed: ${prevStr} → ${nextStr}`);
      this.emit(new LeaderChanged(newLeader));
    }
  }

  private emit(event: ClusterEvent): void {
    this.system.eventStream.publish(event as object);
    for (const listener of this._listeners) {
      try { listener(event); } catch (e) { this.log.warn('listener threw', e); }
    }
  }

  /**
   * Drop tombstones whose `removedAt` exceeds `tombstoneTtlMs` (and
   * the `tombstoneMinRetentionMs` floor).  Each peer makes the same
   * decision on its local clock — with TTL ≫ gossip propagation lag,
   * peers prune within seconds of each other and stale-gossip
   * resurrection is filtered out by `mergeMember`'s "expired
   * tombstone" guard.  See #75 for the full rationale.
   *
   * Tombstones lacking `removedAt` (older nodes pre-dating the field)
   * are kept — we have no age info to compare against.  They drop
   * out naturally when those nodes are upgraded or restart.
   */
  private tombstonePruneTick(): void {
    const now = Date.now();
    const cutoff = Math.max(this.tombstoneTtlMs, this.tombstoneMinRetentionMs);
    let pruned = 0;
    for (const [key, member] of this.members) {
      if (member.status !== 'removed') continue;
      if (member.removedAt === undefined) continue;
      if (now - member.removedAt < cutoff) continue;
      this.deleteMember(key);
      pruned++;
    }
    if (pruned > 0) {
      this.log.debug(
        `tombstone prune: dropped ${pruned} expired entr${pruned === 1 ? 'y' : 'ies'} ` +
        `(ttl=${this.tombstoneTtlMs}ms, minRetention=${this.tombstoneMinRetentionMs}ms)`,
      );
    }
  }
}

/**
 * Say out loud that nothing named this node's advertised address, and what was
 * used instead (#944).
 *
 * The failure this replaces was silent by construction: a node that gossiped a
 * wildcard produced no error, no warning and a member map of one, and the only
 * way to tell a cluster that had not converged *yet* from one that never would
 * was to know this defect existed.  So the derivation announces itself, and
 * the level splits on whether the answer can be dialled from another machine:
 * a value from the environment is a working address and reads as information,
 * where the loopback fallback means no peer off this host can reach this node
 * — fine for a development run, a silent outage for anything else.
 *
 * Emitted from `join` rather than the constructor because only `join` holds
 * both the options as written and the value derived from them; the constructor
 * receives one field and cannot tell which it is.
 */
function reportDerivedAdvertisedHost(system: ActorSystem, options: ClusterOptionsType): void {
  const advertised = `${options.advertisedHost}:${options.port}`;
  const looked = ADVERTISED_HOST_ENV_VARS.join(', ');
  if (options.advertisedHost === DEFAULT_ADVERTISED_HOST) {
    system.log.warn(
      `cluster: nothing named this node's advertised address (no routable host, no `
      + `advertisedHost, none of ${looked}), so it will tell peers to dial ${advertised} — reachable from this `
      + `machine only. Set ClusterOptions.withAdvertisedHost(...), ${ConfigKeys.remote.tcp.advertisedHost}, `
      + 'or the CLUSTER_HOST / POD_IP env var before running more than one node.',
    );
    return;
  }
  system.log.info(
    `cluster: binding ${options.host}:${options.port} and advertising ${advertised}, `
    + `taken from the environment (${looked}) because the bind host is a wildcard.`,
  );
}

/** Helper — creates an InMemoryTransport for tests. */
export function inMemoryTransport(system: ActorSystem, host: string, port: number): Transport {
  return new InMemoryTransport(new NodeAddress(system.name, host, port));
}
