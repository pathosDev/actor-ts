import { match, P } from 'ts-pattern';
import { Actor } from '../Actor.js';
import type { ActorRef } from '../ActorRef.js';
import type { Cluster } from '../cluster/Cluster.js';
import { DistributedPubSubId } from '../cluster/pubsub/index.js';
import {
  Publish, Subscribe, type SubscribeAck,
} from '../cluster/pubsub/Messages.js';
import type { ReplicaId } from '../crdt/Crdt.js';
import type { Journal } from './Journal.js';
import type { PersistentEvent } from './JournalTypes.js';
import { PersistenceExtensionId } from './PersistenceExtension.js';
import {
  type ConflictResolver,
  LastWriterWinsResolver,
} from './replicated/ConflictResolver.js';
import { VectorClock, type VectorClockData } from './replicated/VectorClock.js';

/**
 * Replicated Event Sourcing — multiple nodes can write events for the
 * **same** persistenceId concurrently; vector clocks let every replica
 * recognise the divergent histories and a {@link ConflictResolver}
 * (default: last-writer-wins) decides how to merge them.
 *
 * **Mental model.**  The canonical history at each replica is the
 * union of every event ever persisted by any replica, sorted in a
 * deterministic order (by default: `(timestamp, replicaId,
 * sequenceAtReplica)` via `LastWriterWinsResolver`).  State is the
 * fold of `onEvent` over that ordered history.  Two replicas that
 * have received the same set of events compute the same state — that
 * is the convergence guarantee.
 *
 * **Cross-replica delivery** rides on `DistributedPubSub` — each
 * replica subscribes to a topic derived from its `persistenceId` and
 * publishes its own persisted events to that same topic.  PubSub
 * already gives at-least-once gossip-replicated fan-out; the actor
 * dedupes by `(replica, sequenceAtReplica)`, so re-delivery is
 * harmless.
 *
 * **Local journal**: each replica still appends every event it
 * **observes** to its local journal (its own + every remote it
 * receives).  This means on recovery, replaying the local journal
 * is sufficient to rebuild state — no cross-replica chatter at
 * startup.  Storage cost: events live N times across N replicas;
 * fine for the small-write/many-read workloads where Replicated ES
 * shines.
 *
 *   class ReplicatedCounter extends ReplicatedEventSourcedActor<
 *     Cmd, Event, { value: number }
 *   > {
 *     readonly persistenceId = 'counter-1';
 *     readonly replicaId: string;
 *     constructor(cluster: Cluster) {
 *       super(cluster);
 *       this.replicaId = cluster.selfAddress.toString();
 *     }
 *     initialState() { return { value: 0 }; }
 *     onEvent(s, e) { return { value: s.value + e.amount }; }
 *     onCommand(s, c) { this.persist({ amount: c.delta }); }
 *   }
 *
 * **Out of scope (for v1):**
 *   - Cross-DC replication (PubSub gossip is intra-cluster only).
 *   - Vector-clock garbage collection.  VC entries grow with replicas
 *     ever seen — fine for a stable cluster, but a node-churn-heavy
 *     deployment will eventually want compaction.
 *   - Snapshotting (the local journal is replayed in full on every
 *     restart).
 */

/**
 * Wire envelope for a single replicated event.  Persisted to the
 * journal and broadcast over PubSub.  `seqAtReplica` is monotonic
 * within a replica — the (replica, seqAtReplica) pair uniquely
 * identifies an event across the whole cluster, which is what we
 * dedupe on.
 */
export interface ReplicatedEventEnvelope<E> {
  readonly persistenceId: string;
  readonly replica: ReplicaId;
  readonly seqAtReplica: number;
  readonly vc: VectorClockData;
  readonly timestamp: number;
  readonly event: E;
}

const REPLICATED_TAG = 'replicated-es';

function topicFor(persistenceId: string): string {
  return `replicated-es:${persistenceId}`;
}

