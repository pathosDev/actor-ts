import { match, P } from 'ts-pattern';
import { Actor } from '../Actor.js';
import type { ActorRef } from '../ActorRef.js';
import type { ActorSystem } from '../ActorSystem.js';
import { DistributedPubSubId, DistributedPubSubOptions } from '../cluster/pubsub/index.js';
import type { Lease } from '../coordination/Lease.js';
import type { NodeAddress } from '../cluster/NodeAddress.js';
import {
  Publish, PubSubEnvelope, Subscribe, type SubscribeAcknowledgment,
} from '../cluster/pubsub/Messages.js';
import type { ReplicaId } from '../crdt/Crdt.js';
import { randomId } from '../util/RandomString.js';
import {
  DEFAULT_MAX_REPLICATED_OBSERVED_EVENTS,
  MAX_REPLICA_ID_LENGTH,
  MAX_REPLICATED_EVENT_ID_LENGTH,
  MAX_VECTOR_CLOCK_ENTRIES,
  REPLICATED_EVENT_ID_ENTROPY_CHARACTERS,
  REPLICATED_JOURNAL_RETRY_ATTEMPTS,
  REPLICATED_JOURNAL_RETRY_BACKOFF_MS,
} from './Constants.js';
import type { Journal } from './Journal.js';
import { JournalConcurrencyError, type PersistentEvent } from './JournalTypes.js';
import { PersistenceExtensionId, type PersistenceExtension } from './PersistenceExtension.js';
import { withRecoveryDeadline, type SnapshotPolicy } from './PersistentActor.js';
import type { ConflictCandidate, ConflictResolver } from './replicated/ConflictResolver.js';
import type { ReplicatedSnapshot } from './replicated/ReplicatedSnapshot.js';
import { loadSnapshotOrNull } from './Replay.js';
import type { SnapshotStore } from './SnapshotStore.js';
import { assertValidPersistenceId } from './storage/PersistenceIdValidator.js';
import { VectorClock, type VectorClockData } from './replicated/VectorClock.js';

/**
 * Replicated Event Sourcing — multiple nodes can write events for the
 * **same** persistenceId concurrently; vector clocks let every replica
 * recognise the events that were written concurrently, and an optional
 * {@link ConflictResolver} decides how to reconcile them (#1245).
 *
 * **Mental model.**  The canonical history at each replica is the
 * union of every event ever persisted by any replica, sorted in a
 * deterministic order — `(timestamp, replicaId, sequenceAtReplica)`.
 * State is the fold of `onEvent` over that ordered history: every event
 * by default, or, with a resolver, one reconciled event per run of
 * mutually concurrent events (see `resolver()`).  Two replicas that
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
 * `WARN` if it fails, never absorbed halfway (#706).
 *
 * **And its author is checked, not believed.**  An envelope's `replica`
 * is a value the sender chose, so it is held against the node the
 * *connection* authenticated: the actor subscribes with
 * `deliverWithOrigin`, so every topic delivery arrives as a
 * {@link PubSubEnvelope} naming its origin, and
 * {@link ReplicatedEventSourcedActor.isAuthorizedAuthor} decides whether
 * that node may write under that replica id.  An envelope that reaches
 * this mailbox with no origin at all — which is what
 * `Cluster.dispatchEnvelope`'s generic path resolution produces, the
 * route that bypasses pub-sub entirely — is refused for that reason
 * alone.  Overriding {@link ReplicatedEventSourcedActor.replicaId}
 * without overriding the predicate beside it is what re-opens this.
 *
 * **Local journal**: each replica still appends every event it
 * **observes** to its local journal (its own + every remote it
 * receives).  This means on recovery, replaying the local journal
 * is sufficient to rebuild state — no cross-replica chatter at
 * startup.  Storage cost: events live N times across N replicas;
 * fine for the small-write/many-read workloads where Replicated ES
 * shines.
 *
 * **When the stores are down** (#1497).  The local `persist`, recovery and
 * snapshot saves follow the five `actor-ts.persistence` keys exactly as a
 * `PersistentActor`'s do.  `persist` runs the head probe and the append as
 * one call through the journal breaker, so it rejects with
 * `CircuitBreakerOpenError` or `CircuitBreakerTimeoutError` before anything
 * is folded or broadcast.  Recovery reads under a `max-concurrent-recoveries`
 * permit and the `recovery-timeout` deadline — the snapshot through the
 * snapshot breaker and `snapshot-is-optional`, the journal through the
 * journal breaker — and a recovery that fails fails `preStart`.  A snapshot
 * save goes through the snapshot breaker, and a refusal is a `WARN`.  The
 * breaker ids are `PersistentActor`'s own: there is one journal per node,
 * so one breaker in front of it, and an outage either class runs into
 * fast-fails both.
 *
 * **The append of an event received from a peer** (#958) runs in the same
 * chain as every other journal call this actor makes after recovery — each
 * waits for the one before it — and through the same journal breaker.  It is
 * retried while an attempt is known to have written nothing, and a spent
 * budget, or an outcome nothing can settle, fails the actor so its supervisor
 * sees a journal missing an event its state holds (see `_persistRemote`).
 *
 * **An append whose outcome `persist` never saw** (#1732) — cut by
 * `call-timeout`, which gives up without cancelling, or committed by a store
 * that then lost the answer — is settled once the journal call itself
 * settles.  A call still waiting for its turn in the chain is cancelled, and
 * nothing is written.  Otherwise the actor waits for the call: a success
 * means it landed; a `JournalConcurrencyError` means it did not; any other
 * error is settled by reading the journal back from the head the append saw
 * and looking for the event id.  An event that landed is folded and
 * broadcast, exactly as the successful `persist` would have done — so a peer
 * receives it, and this replica's state shows it.  Three guards close the
 * windows around that:
 *
 *   - Until the event is folded, its journal position is not counted as
 *     covered: a snapshot taken in between records the position one short
 *     of it, and a recovery from that snapshot replays it.
 *   - A stopped instance leaves what its journal calls still owe to its
 *     successor on this node, which waits for it before its recovery reads —
 *     under `recovery-timeout`, like the reads.  The successor therefore
 *     replays an event that landed late and never mints its `seqAtReplica`
 *     again.
 *   - A recovery re-publishes this replica's own events after the snapshot,
 *     so one that landed after its instance stopped still reaches the peers;
 *     they deduplicate on the event id.  Best-effort like every publish: a
 *     peer the mediator does not know yet misses it.
 *
 * What stays open: an outcome the journal cannot be read to settle is a
 * `WARN`, and the event is folded and re-published only by the next recovery
 * — if it landed.  `afterPersist` never runs for an event that landed late;
 * its caller was told the write failed.
 *
 * A refused `persist` still consumes the `seqAtReplica` it was minted with.
 * Peers already accept a gap (see `_envelopeRejection`), and a skipped
 * clock component changes no concurrency verdict — `VectorClock.compareTo`
 * compares components, not how densely they were ticked; handing the number
 * back would mint it twice once a timed-out append landed.
 *
 *   class ReplicatedCounter extends ReplicatedEventSourcedActor<
 *     Command, Event, { value: number }
 *   > {
 *     readonly persistenceId = 'counter-1';
 *     // `replicaId` defaults to this node's address; no constructor needed.
 *     initialState() { return { value: 0 }; }
 *     onEvent(s, e) { return { value: s.value + e.amount }; }
 *     async onCommand(s, c) { await this.persist({ amount: c.delta }); }
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
 * **Every field is peer-supplied**, including `replica`, and nothing
 * *in* the envelope can change that — a signature would only move the
 * question to a key nothing in `src/cluster/` mints.  The binding is
 * therefore made outside the payload: delivery carries the connection's
 * peer alongside it, and
 * {@link ReplicatedEventSourcedActor.isAuthorizedAuthor} holds `replica`
 * against that node before a single field here is acted on.
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

/**
 * One append waiting in, or run by, the actor's journal chain (#958).
 *
 * `started` flips when the chain step asks the journal; until then setting
 * `cancelled` is definitive — the step skips and `written` answers `null`.
 * `head` is the position the step read before appending, where a check of an
 * unknown outcome starts.
 */
