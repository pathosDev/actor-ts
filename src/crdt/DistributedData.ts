import { match, P } from 'ts-pattern';
import { Actor } from '../Actor.js';
import type { ActorRef } from '../ActorRef.js';
import type { ActorSystem } from '../ActorSystem.js';
import type { Cancellable } from '../Scheduler.js';
import { extensionId, type Extension, type ExtensionId } from '../Extension.js';
import { DEFAULT_ASK_TIMEOUT_MS } from '../util/Constants.js';
import type { DistributedDataOptions, DistributedDataOptionsType } from './DistributedDataOptions.js';
import { Props } from '../Props.js';
import type { Cluster } from '../cluster/Cluster.js';
import { MemberRemoved, MemberUp } from '../cluster/ClusterEvents.js';
import { NodeAddress } from '../cluster/NodeAddress.js';
import type { WireMessage } from '../cluster/Protocol.js';
import type { Crdt } from './Crdt.js';
import { DurableDistributedDataStore } from './DurableDistributedDataStore.js';
import { GCounter, type GCounterJson } from './GCounter.js';
import { GCounterMap, type GCounterMapJson } from './GCounterMap.js';
import { PNCounter, type PNCounterJson } from './PNCounter.js';
import { GSet, type GSetJson } from './GSet.js';
import { ORSet, type ORSetJson } from './ORSet.js';
import { ORMap, type ORMapJson } from './ORMap.js';
import { LWWRegister, type LWWRegisterJson } from './LWWRegister.js';
import { LWWMap, type LWWMapJson } from './LWWMap.js';
import { MVRegister, type MVRegisterJson } from './MVRegister.js';

/* =========================== JSON discriminator ======================== */

/** Discriminated union of every CRDT's wire representation. */
export type CrdtJson =
  | GCounterJson
  | PNCounterJson
  | GSetJson
  | ORSetJson
  | LWWRegisterJson<unknown>
  | GCounterMapJson
  | LWWMapJson<unknown>
  | MVRegisterJson<unknown>
  | ORMapJson;

/**
 * Reconstruct a CRDT from its `toJSON()` payload.  Dispatches on the
 * `kind` discriminator each impl writes — adding a new CRDT type is
 * one more case here.  Returned as `Crdt<unknown>` because the
 * concrete type is only known at the call site that asked for the
 * key in the first place.
 *
 * Exported so containers like `ORMap` (whose values are themselves
 * CRDTs of arbitrary kind) can wire it as their inner-value decoder.
 *
 * ## Reference example: discriminated-union dispatch
 *
 * This function is the **codebase's reference shape** for
 * dispatching on a closed string-literal-discriminator union.  Two
 * properties matter:
 *
 *   1. **No `default` arm** — the switch lists every kind explicitly.
 *      The `default` branch's `const _exhaustive: never = json`
 *      assertion gives compile-time exhaustiveness: TypeScript
 *      narrows `json` to `never` after all real arms; adding a new
 *      variant to `CrdtJson` without a matching `case` makes
 *      `json` *not* assignable to `never` and the file fails to
 *      compile.
 *
 *   2. **`throw` inside the default** — defensive belt-and-braces
 *      for the type-erasure boundary (legacy wire data, force-casts).
 *      Unreachable from well-typed callers.
 *
 * Equivalent shape: `match(json).with({ kind: 'X' }, ...).exhaustive()`
 * from `ts-pattern`.  Used elsewhere in the codebase when the
 * discriminator is more complex than a string literal (e.g. nominal
 * type via `instanceof`).  Both forms achieve compile-time
 * exhaustiveness; pick the more readable one per site.
 *
 * **Do not** add a permissive `default` case that returns a stub —
 * it defeats the exhaustiveness check and turns missing variants
 * into silent runtime bugs.
 */
