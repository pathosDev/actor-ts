import type { DurableStateStore } from '../persistence/DurableStateStore.js';
import type { Crdt, ReplicaId } from './Crdt.js';
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
  private get pid(): string { return `ddata|${this.replicaId}`; }

  /**
   * Load the persisted state, decode each entry into a `Crdt<any>`,
   * and return the materialised `Map<key, Crdt>`.  Returns an empty
   * Map if nothing is stored yet.
   */
  async load(): Promise<Map<string, Crdt<any>>> {
    const opt = await this.store.load<DurableDDataPayload>(this.pid);
    if (opt.isNone()) return new Map();
    this.revision = opt.value.revision;
    const out = new Map<string, Crdt<any>>();
    for (const [key, json] of Object.entries(opt.value.state.entries)) {
      out.set(key, decodeCrdt(json));
    }
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
    const entries: Record<string, CrdtJson> = {};
    for (const [key, crdt] of map) {
      entries[key] = crdt.toJSON() as CrdtJson;
    }
    const written = await this.store.upsert<DurableDDataPayload>(
      this.pid, this.revision, { entries },
    );
    this.revision = written.revision;
  }

  /** Forget the persisted state for this replica.  Idempotent. */
  async clear(): Promise<void> {
    await this.store.delete(this.pid);
    this.revision = 0;
  }
}

/** What goes into the durable record. */
interface DurableDDataPayload {
  readonly entries: Record<string, CrdtJson>;
}

// (decodeCrdt is now imported from DistributedData.ts — single source
// of truth for the CRDT-kind dispatcher.  Adding a new CRDT type means
// updating that one switch and nowhere else.)
