import { match, P } from 'ts-pattern';
import { Actor } from '../Actor.js';
import type { ActorRef } from '../ActorRef.js';
import type { ActorSystem } from '../ActorSystem.js';
import { DistributedPubSubId, DistributedPubSubOptions } from '../cluster/pubsub/index.js';
import type { Lease } from '../coordination/Lease.js';
import {
  Publish, Subscribe, type SubscribeAcknowledgment,
} from '../cluster/pubsub/Messages.js';
import type { ReplicaId } from '../crdt/Crdt.js';
import { randomId } from '../util/RandomString.js';
import {
  DEFAULT_MAX_REPLICATED_OBSERVED_EVENTS,
  MAX_REPLICA_ID_LENGTH,
  MAX_REPLICATED_EVENT_ID_LENGTH,
  MAX_VECTOR_CLOCK_ENTRIES,
  REPLICATED_EVENT_ID_ENTROPY_CHARACTERS,
} from './Constants.js';
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
import { assertValidPersistenceId } from './storage/PersistenceIdValidator.js';
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
 * dedupes on the envelope's `eventId`, so re-delivery is harmless.
 *
 * **The remote path is untrusted.**  Anything that can complete the
 * cluster handshake can address this actor — through the pub-sub
 * mediator or straight at its path — so an arriving envelope is
 * validated whole before any state is touched and dropped with a
 * `WARN` if it fails, never absorbed halfway (#706).  What that does
 * *not* yet establish is authorship: nothing binds an envelope's
 * `replica` to the node that sent it, so a member can still author an
 * event attributed to a peer.  See {@link ReplicatedEventEnvelope}.
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
 *     Command, Event, { value: number }
 *   > {
 *     readonly persistenceId = 'counter-1';
 *     // `replicaId` defaults to this node's address; no constructor needed.
 *     initialState() { return { value: 0 }; }
 *     onEvent(s, e) { return { value: s.value + e.amount }; }
 *     onCommand(s, c) { this.persist({ amount: c.delta }); }
 *   }
 *
 * **Out of scope (for v1):**
 *   - Cross-DC replication (PubSub gossip is intra-cluster only).
 *   - Vector-clock garbage collection, and compaction of the event
 *     history.  Both grow monotonically — VC entries with replicas
 *     ever seen, the history with events observed — which is fine for
 *     a stable cluster and eventually wants #535.  Until then
 *     {@link ReplicatedEventSourcedActor.maxObservedEvents} bounds
 *     what a peer can make the history grow to.
 *   - Authorship: an envelope's `replica` is not bound to the node
 *     that sent it.
 */

/**
 * Wire envelope for a single replicated event.  Persisted to the
 * journal and broadcast over PubSub.
 *
 * `eventId` identifies the event across the whole cluster and is what
 * deduplication keys on.  It is minted from crypto-grade entropy at
 * `persist` time and never re-derived, because the value has to be
 * both **unguessable** and **stable across a re-delivery of the same
 * event**:
 *
 *   - Unguessable, because a hit in the deduplication set means
 *     *silently discard*.  The key used to be
 *     `${replica}#${seqAtReplica}` off a plain counter that travelled
 *     in this very payload, so a peer could compute a victim's future
 *     keys by arithmetic and pre-claim them — after which the victim's
 *     genuine events were dropped by every peer, permanently, since the
 *     forgery is journaled and the set is snapshotted (#706).
 *   - Stable, because pub-sub fan-out is at-least-once.  A key derived
 *     at the *receiver* (arrival time, a local counter) would differ per
 *     delivery and double-apply the event.
 *
 * `seqAtReplica` stays on the envelope: it is monotonic within a
 * replica and is the last tie-break in the canonical order.  It is no
 * longer an identity, and nothing may treat it as one — see
 * {@link ReplicatedEventSourcedActor} on why a per-replica
 * "exactly one past the highest seen" rule is *not* wanted here.
 *
 * **Not authenticated.**  Every field is peer-supplied, and this type
 * carries no binding to the node that sent it.  A member can therefore
 * author an event attributed to another replica; what it can no longer
 * do is suppress that replica's real events.
 */
export type ReplicatedEventEnvelope<E> = {
  readonly persistenceId: string;
  readonly replica: ReplicaId;
  readonly seqAtReplica: number;
  readonly eventId: string;
  readonly vc: VectorClockData;
  readonly timestamp: number;
  readonly event: E;
};

const REPLICATED_TAG = 'replicated-es';

function topicFor(persistenceId: string): string {
  return `replicated-es:${persistenceId}`;
}

/**
 * Why a peer-supplied vector clock is unacceptable, or `null`.
 *
 * Separate from the envelope check because it is the one field whose
 * *contents* matter rather than its type: `VectorClock.fromData` is
 * `new Map(Object.entries(data))`, so `undefined` throws a `TypeError`
 * and a non-numeric value silently poisons a component that is merged
 * into local state and re-broadcast from then on.
 *
 * A rejection reason rather than a boolean, so the `WARN` names the
 * offending field the way the cluster's own frame validation does —
 * a version mismatch and a hostile peer must not look alike in a log.
 */
function vectorClockRejection(vc: unknown): string | null {
  if (vc === null || typeof vc !== 'object' || Array.isArray(vc)) {
    return 'vc must be a plain object';
  }
  const entries = Object.entries(vc as Record<string, unknown>);
  if (entries.length > MAX_VECTOR_CLOCK_ENTRIES) {
    return `vc carries ${entries.length} entries, at most ${MAX_VECTOR_CLOCK_ENTRIES} are accepted`;
  }
  for (const [replica, version] of entries) {
    if (replica.length === 0 || replica.length > MAX_REPLICA_ID_LENGTH) {
      return `a vc key is empty or longer than ${MAX_REPLICA_ID_LENGTH} characters`;
    }
    if (typeof version !== 'number' || !Number.isFinite(version) || version < 0) {
      return `vc entry '${replica}' must be a finite non-negative number`;
    }
  }
  return null;
}

/**
 * Per-system live-pid registry (#58).  `ReplicatedEventSourcedActor`
 * relies on being the **single writer** for its `persistenceId` on
 * the local node — `_appendOne` reads `highestSeq` and `append` in
 * one mailbox tick under that assumption.  Two actors with the same
 * pid on the same node violate it: their journal appends race, the
 * second silently drops with `JournalConcurrencyError`, in-memory
 * state diverges between the two instances.
 *
 * The registry catches this at preStart: the second actor sees the
 * pid already taken and throws.  `WeakMap`-keyed by `ActorSystem`
 * so tests with disposable systems don't leak registrations.  The
 * inner `Set` is mutated as actors register / unregister.
 */
const livePersistenceIdsBySystem = new WeakMap<ActorSystem, Set<string>>();

function getLivePersistenceIdsForSystem(system: ActorSystem): Set<string> {
  let set = livePersistenceIdsBySystem.get(system);
  if (!set) { set = new Set(); livePersistenceIdsBySystem.set(system, set); }
  return set;
}

export abstract class ReplicatedEventSourcedActor<Command, Event, State>
  extends Actor<Command | ReplicatedEventEnvelope<Event>> {
  abstract readonly persistenceId: string;

  /**
   * Stable id for this replica — the prefix of every event id this
   * replica mints, its vector-clock component, and a tie-breaker in the
   * deterministic event order.
   *
   * Defaults to this node's cluster address, which is what every replica
   * wanted anyway.  Override only when the id must survive a re-address
   * — a fixed datacenter or region name, say — because two replicas that
   * ever share an id share a vector-clock component:
   *
   *     override get replicaId(): ReplicaId { return 'eu-west'; }
   *
   * That override is also why an arriving envelope's `replica` cannot
   * simply be compared against the authenticated sending node: in a
   * deployment like the one above they legitimately differ, so the check
   * would reject every honest envelope.  Closing authorship needs a
   * replica-to-node mapping that does not exist yet.
   *
   * A getter rather than a field, so the default can read the cluster:
   * the context is attached after construction.  Read from `preStart`
   * onwards.  Must be non-empty and at most
   * {@link MAX_REPLICA_ID_LENGTH} characters — `preStart` checks, so an
   * over-long id fails on the node that chose it rather than being
   * silently rejected by every peer.
   */
  get replicaId(): ReplicaId { return this.cluster.selfAddress.toString(); }

  abstract initialState(): State;
  abstract onEvent(state: State, event: Event): State;
  abstract onCommand(state: State, command: Command): void | Promise<void>;

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
   * Ceiling on the canonical event history, in events — how far a peer
   * may make this actor's history grow.  Default
   * {@link DEFAULT_MAX_REPLICATED_OBSERVED_EVENTS} (100 000).
   *
   * The history has no compaction yet (#535) and every remote envelope
   * also costs a journal write and a deduplication-set entry, so
   * without a bound one member can grow another's memory, disk and
   * refold cost without limit (#706).
   *
   * At the ceiling, remote envelopes are **refused, not evicted**, and
   * one `WARN` says so: dropping from the history would change the
   * fold, and dropping from the deduplication set would reopen
   * double-apply — a bounded leak traded for unbounded divergence.
   * Local `persist` is never refused; the application is not the
   * untrusted party, and losing a write the caller was told succeeded
   * is worse than an unbounded history.
   *
   * Lower it for an entity whose legitimate history is small — that is
   * the tightest honest bound and the cheapest one to reason about.
   */
  protected maxObservedEvents(): number { return DEFAULT_MAX_REPLICATED_OBSERVED_EVENTS; }

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

  /**
   * Optional lease (#89) — when this returns a non-null `Lease`, the
   * actor goes into single-writer mode: only the lease holder may
   * `persist`, observers passively apply replicated events from
   * peers.  Default `null` = multi-master semantics (every replica
   * can persist; vector clocks reconcile concurrent writes).
   *
   * Use cases the multi-master default doesn't fit:
   *
   *   - **Non-replayable side effects** — charging a credit card,
   *     emitting an external webhook, sending an email.  The
   *     framework can't dedupe these for you; restricting writes to
   *     a single replica ensures the side effect fires once.
   *   - **Heartbeat / external-rate actors** — N replicas pushing
   *     beats to a downstream multiplies the rate; the lease binds
   *     the active emitter to one replica at a time.
   *
   * Mechanics: `preStart` calls `lease.acquire()`.  On success the
   * actor is a holder and persist works normally; on failure it's an
   * observer (every `persist` call throws).  Lease loss flips the
   * actor to observer mode and invokes {@link onLeaseLost}; recovery
   * is restart-driven for this v1.
   */
  protected lease(): Lease | null { return null; }

  /**
   * Hook invoked when this replica unexpectedly loses its lease
   * (TTL expired, another holder took over, backend failure).  The
   * actor is already in observer mode by the time this fires — use
   * the hook to stop downstream side-effect processing, page an
   * operator, etc.  Default is a no-op.
   */
  protected onLeaseLost(_reason: string): void | Promise<void> {}

  /* ------------------------------ internals ----------------------------- */

  private _state!: State;
  private _vc = VectorClock.empty();
  /**
   * Strict order: every observed event, deduplicated, sorted by
   * `_compare`.  (Not by `resolver()` — that hook is not consulted on
   * this path.)
   */
  private _events: Array<ReplicatedEventEnvelope<Event>> = [];
  /** Every observed event's `eventId`.  A hit means "already applied". */
  private _seenIds = new Set<string>();
  /**
   * Whether the "history is full, remote events refused" `WARN` has
   * been emitted.  One line rather than one per refused envelope: a
   * peer chooses how many it sends, and a log this actor cannot bound
   * is the same denial of service in a different resource.
   */
  private _observedCapacityWarned = false;

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
  /** Optional lease this actor holds (or attempted to hold).  See `lease()`. */
  private _lease: Lease | null = null;
  /**
   * `true` when this replica may issue new `persist` calls.  Without a
   * lease configured the default is `true` (multi-master); with a
   * lease, this flips based on `acquire` outcome and `onLost` events.
   */
  private _isLeaseHolder = true;
  private _leaseUnsubscribeLost: (() => void) | null = null;

  /** Current state — updated after every event apply. */
  protected get state(): State { return this._state; }

  /**
   * Whether this replica currently holds the configured lease (#89).
   * Always `true` when no lease is configured (multi-master mode);
   * dynamic when a lease IS configured — flips to `false` on
   * `acquire` failure or `onLost` notification.  Use to gate
   * side-effect logic in `onCommand`.
   */
  protected get isLeaseHolder(): boolean { return this._isLeaseHolder; }

  override async preStart(): Promise<void> {
    // Ahead of the live-id registration below, so an id that can never be
    // a storage key does not first claim the single-writer slot and then
    // block a corrected restart from taking it.
    assertValidPersistenceId(this.persistenceId, 'ReplicatedEventSourcedActor');
    // Same bound peers enforce on an arriving envelope's `replica` (#706).
    // Checked here so an over-long id fails on the node that chose it, at
    // startup, rather than showing up as every peer silently dropping this
    // replica's events — a one-way divergence with nothing in this node's log.
    const replicaId = this.replicaId;
    if (typeof replicaId !== 'string' || replicaId.length === 0 || replicaId.length > MAX_REPLICA_ID_LENGTH) {
      throw new Error(
        `ReplicatedEventSourcedActor '${this.persistenceId}': replicaId must be a non-empty string of at most ` +
        `${MAX_REPLICA_ID_LENGTH} characters (got ${typeof replicaId === 'string' ? `${replicaId.length} characters` : typeof replicaId}). ` +
        `It prefixes every event id, keys the vector clock, and every peer validates it on arrival.`,
      );
    }
    // Single-writer-per-pid invariant (#58).  Two ReplicatedEventSourcedActors
    // with the same persistenceId on the same node race their
    // `_appendOne` calls; the second silently drops via
    // JournalConcurrencyError and in-memory state diverges.  Catch
    // it loudly at preStart.
    const livePersistenceIds = getLivePersistenceIdsForSystem(this.system);
    if (livePersistenceIds.has(this.persistenceId)) {
      throw new Error(
        `ReplicatedEventSourcedActor: another live actor on this node already holds persistenceId '${this.persistenceId}'. ` +
        `Each replicated actor must own a unique persistenceId per node — cross-replica multi-writer is the entire ` +
        `point of replication, but on a single node the journal append path assumes single-writer.`,
      );
    }
    livePersistenceIds.add(this.persistenceId);

    // Optional lease acquisition (#89).  We try once at preStart; on
    // success we register an `onLost` handler so a TTL expiry / fence
    // flips us to observer mode.  On failure we silently enter
    // observer mode — the user's `onCommand` either skips side-
    // effecting work via `isLeaseHolder` or hits the explicit throw
    // inside `persist`.
    this._lease = this.lease();
    if (this._lease) {
      const acquired = await this._lease.acquire();
      this._isLeaseHolder = acquired;
      if (acquired) {
        this._leaseUnsubscribeLost = this._lease.onLost((reason) => {
          this._isLeaseHolder = false;
          this.log.warn(
            `ReplicatedEventSourcedActor '${this.persistenceId}': lease lost — entering observer mode`,
            { reason },
          );
          try {
            const result = this.onLeaseLost(reason);
            if (result instanceof Promise) {
              result.catch((e) => this.log.warn('onLeaseLost threw', e));
            }
          } catch (e) {
            this.log.warn('onLeaseLost threw', e);
          }
        });
      } else {
        this.log.info(
          `ReplicatedEventSourcedActor '${this.persistenceId}': could not acquire lease — entering observer mode`,
        );
      }
    }

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
      this.cluster,
      DistributedPubSubOptions.create().withGossipIntervalMs(this.pubsubGossipIntervalMs()),
    );
    this._mediator = pubsub as unknown as ActorRef<Subscribe | Publish | unknown>;
    pubsub.tell(new Subscribe(topicFor(this.persistenceId), this.self));

    await this.onRecoveryComplete(this._state);
  }

  override postStop(): void {
    // Release the live-pid registration so a fresh actor with the
    // same persistenceId can take over (e.g. after a graceful stop
    // + re-spawn).  Must run on every termination path, including
    // restart-after-failure where preRestart calls postStop before
    // a new instance gets preStart.
    const livePersistenceIds = livePersistenceIdsBySystem.get(this.system);
    livePersistenceIds?.delete(this.persistenceId);

    // Release the lease if held (#89) — a clean exit lets a follower
    // acquire faster than waiting for the TTL to expire.  Fire-and-
    // forget; lease backends typically tolerate "owner gone" via TTL
    // anyway so a failure to release is not fatal.
    this._leaseUnsubscribeLost?.();
    this._leaseUnsubscribeLost = null;
    if (this._lease && this._isLeaseHolder) {
      void this._lease.release().catch(() => { /* best-effort */ });
    }
    this._lease = null;
  }

  override async onReceive(message: Command | ReplicatedEventEnvelope<Event> | SubscribeAcknowledgment): Promise<void> {
    // Ignore PubSub ack frames — they're informational.
    if (message && typeof message === 'object' && (message as { subscribe?: unknown }).subscribe instanceof Subscribe) {
      return;
    }
    if (this._isEnvelope(message)) {
      this._handleRemote(message as ReplicatedEventEnvelope<Event>);
      return;
    }
    await this.onCommand(this._state, message as Command);
  }

  /**
   * Persist a fresh local event.  Increments this replica's VC
   * component, appends to the journal tagged `replicated-es`, applies
   * to local state, and broadcasts to peer replicas.
   *
   * When a lease is configured (#89) and this replica is NOT the
   * holder, throws — the actor is in observer mode and writes must
   * route to the holder.  Users that don't want the throw can gate
   * on `isLeaseHolder` before calling `persist`.
   */
  protected async persist(event: Event, afterPersist?: (state: State) => void): Promise<void> {
    if (this._lease && !this._isLeaseHolder) {
      throw new Error(
        `ReplicatedEventSourcedActor '${this.persistenceId}': cannot persist — ` +
        `this replica is in observer mode (lease held by another replica or lost). ` +
        `Gate calls on \`this.isLeaseHolder\` to avoid this.`,
      );
    }
    this._localSeq += 1;
    this._vc = this._vc.tick(this.replicaId);
    const envelope: ReplicatedEventEnvelope<Event> = {
      persistenceId: this.persistenceId,
      replica: this.replicaId,
      seqAtReplica: this._localSeq,
      eventId: this._mintEventId(),
      vc: this._vc.toJSON(),
      timestamp: Date.now(),
      event,
    };
    await this._appendOne(envelope);
    this._absorb(envelope, /* persistLocally= */ false, /* broadcast= */ true);
    afterPersist?.(this._state);
  }

  /**
   * A fresh cluster-wide event id: this replica's id, a `#`, and
   * {@link REPLICATED_EVENT_ID_ENTROPY_CHARACTERS} hex characters.
   *
   * The prefix is for reading — a log line or a snapshot dump still
   * says who authored the event — and carries no authority: the
   * entropy is the whole of the guarantee, exactly as in `ORSet.add`
   * (#722).
   *
   * Drawn against the observed set.  96 bits make a repeat
   * near-impossible, but the consequence of one is the same silent
   * discard the entropy exists to prevent, and the set is already in
   * hand.
   */
  private _mintEventId(): string {
    const prefix = `${this.replicaId}#`;
    return prefix + randomId(
      REPLICATED_EVENT_ID_ENTROPY_CHARACTERS,
      (suffix) => this._seenIds.has(prefix + suffix),
    );
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
      this.persistenceId, [{ event: envelope, tags: [REPLICATED_TAG] }], head,
    );
    const lastWrittenSeq = written[written.length - 1]?.sequenceNr ?? head + 1;
    if (lastWrittenSeq > this._journalSeq) this._journalSeq = lastWrittenSeq;
  }

  /* ----------------------------- absorb event --------------------------- */

  /**
   * The untrusted entry point.  Everything an envelope claims arrives
   * here from a peer — through the pub-sub mediator, or straight at
   * this actor's path — so nothing it says is acted on before the whole
   * shape has been checked (#706).
   *
   * Reject, log, return; never throw.  A malformed envelope used to
   * take `_absorb` half-way through — deduplication key added, event
   * spliced in, state refolded — and *then* die inside
   * `VectorClock.fromData`, escaping into supervision from an actor
   * whose in-memory history no longer matched anything.  One frame did
   * that, repeatably, from any member.  Dropping the frame and keeping
   * the actor is the same policy the cluster's own frame validation
   * follows.
   */
  private _handleRemote(envelope: ReplicatedEventEnvelope<Event>): void {
    if (envelope.persistenceId !== this.persistenceId) return; // not for us
    if (envelope.replica === this.replicaId) return; // our own broadcast — ignore
    const rejection = this._envelopeRejection(envelope);
    if (rejection !== null) {
      this.log.warn(
        `replicated-es '${this.persistenceId}': dropped a remote envelope — ${rejection}`,
      );
      return;
    }
    if (this._events.length >= this.maxObservedEvents()) {
      if (!this._observedCapacityWarned) {
        this._observedCapacityWarned = true;
        this.log.warn(
          `replicated-es '${this.persistenceId}': the event history reached ${this._events.length} events ` +
          `(maxObservedEvents() = ${this.maxObservedEvents()}); remote envelopes are refused from here on. ` +
          `Refused rather than evicted — dropping history changes the fold and dropping deduplication keys ` +
          `reopens double-apply. Raise the hook, or snapshot and compact (#535).`,
        );
      }
      return;
    }
    void this._absorb(envelope, /* persistLocally= */ true, /* broadcast= */ false);
  }

  /**
   * Why this envelope is unacceptable, or `null`.
   *
   * Only reached from {@link _handleRemote}: replay and own persists
   * come from this node's own journal and this node's own `persist`,
   * and a check there would reject historical data rather than an
   * attacker.
   *
   * Typed as the envelope but read through `unknown` casts, because
   * the value is whatever a peer put on the wire — the static type is
   * a claim, not a fact.
   */
  private _envelopeRejection(envelope: ReplicatedEventEnvelope<Event>): string | null {
    const claim = envelope as {
      replica?: unknown;
      seqAtReplica?: unknown;
      eventId?: unknown;
      timestamp?: unknown;
      vc?: unknown;
    };
    if (typeof claim.replica !== 'string' || claim.replica.length === 0) {
      return 'replica must be a non-empty string';
    }
    if (claim.replica.length > MAX_REPLICA_ID_LENGTH) {
      return `replica is ${claim.replica.length} characters, at most ${MAX_REPLICA_ID_LENGTH} are accepted`;
    }
    // No `eventId` means either a hostile envelope or a peer that predates the
    // field.  Both are refused: accepting one would restore the guessable
    // `${replica}#${seqAtReplica}` key on the one path where guessing it is the
    // attack, which would make the entropy decorative.  A pre-1.0 hard cut, so
    // a mixed-version cluster loses cross-replica delivery until every node is
    // upgraded — loudly, one WARN per envelope, not silently.
    if (typeof claim.eventId !== 'string' || claim.eventId.length === 0) {
      return 'eventId must be a non-empty string (a peer older than #706 does not send one)';
    }
    if (claim.eventId.length > MAX_REPLICATED_EVENT_ID_LENGTH) {
      return `eventId is ${claim.eventId.length} characters, at most ${MAX_REPLICATED_EVENT_ID_LENGTH} are accepted`;
    }
    // Positive integer, not "exactly one past the highest seen": pub-sub
    // dead-letters a publish with no live subscriber and nothing anywhere
    // retransmits, so gaps are normal AND permanent.  A strict successor rule
    // would turn one dropped publish into that replica being suppressed
    // forever — worse than the attack it would prevent.
    if (!Number.isSafeInteger(claim.seqAtReplica) || (claim.seqAtReplica as number) < 1) {
      return 'seqAtReplica must be a positive safe integer';
    }
    // Finite only.  The sort key stays the *sender's* timestamp on purpose:
    // `_compare` has to produce the same order on every replica, and an
    // arrival-time stamp is local, so it would fold two replicas to different
    // states — breaking convergence for everyone to blunt one attack.
    if (typeof claim.timestamp !== 'number' || !Number.isFinite(claim.timestamp)) {
      return 'timestamp must be a finite number';
    }
    return vectorClockRejection(claim.vc);
  }

  /**
   * Insert an envelope into the canonical event list, deduplicate on
   * its `eventId`, refold state from the divergence point.
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
    const deduplicationKey = this._deduplicationKeyFor(envelope);
    if (this._seenIds.has(deduplicationKey)) return;
    this._seenIds.add(deduplicationKey);

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
      for (const persistedEvent of this._events) this._state = this.onEvent(this._state, persistedEvent.event);
    }

    this._vc = this._vc.merge(VectorClock.fromData(envelope.vc));
    this._observedCount += 1;

    if (persistLocally) {
      // Append remote events to OUR local journal so a recovery from
      // disk replays the full causal history.  Single-writer (us) per
      // pid means we can read highestSeq + append in one mailbox
      // tick without races.
      void this._appendOne(envelope).catch((err) => {
        this.log.warn(`replicated-es: failed to persist remote event ${deduplicationKey}`, err);
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

  /**
   * The key this envelope occupies in the observed set.
   *
   * `eventId` for anything minted since #706.  The
   * `${replica}#${seqAtReplica}` fallback exists for one case only:
   * envelopes written to **this node's own journal or snapshot** before
   * the field existed.  Refusing those would make an upgrade lose the
   * entity's history, and accepting them costs nothing, because a
   * guessable key is only a weapon on the path a peer can reach — and
   * {@link _envelopeRejection} refuses an `eventId`-less envelope there.
   *
   * A legacy envelope and its re-broadcast from an upgraded peer would
   * therefore double-apply, since the two carry different keys for the
   * same event.  Accepted: nothing re-broadcasts a historical event
   * (`persist` is the only publisher, at mint time), so the window is a
   * peer's in-flight redelivery across the upgrade itself.
   */
  private _deduplicationKeyFor(envelope: ReplicatedEventEnvelope<Event>): string {
    const eventId = (envelope as { eventId?: unknown }).eventId;
    return typeof eventId === 'string' && eventId.length > 0
      ? eventId
      : `${envelope.replica}#${envelope.seqAtReplica}`;
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

  /**
   * Routing only — "does this message *claim* to be a replicated
   * envelope", not "is it a valid one".  Deliberately unchanged and
   * deliberately loose: narrowing it would hand a rejected-but-
   * envelope-shaped message to the user's `onCommand`, where it is
   * invisible, instead of to {@link _envelopeRejection}, which names the
   * offending field in a `WARN` and drops it.
   *
   * The cost is that a user `Command` carrying a matching
   * `persistenceId` and a numeric `seqAtReplica` is read as an envelope
   * claim and dropped rather than delivered. That was true before #706
   * too, where it was absorbed as an event instead — worse, and silent.
   */
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
