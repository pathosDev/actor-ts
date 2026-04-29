import { match, P } from 'ts-pattern';
import type { ActorRef } from '../ActorRef.js';
import type { ActorSystem } from '../ActorSystem.js';
import { LogContext } from '../LogContext.js';
import type { Logger } from '../Logger.js';
import type { Cancellable } from '../Scheduler.js';
import { none, some, type Option } from '../util/Option.js';
import {
  LeaderChanged,
  MemberDown,
  MemberJoined,
  MemberLeft,
  MemberReachable,
  MemberRemoved,
  MemberUnreachable,
  MemberUp,
  MemberWeaklyUp,
  SelfRemoved,
  SelfUp,
  type ClusterEvent,
} from './ClusterEvents.js';
import {
  defaultFailureDetectorSettings,
  FailureDetector,
  type FailureDetectorSettings,
} from './FailureDetector.js';
import { Member } from './Member.js';
import { NodeAddress } from './NodeAddress.js';
import type {
  EnvelopeMsg,
  GossipMsg,
  HeartbeatMsg,
  LeaveMsg,
  MemberData,
  MemberStatus,
  WireMessage,
} from './Protocol.js';
import { decodeRefs, encodeRefs, parsePathSegments } from './RefCodec.js';
import { InMemoryTransport, TcpTransport, type Transport } from './Transport.js';
import type {
  ClusterPartitionView,
  DowningProvider,
} from './downing/DowningProvider.js';

export interface ClusterSettings {
  readonly host: string;
  readonly port: number;
  /** Other nodes this node should try to contact on startup. */
  readonly seeds?: string[];
  /** Role tags exposed to other members — used to constrain sharding placement. */
  readonly roles?: string[];
  /** Failure detector thresholds. */
  readonly failureDetector?: Partial<FailureDetectorSettings>;
  /** Override the transport (e.g. InMemoryTransport for tests). */
  readonly transport?: Transport;
  /** How often gossip is pushed to a random reachable peer. */
  readonly gossipIntervalMs?: number;
  /** How often to resend the initial join gossip to seeds until self is Up. */
  readonly seedRetryIntervalMs?: number;
  /**
   * Auto-promote a `joining` member to `weakly-up` after this many ms if
   * convergence (leader + `up` transition) hasn't happened yet.  Set to 0
   * to disable.  Default: 0 (disabled — opt-in only).
   */
  readonly weaklyUpAfterMs?: number;
  /**
   * Optional split-brain resolver.  When provided, the cluster invokes
   * `provider.decide(view)` whenever a member transitions to / from
   * `unreachable`, and force-downs every address in the returned set
   * (regardless of failure-detector state).  Without a provider, the
   * cluster relies solely on the failure detector's elapsed-time
   * `unreachable → down → removed` cascade — fine for unilateral
   * crashes, weak under network partitions.
   *
   * See `src/cluster/downing/` for the bundled strategies (KeepMajority,
   * KeepOldest, KeepReferee, StaticQuorum, LeaseMajority).
   */
  readonly downing?: DowningProvider;
}

