import type { ReplicaId } from '../../crdt/Crdt.js';
import type { VectorClock } from './VectorClock.js';

/**
 * Resolution strategy for two events that {@link VectorClock} flags
 * as concurrent — neither happens-before the other.  The replicated-
 * event-sourced actor consults this when merging divergent histories
 * so every replica converges to the same state.
 *
 * Two contracts:
 *   - The resolver is deterministic for a given `(a, b)` pair —
 *     given the same inputs, every replica must pick the same
 *     winner / merge result.
 *   - The resolver MUST be commutative: `resolve(a, b) === resolve(b, a)`.
 *     Otherwise different replicas would diverge based on which
 *     event arrived first.
 *
 * The simplest deterministic resolver is **last-writer-wins** (LWW)
 * keyed on `(timestamp, replicaId)` — that's what we ship as the
 * default.  Domain-aware resolvers can do something smarter
 * (e.g. additive merge for counters, set union for tag sets).
 */
export interface ConflictResolver<E> {
  /**
   * Pick a single event from a concurrent pair.  Implementations
   * MUST be commutative — `resolve(a, b)` must equal `resolve(b, a)`.
   * Return one of the inputs, or a synthesised merge of both —
   * either is fine as long as the result is deterministic across
   * replicas.
   */
  resolve(a: ConflictCandidate<E>, b: ConflictCandidate<E>): E;
}

/** Event paired with the metadata a resolver needs to break ties. */
export interface ConflictCandidate<E> {
  /** The user-domain event payload. */
  readonly event: E;
  /** Wall-clock timestamp at the originating replica. */
  readonly timestamp: number;
  /** Originating replica id (typically `cluster.selfAddress.toString()`). */
  readonly replica: ReplicaId;
  /** Vector clock at persist time. */
  readonly vc: VectorClock;
}

/* ============================== built-in: LWW ============================ */

/**
 * Last-writer-wins on `(timestamp, replicaId)`.  Higher timestamp
 * wins; on ties the higher (lexicographic) replicaId wins so every
 * replica converges deterministically.
 *
 * Caveat: relies on wall-clock timestamps being roughly comparable
 * across replicas.  Same trade-off as `LWWRegister`.
 */
export class LastWriterWinsResolver<E> implements ConflictResolver<E> {
  resolve(a: ConflictCandidate<E>, b: ConflictCandidate<E>): E {
    if (a.timestamp > b.timestamp) return a.event;
    if (b.timestamp > a.timestamp) return b.event;
    // Tie on timestamp — break by replica id.
    return a.replica > b.replica ? a.event : b.event;
  }
}

/* ============================== built-in: Custom ======================== */

/**
 * Wraps a user-provided commutative merge function.  Use this when
 * you have domain knowledge that LWW doesn't capture — e.g. the
 * conflicting events are both "deposit X" and you can simply add
 * the amounts.
 *
 *   new CustomMergeResolver<Event>((a, b) => ({
 *     kind: 'merged',
 *     amount: a.event.amount + b.event.amount,
 *   }));
 */
export class CustomMergeResolver<E> implements ConflictResolver<E> {
  constructor(private readonly merge: (a: E, b: E) => E) {}
  resolve(a: ConflictCandidate<E>, b: ConflictCandidate<E>): E {
    // We sort the two candidates by replica id so the user's merge
    // function gets a deterministic argument order even if it isn't
    // strictly commutative.  The contract still says "be
    // commutative", but this guards the common case where the user
    // accidentally wrote a `(left, right)`-asymmetric merge.
    const [first, second] = a.replica <= b.replica ? [a, b] : [b, a];
    return this.merge(first.event, second.event);
  }
}
