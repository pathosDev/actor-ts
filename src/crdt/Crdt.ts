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

  /**
   * The identity function this instance deduplicates by, or `undefined`
   * when it is still on the built-in `JSON.stringify` default.
   *
   * **Why the contract needs this at all.**  `identity` is not on the wire
   * and cannot be — it is a closure.  A decoder therefore has to be *told*
   * which one to file elements under, and the only place that knowledge
   * exists is the `factory` the application already hands
   * `DistributedData.update`.  This accessor is what turns that factory into
   * something `decodeCrdt` can use, which is why deriving the identity needs
   * no new method on `DistributedDataHandle` (#766).
   *
   * **Why optional, and why `undefined` for the default.**  Four of the nine
   * bundled CRDTs — the two counters and the two registers — have no notion
   * of element identity, so a required member would be four stub methods and
   * a breaking change for every CRDT outside this repository.  Reporting
   * `undefined` rather than the default function is what lets a caller ask
   * *"was one configured?"* without a shared sentinel: each implementation
   * declares its own module-local `defaultIdentity`, so comparing across
   * files would never match.
   */
  customIdentity?(): CrdtIdentityFunction | undefined;
}

/**
 * Maps an element (or a map key) to the string a set- or map-shaped CRDT
 * files it under — the `identity` option every such type accepts.
 *
 * The parameter is `any` rather than `unknown` on purpose.  Parameters are
 * contravariant, so an `ORSet<CartItem>`'s `(item: CartItem) => string` is
 * *not* assignable to `(value: unknown) => string`; a decoder reading the
 * function back off an erased `Crdt<any>` has no element type left to name.
 * This alias sits at that erasure boundary — the same one `decodeCrdt`'s
 * `Crdt<any>` return type already lives on — and every value that reaches it
 * came off the wire as `unknown` anyway.
 */
export type CrdtIdentityFunction = (value: any) => string;

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
