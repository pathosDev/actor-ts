import { match, P } from 'ts-pattern';
import { Actor } from '../Actor.js';
import type { ActorRef } from '../ActorRef.js';
import type { ActorSystem } from '../ActorSystem.js';
import type { DurableStateStore } from '../persistence/DurableStateStore.js';
import type { Cancellable } from '../Scheduler.js';
import { extensionId, type Extension, type ExtensionId } from '../Extension.js';
import { Props } from '../Props.js';
import type { Cluster } from '../cluster/Cluster.js';
import { MemberRemoved, MemberUp } from '../cluster/ClusterEvents.js';
import { NodeAddress } from '../cluster/NodeAddress.js';
import type { WireMessage } from '../cluster/Protocol.js';
import type { Crdt } from './Crdt.js';
import { DurableDistributedDataStore } from './DurableDistributedDataStore.js';
import { GCounter, type GCounterJson } from './GCounter.js';
import { PNCounter, type PNCounterJson } from './PNCounter.js';
import { GSet, type GSetJson } from './GSet.js';
import { ORSet, type ORSetJson } from './ORSet.js';
import { LWWRegister, type LWWRegisterJson } from './LWWRegister.js';

/* =========================== JSON discriminator ======================== */

/** Discriminated union of every CRDT's wire representation. */
export type CrdtJson =
  | GCounterJson
  | PNCounterJson
  | GSetJson
  | ORSetJson
  | LWWRegisterJson<unknown>;

/**
 * Reconstruct a CRDT from its `toJSON()` payload.  Dispatches on the
 * `kind` discriminator each impl writes — adding a new CRDT type is
 * one more case here.  Returned as `Crdt<unknown>` because the
 * concrete type is only known at the call site that asked for the
 * key in the first place.
 */
function decodeCrdt(json: CrdtJson): Crdt<any> {
  switch (json.kind) {
    case 'GCounter':    return GCounter.fromJSON(json);
    case 'PNCounter':   return PNCounter.fromJSON(json);
    case 'GSet':        return GSet.fromJSON<unknown>(json);
    case 'ORSet':       return ORSet.fromJSON<unknown>(json);
    case 'LWWRegister': return LWWRegister.fromJSON<unknown>(json);
    default: {
      const _exhaustive: never = json;
      void _exhaustive;
      throw new Error(`decodeCrdt: unknown CRDT kind`);
    }
  }
}

/**
 * Empty-CRDT factory.  Callers pass this to `update(key, factory, fn)`
 * so the extension can materialize a brand-new CRDT for a key that
 * doesn't exist yet — without DistributedData itself needing to know
 * about every CRDT type.
 *
 *   GCounter.empty       satisfies CrdtFactory<GCounter>
 *   () => ORSet.empty()  satisfies CrdtFactory<ORSet<X>>
 */
export type CrdtFactory<C extends Crdt<C>> = () => C;

/* ============================== gossip wire ============================ */

/**
 * One gossip round = a snapshot of every key this replica currently
 * knows.  Receivers merge each entry into their own state.
 *
 * Deliberately simple: no digest, no delta — just push the full set
 * to one random peer per tick.  Cheap to implement and good enough
 * for the small-to-medium stores DistributedData is meant for.
 */
interface DDataGossipMsg {
  readonly t: 'ddata-gossip';
  readonly from: ReturnType<NodeAddress['toJSON']>;
  /** Keyed by user-key; payload is the CRDT's own JSON discriminator. */
  readonly entries: Record<string, CrdtJson>;
}

/* ============================== settings ============================== */

export interface DistributedDataSettings {
  /** Period between gossip pushes.  Default: 1 s. */
  readonly gossipIntervalMs?: number;
  /**
   * Optional durable backend.  When provided, the local CRDT view
   * is loaded from the store on `preStart` and re-saved after every
   * mutation (local update, gossip merge, delete).  Without this,
   * `DistributedData` is purely in-memory — a full cluster restart
   * (deploy / outage) starts every replica empty.
   *
   * The store is keyed by replica id, so each cluster member owns
   * its own durable record.  CRDT semantics handle convergence
   * across replicas via gossip — durability is per-replica.
   *
   * Plug in any of the existing `DurableStateStore` implementations:
   * `InMemoryDurableStateStore` for tests, the SQLite / Cassandra /
   * S3 / filesystem backends for production.
   */
  readonly durableStore?: DurableStateStore;
}