type EnvelopeHandler = (env: EnvelopeMsg, from: NodeAddress) => void;

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

  private heartbeatSeq = 0;
  private gossipTimer: Cancellable | null = null;
  private heartbeatTimer: Cancellable | null = null;
  private fdTimer: Cancellable | null = null;
  private seedTimer: Cancellable | null = null;
  private weaklyUpTimer: Cancellable | null = null;
  private currentLeader: Option<Member> = none;
  private readonly weaklyUpAfterMs: number;

  private envelopeHandler: EnvelopeHandler | null = null;
  private readonly _envelopeHandlersByPath = new Map<string, EnvelopeHandler>();
  private readonly wireHandlers = new Map<string, (msg: WireMessage, from: NodeAddress) => void>();
  private started = false;

  private readonly downing: DowningProvider | null;
  /**
   * Set of unreachable address keys observed at the last downing
   * evaluation.  We only re-invoke the provider when the set
   * actually changes — without this debounce a steady "always one
   * unreachable peer" state would call `decide()` on every tick.
   */
  private lastDownedView: string | null = null;

  private constructor(system: ActorSystem, settings: ClusterSettings) {
    this.system = system;
    this.selfAddress = new NodeAddress(system.name, settings.host, settings.port);
    this.selfRoles = new Set(settings.roles ?? []);
    this.log = system.log.withSource(`cluster@${this.selfAddress}`);
    this.transport = settings.transport ?? new TcpTransport(this.selfAddress, this.log);
    const fdSettings: FailureDetectorSettings = {
      ...defaultFailureDetectorSettings,
      ...(settings.failureDetector ?? {}),
    };
    this.failureDetector = new FailureDetector(fdSettings);
    this.gossipIntervalMs = settings.gossipIntervalMs ?? 1_000;
    this.seedRetryIntervalMs = settings.seedRetryIntervalMs ?? 3_000;
    this.weaklyUpAfterMs = settings.weaklyUpAfterMs ?? 0;
    this.downing = settings.downing ?? null;
  }

  /** Entry point: start the cluster and attempt to contact seed nodes. */
  static async join(system: ActorSystem, settings: ClusterSettings): Promise<Cluster> {
    const cluster = new Cluster(system, settings);
    await cluster._start(settings.seeds ?? []);
    return cluster;
  }

  /**
   * Subscribe to membership events.  The listener is immediately replayed
   * the current cluster state as a series of Member/SelfUp events so that
   * late subscribers still see the world they joined.
   */
  subscribe(listener: (event: ClusterEvent) => void): () => void {
    this._listeners.push(listener);
    // Replay current state.
    for (const m of this.members.values()) {
      try { listener(new MemberJoined(m)); } catch { /* ignore */ }
      if (m.status === 'up') {
        try { listener(new MemberUp(m)); } catch { /* ignore */ }
        if (m.address.equals(this.selfAddress)) {
          try { listener(new SelfUp(m)); } catch { /* ignore */ }
        }
      }
    }
    if (this.currentLeader.isSome()) {
      try { listener(new LeaderChanged(this.currentLeader)); } catch { /* ignore */ }
    }
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  }

  private _listeners: Array<(event: ClusterEvent) => void> = [];

  /** Current snapshot of known members. */
  getMembers(): ReadonlyArray<Member> {
    return Array.from(this.members.values());
  }

  /** Members in the `up` state, ordered by address — the "active set". */
  upMembers(): Member[] {
    return Array.from(this.members.values())
      .filter(m => m.status === 'up')
      .sort((a, b) => a.address.compareTo(b.address));
  }

  /** Reachable members (up + joining + leaving). */
  reachableMembers(): Member[] {
    return Array.from(this.members.values()).filter(m => m.isReachable());
  }

  /** Up members that carry the given role tag. */
  upMembersWithRole(role: string): Member[] {
    return this.upMembers().filter(m => m.hasRole(role));
  }

  /** The oldest up-member is the cluster leader (deterministic across nodes). */
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
   * direct remote-ref).  Receiving nodes decode in `handleEnvelope`.
   */
  _sendEnvelope(to: NodeAddress, env: EnvelopeMsg): void {
    const encoded: EnvelopeMsg = { ...env, body: encodeRefs(env.body, this.selfAddress) };
    this.transport.send(to, encoded);
  }

  /** Register a handler for a specific wire-message discriminator. */
  _onWire(kind: string, handler: (msg: WireMessage, from: NodeAddress) => void): () => void {
    this.wireHandlers.set(kind, handler);
    return () => this.wireHandlers.delete(kind);
  }

  /** Gracefully leave the cluster (broadcast `leave`, stop transport). */
  async leave(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    const me = this.members.get(this.selfAddress.toString());
    if (me) {
      this.updateMember(me.withStatus('leaving'));
    }
    const leaveMsg: LeaveMsg = { t: 'leave', node: this.selfAddress.toJSON() };
    for (const m of this.reachableMembers()) {
      if (!m.address.equals(this.selfAddress)) this.transport.send(m.address, leaveMsg);
    }
    this.gossipTimer?.cancel();
    this.heartbeatTimer?.cancel();
    this.fdTimer?.cancel();
    this.seedTimer?.cancel();
    this.weaklyUpTimer?.cancel();
    await this.transport.shutdown();
  }

  /* ================================ Internal ================================ */

  private async _start(seeds: string[]): Promise<void> {
    this.transport.setHandler((from, msg) => this.handleWire(from, msg));
    await this.transport.start();
    this.started = true;

    // Self is "joining" initially; transitions to "up" once at least one
    // peer has acknowledged us (or we are the seed).
    const me = new Member(this.selfAddress, 'joining', 1, this.selfRoles);
    this.members.set(me.address.toString(), me);
    this.emit(new MemberJoined(me));

    for (const s of seeds) {
      const a = NodeAddress.parse(s.includes('@') ? s : `${this.system.name}@${s}`);
      if (!a.equals(this.selfAddress)) this.seedAddrs.push(a);
    }

    if (this.seedAddrs.length === 0) {
      // No seeds — we are the first node. Become Up immediately.
      this.updateMember(me.withStatus('up'));
    } else {
      this.contactSeeds();
      // Keep retrying seed contact until self has transitioned to up,
      // covering the case where a seed hasn't started yet.
      this.seedTimer = this.system.scheduler.scheduleAtFixedRateFn(
        this.seedRetryIntervalMs, this.seedRetryIntervalMs, () => {
          const self = this.members.get(this.selfAddress.toString());
          if (!self || self.status !== 'joining') { this.seedTimer?.cancel(); this.seedTimer = null; return; }
          this.contactSeeds();
        },
      );
    }

    // Schedule automatic joining→weakly-up promotion if configured.
    if (this.weaklyUpAfterMs > 0) {
      this.weaklyUpTimer = this.system.scheduler.scheduleOnceFn(
        this.weaklyUpAfterMs, () => {
          const me = this.members.get(this.selfAddress.toString());
          if (me?.status === 'joining') {
            this.updateMember(me.withStatus('weakly-up'));
          }
          this.weaklyUpTimer = null;
        },
      );
    }

    this.gossipTimer = this.system.scheduler.scheduleAtFixedRateFn(
      this.gossipIntervalMs, this.gossipIntervalMs, () => this.gossipTick(),
    );
    this.heartbeatTimer = this.system.scheduler.scheduleAtFixedRateFn(
      this.failureDetector.interval, this.failureDetector.interval, () => this.heartbeatTick(),
    );
    this.fdTimer = this.system.scheduler.scheduleAtFixedRateFn(
      this.failureDetector.interval, this.failureDetector.interval, () => this.failureDetectionTick(),
    );
  }

  private contactSeeds(): void {
    const me = this.members.get(this.selfAddress.toString());
    if (!me) return;
    for (const seed of this.seedAddrs) {
      this.failureDetector.register(seed);
      const initialGossip: GossipMsg = {
        t: 'gossip',
        from: this.selfAddress.toJSON(),
        members: [me.toData()],
      };
      this.transport.send(seed, initialGossip);
    }
  }

  private handleWire(from: NodeAddress, msg: WireMessage): void {
    this.failureDetector.heartbeat(from);

    match(msg)
      .with({ t: 'heartbeat' }, (m) => this.handleHeartbeat(from, m))
      .with({ t: 'heartbeat-ack' }, () => { /* already bumped fd */ })
      .with({ t: 'gossip' }, (m) => this.handleGossip(m))
      .with({ t: 'envelope' }, (m) => this.handleEnvelope(from, m))
      .with({ t: 'leave' }, (m) => this.handleLeave(m))
      .otherwise(() => {
        // 'shard-map' and any custom extension wire-msgs handled by the
        // registry; we intentionally fall through when no handler is set.
        const custom = this.wireHandlers.get(msg.t);
        if (custom) custom(msg, from);
      });
  }

  private handleHeartbeat(_from: NodeAddress, msg: HeartbeatMsg): void {
    const peer = NodeAddress.fromJSON(msg.from);
    this.failureDetector.heartbeat(peer);
    // Reply isn't strictly needed because send() also bumps the detector,
    // but it keeps symmetric latency information.
    this.transport.send(peer, { t: 'heartbeat-ack', from: this.selfAddress.toJSON(), seq: msg.seq });

    // If the peer was unreachable and we see traffic again, flip it back.
    const existing = this.members.get(peer.toString());
    if (existing && existing.status === 'unreachable') {
      this.updateMember(existing.withStatus('up'));
      this.emit(new MemberReachable(this.members.get(peer.toString())!));
    }
  }

  private handleGossip(msg: GossipMsg): void {
    const sender = NodeAddress.fromJSON(msg.from);
    this.failureDetector.heartbeat(sender);

    for (const data of msg.members) {
      this.mergeMember(data);
    }

    // Ensure we know about the sender itself.
    if (!this.members.has(sender.toString())) {
      const m = new Member(sender, 'joining', 1);
      this.members.set(sender.toString(), m);
      this.emit(new MemberJoined(m));
    }

    // Leader promotes joining (and weakly-up) members to up.
    if (this.isLeader()) {
      for (const m of this.members.values()) {
        if (m.status === 'joining' || m.status === 'weakly-up') {
          this.updateMember(m.withStatus('up'));
        }
      }
    }
  }

  private handleEnvelope(from: NodeAddress, msg: EnvelopeMsg): void {
    // Re-install the originating MDC for the duration of dispatch
    // (#53).  Local refs the dispatcher subsequently `tell`s capture
    // this same context onto the next envelope, so the trail keeps
    // flowing across hops.  Empty / missing contexts skip the wrapper
    // — nothing to install, nothing to clean up.
    const dispatch = (): void => this.dispatchEnvelope(from, msg);
    if (msg.context && Object.keys(msg.context).length > 0) {
      LogContext.run(msg.context, dispatch);
    } else {
      dispatch();
    }
  }

  private dispatchEnvelope(from: NodeAddress, msg: EnvelopeMsg): void {
    // Rehydrate any ActorRef markers embedded in the user payload before
    // handing it off — downstream handlers (sharding, pubsub, …) just
    // forward `env.body` and shouldn't each duplicate the decode step.
    const decoded: EnvelopeMsg = { ...msg, body: decodeRefs(msg.body, this) };

    // 1. Explicit per-path handler (pub-sub mediator, singleton manager,
    //    sharding coordinator, …).
    const perPath = this._envelopeHandlersByPath.get(msg.to);
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
      this.log.warn(`no envelope handler registered, dropping message to ${msg.to}`);
    }
  }

  private handleLeave(msg: LeaveMsg): void {
    const peer = NodeAddress.fromJSON(msg.node);
    const existing = this.members.get(peer.toString());
    if (!existing) return;
    const leaving = existing.withStatus('leaving');
    const removed = leaving.withStatus('removed');
    this.members.delete(peer.toString());
    this.failureDetector.forget(peer);
    this.emit(new MemberLeft(leaving));
    this.emit(new MemberRemoved(removed));
    this.maybeEmitLeaderChange();
  }

  private gossipTick(): void {
    const targets = this.reachableMembers().filter(m => !m.address.equals(this.selfAddress));
    if (targets.length === 0) return;
    // Push to one random reachable peer each tick — epidemic style.
    const target = targets[Math.floor(Math.random() * targets.length)]!;
    const gossip: GossipMsg = {
      t: 'gossip',
      from: this.selfAddress.toJSON(),
      members: Array.from(this.members.values()).map(m => m.toData()),
    };
    this.transport.send(target.address, gossip);
  }

  private heartbeatTick(): void {
    this.heartbeatSeq++;
    const hb: HeartbeatMsg = {
      t: 'heartbeat',
      from: this.selfAddress.toJSON(),
      seq: this.heartbeatSeq,
      ts: Date.now(),
    };
    for (const m of this.reachableMembers()) {
      if (m.address.equals(this.selfAddress)) continue;
      this.transport.send(m.address, hb);
    }
  }

  private failureDetectionTick(): void {
    for (const m of Array.from(this.members.values())) {
      if (m.address.equals(this.selfAddress)) continue;
      const decision = this.failureDetector.decide(m.address);
      if (decision === 'unreachable' && m.status === 'up') {
        this.updateMember(m.withStatus('unreachable'));
        this.emit(new MemberUnreachable(this.members.get(m.address.toString())!));
      } else if (decision === 'down' && m.status !== 'down' && m.status !== 'removed') {
        const downed = m.withStatus('down');
        this.updateMember(downed);
        this.emit(new MemberDown(downed));
        // After declaring down, remove it so it no longer appears in sets.
        this.members.delete(m.address.toString());
        this.failureDetector.forget(m.address);
        const removed = downed.withStatus('removed');
        this.emit(new MemberRemoved(removed));
      }
    }
    // Optional split-brain resolver — runs after the failure-detector
    // pass so it sees the latest unreachable set.
    if (this.downing) this.evaluateDowning();
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
        .filter((m) => m.status === 'unreachable')
        .map((m) => m.address.toString()),
    );
    // Cheap fingerprint — re-evaluate only when membership or
    // reachability shifts.  The fingerprint includes statuses so a
    // change like "leaving → unreachable" also triggers a re-check.
    const fingerprint = allMembers
      .map((m) => `${m.address.toString()}:${m.status}`)
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
      const m = this.members.get(key);
      if (!m) continue;
      if (m.status === 'down' || m.status === 'removed') continue;
      const downed = m.withStatus('down');
      this.updateMember(downed);
      this.emit(new MemberDown(downed));
      this.members.delete(key);
      this.failureDetector.forget(m.address);
      this.emit(new MemberRemoved(downed.withStatus('removed')));
    }
    if (downsSelf) {
      void this.leave().catch((e) =>
        this.log.warn(`self-leave after downing decision failed`, e));
    }
  }

  private mergeMember(data: MemberData): void {
    const incoming = Member.fromData(data);
    const existing = this.members.get(incoming.address.toString());
    if (!existing) {
      this.members.set(incoming.address.toString(), incoming);
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
    if (incoming.version <= existing.version) return; // older or equal, ignore
    this.members.set(incoming.address.toString(), incoming);
    this.emitStatusTransition(existing, incoming);
  }

  private updateMember(next: Member): void {
    const key = next.address.toString();
    const prev = this.members.get(key);
    this.members.set(key, next);
    if (prev) this.emitStatusTransition(prev, next);
    else this.emit(new MemberJoined(next));
  }

  private emitStatusTransition(prev: Member, next: Member): void {
    if (prev.status === next.status) return;
    match(next.status)
      .with('up', () => {
        this.emit(new MemberUp(next));
        if (next.address.equals(this.selfAddress)) this.emit(new SelfUp(next));
      })
      .with('weakly-up', () => this.emit(new MemberWeaklyUp(next)))
      .with('unreachable', () => this.emit(new MemberUnreachable(next)))
      .with('down', () => this.emit(new MemberDown(next)))
      .with('leaving', () => this.emit(new MemberLeft(next)))
      .with('removed', () => {
        this.emit(new MemberRemoved(next));
        if (next.address.equals(this.selfAddress)) this.emit(new SelfRemoved(next));
      })
      .with('joining', () => { /* transient; no event */ })
      .exhaustive();
    this.maybeEmitLeaderChange();
  }

  private maybeEmitLeaderChange(): void {
    const newLeader = this.leader();
    const prev = this.currentLeader;
    const changed = prev.isSome() !== newLeader.isSome()
      || (prev.isSome() && newLeader.isSome() && !prev.value.address.equals(newLeader.value.address));
    if (changed) {
      this.currentLeader = newLeader;
      this.emit(new LeaderChanged(newLeader));
    }
  }

  private emit(event: ClusterEvent): void {
    this.system.eventStream.publish(event as object);
    for (const l of this._listeners) {
      try { l(event); } catch (e) { this.log.warn('listener threw', e); }
    }
  }
}

/** Helper — creates an InMemoryTransport for tests. */
export function inMemoryTransport(system: ActorSystem, host: string, port: number): Transport {
  return new InMemoryTransport(new NodeAddress(system.name, host, port));
}
