import type { DurableStateStore } from '../persistence/DurableStateStore.js';
import type { Crdt, CrdtIdentityFunction, ReplicaId } from './Crdt.js';
import { decodeCrdt, type CrdtJson } from './DistributedData.js';

/**
 * Thin wrapper around `DurableStateStore` that persists ONE replica's
 * full key→CRDT view as a single durable record per replica.
 *
 * One record (vs. one record per key) keeps the recovery path simple
 * — `DurableStateStore` has no "list pids by prefix" capability, so a
 * per-key layout would need a separate index record + two-phase write
 * on every mutation.  For the typical DD workload (≤ 100 keys per
 * replica) the single-record layout is the simpler trade-off.
 *
 * High-frequency workloads can wrap the underlying `DurableStateStore`
 * with caching / batching (e.g. an in-process write coalescer) — the
 * `DurableStateStore` interface is what `DistributedData` plugs into,
 * so any wrapper that satisfies it composes here.
 *
 * **Revision tracking** is local — `DurableStateStore.upsert` requires
 * `expectedRevision`, so we cache the last-seen revision after every
 * load + save and bump it on each successful write.  Mirrors the
 * pattern used by `DurableStateOffsetStore` from #36.
 */
export class DurableDistributedDataStore {
  private revision = 0;

  constructor(
    private readonly store: DurableStateStore,
    private readonly replicaId: ReplicaId,
  ) {}

  /** Persistence id used inside the underlying `DurableStateStore`. */
  private get persistenceId(): string { return `ddata|${this.replicaId}`; }

  /**
   * Load the persisted state, decode each entry into a `Crdt<any>`,
   * and return the materialised `Map<key, Crdt>`.  Returns an empty
   * Map if nothing is stored yet.
   *
   * `identityFor` supplies the element identity to decode a key under — the
   * record carries the elements but not the closure that says how to
   * deduplicate them, so without it every set- and map-shaped value comes
   * back on `JSON.stringify` (#766).  A direct caller who knows its own
   * keys should pass one.
   *
   * **What it does not fix, and what does.**  `DistributedDataActor` passes
   * its per-key registry here, and at `preStart` that registry is empty for
   * every key — it is learned from `update`, and no update has run yet.  So
   * for the extension this parameter is a door, not the repair: a reloaded
   * key is put right by the re-key on its first `update`, which is where the
   * factory finally names an identity.  The parameter still matters, because
   * the alternative is a decode that *cannot* be told even when the caller
   * knows.
   */
  async load(
    identityFor: (key: string) => CrdtIdentityFunction | undefined = () => undefined,
  ): Promise<Map<string, Crdt<any>>> {
    const option = await this.store.load<DurableDDataPayload>(this.persistenceId);
    if (option.isNone()) return new Map();
    const out = new Map<string, Crdt<any>>();
    // Decode first, adopt the revision only once every entry is in.
    //
    // Assigning it up front looks harmless but destroys the data: a decode
    // that throws leaves the caller with no state and this store holding a
    // *valid* revision, so the next save of the now-empty view satisfies the
    // optimistic-concurrency check and overwrites the persisted record.  The
    // failure is swallowed as a warning upstream, so a single undecodable
    // entry silently wipes the whole durable replica (#725).
    for (const [key, json] of Object.entries(option.value.state.entries)) {
      out.set(key, decodeCrdt(json, identityFor(key)));
    }
    this.revision = option.value.revision;
    return out;
  }

  /**
   * Persist the supplied map.  Encodes each value via its `toJSON()`
   * method (every CRDT in the bundle ships a stable JSON shape) and
   * upserts as a single record.
   *
   * Throws if the underlying store rejects the write (concurrency
   * conflict — but in practice we're the only writer per replica
   * because the `DistributedDataActor` serialises mutations on its
   * own mailbox).
   */
  async save(map: ReadonlyMap<string, Crdt<any>>): Promise<void> {
    // Same reason as `gossipTick`: assigning into an object literal loses the
    // key `__proto__` to the inherited setter, so a store key an application
    // derived from untrusted input was absent from every snapshot and
    // disappeared across a restart the replica had reported it surviving
    // (#767).  `Object.fromEntries` defines the property instead.
    const entries = Object.fromEntries(
      Array.from(map, ([key, crdt]) => [key, crdt.toJSON() as CrdtJson] as const),
    ) as Record<string, CrdtJson>;
    const written = await this.store.upsert<DurableDDataPayload>(
      this.persistenceId, this.revision, { entries },
    );
    this.revision = written.revision;
  }

  /** Forget the persisted state for this replica.  Idempotent. */
  async clear(): Promise<void> {
    await this.store.delete(this.persistenceId);
    this.revision = 0;
  }
}

/** What goes into the durable record. */
type DurableDDataPayload = {
  readonly entries: Record<string, CrdtJson>;
};

// (decodeCrdt is now imported from DistributedData.ts — single source
// of truth for the CRDT-kind dispatcher.  Adding a new CRDT type means
// updating that one switch and nowhere else.)