/* ============================== extension ============================== */

const dataActorPath = (systemName: string): string =>
  `actor-ts://${systemName}/user/distributed-data`;

/**
 * Cluster-wide replicated key-value store of CRDTs.  Each node hosts
 * one local replica.  `update(key, ...)` mutates the local replica
 * (idempotent, conflict-free), and gossip fans the state out so
 * every replica eventually agrees on `merge(...)` of all updates.
 *
 * **Lifecycle:** call `extension(DistributedDataId).start(cluster)`
 * once per process to spawn the internal gossip actor.  Subsequent
 * calls return the same handle.
 *
 *   const dd = system.extension(DistributedDataId).start(cluster);
 *   dd.update('cart-42', () => ORSet.empty<string>(),
 *     (cart) => cart.add(cluster.selfAddress.toString(), 'apple'));
 *   const cart = dd.get<ORSet<string>>('cart-42');
 *
 * **Limits / non-goals (v1):**
 *   - Full-state push on every gossip tick — fine for small stores.
 *   - No durable persistence: the store lives in memory.
 *   - No tombstone delete; `delete(key)` is best-effort and can be
 *     undone by an in-flight gossip from a peer who still has the
 *     key.  Plan a workload-specific tombstone pattern (typically
 *     embed deletion in the CRDT — e.g. `ORSet.remove`).
 */
export class DistributedData implements Extension {
  private _handle: DistributedDataHandle | null = null;
  private _cluster: Cluster | null = null;

  constructor(private readonly system: ActorSystem) {}

  start(cluster: Cluster, settings: DistributedDataSettings = {}): DistributedDataHandle {
    if (this._handle && this._cluster === cluster) return this._handle;
    if (this._handle) {
      throw new Error('DistributedData is already bound to a different cluster');
    }
    this._cluster = cluster;

    // The extension exposes a synchronous API; the internal actor owns
    // the state and the gossip loop.  We hand the actor a setter for a
    // shared "view" the public handle reads, so callers don't have to
    // ask().
    const view: SharedView = { state: new Map(), listeners: new Map() };
    const ref = this.system.actorOf(
      Props.create(() => new DistributedDataActor({ cluster, settings, view })),
      'distributed-data',
    );
    this._handle = new DistributedDataHandle(ref, view, cluster);
    return this._handle;
  }

  get(): DistributedDataHandle {
    if (!this._handle) {
      throw new Error('DistributedData.start(cluster) must be called first');
    }
    return this._handle;
  }

  isStarted(): boolean { return this._handle !== null; }
}

export const DistributedDataId: ExtensionId<DistributedData> = extensionId<DistributedData>(
  'actor-ts/crdt/distributed-data',
  (system) => new DistributedData(system),
);

/* ============================== handle ============================== */

/** Shared between actor + handle so reads stay synchronous. */
interface SharedView {
  state: Map<string, Crdt<any>>;
  listeners: Map<string, Set<(value: Crdt<any>) => void>>;
}

interface UpdateMsg {
  readonly t: 'ddata-update';
  readonly key: string;
  readonly factory: CrdtFactory<Crdt<any>>;
  readonly fn: (c: Crdt<any>) => Crdt<any>;
}
interface DeleteMsg { readonly t: 'ddata-delete'; readonly key: string }
type ActorMsg = UpdateMsg | DeleteMsg | DDataGossipMsg;

/**
 * Public handle returned from `extension.start(cluster)`.  Holds a
 * ref to the internal actor + a synchronously-readable view of the
 * replicated state.
 */
export class DistributedDataHandle {
  constructor(
    private readonly ref: ActorRef<ActorMsg>,
    private readonly view: SharedView,
    private readonly cluster: Cluster,
  ) {}

  /** Synchronously read the local replica's view of `key`. */
  get<C extends Crdt<C>>(key: string): C | undefined {
    return this.view.state.get(key) as C | undefined;
  }

