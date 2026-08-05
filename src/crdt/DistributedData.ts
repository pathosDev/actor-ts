import { match, P } from 'ts-pattern';
import { Actor } from '../Actor.js';
import type { ActorRef } from '../ActorRef.js';
import { SystemActorNames, SystemGroups } from '../internal/SystemPaths.js';
import type { ActorSystem } from '../ActorSystem.js';
import type { Cancellable } from '../Scheduler.js';
import { extensionId, type Extension, type ExtensionId } from '../Extension.js';
import { DEFAULT_ASK_TIMEOUT_MS } from '../util/Constants.js';
import { randomId } from '../util/RandomString.js';
import { DistributedDataOptionsValidator } from './DistributedDataOptions.js';
import type { DistributedDataOptions, DistributedDataOptionsType } from './DistributedDataOptions.js';
import type { Cluster } from '../cluster/Cluster.js';
import { MemberRemoved, MemberUp } from '../cluster/ClusterEvents.js';
import { NodeAddress } from '../cluster/NodeAddress.js';
import type { WireMessage } from '../cluster/Protocol.js';
import type { Crdt } from './Crdt.js';
import { DurableDistributedDataStore } from './DurableDistributedDataStore.js';
import { CrdtDecodeError } from './CrdtWireValidation.js';
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
 *
 * The switch itself lives in {@link decodeCrdtAtDepth}, which carries the
 * nesting depth `ORMap` recursion has to bound; this is the entry point that
 * starts it at zero.
 */
export function decodeCrdt(json: CrdtJson): Crdt<any> {
  return decodeCrdtAtDepth(json, 0);
}

/**
 * Ceiling on nested `ORMap` levels.
 *
 * `decodeCrdt` recurses once per level, so without a bound a few MiB of
 * nested map headers exhausts the JS stack — inside the DistributedData
 * actor, from a single gossip frame (#721).  Real data is shallow; anything
 * approaching this is malformed or hostile.
 */
const MAX_CRDT_NESTING_DEPTH = 32;

