/**
 * Conflict-free Replicated Data Type — a value that converges under
 * replication without coordination.  Every implementation is a
 * **state-based CvRDT**: replicas exchange full state, and `merge`
 * forms a join-semilattice.
 *
 * Three properties every implementation must satisfy — `tests/unit/crdt`
 * verifies them by hand-rolled property tests against generated samples:
 *
 *   - **Idempotent**:    `merge(a, a) === a`
 *   - **Commutative**:   `merge(a, b) === merge(b, a)`
 *   - **Associative**:   `merge(merge(a, b), c) === merge(a, merge(b, c))`
 *
 * Together these mean: gossip can deliver state updates in any order,
 * deduplicate, retransmit, and the world converges as long as every
 * replica eventually sees every state.
 *
 * **Why state-based and not delta-state.**  Delta-CRDTs ship only the
 * incremental change rather than the full state — much cheaper on the
 * wire, but the implementation has more moving parts and you need
 * delta acknowledgement protocols.  State-based is the simplest thing
 * that converges; we ship it first and revisit if payload size hurts.
 *
 * @typeParam Self - The concrete CRDT type.  F-bounded so subclass
 *   `merge` keeps the right return type without casting at every call
 *   site.
 */
export interface Crdt<Self extends Crdt<Self>> {
  /**
   * Join two replicas.  Must be a join-semilattice operation: total,
   * idempotent, commutative, associative.
   */
  merge(other: Self): Self;

  /**
   * Wire-friendly representation — every CRDT must be JSON-encodable
   * so it can travel through the cluster transport without bespoke
   * codecs.  `toJSON()` is the inverse of the static `fromJSON`
   * factory each impl exposes.
   */
  toJSON(): unknown;
}

/**
 * Identifier of the replica producing an update.  In a cluster, this is
 * typically `cluster.selfAddress.toString()` — every NodeAddress is
 * already unique within the cluster, so we can reuse it as the replica
 * id rather than minting a separate one.
 *
 * The CRDT operations themselves treat the id as opaque — any string
 * that's stable across a process's lifetime is fine.
 */
export type ReplicaId = string;