type AppendTicket = {
  started: boolean;
  cancelled: boolean;
  head: number;
  written: Promise<number | null>;
};

/** The append is in the journal, at `sequenceNr`. */
type WrittenOutcome = { readonly kind: 'written'; readonly sequenceNr: number };
/** The journal holds no such append. */
type AbsentOutcome = { readonly kind: 'absent' };
/** Neither could be established — the journal could not be read. */
type UnknownOutcome = { readonly kind: 'unknown' };
/** What an append whose call did not succeed actually did. */
type AppendOutcome = WrittenOutcome | AbsentOutcome | UnknownOutcome;

/**
 * Told to itself by an actor whose append of a peer's event failed for good,
 * so the failure is thrown from a mailbox turn and reaches the supervisor.
 * A class rather than a shape, so nothing that arrives over the wire can be
 * one.
 */
class RemoteAppendExhausted {
  constructor(readonly failure: Error) {}
}

/**
 * Told to itself by an actor whose local append reached the journal after its
 * `persist` had failed (#1732), so the fold happens in a mailbox turn.
 */
class LandedLate<E> {
  constructor(readonly envelope: ReplicatedEventEnvelope<E>) {}
}

/**
 * Per-system, per-persistence-id: what a stopped instance's journal calls
 * still owe (#1732).  A timed-out append is not cancelled, so it can land
 * after its actor stopped — and after a successor's recovery read, which then
 * never sees it and mints its `seqAtReplica` again.  The successor waits for
 * this before it reads.  Same `WeakMap` shape as the live-id registry below.
 */
const pendingJournalWorkBySystem = new WeakMap<ActorSystem, Map<string, Promise<void>>>();