function decodeCrdtAtDepth(json: CrdtJson, depth: number): Crdt<any> {
  if (depth > MAX_CRDT_NESTING_DEPTH) {
    throw new CrdtDecodeError(`CRDT nesting deeper than ${MAX_CRDT_NESTING_DEPTH} levels`);
  }
  if (typeof json !== 'object' || json === null) {
    throw new CrdtDecodeError('CRDT payload must be an object');
  }
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
      (inner) => decodeCrdtAtDepth(inner as CrdtJson, depth + 1) as Crdt<any>,
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
type DDataGossipMessage = {
  readonly kind: 'ddata-gossip';
  readonly from: ReturnType<NodeAddress['toJSON']>;
  /** Keyed by user-key; payload is the CRDT's own JSON discriminator. */
  readonly entries: Record<string, CrdtJson>;
};

/* ====================== quorum write / read wire ======================= */

/**
 * Quorum-write request — sent by the originator of a
 * `updateAsync(..., { consistency: 'majority' | 'all' | { from } })`
 * call to every other up-member.  Each receiver merges `value` into
 * its local replica (same merge as gossip) and replies with a
 * `DDataWriteAcknowledgmentMessage` carrying the same `pendingId` so the originator
 * can match it to the pending write.
 */
type DDataWriteRequestMessage = {
  readonly kind: 'ddata-write-request';
  readonly from: ReturnType<NodeAddress['toJSON']>;
  readonly pendingId: string;
  readonly key: string;
  readonly value: CrdtJson;
};

type DDataWriteAcknowledgmentMessage = {
  readonly kind: 'ddata-write-ack';
  readonly from: ReturnType<NodeAddress['toJSON']>;
  readonly pendingId: string;
  readonly key: string;
};

/**
 * Quorum-read request — sent by the originator of a
 * `getAsync(..., { consistency: ... })` call to every other
 * up-member.  Each receiver replies with its current local value
 * (or `null` if it has no entry) so the originator can merge the
 * responses and return the result.
 */
type DDataReadRequestMessage = {
  readonly kind: 'ddata-read-request';
  readonly from: ReturnType<NodeAddress['toJSON']>;
  readonly pendingId: string;
  readonly key: string;
};

type DDataReadResponseMessage = {
  readonly kind: 'ddata-read-response';
  readonly from: ReturnType<NodeAddress['toJSON']>;
  readonly pendingId: string;
  readonly key: string;
  readonly value: CrdtJson | null;
};

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
    const resolvedOptions = (options as Partial<DistributedDataOptionsType>);
    new DistributedDataOptionsValidator().validate(resolvedOptions);

    // The extension exposes a synchronous API; the internal actor owns
    // the state and the gossip loop.  We hand the actor a setter for a
    // shared "view" the public handle reads, so callers don't have to
    // ask().
    const view: SharedView = { state: new Map(), listeners: new Map() };
    const ref = this.system._spawnSystemActor(
      () => new DistributedDataActor({ cluster, options: resolvedOptions, view }),
      SystemGroups.clusterCrdt,
      SystemActorNames.distributedData,
    );
    // Register wire handlers SYNCHRONOUSLY here — `spawn` returns
    // before the actor's async `preStart` has run, but quorum
    // writes/reads need every peer to already be routing inbound
    // requests by the time the originator sends them.  Forwarding via
    // `ref.tell(...)` instead of `self.tell(...)` is safe: messages
    // queued before preStart completes wait in the mailbox.
    const unsubscribes: Array<() => void> = [];
    for (const kind of [
      'ddata-gossip',
      'ddata-write-request',
      'ddata-write-ack',
      'ddata-read-request',
      'ddata-read-response',
    ] as const) {
      unsubscribes.push(cluster._onWire(kind, (message, from) => {
        ref.tell({ kind: 'ddata-wire', peer: from, frame: message as unknown as DDataWireFrame });
      }));
    }
    this._handle = new DistributedDataHandle(ref, view, cluster, unsubscribes);
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
type SharedView = {
  state: Map<string, Crdt<any>>;
  listeners: Map<string, Set<(value: Crdt<any>) => void>>;
};

type UpdateMessage = {
  readonly kind: 'ddata-update';
  readonly key: string;
  readonly factory: CrdtFactory<Crdt<any>>;
  readonly fn: (c: Crdt<any>) => Crdt<any>;
  /**
   * Optional quorum options.  When present, the update runs as a
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
};
type DeleteMessage = { readonly kind: 'ddata-delete'; readonly key: string };
/** Out-of-mailbox: a quorum-read user call.  See {@link DistributedDataHandle.getAsync}. */
type ReadMessage = {
  readonly kind: 'ddata-read';
  readonly key: string;
  readonly pendingId: string;
  readonly consistency: ReadConsistency;
  readonly timeoutMs: number;
  readonly resolve: (value: Crdt<any> | undefined) => void;
  readonly reject: (err: Error) => void;
};
/** Every frame DistributedData registers a wire handler for. */
type DDataWireFrame =
  | DDataGossipMessage
  | DDataWriteRequestMessage
  | DDataWriteAcknowledgmentMessage
  | DDataReadRequestMessage
  | DDataReadResponseMessage;

/**
 * A wire frame together with the peer whose connection it arrived on.
 *
 * The wrapper exists because the authenticated identity has to survive the
 * trip through the actor's mailbox.  `Cluster._onWire` hands the handler
 * that peer, but the handler forwards with `ref.tell(...)` — so registering
 * a one-parameter arrow, as this extension did, drops the only trustworthy
 * thing about the frame and leaves the actor with the sender's self-declared
 * `from` (#719, #723).
 */
type WireFrameMessage = {
  readonly kind: 'ddata-wire';
  /** Connection-authenticated sender.  Not `frame.from`, which the sender writes. */
  readonly peer: NodeAddress;
  readonly frame: DDataWireFrame;
};

type ActorMessage =
  | UpdateMessage
  | DeleteMessage
  | ReadMessage
  | WireFrameMessage;

/**
 * Public handle returned from `extension.start(cluster)`.  Holds a
 * ref to the internal actor + a synchronously-readable view of the
 * replicated state.
 */
export class DistributedDataHandle {
  constructor(
    private readonly ref: ActorRef<ActorMessage>,
    private readonly view: SharedView,
    private readonly cluster: Cluster,
    private wireUnsubscribes: ReadonlyArray<() => void> = [],
  ) {}

  /** @internal — called by the extension's `stop()`. */
  _stopWireHandlers(): void {
    for (const unsubscribe of this.wireUnsubscribes) unsubscribe();
    this.wireUnsubscribes = [];
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
      kind: 'ddata-update', key,
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
    options: { readonly consistency: WriteConsistency; readonly timeoutMs?: number } = {
      consistency: 'local',
    },
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const pendingId = nextPendingId();
      const timeoutMs = options.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
      this.ref.tell({
        kind: 'ddata-update', key,
        factory: factory as unknown as CrdtFactory<Crdt<any>>,
        fn: fn as unknown as (c: Crdt<any>) => Crdt<any>,
        quorum: {
          pendingId, consistency: options.consistency, timeoutMs,
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
    options: { readonly consistency: ReadConsistency; readonly timeoutMs?: number } = {
      consistency: 'local',
    },
  ): Promise<C | undefined> {
    return new Promise<C | undefined>((resolve, reject) => {
      const pendingId = nextPendingId();
      const timeoutMs = options.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
      this.ref.tell({
        kind: 'ddata-read', key, pendingId,
        consistency: options.consistency, timeoutMs,
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
    this.ref.tell({ kind: 'ddata-delete', key });
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
      const listenerSet = this.view.listeners.get(key);
      if (listenerSet) {
        listenerSet.delete(wrapper);
        if (listenerSet.size === 0) this.view.listeners.delete(key);
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
type PendingWrite = {
  readonly kind: 'write';
  readonly key: string;
  readonly required: number;
  /**
   * Peers this request actually went to.  A reply used to be matched on its
   * correlation id alone, so any member could answer a quorum it was never
   * part of (#768).
   */
  readonly targets: ReadonlySet<string>;
  readonly acks: Set<string>;
  readonly timer: Cancellable;
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
};

/**
 * Pending quorum-read — produced by `getAsync`.  Collects local +
 * peer values and merges them when either the quorum count is met or
 * the timeout fires.  `merged` accumulates as responses arrive so the
 * timeout path can still resolve with a partial answer (best-effort)
 * — we treat reads as "best-available" rather than strict.
 */
type PendingRead = {
  /** Peers this request actually went to — see {@link PendingWrite.targets}. */
  readonly targets: ReadonlySet<string>;
  readonly kind: 'read';
  readonly key: string;
  readonly required: number;
  readonly responses: Set<string>;
  readonly timer: Cancellable;
  merged: Crdt<any> | undefined;
  readonly resolve: (value: Crdt<any> | undefined) => void;
  readonly reject: (err: Error) => void;
};

class DistributedDataActor extends Actor<ActorMessage> {
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

  constructor(public readonly options: {
    cluster: Cluster;
    options: DistributedDataOptionsType;
    view: SharedView;
  }) {
    super();
    this.view = options.view;
    this.gossipIntervalMs = options.options.gossipInterval ?? 1_000;
    this.durable = options.options.durableStore
      ? new DurableDistributedDataStore(
          options.options.durableStore,
          options.cluster.selfAddress.toString(),
        )
      : null;
  }

  /**
   * The cluster `DistributedData.start` was bound to, which is what this
   * actor must gossip over — not whatever `system.cluster` happens to
   * resolve to.  The two are the same in every normal setup; overriding
   * keeps them the same in the ones where they aren't (a test wiring two
   * clusters through one system).  Reading the parameter property rather
   * than a copy of it means there is still exactly one owner.
   */
  protected override get cluster(): Cluster { return this.options.cluster; }

  override async preStart(): Promise<void> {
    // Wire handlers are registered in the extension's `start()` so they're
    // ready BEFORE the user can issue the first quorum write — registering
    // them here would race with `updateAsync` called immediately after
    // `extension.start()` returns.
    this.unsubscribeCluster = this.cluster.subscribe((evt) =>
      match(evt)
        .with(P.instanceOf(MemberUp), () => this.onMemberUp())
        .with(P.instanceOf(MemberRemoved), () => this.onMemberRemoved())
        .otherwise(() => this.onOtherClusterEvent()),
    );
    this.gossipTimer = this.system.scheduler.scheduleAtFixedRateFunction(
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

  private onMemberUp(): void {
    /* trigger an early gossip */
    this.gossipTick();
  }

  private onMemberRemoved(): void {
    /* nothing local to clean */
  }

  private onOtherClusterEvent(): void {
    /* ignored */
  }

  override postStop(): void {
    this.unsubscribeCluster?.();
    this.gossipTimer?.cancel();
    // Reject any still-pending quorum requests so callers don't hang.
    for (const pendingWrite of this.pendingWrites.values()) {
      pendingWrite.timer.cancel();
      pendingWrite.reject(new Error(`DistributedData stopped before quorum write on "${pendingWrite.key}" completed`));
    }
    this.pendingWrites.clear();
    for (const pendingRead of this.pendingReads.values()) {
      pendingRead.timer.cancel();
      pendingRead.reject(new Error(`DistributedData stopped before quorum read on "${pendingRead.key}" completed`));
    }
    this.pendingReads.clear();
  }

  override onReceive(message: ActorMessage): void {
    match(message)
      .with({ kind: 'ddata-update' }, (m) => this.onUpdate(m))
      .with({ kind: 'ddata-delete' }, (m) => this.onDelete(m))
      .with({ kind: 'ddata-read' }, (m) => this.onRead(m))
      .with({ kind: 'ddata-wire' }, (m) => this.onWireFrame(m))
      .exhaustive();
  }

  /**
   * Inbound frame from a peer.  Every handler below takes the connection's
   * peer as a separate argument and must use it in preference to the
   * frame's own `from` — that field is the one an attacker fully controls.
   */
  private onWireFrame(envelope: WireFrameMessage): void {
    const { peer, frame } = envelope;
    match(frame)
      .with({ kind: 'ddata-gossip' }, (m) => this.onGossip(m, peer))
      .with({ kind: 'ddata-write-request' }, (m) => this.onWriteRequest(m, peer))
      .with({ kind: 'ddata-write-ack' }, (m) => this.onWriteAcknowledgment(m, peer))
      .with({ kind: 'ddata-read-request' }, (m) => this.onReadRequest(m, peer))
      .with({ kind: 'ddata-read-response' }, (m) => this.onReadResponse(m, peer))
      .exhaustive();
  }

  private onUpdate(message: UpdateMessage): void {
    const current = this.view.state.get(message.key) ?? message.factory();
    const next = message.fn(current);
    this.applyMerged(message.key, current, next);
    if (!message.quorum) return;

    // Quorum write: self-vote counts as the first ack.  If only self
    // is needed (single-node, or 'local'), resolve immediately;
    // otherwise broadcast a write-request to peers and arm a timer.
    const peers = this.cluster.upMembers()
      .filter((m) => !m.address.equals(this.cluster.selfAddress));
    const totalN = 1 + peers.length;
    const required = clampQuorum(message.quorum.consistency, totalN);
    const acks = new Set<string>([this.cluster.selfAddress.toString()]);
    if (acks.size >= required) {
      message.quorum.resolve();
      return;
    }
    const timer = this.system.scheduler.scheduleOnceFunction(message.quorum.timeoutMs, () => {
      const pending = this.pendingWrites.get(message.quorum!.pendingId);
      if (!pending) return;
      this.pendingWrites.delete(message.quorum!.pendingId);
      pending.reject(new Error(
        `DistributedData quorum write on "${message.key}" timed out after ${message.quorum!.timeoutMs}ms ` +
        `(${pending.acks.size}/${pending.required} acks)`,
      ));
    });
    this.pendingWrites.set(message.quorum.pendingId, {
      kind: 'write', key: message.key, required, acks, timer,
      targets: new Set(peers.map((m) => m.address.toString())),
      resolve: message.quorum.resolve, reject: message.quorum.reject,
    });
    const wire: DDataWriteRequestMessage = {
      kind: 'ddata-write-request',
      from: this.cluster.selfAddress.toJSON(),
      pendingId: message.quorum.pendingId,
      key: message.key,
      value: next.toJSON() as CrdtJson,
    };
    for (const peer of peers) {
      this.cluster.transport.send(peer.address, wire as unknown as WireMessage);
    }
  }

  private onRead(message: ReadMessage): void {
    const peers = this.cluster.upMembers()
      .filter((m) => !m.address.equals(this.cluster.selfAddress));
    const totalN = 1 + peers.length;
    const required = clampQuorum(message.consistency, totalN);
    const localValue = this.view.state.get(message.key);
    const responses = new Set<string>([this.cluster.selfAddress.toString()]);
    if (responses.size >= required) {
      message.resolve(localValue);
      return;
    }
    const timer = this.system.scheduler.scheduleOnceFunction(message.timeoutMs, () => {
      const pending = this.pendingReads.get(message.pendingId);
      if (!pending) return;
      this.pendingReads.delete(message.pendingId);
      // Best-effort: resolve with whatever we've merged so far rather
      // than rejecting outright.  Reads are forgiving — a partial
      // answer is more useful than no answer for most workloads.  If
      // *nothing* came back (not even local), keep undefined.
      pending.resolve(pending.merged);
    });
    this.pendingReads.set(message.pendingId, {
      kind: 'read', key: message.key, required, responses, timer,
      targets: new Set(peers.map((m) => m.address.toString())),
      merged: localValue,
      resolve: message.resolve, reject: message.reject,
    });
    const wire: DDataReadRequestMessage = {
      kind: 'ddata-read-request',
      from: this.cluster.selfAddress.toJSON(),
      pendingId: message.pendingId,
      key: message.key,
    };
    for (const peer of peers) {
      this.cluster.transport.send(peer.address, wire as unknown as WireMessage);
    }
  }

  private onWriteRequest(message: DDataWriteRequestMessage, peer: NodeAddress): void {
    // Merge the incoming value into our local replica (same merge
    // semantics as gossip) and ack back.
    const incoming = decodeCrdt(message.value);
    const current = this.view.state.get(message.key);
    const merged = current ? current.merge(incoming) : incoming;
    this.applyMerged(message.key, current ?? null, merged);
    // The ack goes back down the connection the request arrived on.  It used
    // to go to whatever address the payload named, so a peer could make this
    // node dial a host of its choosing and queue a full CRDT snapshot in a
    // `Connection.pending` buffer that is never drained (#723).
    const ack: DDataWriteAcknowledgmentMessage = {
      kind: 'ddata-write-ack',
      from: this.cluster.selfAddress.toJSON(),
      pendingId: message.pendingId,
      key: message.key,
    };
    this.cluster.transport.send(peer, ack as unknown as WireMessage);
  }

  private onWriteAcknowledgment(message: DDataWriteAcknowledgmentMessage, peer: NodeAddress): void {
    const pending = this.pendingWrites.get(message.pendingId);
    if (!pending) return; // late ack after timeout / already resolved
    // Counted per authenticated peer.  Keyed on the payload's `from`, one
    // member could forge a whole quorum by acking under other members'
    // names and have its own CRDT state accepted as agreed (#719).
    const senderAddr = peer.toString();
    // The correlation id alone is not enough: it says which request this
    // claims to answer, not that the answer is about the same key or that
    // this peer was ever asked (#768).
    if (message.key !== pending.key) return;
    if (!pending.targets.has(senderAddr)) return;
    if (pending.acks.has(senderAddr)) return; // dedupe
    pending.acks.add(senderAddr);
    if (pending.acks.size >= pending.required) {
      pending.timer.cancel();
      this.pendingWrites.delete(message.pendingId);
      pending.resolve();
    }
  }

  private onReadRequest(message: DDataReadRequestMessage, peer: NodeAddress): void {
    const local = this.view.state.get(message.key);
    const response: DDataReadResponseMessage = {
      kind: 'ddata-read-response',
      from: this.cluster.selfAddress.toJSON(),
      pendingId: message.pendingId,
      key: message.key,
      value: local ? (local.toJSON() as CrdtJson) : null,
    };
    this.cluster.transport.send(peer, response as unknown as WireMessage);
  }

  private onReadResponse(message: DDataReadResponseMessage, peer: NodeAddress): void {
    const pending = this.pendingReads.get(message.pendingId);
    if (!pending) return;
    const senderAddr = peer.toString();
    if (message.key !== pending.key) return;
    if (!pending.targets.has(senderAddr)) return;
    if (pending.responses.has(senderAddr)) return; // dedupe
    pending.responses.add(senderAddr);
    if (message.value !== null) {
      const incoming = decodeCrdt(message.value);
      pending.merged = pending.merged ? pending.merged.merge(incoming) : incoming;
    }
    if (pending.responses.size >= pending.required) {
      pending.timer.cancel();
      this.pendingReads.delete(message.pendingId);
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

  private onDelete(message: DeleteMessage): void {
    if (this.view.state.delete(message.key)) {
      // Notify subscribers with a best-effort signal — we synthesise
      // a fresh CRDT via the most-recently-seen factory.  Since we
      // don't track factories per key, listeners just get nothing
      // for now; they'll see the next merge bring the key back if
      // a peer gossips it.
      this.scheduleDurableSave();
    }
  }

  private onGossip(message: DDataGossipMessage, peer: NodeAddress): void {
    if (peer.equals(this.cluster.selfAddress)) return; // shouldn't happen but harmless
    for (const [key, json] of Object.entries(message.entries)) {
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
    for (const listener of listeners) {
      try { listener(next); } catch (e) {
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
    const payload: DDataGossipMessage = {
      kind: 'ddata-gossip',
      from: this.cluster.selfAddress.toJSON(),
      entries,
    };
    const target = peers[Math.floor(Math.random() * peers.length)]!;
    this.cluster.transport.send(target.address, payload as unknown as WireMessage);
  }
}

/* ============================== helpers ============================== */

/**
 * Correlates a quorum read or write with the acknowledgments that answer it.
 *
 * Was `p${Date.now()}-${++counter}`.  This value goes onto the wire, and the
 * peer replies with the same one so the originator can match it up — so a
 * predictable id is an invitation: guess one that is in flight and a forged
 * acknowledgment counts toward a quorum that no peer actually gave.  A
 * timestamp is observable and a counter starts at 1 in every process, which
 * makes guessing arithmetic rather than search.
 *
 * The counter was also module-global rather than per-system, so two systems in
 * one process drew from the same sequence.  Sixteen hex characters are ~64
 * bits, far past the number of quorum requests in flight at once — the only
 * uniqueness that has to hold.
 */
function nextPendingId(): string {
  return `p${randomId(16)}`;
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
function clampQuorum(consistency: WriteConsistency | ReadConsistency, totalN: number): number {
  if (consistency === 'local') return 1;
  if (consistency === 'majority') return Math.floor(totalN / 2) + 1;
  if (consistency === 'all') return totalN;
  // { from: K }
  const fromCount = Math.trunc(consistency.from);
  if (!Number.isFinite(fromCount) || fromCount < 1) return 1;
  if (fromCount > totalN) return totalN;
  return fromCount;
}