export abstract class ReplicatedEventSourcedActor<Cmd, Event, State>
  extends Actor<Cmd | ReplicatedEventEnvelope<Event>> {
  abstract readonly persistenceId: string;
  /** Stable id for this replica.  Default: cluster.selfAddress.toString(). */
  abstract readonly replicaId: ReplicaId;

  abstract initialState(): State;
  abstract onEvent(state: State, event: Event): State;
  abstract onCommand(state: State, cmd: Cmd): void | Promise<void>;

  /** Resolver consulted only as the deterministic order comparator. */
  protected resolver(): ConflictResolver<Event> { return new LastWriterWinsResolver<Event>(); }

  /**
   * How often the underlying DistributedPubSub mediator gossips its
   * subscription set.  Default 250 ms — tight enough that fresh
   * actors reach a steady-state cross-replica delivery within a
   * second, slow enough not to flood small clusters.  Override in
   * tests for snappier convergence.
   */
  protected pubsubGossipIntervalMs(): number { return 250; }

  /** Recovery hook — called after the local journal has been replayed. */
  onRecoveryComplete(_state: State): void | Promise<void> {}

  /* ------------------------------ internals ----------------------------- */

  private _state!: State;
  private _vc = VectorClock.empty();
  /** Strict order: every observed event, deduped, sorted via resolver. */
  private readonly _events: Array<ReplicatedEventEnvelope<Event>> = [];
  private readonly _seenIds = new Set<string>();

  private _journal!: Journal;
  private _mediator: ActorRef<Subscribe | Publish | unknown> | null = null;
  private _localSeq = 0;

  constructor(public readonly cluster: Cluster) { super(); }

  /** Current state — updated after every event apply. */
  protected get state(): State { return this._state; }

  override async preStart(): Promise<void> {
    this._state = this.initialState();
    this._journal = this.system.extension(PersistenceExtensionId).journal;

    // Replay local journal — every event we've ever observed is here.
    const stored = await this._journal.read<ReplicatedEventEnvelope<Event>>(this.persistenceId, 1);
    for (const ev of stored) {
      this._absorb(ev.event, /* persistLocally= */ false, /* broadcast= */ false);
    }

    // Subscribe to the cross-replica topic.  The Subscribe message
    // is delivered to the mediator via tell(); the actor mailbox is
    // ours, so when remote events arrive they land in onReceive.
    //
    // We pass `gossipIntervalMs: this.pubsubGossipIntervalMs()` —
    // default 250 ms — so subscription state propagates fast enough
    // that the first user-issued persist a few hundred ms after
    // construction reaches peer replicas.  Tests can dial this
    // tighter; production should leave the default.
    const pubsub = this.system.extension(DistributedPubSubId).start(
      this.cluster, { gossipIntervalMs: this.pubsubGossipIntervalMs() },
    );
    this._mediator = pubsub as unknown as ActorRef<Subscribe | Publish | unknown>;
    pubsub.tell(new Subscribe(topicFor(this.persistenceId), this.self));

    await this.onRecoveryComplete(this._state);
  }

  override async onReceive(msg: Cmd | ReplicatedEventEnvelope<Event> | SubscribeAck): Promise<void> {
    // Ignore PubSub ack frames — they're informational.
    if (msg && typeof msg === 'object' && (msg as { subscribe?: unknown }).subscribe instanceof Subscribe) {
      return;
    }
    if (this._isEnvelope(msg)) {
      this._handleRemote(msg as ReplicatedEventEnvelope<Event>);
      return;
    }
    await this.onCommand(this._state, msg as Cmd);
  }

  /**
   * Persist a fresh local event.  Increments this replica's VC
   * component, appends to the journal tagged `replicated-es`, applies
   * to local state, and broadcasts to peer replicas.
   */
  protected async persist(event: Event, cb?: (state: State) => void): Promise<void> {
    this._localSeq += 1;
    this._vc = this._vc.tick(this.replicaId);
    const envelope: ReplicatedEventEnvelope<Event> = {
      persistenceId: this.persistenceId,
      replica: this.replicaId,
      seqAtReplica: this._localSeq,
      vc: this._vc.toJSON(),
      timestamp: Date.now(),
      event,
    };
    await this._appendOne(envelope);
    this._absorb(envelope, /* persistLocally= */ false, /* broadcast= */ true);
    cb?.(this._state);
  }

  /**
   * Append exactly one envelope to the local journal.  We read the
   * current highestSeq inside the same actor mailbox tick so the
   * `expectedSeq` argument is always accurate — the actor is the
   * single writer to its own persistenceId, so no other coroutine
   * can interleave between the read and the append.
   */
  private async _appendOne(envelope: ReplicatedEventEnvelope<Event>): Promise<void> {
    const head = await this._journal.highestSeq(this.persistenceId);
    await this._journal.append(this.persistenceId, [envelope], head, [REPLICATED_TAG]);
  }

  /* ----------------------------- absorb event --------------------------- */

  private _handleRemote(envelope: ReplicatedEventEnvelope<Event>): void {
    if (envelope.persistenceId !== this.persistenceId) return; // not for us
    if (envelope.replica === this.replicaId) return; // our own broadcast — ignore
    void this._absorb(envelope, /* persistLocally= */ true, /* broadcast= */ false);
  }

  /**
   * Insert an envelope into the canonical event list, dedupe by
   * (replica, seqAtReplica), refold state from the divergence point.
   *
   * `persistLocally` controls whether we also append the event to
   * our local journal (true for events received from peers; false
   * for replays + own broadcasts since those are already on disk).
   *
   * `broadcast` controls whether we publish the event to PubSub
   * (true only for fresh local persists).
   */
  private _absorb(
    envelope: ReplicatedEventEnvelope<Event>,
    persistLocally: boolean,
    broadcast: boolean,
  ): void {
    const id = `${envelope.replica}#${envelope.seqAtReplica}`;
    if (this._seenIds.has(id)) return;
    this._seenIds.add(id);

    // Fast path: envelope sorts after every existing event → just append.
    const last = this._events[this._events.length - 1];
    const insertIndex = last && this._compare(envelope, last) > 0
      ? this._events.length
      : this._findInsertIndex(envelope);
    this._events.splice(insertIndex, 0, envelope);

    if (insertIndex === this._events.length - 1) {
      // Append-only — apply just this event to current state.
      this._state = this.onEvent(this._state, envelope.event);
    } else {
      // Out-of-order arrival — refold from initial state to keep
      // the canonical sort intact.  Cheap as long as N stays small;
      // gossip usually delivers in order so this is rare.
      this._state = this.initialState();
      for (const e of this._events) this._state = this.onEvent(this._state, e.event);
    }

    this._vc = this._vc.merge(VectorClock.fromData(envelope.vc));

    if (persistLocally) {
      // Append remote events to OUR local journal so a recovery from
      // disk replays the full causal history.  Single-writer (us) per
      // pid means we can read highestSeq + append in one mailbox
      // tick without races.
      void this._appendOne(envelope).catch((err) => {
        this.log.warn(`replicated-es: failed to persist remote event from ${envelope.replica}#${envelope.seqAtReplica}`, err);
      });
    }

    if (broadcast && this._mediator) {
      this._mediator.tell(new Publish<ReplicatedEventEnvelope<Event>>(
        topicFor(this.persistenceId), envelope,
      ) as unknown as never);
    }
  }

  private _findInsertIndex(envelope: ReplicatedEventEnvelope<Event>): number {
    // Linear scan — for small histories this is cheaper than a
    // binary search's branch overhead.  Swap for binary if profiling
    // says so.
    for (let i = 0; i < this._events.length; i++) {
      if (this._compare(envelope, this._events[i]!) < 0) return i;
    }
    return this._events.length;
  }

  private _compare(
    a: ReplicatedEventEnvelope<Event>, b: ReplicatedEventEnvelope<Event>,
  ): number {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    if (a.replica !== b.replica) return a.replica < b.replica ? -1 : 1;
    return a.seqAtReplica - b.seqAtReplica;
  }

  private _isEnvelope(x: unknown): x is ReplicatedEventEnvelope<Event> {
    return !!x && typeof x === 'object'
      && (x as ReplicatedEventEnvelope<Event>).persistenceId === this.persistenceId
      && typeof (x as ReplicatedEventEnvelope<Event>).seqAtReplica === 'number';
  }
}

export { LastWriterWinsResolver, CustomMergeResolver } from './replicated/ConflictResolver.js';
export type { ConflictResolver, ConflictCandidate } from './replicated/ConflictResolver.js';
export { VectorClock };
export type { VectorClockData };