  /**
   * Mutate `key` via `fn`.  If the key doesn't exist yet, `factory()`
   * is called to seed a fresh CRDT.  The mutation runs on the actor
   * thread so concurrent local callers serialize cleanly.
   */
  update<C extends Crdt<C>>(
    key: string, factory: CrdtFactory<C>, fn: (current: C) => C,
  ): void {
    this.ref.tell({
      t: 'ddata-update', key,
      factory: factory as unknown as CrdtFactory<Crdt<any>>,
      fn: fn as unknown as (c: Crdt<any>) => Crdt<any>,
    });
  }

  /**
   * Best-effort delete.  Forgets `key` on this replica only — peers
   * may re-introduce it via gossip.  See class header for the
   * tombstone story.
   */
  delete(key: string): void {
    this.ref.tell({ t: 'ddata-delete', key });
  }

  /**
   * Subscribe to changes for `key`.  Listener fires synchronously
   * after every successful update / merge that changes the local
   * value (deep-equal check via the CRDT's own `toJSON`).  Returns
   * an unsubscribe function.
   */
  subscribe<C extends Crdt<C>>(
    key: string, listener: (value: C) => void,
  ): () => void {
    let set = this.view.listeners.get(key);
    if (!set) { set = new Set(); this.view.listeners.set(key, set); }
    const wrapper = listener as unknown as (value: Crdt<any>) => void;
    set.add(wrapper);
    // Replay current value so a late subscriber catches up immediately.
    const current = this.view.state.get(key);
    if (current) {
      try { wrapper(current); } catch (e) { /* ignore in tests */ void e; }
    }
    return () => {
      const s = this.view.listeners.get(key);
      if (s) {
        s.delete(wrapper);
        if (s.size === 0) this.view.listeners.delete(key);
      }
    };
  }

  /** Snapshot of every key currently known on the local replica. */
  keys(): string[] {
    return Array.from(this.view.state.keys());
  }

  /** ReplicaId used when seeding ops (delegated from `cluster.selfAddress`). */
  selfReplicaId(): string {
    return this.cluster.selfAddress.toString();
  }
}

/* ============================== internal actor ======================== */

class DistributedDataActor extends Actor<ActorMsg> {
  private readonly cluster: Cluster;
  private readonly view: SharedView;
  private readonly gossipIntervalMs: number;
  private readonly durable: DurableDistributedDataStore | null;
  private gossipTimer: Cancellable | null = null;
  private unsubscribeWire: (() => void) | null = null;
  private unsubscribeCluster: (() => void) | null = null;
  /** Set while a durable save is in flight; subsequent changes set
   *  `_durableDirty = true` so the in-flight save is followed by a
   *  catch-up save instead of multiple overlapping saves. */
  private durableSaveInFlight = false;
  private durableDirty = false;

  constructor(public readonly settings: {
    cluster: Cluster;
    settings: DistributedDataSettings;
    view: SharedView;
  }) {
    super();
    this.cluster = settings.cluster;
    this.view = settings.view;
    this.gossipIntervalMs = settings.settings.gossipIntervalMs ?? 1_000;
    this.durable = settings.settings.durableStore
      ? new DurableDistributedDataStore(
          settings.settings.durableStore,
          this.cluster.selfAddress.toString(),
        )
      : null;
  }

  override async preStart(): Promise<void> {
    this.unsubscribeWire = this.cluster._onWire('ddata-gossip', (msg) => {
      this.self.tell(msg as unknown as DDataGossipMsg);
    });
    this.unsubscribeCluster = this.cluster.subscribe((evt) =>
      match(evt)
        .with(P.instanceOf(MemberUp), () => { /* trigger an early gossip */
          this.gossipTick();
        })
        .with(P.instanceOf(MemberRemoved), () => { /* nothing local to clean */ })
        .otherwise(() => { /* ignored */ }),
    );
    this.gossipTimer = this.system.scheduler.scheduleAtFixedRateFn(
      this.gossipIntervalMs, this.gossipIntervalMs, () => this.gossipTick(),
    );

    if (this.durable) {
      // Load + populate the in-memory view BEFORE accepting any
      // user-issued updates.  Subscribers registered after preStart
      // will see the recovered values via the handle's replay
      // mechanism (subscribe() fires once with the current value).
      try {
        const loaded = await this.durable.load();
        for (const [key, crdt] of loaded) {
          this.applyMerged(key, null, crdt);
        }
      } catch (err) {
        this.log.warn(`DistributedData: durable load failed`, err);
      }
    }
  }

