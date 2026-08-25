/**
 * Where a store's data physically lives, relative to the nodes of a cluster.
 *
 * `'node-local'` — the store reads and writes storage only this process can
 * see: a SQLite file, an in-process map, a directory on the local disk.  Two
 * nodes running the same application then talk to two *different* databases,
 * and nothing ever conflicts across them — the optimistic head check compares
 * against the local store, so two divergent histories under one persistence
 * id accumulate with no error on either node.  The cluster's storage advisory
 * warns when such a store backs cluster-relevant persistent state (#1356).
 *
 * `'shared'` — the store speaks to a database service that every node with
 * the same configuration reaches (Postgres, Cassandra, S3, …).  A declaration
 * can only promise the *capability*; whether two nodes actually reached the
 * same instance of it is a runtime question, answered by the storage identity
 * (#1358), not by this type.
 *
 * The contracts carry this as an **optional** member, in the same
 * absence-is-meaningful family as `Journal.raiseCompactionMark` and
 * `Journal.events`: a store that does not declare its locality is *unknown*,
 * and the advisory stays silent rather than guessing — a third-party store
 * must never be misjudged by a default it did not choose.  It is a property
 * of the **instance**, not the class: one in-memory journal handed to several
 * in-process systems genuinely is shared storage, so the in-memory stores
 * leave the field writable for exactly that fixture shape.
 */
export type StorageLocality = 'node-local' | 'shared';
