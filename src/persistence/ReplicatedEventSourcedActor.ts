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
import type { SnapshotPolicy } from './PersistentActor.js';
import {
  type ConflictResolver,
  LastWriterWinsResolver,
} from './replicated/ConflictResolver.js';
import type { ReplicatedSnapshot } from './replicated/ReplicatedSnapshot.js';
import type { SnapshotStore } from './SnapshotStore.js';
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

  /**
   * Snapshot policy — return true after applying an event to take a
   * snapshot of current state.  Default: never snapshot, full journal
   * is replayed on every restart.
   *
   * The `seqNr` argument is the running TOTAL count of events the
   * actor has observed (own + remote), not just locally-issued ones —
   * "snapshot every 100 events from any source" is the natural unit.
   * Re-uses the shared `SnapshotPolicy` helper from `PersistentActor`,
   * so `everyNEvents(N)` works the same way it does for classic
   * event-sourced actors.
   */
  protected snapshotPolicy(): SnapshotPolicy<State, Event> { return () => false; }

  /** Recovery hook — called after the local journal has been replayed. */
  onRecoveryComplete(_state: State): void | Promise<void> {}

  /* ------------------------------ internals ----------------------------- */

  private _state!: State;
  private _vc = VectorClock.empty();
  /** Strict order: every observed event, deduped, sorted via resolver. */
  private _events: Array<ReplicatedEventEnvelope<Event>> = [];
  private _seenIds = new Set<string>();

  private _journal!: Journal;
  private _snapshotStore!: SnapshotStore;
  private _mediator: ActorRef<Subscribe | Publish | unknown> | null = null;
  private _localSeq = 0;
  /** Journal seq up to which we've absorbed events.  Updated on each
   *  successful `_appendOne`; persisted as part of the snapshot so
   *  recovery only re-reads the post-snapshot delta. */
  private _journalSeq = 0;
  /** Total observed events count — snapshot policy operates on this. */
  private _observedCount = 0;
  /** Guard so concurrent absorbs don't issue overlapping snapshot saves. */
  private _snapshotInFlight = false;

  constructor(public readonly cluster: Cluster) { super(); }

  /** Current state — updated after every event apply. */
  protected get state(): State { return this._state; }

  override async preStart(): Promise<void> {
    this._state = this.initialState();
    const ext = this.system.extension(PersistenceExtensionId);
    this._journal = ext.journal;
    this._snapshotStore = ext.snapshotStore;

    // 1. Try to load a snapshot.  If present, seed every in-memory
    //    field from it so we don't have to re-fold the journal
    //    history that produced it.
    let journalReplayFrom = 1;
    const snapshotOpt = await this._snapshotStore
      .loadLatest<ReplicatedSnapshot<Event, State>>(this.persistenceId);
    if (snapshotOpt.isSome()) {
      const snap = snapshotOpt.value.state;
      this._state = snap.state;
      this._vc = VectorClock.fromData(snap.vc);
      this._seenIds = new Set(snap.seenIds);
      this._events = [...snap.events];
      this._localSeq = snap.localSeq;
      this._journalSeq = snap.journalSeqAtSnapshot;
      this._observedCount = snap.events.length;
      journalReplayFrom = snap.journalSeqAtSnapshot + 1;
    }

    // 2. Read post-snapshot journal delta and absorb anything not
    //    already accounted for by `_seenIds`.  Without a snapshot
    //    `journalReplayFrom = 1` and this is the same full-replay
    //    path as before.
    const delta = await this._journal.read<ReplicatedEventEnvelope<Event>>(
      this.persistenceId, journalReplayFrom,
    );
    for (const pe of delta) {
      // Track the journal seq cursor so a snapshot taken later
      // records the right `journalSeqAtSnapshot`.
      if (pe.sequenceNr > this._journalSeq) this._journalSeq = pe.sequenceNr;
      this._absorb(pe.event, /* persistLocally= */ false, /* broadcast= */ false);
    }

    // 3. Subscribe to the cross-replica topic.  The Subscribe message
    //    is delivered to the mediator via tell(); the actor mailbox is
    //    ours, so when remote events arrive they land in onReceive.
    //
    //    We pass `gossipIntervalMs: this.pubsubGossipIntervalMs()` —
    //    default 250 ms — so subscription state propagates fast enough
    //    that the first user-issued persist a few hundred ms after
    //    construction reaches peer replicas.  Tests can dial this
    //    tighter; production should leave the default.
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
   *
   * Updates `_journalSeq` so the next snapshot records the
   * just-appended journal position.
   */
  private async _appendOne(envelope: ReplicatedEventEnvelope<Event>): Promise<void> {
    const head = await this._journal.highestSeq(this.persistenceId);
    const written = await this._journal.append(
      this.persistenceId, [envelope], head, [REPLICATED_TAG],
    );
    const lastWrittenSeq = written[written.length - 1]?.sequenceNr ?? head + 1;
    if (lastWrittenSeq > this._journalSeq) this._journalSeq = lastWrittenSeq;
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
    this._observedCount += 1;

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

    // Snapshot policy check — fire AFTER state has been updated and
    // VC merged so the snapshot we save is fully consistent.
    const policy = this.snapshotPolicy();
    if (policy(this._observedCount, this._state, envelope.event)) {
      this._maybeSaveSnapshot();
    }
  }

  /* ----------------------------- snapshotting --------------------------- */

  /**
   * Force a snapshot of the current state.  Useful for tests + manual
   * compaction.  Returns the saved snapshot or `null` if a save was
   * already in flight.
   */
  protected async saveSnapshot(): Promise<void> {
    return this._saveSnapshotNow();
  }

  /**
   * Triggered by the policy check in `_absorb`.  Fire-and-forget so
   * the actor's mailbox doesn't block on disk I/O; the in-flight
   * guard prevents overlapping saves.  Recovery is correct even if a
   * mid-save crash drops the snapshot — we just fall back to the
   * previous snapshot or full replay.
   */
  private _maybeSaveSnapshot(): void {
    if (this._snapshotInFlight) return;
    this._snapshotInFlight = true;
    void this._saveSnapshotNow().finally(() => {
      this._snapshotInFlight = false;
    });
  }

  private async _saveSnapshotNow(): Promise<void> {
    const snapshot: ReplicatedSnapshot<Event, State> = {
      state: this._state,
      vc: this._vc.toJSON(),
      seenIds: Array.from(this._seenIds),
      events: [...this._events],
      localSeq: this._localSeq,
      journalSeqAtSnapshot: this._journalSeq,
      takenBy: this.replicaId,
      takenAt: Date.now(),
    };
    try {
      await this._snapshotStore.save<ReplicatedSnapshot<Event, State>>(
        this.persistenceId, this._journalSeq, snapshot,
      );
    } catch (err) {
      this.log.warn(`replicated-es: snapshot save failed`, err);
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