export function decodeCrdt(json: CrdtJson): Crdt<any> {
  switch (json.kind) {
    case 'GCounter':    return GCounter.fromJSON(json);
    case 'PNCounter':   return PNCounter.fromJSON(json);
    case 'GSet':        return GSet.fromJSON<unknown>(json);
    case 'ORSet':       return ORSet.fromJSON<unknown>(json);
    case 'LWWRegister': return LWWRegister.fromJSON<unknown>(json);
    case 'GCounterMap': return GCounterMap.fromJSON<unknown>(json);
    case 'LWWMap':      return LWWMap.fromJSON<unknown, unknown>(json);
    case 'MVRegister':  return MVRegister.fromJSON<unknown>(json);
    case 'ORMap':       return ORMap.fromJSON<unknown, Crdt<any>>(
      json,
      // Inner CRDTs decode through the same dispatcher — a value can
      // be any of the registered CRDT kinds.
      (inner) => decodeCrdt(inner as CrdtJson) as Crdt<any>,
    );
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

/* ====================== quorum write / read wire ======================= */

/**
 * Quorum-write request — sent by the originator of a
 * `updateAsync(..., { consistency: 'majority' | 'all' | { from } })`
 * call to every other up-member.  Each receiver merges `value` into
 * its local replica (same merge as gossip) and replies with a
 * `DDataWriteAckMsg` carrying the same `pendingId` so the originator
 * can match it to the pending write.
 */
interface DDataWriteRequestMsg {
  readonly t: 'ddata-write-request';
  readonly from: ReturnType<NodeAddress['toJSON']>;
  readonly pendingId: string;
  readonly key: string;
  readonly value: CrdtJson;
}

interface DDataWriteAckMsg {
  readonly t: 'ddata-write-ack';
  readonly from: ReturnType<NodeAddress['toJSON']>;
  readonly pendingId: string;
  readonly key: string;
}

/**
 * Quorum-read request — sent by the originator of a
 * `getAsync(..., { consistency: ... })` call to every other
 * up-member.  Each receiver replies with its current local value
 * (or `null` if it has no entry) so the originator can merge the
 * responses and return the result.
 */
interface DDataReadRequestMsg {
  readonly t: 'ddata-read-request';
  readonly from: ReturnType<NodeAddress['toJSON']>;
  readonly pendingId: string;
  readonly key: string;
}

interface DDataReadResponseMsg {
  readonly t: 'ddata-read-response';
  readonly from: ReturnType<NodeAddress['toJSON']>;
  readonly pendingId: string;
  readonly key: string;
  readonly value: CrdtJson | null;
}

/* ============================== consistency =========================== */

/**
 * Quorum target for `updateAsync` / `getAsync`.
 *
 *   - `'local'` — return immediately after applying locally.  Equivalent
 *     to the sync `update` / `get` API, kept for API symmetry.
 *   - `'majority'` — wait for `floor(N/2)+1` replicas (incl. self).
 *   - `'all'` — wait for every up-member.
 *   - `{ from: K }` — wait for `K` replicas (clamped to `[1, N]`).
 *
 * `N` is `cluster.upMembers().length` at the moment the call starts.
 * Self always counts as the first ack (the local apply is synchronous),
 * so a single-node cluster resolves immediately regardless of the
 * chosen consistency level.
 */
export type WriteConsistency =
  | 'local'
  | 'majority'
  | 'all'
  | { readonly from: number };

export type ReadConsistency = WriteConsistency;

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

  start(
    cluster: Cluster,
    options: DistributedDataOptions = {},
  ): DistributedDataHandle {
    if (this._handle && this._cluster === cluster) return this._handle;
    if (this._handle) {
      throw new Error('DistributedData is already bound to a different cluster');
    }
    this._cluster = cluster;
    const settings = (options as Partial<DistributedDataOptionsType>);

    // The extension exposes a synchronous API; the internal actor owns
    // the state and the gossip loop.  We hand the actor a setter for a
    // shared "view" the public handle reads, so callers don't have to
    // ask().
    const view: SharedView = { state: new Map(), listeners: new Map() };
    const ref = this.system.spawn(
      Props.create(() => new DistributedDataActor({ cluster, settings, view })),
      'distributed-data',
    );
    // Register wire handlers SYNCHRONOUSLY here — `spawn` returns
    // before the actor's async `preStart` has run, but quorum
    // writes/reads need every peer to already be routing inbound
    // requests by the time the originator sends them.  Forwarding via
    // `ref.tell(...)` instead of `self.tell(...)` is safe: messages
    // queued before preStart completes wait in the mailbox.
    const unsubs: Array<() => void> = [];
    for (const kind of [
      'ddata-gossip',
      'ddata-write-request',
      'ddata-write-ack',
      'ddata-read-request',
      'ddata-read-response',
    ] as const) {
      unsubs.push(cluster._onWire(kind, (msg) => {
        ref.tell(msg as unknown as ActorMsg);
      }));
    }
    this._handle = new DistributedDataHandle(ref, view, cluster, unsubs);
    return this._handle;
  }

  /** Tear down the wire-handler subscriptions (test/shutdown only). */
  stop(): void {
    if (this._handle) {
      this._handle._stopWireHandlers();
    }
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
  /**
   * Optional quorum settings.  When present, the update runs as a
   * quorum write — the actor broadcasts the merged value to peers,
   * collects acks, and only then resolves the user's promise.  When
   * absent, behaves like the legacy sync path (apply locally + let
   * gossip carry the value eventually).
   */
  readonly quorum?: {
    readonly pendingId: string;
    readonly consistency: WriteConsistency;
    readonly timeoutMs: number;
    readonly resolve: () => void;
    readonly reject: (err: Error) => void;
  };
}
interface DeleteMsg { readonly t: 'ddata-delete'; readonly key: string }
/** Out-of-mailbox: a quorum-read user call.  See {@link DistributedDataHandle.getAsync}. */
interface ReadMsg {
  readonly t: 'ddata-read';
  readonly key: string;
  readonly pendingId: string;
  readonly consistency: ReadConsistency;
  readonly timeoutMs: number;
  readonly resolve: (value: Crdt<any> | undefined) => void;
  readonly reject: (err: Error) => void;
}
type ActorMsg =
  | UpdateMsg
  | DeleteMsg
  | ReadMsg
  | DDataGossipMsg
  | DDataWriteRequestMsg
  | DDataWriteAckMsg
  | DDataReadRequestMsg
  | DDataReadResponseMsg;

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
    private wireUnsubs: ReadonlyArray<() => void> = [],
  ) {}

  /** @internal — called by the extension's `stop()`. */
  _stopWireHandlers(): void {
    for (const u of this.wireUnsubs) u();
    this.wireUnsubs = [];
  }

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
   * Quorum-write variant of {@link update}.  Returns a promise that
   * resolves only after the requested number of replicas have
   * acknowledged the merge.  Self always counts as the first ack, so
   * single-node clusters and `consistency: 'local'` resolve as soon as
   * the local apply is done.
   *
   * Rejects with a timeout error if not enough acks arrive within
   * `timeoutMs` (default `gossipIntervalMs × 5`).  A timeout does NOT
   * roll the local write back — the value is already applied locally
   * and will continue to gossip; the rejection only signals "I'm not
   * sure enough replicas saw it".
   *
   *   await dd.updateAsync<GCounter>('hits', GCounter.empty,
   *     (c) => c.increment(dd.selfReplicaId(), 1),
   *     { consistency: 'majority' });
   */
  updateAsync<C extends Crdt<C>>(
    key: string,
    factory: CrdtFactory<C>,
    fn: (current: C) => C,
    opts: { readonly consistency: WriteConsistency; readonly timeoutMs?: number } = {
      consistency: 'local',
    },
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const pendingId = nextPendingId();
      const timeoutMs = opts.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
      this.ref.tell({
        t: 'ddata-update', key,
        factory: factory as unknown as CrdtFactory<Crdt<any>>,
        fn: fn as unknown as (c: Crdt<any>) => Crdt<any>,
        quorum: {
          pendingId, consistency: opts.consistency, timeoutMs,
          resolve, reject,
        },
      });
    });
  }

  /**
   * Quorum-read variant of {@link get}.  Sends a read request to peers
   * matching the consistency target, merges all incoming responses
   * (plus the local replica), and resolves with the merged value.
   * `undefined` if no replica knows the key.
   *
   * Self always counts as the first response — `'local'` returns
   * immediately with whatever's in the local view.  Timeout default is
   * the same as {@link updateAsync}.
   *
   *   const cart = await dd.getAsync<ORSet<string>>('cart-42',
   *     { consistency: 'majority' });
   */
  getAsync<C extends Crdt<C>>(
    key: string,
    opts: { readonly consistency: ReadConsistency; readonly timeoutMs?: number } = {
      consistency: 'local',
    },
  ): Promise<C | undefined> {
    return new Promise<C | undefined>((resolve, reject) => {
      const pendingId = nextPendingId();
      const timeoutMs = opts.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
      this.ref.tell({
        t: 'ddata-read', key, pendingId,
        consistency: opts.consistency, timeoutMs,
        resolve: resolve as (v: Crdt<any> | undefined) => void,
        reject,
      });
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

/**
 * Pending quorum-write — produced by `updateAsync` and tracked until
 * either enough peer acks arrive or the timeout fires.  `acks` is a
 * set of `address.toString()` so duplicates from a flaky peer count
 * once; self always counts as the first ack.
 */
interface PendingWrite {
  readonly kind: 'write';
  readonly key: string;
  readonly required: number;
  readonly acks: Set<string>;
  readonly timer: Cancellable;
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
}

/**
 * Pending quorum-read — produced by `getAsync`.  Collects local +
 * peer values and merges them when either the quorum count is met or
 * the timeout fires.  `merged` accumulates as responses arrive so the
 * timeout path can still resolve with a partial answer (best-effort)
 * — we treat reads as "best-available" rather than strict.
 */
interface PendingRead {
  readonly kind: 'read';
  readonly key: string;
  readonly required: number;
  readonly responses: Set<string>;
  readonly timer: Cancellable;
  merged: Crdt<any> | undefined;
  readonly resolve: (value: Crdt<any> | undefined) => void;
  readonly reject: (err: Error) => void;
}

class DistributedDataActor extends Actor<ActorMsg> {
  private readonly cluster: Cluster;
  private readonly view: SharedView;
  private readonly gossipIntervalMs: number;
  private readonly durable: DurableDistributedDataStore | null;
  private gossipTimer: Cancellable | null = null;
  private unsubscribeCluster: (() => void) | null = null;
  /** Set while a durable save is in flight; subsequent changes set
   *  `_durableDirty = true` so the in-flight save is followed by a
   *  catch-up save instead of multiple overlapping saves. */
  private durableSaveInFlight = false;
  private durableDirty = false;
  /** Outstanding quorum-write requests, keyed by pendingId. */
  private readonly pendingWrites = new Map<string, PendingWrite>();
  /** Outstanding quorum-read requests, keyed by pendingId. */
  private readonly pendingReads = new Map<string, PendingRead>();

  constructor(public readonly settings: {
    cluster: Cluster;
    settings: DistributedDataOptionsType;
    view: SharedView;
  }) {
    super();
    this.cluster = settings.cluster;
    this.view = settings.view;
    this.gossipIntervalMs = settings.settings.gossipInterval ?? 1_000;
    this.durable = settings.settings.durableStore
      ? new DurableDistributedDataStore(
          settings.settings.durableStore,
          this.cluster.selfAddress.toString(),
        )
      : null;
  }

  override async preStart(): Promise<void> {
    // Wire handlers are registered in the extension's `start()` so they're
    // ready BEFORE the user can issue the first quorum write — registering
    // them here would race with `updateAsync` called immediately after
    // `extension.start()` returns.
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
    this.unsubscribeCluster?.();
    this.gossipTimer?.cancel();
    // Reject any still-pending quorum requests so callers don't hang.
    for (const w of this.pendingWrites.values()) {
      w.timer.cancel();
      w.reject(new Error(`DistributedData stopped before quorum write on "${w.key}" completed`));
    }
    this.pendingWrites.clear();
    for (const r of this.pendingReads.values()) {
      r.timer.cancel();
      r.reject(new Error(`DistributedData stopped before quorum read on "${r.key}" completed`));
    }
    this.pendingReads.clear();
  }

  override onReceive(msg: ActorMsg): void {
    match(msg)
      .with({ t: 'ddata-update' }, (m) => this.handleUpdate(m))
      .with({ t: 'ddata-delete' }, (m) => this.handleDelete(m))
      .with({ t: 'ddata-read' }, (m) => this.handleRead(m))
      .with({ t: 'ddata-gossip' }, (m) => this.handleGossip(m))
      .with({ t: 'ddata-write-request' }, (m) => this.handleWriteRequest(m))
      .with({ t: 'ddata-write-ack' }, (m) => this.handleWriteAck(m))
      .with({ t: 'ddata-read-request' }, (m) => this.handleReadRequest(m))
      .with({ t: 'ddata-read-response' }, (m) => this.handleReadResponse(m))
      .exhaustive();
  }

  private handleUpdate(msg: UpdateMsg): void {
    const current = this.view.state.get(msg.key) ?? msg.factory();
    const next = msg.fn(current);
    this.applyMerged(msg.key, current, next);
    if (!msg.quorum) return;

    // Quorum write: self-vote counts as the first ack.  If only self
    // is needed (single-node, or 'local'), resolve immediately;
    // otherwise broadcast a write-request to peers and arm a timer.
    const peers = this.cluster.upMembers()
      .filter((m) => !m.address.equals(this.cluster.selfAddress));
    const totalN = 1 + peers.length;
    const required = clampQuorum(msg.quorum.consistency, totalN);
    const acks = new Set<string>([this.cluster.selfAddress.toString()]);
    if (acks.size >= required) {
      msg.quorum.resolve();
      return;
    }
    const timer = this.system.scheduler.scheduleOnceFn(msg.quorum.timeoutMs, () => {
      const pending = this.pendingWrites.get(msg.quorum!.pendingId);
      if (!pending) return;
      this.pendingWrites.delete(msg.quorum!.pendingId);
      pending.reject(new Error(
        `DistributedData quorum write on "${msg.key}" timed out after ${msg.quorum!.timeoutMs}ms ` +
        `(${pending.acks.size}/${pending.required} acks)`,
      ));
    });
    this.pendingWrites.set(msg.quorum.pendingId, {
      kind: 'write', key: msg.key, required, acks, timer,
      resolve: msg.quorum.resolve, reject: msg.quorum.reject,
    });
    const wire: DDataWriteRequestMsg = {
      t: 'ddata-write-request',
      from: this.cluster.selfAddress.toJSON(),
      pendingId: msg.quorum.pendingId,
      key: msg.key,
      value: next.toJSON() as CrdtJson,
    };
    for (const peer of peers) {
      this.cluster.transport.send(peer.address, wire as unknown as WireMessage);
    }
  }

  private handleRead(msg: ReadMsg): void {
    const peers = this.cluster.upMembers()
      .filter((m) => !m.address.equals(this.cluster.selfAddress));
    const totalN = 1 + peers.length;
    const required = clampQuorum(msg.consistency, totalN);
    const localValue = this.view.state.get(msg.key);
    const responses = new Set<string>([this.cluster.selfAddress.toString()]);
    if (responses.size >= required) {
      msg.resolve(localValue);
      return;
    }
    const timer = this.system.scheduler.scheduleOnceFn(msg.timeoutMs, () => {
      const pending = this.pendingReads.get(msg.pendingId);
      if (!pending) return;
      this.pendingReads.delete(msg.pendingId);
      // Best-effort: resolve with whatever we've merged so far rather
      // than rejecting outright.  Reads are forgiving — a partial
      // answer is more useful than no answer for most workloads.  If
      // *nothing* came back (not even local), keep undefined.
      pending.resolve(pending.merged);
    });
    this.pendingReads.set(msg.pendingId, {
      kind: 'read', key: msg.key, required, responses, timer,
      merged: localValue,
      resolve: msg.resolve, reject: msg.reject,
    });
    const wire: DDataReadRequestMsg = {
      t: 'ddata-read-request',
      from: this.cluster.selfAddress.toJSON(),
      pendingId: msg.pendingId,
      key: msg.key,
    };
    for (const peer of peers) {
      this.cluster.transport.send(peer.address, wire as unknown as WireMessage);
    }
  }

  private handleWriteRequest(msg: DDataWriteRequestMsg): void {
    // Merge the incoming value into our local replica (same merge
    // semantics as gossip) and ack back.
    const incoming = decodeCrdt(msg.value);
    const current = this.view.state.get(msg.key);
    const merged = current ? current.merge(incoming) : incoming;
    this.applyMerged(msg.key, current ?? null, merged);
    const sender = NodeAddress.fromJSON(msg.from);
    const ack: DDataWriteAckMsg = {
      t: 'ddata-write-ack',
      from: this.cluster.selfAddress.toJSON(),
      pendingId: msg.pendingId,
      key: msg.key,
    };
    this.cluster.transport.send(sender, ack as unknown as WireMessage);
  }

  private handleWriteAck(msg: DDataWriteAckMsg): void {
    const pending = this.pendingWrites.get(msg.pendingId);
    if (!pending) return; // late ack after timeout / already resolved
    const senderAddr = NodeAddress.fromJSON(msg.from).toString();
    if (pending.acks.has(senderAddr)) return; // dedupe
    pending.acks.add(senderAddr);
    if (pending.acks.size >= pending.required) {
      pending.timer.cancel();
      this.pendingWrites.delete(msg.pendingId);
      pending.resolve();
    }
  }

  private handleReadRequest(msg: DDataReadRequestMsg): void {
    const local = this.view.state.get(msg.key);
    const sender = NodeAddress.fromJSON(msg.from);
    const response: DDataReadResponseMsg = {
      t: 'ddata-read-response',
      from: this.cluster.selfAddress.toJSON(),
      pendingId: msg.pendingId,
      key: msg.key,
      value: local ? (local.toJSON() as CrdtJson) : null,
    };
    this.cluster.transport.send(sender, response as unknown as WireMessage);
  }

  private handleReadResponse(msg: DDataReadResponseMsg): void {
    const pending = this.pendingReads.get(msg.pendingId);
    if (!pending) return;
    const senderAddr = NodeAddress.fromJSON(msg.from).toString();
    if (pending.responses.has(senderAddr)) return; // dedupe
    pending.responses.add(senderAddr);
    if (msg.value !== null) {
      const incoming = decodeCrdt(msg.value);
      pending.merged = pending.merged ? pending.merged.merge(incoming) : incoming;
    }
    if (pending.responses.size >= pending.required) {
      pending.timer.cancel();
      this.pendingReads.delete(msg.pendingId);
      // Also apply the merged value locally so the next sync `get`
      // sees the freshest view — a quorum read effectively pulls the
      // latest state to this replica without waiting for gossip.
      if (pending.merged) {
        const current = this.view.state.get(pending.key);
        this.applyMerged(pending.key, current ?? null,
          current ? current.merge(pending.merged) : pending.merged);
      }
      pending.resolve(pending.merged);
    }
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

/* ============================== helpers ============================== */

let _pendingCounter = 0;
function nextPendingId(): string {
  _pendingCounter = (_pendingCounter + 1) >>> 0;
  return `p${Date.now()}-${_pendingCounter}`;
}

/**
 * Translate a {@link WriteConsistency} / {@link ReadConsistency} value
 * into the integer ack count required, given the current up-member
 * cluster size `N` (incl. self).
 *
 *   - `'local'`     → 1            (just self)
 *   - `'majority'`  → floor(N/2)+1
 *   - `'all'`       → N
 *   - `{ from: K }` → clamp(K, 1, N)
 */
function clampQuorum(c: WriteConsistency | ReadConsistency, totalN: number): number {
  if (c === 'local') return 1;
  if (c === 'majority') return Math.floor(totalN / 2) + 1;
  if (c === 'all') return totalN;
  // { from: K }
  const k = Math.trunc(c.from);
  if (!Number.isFinite(k) || k < 1) return 1;
  if (k > totalN) return totalN;
  return k;
}