  override postStop(): void {
    this.unsubscribeWire?.();
    this.unsubscribeCluster?.();
    this.gossipTimer?.cancel();
  }

  override onReceive(msg: ActorMsg): void {
    match(msg)
      .with({ t: 'ddata-update' }, (m) => this.handleUpdate(m))
      .with({ t: 'ddata-delete' }, (m) => this.handleDelete(m))
      .with({ t: 'ddata-gossip' }, (m) => this.handleGossip(m))
      .exhaustive();
  }

  private handleUpdate(msg: UpdateMsg): void {
    const current = this.view.state.get(msg.key) ?? msg.factory();
    const next = msg.fn(current);
    this.applyMerged(msg.key, current, next);
  }

  private handleDelete(msg: DeleteMsg): void {
    if (this.view.state.delete(msg.key)) {
      // Notify subscribers with a best-effort signal — we synthesise
      // a fresh CRDT via the most-recently-seen factory.  Since we
      // don't track factories per key, listeners just get nothing
      // for now; they'll see the next merge bring the key back if
      // a peer gossips it.
      this.scheduleDurableSave();
    }
  }

  private handleGossip(msg: DDataGossipMsg): void {
    const sender = NodeAddress.fromJSON(msg.from);
    if (sender.equals(this.cluster.selfAddress)) return; // shouldn't happen but harmless
    for (const [key, json] of Object.entries(msg.entries)) {
      const incoming = decodeCrdt(json);
      const current = this.view.state.get(key);
      const merged = current ? current.merge(incoming) : incoming;
      this.applyMerged(key, current ?? null, merged);
    }
  }

  private applyMerged(key: string, prev: Crdt<any> | null, next: Crdt<any>): void {
    // Skip the listener fan-out if the merge was a no-op.  Compare by
    // JSON shape — every CRDT's toJSON is a stable structural form.
    const prevJson = prev ? JSON.stringify(prev.toJSON()) : null;
    const nextJson = JSON.stringify(next.toJSON());
    this.view.state.set(key, next);
    if (prevJson === nextJson) return;
    // Persist the change.  If we're recovering from durable load
    // (preStart loop), this re-saves the same state we just loaded
    // — harmless and keeps the code path uniform.
    this.scheduleDurableSave();
    const listeners = this.view.listeners.get(key);
    if (!listeners) return;
    for (const l of listeners) {
      try { l(next); } catch (e) {
        this.log.warn(`DistributedData: subscriber for "${key}" threw`, e);
      }
    }
  }

  /**
   * Fire a durable save off the actor mailbox.  Coalesces overlapping
   * requests: if a save is already in flight, we mark `durableDirty`
   * and the in-flight save's `.finally` handler kicks off a follow-up.
   * Net effect: a burst of mutations produces 1-2 disk writes, not N.
   */
  private scheduleDurableSave(): void {
    if (!this.durable) return;
    if (this.durableSaveInFlight) {
      this.durableDirty = true;
      return;
    }
    this.durableSaveInFlight = true;
    const snapshot = new Map(this.view.state);
    void this.durable.save(snapshot)
      .catch((err) => {
        this.log.warn(`DistributedData: durable save failed`, err);
      })
      .finally(() => {
        this.durableSaveInFlight = false;
        if (this.durableDirty) {
          this.durableDirty = false;
          this.scheduleDurableSave();
        }
      });
  }

  private gossipTick(): void {
    const peers = this.cluster.upMembers()
      .filter((m) => !m.address.equals(this.cluster.selfAddress));
    if (peers.length === 0) return;
    const entries: Record<string, CrdtJson> = {};
    for (const [key, crdt] of this.view.state) {
      entries[key] = crdt.toJSON() as CrdtJson;
    }
    if (Object.keys(entries).length === 0) return;
    const payload: DDataGossipMsg = {
      t: 'ddata-gossip',
      from: this.cluster.selfAddress.toJSON(),
      entries,
    };
    const target = peers[Math.floor(Math.random() * peers.length)]!;
    this.cluster.transport.send(target.address, payload as unknown as WireMessage);
  }
}

void dataActorPath; // currently unused — reserved for envelope-routing variants
