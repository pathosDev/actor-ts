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
import { MAX_WALL_CLOCK_SKEW_MS } from './Constants.js';
import { none, some, type Option } from '../util/Option.js';
import { ClusterExtensionId } from './ClusterExtension.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import {
  ClusterOptionsValidator,
  DEFAULT_MAX_MEMBERS,
  DEFAULT_MAX_TOMBSTONES,
  DEFAULT_MAX_VERSION_SKEW_MS,
  DEFAULT_SEED_RETRY_INTERVAL_MS,
  DEFAULT_TOMBSTONE_PRUNE_INTERVAL_MS,
  DEFAULT_TOMBSTONE_TTL_MS,
  isRemoteTlsRequested,
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
// `ClusterSharding` and `ClusterSingleton` only import `Cluster` as a type
// (erased at runtime), so the value-imports here don't create a runtime
// cycle — every sharding and singleton file uses `import type { Cluster }`.
import { ClusterSharding } from './sharding/ClusterSharding.js';
import { ClusterSingleton } from './singleton/ClusterSingleton.js';
import type {
  EnvelopeMessage,
  GossipMessage,
  HeartbeatMessage,
  LeaveMessage,
  MemberData,
  MemberStatus,
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
  'map-cap', 'version-skew', 'timestamp-skew', 'replayed-frame',
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
 * The Cluster is a single-instance "extension" attached to an ActorSystem.
 * It owns a Transport, a gossip-based membership view, a failure detector
 * and the plumbing that dispatches inbound envelope messages to local actors.
 */
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
  };

  /**
   * The highest {@link GossipMessage.sequence} accepted from each connection
   * peer — the high-water mark that makes a captured gossip frame worthless
   * on a second delivery (#112).
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
    this.selfAddress = new NodeAddress(system.name, options.host, options.port);
    this.selfRoles = new Set(options.roles ?? []);
    this.log = system.log.withSource(`cluster@${this.selfAddress}`);
    // The frame cap only reaches a transport this constructor builds; an
    // injected one was constructed with its own, and silently re-capping
    // someone else's transport would be a surprise.
    this.transport = options.transport
      ?? new TcpTransport(this.selfAddress, this.log, null, options.maxFrameBytes);
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
    const resolvedOptions = withClusterConfigDefaults(system.config, options as ClusterOptionsType);
    new ClusterOptionsValidator().validate(resolvedOptions);
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
    const me = new Member(this.selfAddress, 'joining', Date.now(), this.selfRoles);
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
      // Keep retrying seed contact until self has transitioned to up,
      // covering the case where a seed hasn't started yet.
      this.seedTimer = this.system.scheduler.scheduleAtFixedRateFunction(
        this.seedRetryIntervalMs, this.seedRetryIntervalMs, () => {
          const self = this.members.get(this.selfAddress.toString());
          if (!self || self.status !== 'joining') { this.seedTimer?.cancel(); this.seedTimer = null; return; }
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
      members: [me.toData()],
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
    this.updateMember(me.withStatus('up'));
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

  private onUnhandledWire(message: WireMessage, from: NodeAddress): void {
    // 'shard-map' and any custom extension wire-msgs handled by the
    // registry; we intentionally fall through when no handler is set.
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
   * connection peer — the guard that makes a captured gossip frame worthless
   * on a second delivery (#112).
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
   * **What it does not close.**  A peer that has earned standing can still
   * *compose* a fresh frame naming a deleted address at its old version — that
   * is not a replay, and only an incarnation identity on `NodeAddress` closes
   * it (#940).
   */
  private admitsGossipSequence(from: NodeAddress, sequence: number): boolean {
    const lastAccepted = this.acceptedGossipSequences.get(from.toString());
    return lastAccepted === undefined || sequence > lastAccepted;
  }

  /**
   * Raise the high-water mark for a peer whose frame was just merged.
   *
   * Two conditions, both about not turning a replay guard into a denial of
   * service:
   *
   * - **Only for an address the member map holds**, which is what bounds this
   *   map by the same caps as that one — the sender fallback above has already
   *   run, so an honest peer is on file by the time this is asked.
   * - **Only for a sequence that is plausible**, held to the same budget as a
   *   gossiped version.  A frame numbered `Number.MAX_SAFE_INTEGER` is still
   *   *accepted* — it is by definition not a recording of a real frame, so the
   *   guard has no business refusing it — but it must not become the mark, or
   *   one frame would pin a member's address and refuse everything the real
   *   node says from then on.  That is exactly the exploit #114 closed on
   *   `version`, and it would be reintroduced one field to the left.
   */
  private rememberGossipSequence(from: NodeAddress, sequence: number): void {
    const key = from.toString();
    if (!this.members.has(key)) return;
    if (sequence > Date.now() + this.maxVersionSkewMs) return;
    this.acceptedGossipSequences.set(key, sequence);
  }

  /**
   * Fold one frame's refusals into a WARN and the stock counter.
   *
   * The reason is a label rather than a metric name so an operator can alert
   * on "records are being refused at all" without knowing which guard fired,
   * and it is drawn from a closed union so the series count stays at three no
   * matter what a peer sends — the cardinality trap #131 put a cap on.
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
        'the frame does not out-number the last one accepted from that peer — a replay or a duplicate')
      .exhaustive();
  }

  private onEnvelope(from: NodeAddress, message: EnvelopeMessage): void {
    // Re-install the originating MDC + active trace context for the
    // duration of dispatch (#53, #10).  Local refs that the
    // dispatcher subsequently `tell`s capture this same context onto
    // the next envelope, so both trails keep flowing across hops.
    // Empty / missing contexts skip the corresponding wrapper.
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
    // one whose every key the sanitiser rejected, must still take the
    // no-wrapper branch rather than pay an `AsyncLocalStorage` frame for a
    // context with nothing in it.
    if (context && !LogContext.isEmpty(context)) {
      LogContext.run(context, dispatch);
    } else {
      dispatch();
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
      members: Array.from(this.members.values()).map(member => member.toData()),
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
        this.log.debug(`FD: ${member.address} → down (was ${member.status}); deleting from membership`);
        const downed = member.withStatus('down');
        this.updateMember(downed);
        this.emit(new MemberDown(downed));
        // Note: FD-driven downing is the *advisory* fallback when no
        // `DowningProvider` is configured.  We delete here (rather
        // than tombstone) so a partition followed by a heal can
        // recover the peer — `partition+heal` semantics rely on
        // this.  Definitive downing paths (`onLeave`,
        // `evaluateDowning` force-down) tombstone instead, which
        // prevents stale gossip from resurrecting the address.
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
      this.log.warn(
        `merge: refusing ${from}'s claim that we are "${incomingStatus}" — `
        + `this node is the author of its own status, promotion aside`,
      );
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
    const incoming = Member.fromData(data);

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
      this.failureDetector.register(incoming.address);
      this.emit(new MemberJoined(incoming));
      if (incoming.status !== 'joining') {
        this.emitStatusTransition(new Member(incoming.address, 'joining', 0), incoming);
      }
      return;
    }

    if (incoming.version <= existing.version) return; // older or equal, ignore
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
    this.emitStatusTransition(existing, incoming);
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

/** Helper — creates an InMemoryTransport for tests. */
export function inMemoryTransport(system: ActorSystem, host: string, port: number): Transport {
  return new InMemoryTransport(new NodeAddress(system.name, host, port));
}