function getPendingJournalWorkForSystem(system: ActorSystem): Map<string, Promise<void>> {
  let pending = pendingJournalWorkBySystem.get(system);
  if (!pending) { pending = new Map(); pendingJournalWorkBySystem.set(system, pending); }
  return pending;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

function topicFor(persistenceId: string): string {
  return `replicated-es:${persistenceId}`;
}

/**
 * What a recovery's read phase hands its apply phase — the two reads, still
 * unapplied (see `ReplicatedEventSourcedActor._readRecovery`).
 */
type ReplicatedRecovery<Event, State> = {
  /** The newest snapshot's content, or `null` to start from `initialState()`. */
  readonly snapshot: ReplicatedSnapshot<Event, State> | null;
  /** The journal after the snapshot — the whole stream when there is none. */
  readonly delta: ReadonlyArray<PersistentEvent<ReplicatedEventEnvelope<Event>>>;
};

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
 * the local node — `_appendOne` reads `highestSeq` and then appends
 * conditionally on it, and the actor's own append chain (#958) only
 * keeps *one* instance from racing itself.  Two actors with the same
 * pid on the same node violate it: their journal appends race, the
 * loser fails with `JournalConcurrencyError`, in-memory state diverges
 * between the two instances.
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
   * **Overriding this means overriding
   * {@link ReplicatedEventSourcedActor.isAuthorizedAuthor} too.**  Its
   * default holds an arriving envelope's `replica` against the node the
   * connection authenticated, which is exactly right while the id *is*
   * the node address and rejects every honest envelope once it is not.
   * The pair is the replica-to-node mapping; the framework cannot infer
   * the second half of it.
   *
   * A getter rather than a field, so the default can read the cluster:
   * the context is attached after construction.  Read from `preStart`
   * onwards.  Must be non-empty and at most
   * {@link MAX_REPLICA_ID_LENGTH} characters — `preStart` checks, so an
   * over-long id fails on the node that chose it rather than being
   * silently rejected by every peer.
   */
  get replicaId(): ReplicaId { return this.cluster.selfAddress.toString(); }

  /**
   * Whether `origin` — the cluster node the *connection* authenticated —
   * may write events under `replica` (#706).
   *
   * This is the whole of the authorship check, and the default is an
   * equality: with the default {@link replicaId} a replica id *is* its
   * node's address, so a member that sets `replica` to a peer's id is
   * refused by the one party that can tell the difference, the receiver
   * holding the socket.  Without it, a member could author events
   * attributed to any replica and — with a large enough `timestamp` —
   * make them win the deterministic order for everyone.
   *
   * **Override it whenever you override {@link replicaId}.**  A fixed
   * region name is not an address, so the default equality would refuse
   * every honest envelope; the mapping has to come from the deployment:
   *
   *     private static readonly NODES: Record<string, string> = {
   *       'eu-west': 'orders@10.0.1.7:2551',
   *       'us-east': 'orders@10.0.2.9:2551',
   *     };
   *     override get replicaId(): ReplicaId { return 'eu-west'; }
   *     protected override isAuthorizedAuthor(replica: ReplicaId, origin: NodeAddress): boolean {
   *       return OrderEntity.NODES[replica] === origin.toString();
   *     }
   *
   * A `return true` here restores the pre-#706 behaviour in full, and is
   * worth writing only for a cluster whose every member is as trusted as
   * this actor's own process.
   *
   * **Sound because a replicated event crosses at most one hop.**
   * `persist` is the only publisher and no mediator re-forwards what it
   * received, so `origin` is the node that authored the event rather
   * than a relay.  A store-and-forward path would have to carry the
   * author separately for this comparison to keep its meaning.
   */
  protected isAuthorizedAuthor(replica: ReplicaId, origin: NodeAddress): boolean {
    return replica === origin.toString();
  }

  abstract initialState(): State;
  abstract onEvent(state: State, event: Event): State;
  abstract onCommand(state: State, command: Command): void | Promise<void>;

  /**
   * How events the vector clocks call **concurrent** are reconciled (#1245).
   * Read once, in `preStart`, before recovery folds anything.
   *
   * Two jobs, kept apart.  The canonical order — `(timestamp, replica,
   * seqAtReplica)` — decides where every event sits in the history, resolver
   * or not; it is what makes the history the same list on every replica.  The
   * resolver decides what a run of concurrent events in that list *means*:
   *
   *   - **`null` (the default)** — nothing is reconciled.  Every event is
   *     folded through `onEvent`, in canonical order, concurrent or not.  For
   *     an event that replaces a value that is last-writer-wins by order: the
   *     concurrent event stamped later is applied last.  For an event that
   *     adds, both apply.  This is the fold the class always had.
   *   - **A {@link ConflictResolver}** — the history is cut into **conflict
   *     groups**: walking the canonical order, an event joins the current
   *     group when it is concurrent with every event already in it, and opens
   *     a new group otherwise.  A group of one is folded as it is; a larger
   *     one is reduced pairwise through `resolve`, left to right in canonical
   *     order, and the single event that comes out is folded through
   *     `onEvent`.  An event that happens after another is never handed to the
   *     resolver with it.
   *
   * The groups are a function of the event set alone, so two replicas holding
   * the same events fold the same state whatever order they arrived in.  A
   * resolver that returns one of its inputs carries that input's metadata into
   * the next pairwise step; a synthesised event carries the later candidate's
   * `timestamp` and `replica` and the merge of both clocks.  The pairwise steps
   * run in canonical order, the same on every replica, so convergence needs
   * `resolve` to be deterministic, not associative.
   *
   * `LastWriterWinsResolver` *drops* the losing event of a concurrent pair —
   * unlike the default, where an additive event from both sides still applies.
   * Choose it for state that is replaced, not accumulated.
   */
  protected resolver(): ConflictResolver<Event> | null { return null; }

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
  /** Strict order: every observed event, deduplicated, sorted by `_compare`. */
  private _events: Array<ReplicatedEventEnvelope<Event>> = [];
  /** Every observed event's `eventId`.  A hit means "already applied". */
  private _seenIds = new Set<string>();
  /** What {@link resolver} returned at `preStart` — `null` folds every event as it is. */
  private _conflictResolver: ConflictResolver<Event> | null = null;
  /**
   * With a resolver: the last conflict group of `_events`, which the next
   * in-order arrival may join, or `null` when it is not known — after a
   * snapshot seeded the history, until the first refold works it out.
   */
  private _trailingGroup: Array<ReplicatedEventEnvelope<Event>> | null = [];
  /** With a resolver: the state folded up to, and excluding, {@link _trailingGroup}. */
  private _stateBeforeTrailingGroup!: State;
  /**
   * Whether the "history is full, remote events refused" `WARN` has
   * been emitted.  One line rather than one per refused envelope: a
   * peer chooses how many it sends, and a log this actor cannot bound
   * is the same denial of service in a different resource.
   */
  private _observedCapacityWarned = false;

  private _journal!: Journal;
  private _snapshotStore!: SnapshotStore;
  /**
   * The extension the two stores came from, kept so its breakers stay
   * reachable after `preStart` (#1497) — the same field, for the same reason,
   * as `PersistentActor`'s.  Assigned in `preStart` from the one lookup the
   * stores come from.
   */
  private _persistence!: PersistenceExtension;
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
  /**
   * The tail of the local journal's write schedule (#958).  Every journal
   * call this actor makes after recovery — an append, local or a peer's, and
   * the read that checks whether an append of unknown outcome landed — is
   * chained behind the one before it, so a head probe never runs while an
   * earlier append is still in flight.  Never rejects.
   */
  private _appendChain: Promise<void> = Promise.resolve();
  /** Background work that outlives the message that started it — a peer's append and its retries. */
  private readonly _unsettled = new Set<Promise<void>>();
  /** Set in `postStop`: background work stops scheduling retries and reports instead of escalating. */
  private _stopped = false;
  /**
   * Events in the journal that are not folded yet, by event id, with their
   * journal position — what keeps a snapshot from claiming their position
   * (#1732).  Almost always empty: an entry lives from the write until the
   * fold, which for a successful `persist` is the same turn.
   */
  private readonly _writtenUnfolded = new Map<string, number>();
  /** This replica's own events the recovery replayed from the journal — re-published once subscribed (#1732). */
  private _recoveredOwnEvents: Array<ReplicatedEventEnvelope<Event>> = [];

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

    const ext = this.system.extension(PersistenceExtensionId);
    this._persistence = ext;
    this._journal = ext.journal;
    this._snapshotStore = ext.snapshotStore;
    // Before recovery: the replayed history is folded with it.
    this._conflictResolver = this.resolver();

    // 1 + 2. Recovery, guarded as `PersistentActor`'s is (#1497), in two
    //    phases.  The read phase — the snapshot, then the journal after it —
    //    holds one of `max-concurrent-recoveries` permits and runs under
    //    `recovery-timeout`.  The apply phase runs only once it has returned.
    //    The split is what makes the deadline safe: it gives up on the reads
    //    and cannot cancel them, so a read that answers after it lands in a
    //    promise nobody awaits any more, instead of folding history into —
    //    and saving snapshots and completing a recovery for — an instance
    //    supervision has already replaced.  The checks above stay outside the
    //    permit for the reason `PersistentActor` gives: waiting on a lease
    //    while holding a permit would starve replays that own theirs.
    const { recoveryTimeoutMs } = ext.behavior;
    const recovery = await ext.withRecoveryPermit(() => {
      const read = this._readRecovery();
      return recoveryTimeoutMs > 0 ? withRecoveryDeadline(read, this.persistenceId, recoveryTimeoutMs) : read;
    });
    this._applyRecovery(recovery);

    // 3. Subscribe to the cross-replica topic.  The Subscribe message
    //    is delivered to the mediator via tell(); the actor mailbox is
    //    ours, so when remote events arrive they land in onReceive.
    //
    //    We pass `gossipIntervalMs: this.pubsubGossipIntervalMs()` —
    //    default 250 ms — so subscription state propagates fast enough
    //    that the first user-issued persist a few hundred ms after
    //    construction reaches peer replicas.  Tests can dial this
    //    tighter; production should leave the default.
    //
    //    `deliverWithOrigin` is what makes the authorship check possible
    //    at all: a bare topic fan-out carries no sender, so every
    //    delivery arrives wrapped in the node the connection
    //    authenticated (#706).  No `replyTo` — the acknowledgment is
    //    informational and `onReceive` drops it.
    const pubsub = this.system.extension(DistributedPubSubId).start(
      this.cluster,
      DistributedPubSubOptions.create().withGossipIntervalMs(this.pubsubGossipIntervalMs()),
    );
    this._mediator = pubsub as unknown as ActorRef<Subscribe | Publish | unknown>;
    pubsub.tell(new Subscribe(
      topicFor(this.persistenceId), this.self, null, /* deliverWithOrigin= */ true,
    ));

    // 4. Re-publish this replica's own events from the replayed journal
    //    (#1732).  An append whose `persist` failed may still have landed —
    //    after a `call-timeout`, or with its answer lost — and if this
    //    replica stopped before it settled, no peer ever received it.
    //    Nothing marks which events those were, so every own event after the
    //    snapshot goes out again; peers deduplicate on the event id, and the
    //    snapshot policy bounds how many that is.  Best-effort like every
    //    publish here: a peer the mediator does not know yet misses it.
    for (const own of this._recoveredOwnEvents) {
      pubsub.tell(new Publish<ReplicatedEventEnvelope<Event>>(topicFor(this.persistenceId), own) as unknown as never);
    }
    this._recoveredOwnEvents = [];

    await this.onRecoveryComplete(this._state);
  }

  /**
   * The read phase of a recovery: the newest snapshot, then the journal
   * after it, each through its own store's breaker — and nothing else.  It
   * returns both and assigns no field, which is the whole contract: see
   * `preStart` for why the deadline depends on it.
   *
   * The snapshot load goes through `snapshot-is-optional`'s one rule rather
   * than a copy of it, so a `SnapshotIntegrityError` is never tolerated here
   * either.  No `persistenceOptions` reach that rule because this class has
   * no `encryption()` / `integrity()` hooks — nothing it loads is a body it
   * asked to have verified.
   */
  private async _readRecovery(): Promise<ReplicatedRecovery<Event, State>> {
    // A predecessor on this node may still have an append in flight — one a
    // `call-timeout` gave up on.  Reading before it settles would miss the
    // event and mint its `seqAtReplica` again (#1732).  Under the recovery
    // deadline, like the reads: a store that never answers fails the recovery
    // rather than wedging it.
    const predecessor = pendingJournalWorkBySystem.get(this.system)?.get(this.persistenceId);
    if (predecessor !== undefined) await predecessor;
    const persistence = this._persistence;
    const loaded = await loadSnapshotOrNull(
      () => persistence.callThroughSnapshotBreaker(
        'load',
        () => this._snapshotStore.loadLatest<ReplicatedSnapshot<Event, State>>(this.persistenceId),
      ),
      {
        snapshotIsOptional: persistence.behavior.snapshotIsOptional,
        onSnapshotLoadFailure: (error) => this._onSnapshotUnavailable(error),
      },
      undefined,
    );
    const snapshot = loaded !== null && loaded.isSome() ? loaded.value.state : null;
    // Without a snapshot this is the full replay, from the first event.
    const fromSequenceNr = snapshot === null ? 1 : snapshot.journalSeqAtSnapshot + 1;
    const delta = await persistence.callThroughJournalBreaker(
      'replay',
      () => this._journal.read<ReplicatedEventEnvelope<Event>>(this.persistenceId, fromSequenceNr),
    );
    return { snapshot, delta };
  }

  /**
   * The apply phase: seed every in-memory field from the snapshot, so the
   * history that produced it is not refolded, then absorb whatever the
   * journal holds after it.  Synchronous, and reached only with what a
   * finished read phase returned.
   *
   * `_localSeq` continues past this replica's own events in the journal as
   * well as past the snapshot's (found while #1497).  Restored from the
   * snapshot alone, a restart with none — `snapshot-is-optional`'s fallback
   * among them — minted `seqAtReplica` 1 a second time, and one from a
   * snapshot re-minted the number of every own event written after it: the
   * conflict `ReplicatedSnapshot.localSeq` exists to prevent.  A peer's
   * events do not count — their numbers are that peer's counter.
   */
  private _applyRecovery(recovery: ReplicatedRecovery<Event, State>): void {
    this._state = this.initialState();
    this._stateBeforeTrailingGroup = this._state;
    this._trailingGroup = [];
    const { snapshot, delta } = recovery;
    if (snapshot !== null) {
      // The snapshot carries the folded state but not its conflict groups;
      // the first arrival that needs them refolds the seeded history.
      this._trailingGroup = null;
      this._state = snapshot.state;
      this._vc = VectorClock.fromData(snapshot.vc);
      this._seenIds = new Set(snapshot.seenIds);
      this._events = [...snapshot.events];
      this._localSeq = snapshot.localSeq;
      this._journalSeq = snapshot.journalSeqAtSnapshot;
      this._observedCount = snapshot.events.length;
    }
    const replicaId = this.replicaId;
    for (const persisted of delta) {
      // Track the journal seq cursor so a snapshot taken later
      // records the right `journalSeqAtSnapshot`.
      if (persisted.sequenceNr > this._journalSeq) this._journalSeq = persisted.sequenceNr;
      const envelope = persisted.event;
      if (envelope.replica === replicaId) {
        if (envelope.seqAtReplica > this._localSeq) this._localSeq = envelope.seqAtReplica;
        this._recoveredOwnEvents.push(envelope);
      }
      // Anything the snapshot already accounts for is a no-op here: `_absorb`
      // deduplicates on the event id the snapshot's `seenIds` carries.
      this._absorb(envelope, /* persistLocally= */ false, /* broadcast= */ false);
    }
  }

  /**
   * `snapshot-is-optional` turned a failed snapshot load into a full journal
   * replay.  `warn`, not `debug`, for the reason `PersistentActor` gives: the
   * recovery succeeded, so nothing else will ever say the snapshot store was
   * unreachable.
   */
  private _onSnapshotUnavailable(error: Error): void {
    this.log.warn(
      `replicated-es '${this.persistenceId}': snapshot store could not be read — `
      + 'recovering by full journal replay (actor-ts.persistence.snapshot-is-optional)',
      error,
    );
  }

  override postStop(): void {
    this._stopped = true;
    // Hand what the journal calls still owe to a successor on this node, which
    // waits for it before its recovery reads (#1732).  `_journal` is unset when
    // `preStart` failed before the stores were resolved — nothing was written.
    //
    // What the instance before this one still owes is carried over: an
    // instance whose recovery deadline expired while it waited for that work
    // stops with nothing of its own in flight, and handing over only its own
    // drain would let the next successor read before the earlier append lands.
    if (this._journal !== undefined) {
      const pending = getPendingJournalWorkForSystem(this.system);
      const predecessor = pending.get(this.persistenceId);
      const own = this._drain();
      const drained = predecessor === undefined ? own : Promise.all([predecessor, own]).then(() => undefined);
      pending.set(this.persistenceId, drained);
      void drained.finally(() => {
        if (pending.get(this.persistenceId) === drained) pending.delete(this.persistenceId);
      });
    }
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

  override async onReceive(
    message: Command
      | ReplicatedEventEnvelope<Event>
      | PubSubEnvelope<ReplicatedEventEnvelope<Event>>
      | SubscribeAcknowledgment
      | RemoteAppendExhausted
      | LandedLate<Event>,
  ): Promise<void> {
    // Ignore PubSub ack frames — they're informational.
    if (message && typeof message === 'object' && (message as { subscribe?: unknown }).subscribe instanceof Subscribe) {
      return;
    }
    // A topic delivery, with the node the connection authenticated attached.
    // `instanceof` is the load-bearing part: the wire carries JSON, so this
    // class is a shape only the local mediator can have produced (#706).
    if (message instanceof PubSubEnvelope) {
      this._handleTopicDelivery(message);
      return;
    }
    // Only this actor creates either, and only by telling itself.
    if (message instanceof RemoteAppendExhausted) {
      this._onRemoteAppendExhausted(message);
      return;
    }
    if (message instanceof LandedLate) {
      this._onLandedLate(message as LandedLate<Event>);
      return;
    }
    if (this._isEnvelope(message)) {
      // Envelope-shaped, but it did not come in on the topic — the generic
      // path-resolution route through `Cluster.dispatchEnvelope`, or a local
      // `tell`.  Neither carries an identity, so `_handleRemote` refuses it;
      // it is passed on rather than ignored so the refusal is logged.
      this._handleRemote(message as ReplicatedEventEnvelope<Event>, null);
      return;
    }
    await this.onCommand(this._state, message as Command);
  }

  /**
   * Unwrap a topic delivery.  A message on this actor's own topic that is
   * not an envelope claim is not a command either — the topic is the
   * cross-replica channel and nothing else publishes to it — so it is
   * dropped rather than handed to `onCommand`, where a peer would be
   * choosing which of the application's commands to run.
   */
  private _handleTopicDelivery(delivery: PubSubEnvelope<ReplicatedEventEnvelope<Event>>): void {
    if (!this._isEnvelope(delivery.message)) {
      this.log.warn(
        `replicated-es '${this.persistenceId}': dropped a message on the replication topic — `
        + 'it does not claim to be an event envelope',
      );
      return;
    }
    this._handleRemote(delivery.message, delivery.origin);
  }

  /**
   * Persist a fresh local event.  Increments this replica's VC
   * component, appends to the journal tagged `replicated-es`, applies
   * to local state, and broadcasts to peer replicas.  Resolves once the
   * event is applied and published and `afterPersist` has run with the new
   * state; await it in `onCommand`, or a rejection escapes the handler
   * unseen.
   *
   * The append goes through the journal breaker (#1497), exactly as
   * `PersistentActor.persist` does, so besides whatever the journal throws it
   * rejects with two errors of the breaker's own — handle them where journal
   * errors are handled:
   *
   *   - `CircuitBreakerOpenError` — the breaker is open and the journal was
   *     not asked.
   *   - `CircuitBreakerTimeoutError` — the call outlived
   *     `actor-ts.circuit-breaker.<journal-breaker>.call-timeout`.  The
   *     timeout gives up; it does not cancel, so the append may still land.
   *
   * On either — and on any other journal error — nothing is folded or
   * broadcast *by this call*, and the `seqAtReplica` the event was minted with
   * stays used.  If the append landed after all, the actor folds and
   * broadcasts the event once the journal call settles, without running
   * `afterPersist` (#1732) — see "An append whose outcome `persist` never
   * saw" in the class description.  A rejection therefore means "not
   * confirmed", not "never happened": a command handler that retries one
   * should be idempotent at the domain level.
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
    // The number and the clock tick are taken before the append and kept
    // whatever it does.  A refusal leaves a gap in this replica's
    // `seqAtReplica`, which every peer already accepts (see
    // `_envelopeRejection`).  Handing the number back instead would mint it
    // twice after a `CircuitBreakerTimeoutError`: the append that timed out is
    // not cancelled, and once it lands the journal holds two events under the
    // one number.
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
    // One call through the breaker for the wait in the append chain, the head
    // probe and the append together: a backend that stalls the probe stalls
    // the write as surely as one that stalls the append, and so does an
    // earlier append it is queued behind.  `isStoreOutage` travels with the
    // call, so a losing conditional append — the journal answering, not
    // failing — is not counted against the breaker.
    const holder: { ticket: AppendTicket | null } = { ticket: null };
    try {
      await this._persistence.callThroughJournalBreaker('append', () => {
        holder.ticket = this._enqueueAppend(envelope);
        return holder.ticket.written;
      });
    } catch (error) {
      // The caller hears the failure now; what the append actually did is
      // settled in the background, and an event that landed after all is
      // folded and broadcast then (#1732).
      this._track(this._settleLocalAppend(envelope, holder.ticket));
      throw error;
    }
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
   * Append exactly one envelope to the local journal: read the head, then
   * append conditionally on it.  The two awaits span mailbox turns, so the
   * pair is only race-free because every caller reaches it through
   * {@link _enqueueAppend} — the single-writer registry (#58) keeps a second
   * *actor* off this persistence id, and the chain keeps this actor from
   * racing *itself* (#958).
   *
   * Records the head it read on `ticket`, where a check of an unknown outcome
   * starts reading, and answers the sequence number written.
   */
  private async _appendOne(envelope: ReplicatedEventEnvelope<Event>, ticket: AppendTicket): Promise<number> {
    const head = await this._journal.highestSeq(this.persistenceId);
    ticket.head = head;
    const written = await this._journal.append(
      this.persistenceId, [{ event: envelope, tags: [REPLICATED_TAG] }], head,
    );
    const lastWrittenSeq = written[written.length - 1]?.sequenceNr ?? head + 1;
    this._recordWritten(envelope, lastWrittenSeq);
    return lastWrittenSeq;
  }

  /**
   * Note that `envelope` is in the journal at `sequenceNr`.  An event not yet
   * folded — a local append whose `persist` is still on its way to `_absorb`,
   * or one that landed after its `persist` gave up — is remembered until it
   * is, so a snapshot taken in between does not count its position as
   * covered (see {@link _coveredJournalSeq}).
   */
  private _recordWritten(envelope: ReplicatedEventEnvelope<Event>, sequenceNr: number): void {
    if (sequenceNr > this._journalSeq) this._journalSeq = sequenceNr;
    const deduplicationKey = this._deduplicationKeyFor(envelope);
    if (!this._seenIds.has(deduplicationKey)) this._writtenUnfolded.set(deduplicationKey, sequenceNr);
  }

  /**
   * The journal position a snapshot may claim: everything up to it is in the
   * state.  `_journalSeq` unless an event written before it has not been
   * folded yet, in which case one short of the earliest such event — the
   * recovery from that snapshot replays it, and anything after it that the
   * snapshot already holds is deduplicated on its event id.
   */
  private _coveredJournalSeq(): number {
    let covered = this._journalSeq;
    for (const sequenceNr of this._writtenUnfolded.values()) {
      if (sequenceNr - 1 < covered) covered = sequenceNr - 1;
    }
    return covered;
  }

  /**
   * Settle a local append whose `persist` rejected (#1732).  If it is in the
   * journal after all — a `call-timeout` that gave up on a call that then
   * landed, or a store that committed and lost the answer — the event is
   * folded and broadcast, exactly as the successful `persist` would have
   * done.  Its `seqAtReplica` was never handed back, so nothing else carries
   * that number.  `afterPersist` does not run: its caller has been told the
   * write failed.
   */
  private async _settleLocalAppend(
    envelope: ReplicatedEventEnvelope<Event>,
    ticket: AppendTicket | null,
  ): Promise<void> {
    const outcome = await this._settleAppend(envelope, ticket);
    if (outcome.kind === 'written') {
      this._landedLate(envelope, outcome.sequenceNr);
    } else if (outcome.kind === 'unknown') {
      this.log.warn(
        `replicated-es '${this.persistenceId}': whether the event ${envelope.eventId} reached the journal could not `
        + 'be established — the journal could not be read; the next recovery folds and re-publishes it if it did',
      );
    }
  }

  /**
   * An event of this replica's that reached the journal after its `persist`
   * had already failed.  Folding it touches the actor's state, so it goes
   * back through the mailbox; a stopped instance leaves it to its successor,
   * whose recovery replays it and re-publishes it (see `preStart`).
   */
  private _landedLate(envelope: ReplicatedEventEnvelope<Event>, sequenceNr: number): void {
    this._recordWritten(envelope, sequenceNr);
    if (this._seenIds.has(this._deduplicationKeyFor(envelope)) || this._stopped) return;
    this.self.tell(new LandedLate(envelope) as unknown as Command);
  }

  /** Back in the mailbox: fold the late event and broadcast it, as `persist` would have. */
  private _onLandedLate(message: LandedLate<Event>): void {
    this._absorb(message.envelope, /* persistLocally= */ false, /* broadcast= */ true);
  }

  /**
   * Settles once every journal call this instance scheduled, and every
   * retry or settling read still to come, has finished.  What a successor
   * on this node waits for before it recovers (see `postStop`).
   */
  private async _drain(): Promise<void> {
    for (;;) {
      const tail = this._appendChain;
      await tail;
      if (this._unsettled.size === 0) {
        if (tail === this._appendChain) return;
        continue;
      }
      await Promise.allSettled([...this._unsettled]);
    }
  }

  /**
   * Run `work` once every journal call scheduled before it has settled, and
   * make it what the next one waits for.  The chain itself never rejects; the
   * returned promise carries `work`'s own outcome.
   */
  private _enqueueJournalCall<T>(work: () => Promise<T>): Promise<T> {
    const result = this._appendChain.then(work);
    this._appendChain = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * Schedule one append in the chain and answer its ticket.  The ticket's
   * `written` settles with the journal's answer — the sequence number written
   * — or with `null` when the ticket was cancelled before its turn came, in
   * which case the journal was never asked.
   */
  private _enqueueAppend(envelope: ReplicatedEventEnvelope<Event>): AppendTicket {
    const ticket: AppendTicket = { started: false, cancelled: false, head: 0, written: Promise.resolve(null) };
    ticket.written = this._enqueueJournalCall(async () => {
      if (ticket.cancelled) return null;
      ticket.started = true;
      return this._appendOne(envelope, ticket);
    });
    return ticket;
  }

  /**
   * What an append that was not answered with success actually did: written
   * (with its position), absent, or unknown.  Waits for the journal call
   * itself to settle — a breaker's `call-timeout` gives up on it and does not
   * cancel it — and cancels it first if its turn has not come yet, which is
   * the one case in which "absent" is known without asking the journal.
   *
   * A `JournalConcurrencyError` is the conditional append refused, so nothing
   * was written.  Any other error may have come after the store committed —
   * a lost response — and is settled by reading the journal from the head the
   * append saw, looking for the event id.
   */
  private async _settleAppend(
    envelope: ReplicatedEventEnvelope<Event>,
    ticket: AppendTicket | null,
  ): Promise<AppendOutcome> {
    // The breaker refused before the journal was asked.
    if (ticket === null) return { kind: 'absent' };
    ticket.cancelled = true;
    try {
      const sequenceNr = await ticket.written;
      return sequenceNr === null ? { kind: 'absent' } : { kind: 'written', sequenceNr };
    } catch (error) {
      if (error instanceof JournalConcurrencyError) return { kind: 'absent' };
      return this._findLanded(envelope, ticket.head);
    }
  }

  /**
   * Read the journal after `head` for `envelope`'s event id, through the
   * journal breaker and in the chain, so nothing this actor writes moves
   * under the read.  Tried {@link REPLICATED_JOURNAL_RETRY_ATTEMPTS} times;
   * if no read gets an answer the outcome stays unknown.
   */
  private async _findLanded(envelope: ReplicatedEventEnvelope<Event>, head: number): Promise<AppendOutcome> {
    for (let attempt = 1; attempt <= REPLICATED_JOURNAL_RETRY_ATTEMPTS; attempt++) {
      try {
        const after = await this._enqueueJournalCall(() => this._persistence.callThroughJournalBreaker(
          'replay',
          () => this._journal.read<ReplicatedEventEnvelope<Event>>(this.persistenceId, head + 1),
        ));
        const landed = after.find((persisted) => persisted.event.eventId === envelope.eventId);
        return landed === undefined ? { kind: 'absent' } : { kind: 'written', sequenceNr: landed.sequenceNr };
      } catch {
        if (attempt < REPLICATED_JOURNAL_RETRY_ATTEMPTS && !this._stopped) {
          await sleep(REPLICATED_JOURNAL_RETRY_BACKOFF_MS * attempt);
        }
      }
    }
    return { kind: 'unknown' };
  }

  /**
   * Append an event received from a peer to the local journal (#958) — in
   * the chain, through the journal breaker, and retried.
   *
   * The event is already folded when this starts: the fold is what a peer
   * sees, and nothing re-sends the event, so it cannot wait on a store.  What
   * a failure costs is this replica's *on-disk* history, which the next
   * recovery rebuilds from.  So an attempt that ends absent — the breaker
   * open, a losing conditional append, an error the journal confirms wrote
   * nothing — is retried, up to {@link REPLICATED_JOURNAL_RETRY_ATTEMPTS}
   * attempts with a growing pause.  An attempt whose outcome stays unknown is
   * not retried, since a second write could land the event twice; it
   * escalates at once, like a spent budget.
   *
   * Escalating fails the actor through its supervisor: a replica whose
   * journal is missing an event it has folded must not carry on as if it
   * were whole.  The restarted instance recovers from its journal and so
   * does not hold the event — the divergence is loud now, not repaired.
   */
  private async _persistRemote(envelope: ReplicatedEventEnvelope<Event>): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= REPLICATED_JOURNAL_RETRY_ATTEMPTS; attempt++) {
      const holder: { ticket: AppendTicket | null } = { ticket: null };
      try {
        await this._persistence.callThroughJournalBreaker('append', () => {
          holder.ticket = this._enqueueAppend(envelope);
          return holder.ticket.written;
        });
        return;
      } catch (error) {
        lastError = error;
        const outcome = await this._settleAppend(envelope, holder.ticket);
        if (outcome.kind === 'written') return;
        if (outcome.kind === 'unknown') break;
      }
      if (attempt < REPLICATED_JOURNAL_RETRY_ATTEMPTS && !this._stopped) {
        await sleep(REPLICATED_JOURNAL_RETRY_BACKOFF_MS * attempt);
      }
    }
    this._escalateRemoteAppend(envelope, lastError);
  }

  private _escalateRemoteAppend(envelope: ReplicatedEventEnvelope<Event>, cause: unknown): void {
    const failure = new Error(
      `replicated-es '${this.persistenceId}': the event ${envelope.eventId} from ${envelope.replica} is folded `
      + 'but could not be written to the local journal — a recovery from this journal would not hold it',
      { cause },
    );
    this.log.error(failure.message, cause);
    // A stopped instance has no supervisor left to tell; the log line is all.
    if (!this._stopped) this.self.tell(new RemoteAppendExhausted(failure) as unknown as Command);
  }

  /** Back in the mailbox: fail, so the supervisor sees the incomplete journal. */
  private _onRemoteAppendExhausted(message: RemoteAppendExhausted): never {
    throw message.failure;
  }

  /** Keep `work` reachable until it settles. */
  private _track(work: Promise<void>): void {
    this._unsettled.add(work);
    void work.finally(() => this._unsettled.delete(work));
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
  private _handleRemote(envelope: ReplicatedEventEnvelope<Event>, origin: NodeAddress | null): void {
    if (envelope.persistenceId !== this.persistenceId) return; // not for us
    if (envelope.replica === this.replicaId) return; // our own broadcast — ignore
    const rejection = this._envelopeRejection(envelope) ?? this._authorshipRejection(envelope, origin);
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
          `(maxObservedEvents() = ${this.maxObservedEvents()}); remote envelopes are refused from here on, ` +
          `and the refusal is permanent for this entity — a snapshot carries the whole history and recovery ` +
          `re-seeds it, so restarting does not clear it. ` +
          `Refused rather than evicted — dropping history changes the fold and dropping deduplication keys ` +
          `reopens double-apply. Raising the hook is the only relief today; compaction is #535.`,
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
    // Finite only, and deliberately not "close to now".  Every check in this
    // function has to reach the same verdict on every replica, or the two fold
    // different histories and convergence — the guarantee the class exists for
    // — is gone.  A shape check does; a check against the receiver's clock does
    // not, so a skewed pair of nodes would silently disagree about which events
    // exist.  The sort key stays the sender's timestamp for the same reason:
    // an arrival-time stamp is local.  What makes that acceptable is authorship
    // (see `_authorshipRejection`) — a member can still stamp
    // `Number.MAX_SAFE_INTEGER` on an event and win the order, but only under
    // its *own* replica id, which it could always do by writing honestly.
    if (typeof claim.timestamp !== 'number' || !Number.isFinite(claim.timestamp)) {
      return 'timestamp must be a finite number';
    }
    return vectorClockRejection(claim.vc);
  }

  /**
   * Why this envelope's claimed author is unacceptable, or `null`.
   *
   * Runs after {@link _envelopeRejection}, so `replica` is already known
   * to be a plausible string and the message names the field rather than
   * whatever a peer put there.
   *
   * **A missing origin is a refusal, not a pass.**  Two routes reach this
   * actor from a peer: the replication topic, which now carries the
   * connection's peer, and `Cluster.dispatchEnvelope`'s generic path
   * resolution, which delivers the raw body to any resolvable path with
   * no identity whatsoever.  Treating the second as trusted would leave
   * the whole attack reachable one path over from the one that was
   * closed, so the absence of an identity is itself the reason (#706).
   * The same rule makes a locally-`tell`ed envelope inert, which is the
   * correct reading of it: nothing on this node may speak for a peer.
   */
  private _authorshipRejection(
    envelope: ReplicatedEventEnvelope<Event>, origin: NodeAddress | null,
  ): string | null {
    if (origin === null) {
      return `replica '${envelope.replica}' claims an author, but the envelope arrived with no `
        + 'authenticated origin — it did not come in on the replication topic';
    }
    if (!this.isAuthorizedAuthor(envelope.replica, origin)) {
      return `replica '${envelope.replica}' may not be written by ${origin}, the node this `
        + 'connection authenticated (isAuthorizedAuthor said no)';
    }
    return null;
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
    this._writtenUnfolded.delete(deduplicationKey);

    // Fast path: envelope sorts after every existing event → just append.
    const last = this._events[this._events.length - 1];
    const insertIndex = last && this._compare(envelope, last) > 0
      ? this._events.length
      : this._findInsertIndex(envelope);
    this._events.splice(insertIndex, 0, envelope);

    this._foldInserted(envelope, insertIndex === this._events.length - 1);

    this._vc = this._vc.merge(VectorClock.fromData(envelope.vc));
    this._observedCount += 1;

    if (persistLocally) {
      // Append remote events to OUR local journal so a recovery from disk
      // replays the full causal history — serialized behind every other
      // journal call this actor makes, so back-to-back envelopes do not race
      // one head (#958).
      this._track(this._persistRemote(envelope));
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

  /* -------------------------------- fold -------------------------------- */

  /**
   * Bring `_state` up to date with an envelope just spliced into `_events`.
   *
   * Without a resolver this is the fold the class always had: an envelope
   * that sorts last is applied on its own, anything else refolds.  With one,
   * an envelope that sorts last either joins the trailing conflict group —
   * concurrent with every member — and the group is re-reduced from the state
   * before it, or opens a new group of one and is applied on its own.
   */
  private _foldInserted(envelope: ReplicatedEventEnvelope<Event>, appended: boolean): void {
    const resolver = this._conflictResolver;
    if (resolver === null) {
      if (appended) this._state = this.onEvent(this._state, envelope.event);
      // Out-of-order arrival — refold to keep the canonical sort intact.
      // Cheap as long as N stays small; gossip usually delivers in order.
      else this._refold();
      return;
    }
    const trailing = this._trailingGroup;
    if (!appended || trailing === null) {
      this._refold();
      return;
    }
    if (trailing.length > 0 && this._isConcurrentWithAll(envelope, trailing)) {
      trailing.push(envelope);
      this._state = this._foldGroup(this._stateBeforeTrailingGroup, trailing, resolver);
      return;
    }
    this._stateBeforeTrailingGroup = this._state;
    this._trailingGroup = [envelope];
    this._state = this.onEvent(this._state, envelope.event);
  }

  /**
   * Fold the whole canonical history from `initialState()`, cutting it into
   * conflict groups when a resolver is set (see {@link resolver}).  Records the
   * trailing group and the state before it, so the next in-order arrival
   * folds incrementally again.
   */
  private _refold(): void {
    const resolver = this._conflictResolver;
    let state = this.initialState();
    if (resolver === null) {
      for (const observed of this._events) state = this.onEvent(state, observed.event);
      this._state = state;
      return;
    }
    let group: Array<ReplicatedEventEnvelope<Event>> = [];
    let before = state;
    for (const observed of this._events) {
      if (group.length > 0 && this._isConcurrentWithAll(observed, group)) {
        group.push(observed);
        continue;
      }
      if (group.length > 0) state = this._foldGroup(state, group, resolver);
      before = state;
      group = [observed];
    }
    this._trailingGroup = group;
    this._stateBeforeTrailingGroup = before;
    this._state = group.length > 0 ? this._foldGroup(before, group, resolver) : before;
  }

  /**
   * Fold one conflict group: a lone event as it is, a larger group reduced
   * pairwise through the resolver in canonical order and folded once.
   */
  private _foldGroup(
    state: State,
    group: ReadonlyArray<ReplicatedEventEnvelope<Event>>,
    resolver: ConflictResolver<Event>,
  ): State {
    if (group.length === 1) return this.onEvent(state, group[0]!.event);
    let winner = this._candidateOf(group[0]!);
    for (let i = 1; i < group.length; i++) {
      const next = this._candidateOf(group[i]!);
      const resolved = resolver.resolve(winner, next);
      if (resolved === next.event) winner = next;
      else if (resolved !== winner.event) {
        // A synthesised event.  `next` sorts after `winner`, so its timestamp
        // is the larger one; the clock covers both.
        winner = { event: resolved, timestamp: next.timestamp, replica: next.replica, vc: winner.vc.merge(next.vc) };
      }
    }
    return this.onEvent(state, winner.event);
  }

  private _candidateOf(envelope: ReplicatedEventEnvelope<Event>): ConflictCandidate<Event> {
    return {
      event: envelope.event,
      timestamp: envelope.timestamp,
      replica: envelope.replica,
      vc: VectorClock.fromData(envelope.vc),
    };
  }

  /** Whether `envelope`'s clock is concurrent with the clock of every member of `group`. */
  private _isConcurrentWithAll(
    envelope: ReplicatedEventEnvelope<Event>,
    group: ReadonlyArray<ReplicatedEventEnvelope<Event>>,
  ): boolean {
    const clock = VectorClock.fromData(envelope.vc);
    return group.every((member) => clock.isConcurrentWith(VectorClock.fromData(member.vc)));
  }

  /* ----------------------------- snapshotting --------------------------- */

  /**
   * Force a snapshot of the current state.  Useful for tests + manual
   * compaction.
   *
   * Resolves to nothing once the snapshot store has answered — and resolves
   * either way.  A save that fails, or that the snapshot breaker refuses
   * (#1497), is logged as a `WARN` and not thrown: a snapshot is an
   * optimisation, recovery falls back to the previous one or to a full
   * replay, and a throw here would fail the command that asked for it.
   * It does not wait for, or skip because of, a policy-triggered save that
   * is already in flight.
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
      journalSeqAtSnapshot: this._coveredJournalSeq(),
      takenBy: this.replicaId,
      takenAt: Date.now(),
    };
    try {
      // Its own breaker, not the journal's, exactly as for `PersistentActor`
      // (#1497): a snapshot store that is down must not fast-fail a journal
      // that is fine.  A failed save is not counted by that breaker (#1496):
      // it opens on failed loads, the call a recovery cannot do without, so
      // a store that refuses writes but reads fine cannot fail recoveries.
      // The save still runs through it, though: an open breaker refuses it
      // before the store is asked, and `call-timeout` bounds one that never
      // answers.
      await this._persistence.callThroughSnapshotBreaker(
        'save',
        () => this._snapshotStore.save<ReplicatedSnapshot<Event, State>>(
          this.persistenceId, snapshot.journalSeqAtSnapshot, snapshot,
        ),
      );
    } catch (err) {
      this.log.warn(
        `replicated-es '${this.persistenceId}': snapshot save failed — the next recovery starts from `
        + 'the previous snapshot, or replays the whole journal',
        err,
      );
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

  /**
   * The canonical order: payload `timestamp`, then `replica`, then
   * `seqAtReplica`.
   *
   * All three come out of the envelope, and that is required rather than
   * merely tolerated — the order has to be a function of the events alone
   * or two replicas holding the same set compute different states.  A
   * receive-time key would be local to each replica and would break that
   * outright, which is why #706's "use a receive-time timestamp for
   * ordering" is refused here and answered by binding the author instead:
   * a forged `timestamp` is now traceable to the member that sent it and
   * can no longer be attributed to a victim.
   */
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
